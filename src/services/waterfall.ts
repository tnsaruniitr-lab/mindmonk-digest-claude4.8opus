import { one, query } from '../db/db'
import { log, scrub } from '../util/logger'

// Waterfall observability: every transcript-acquisition attempt (cache probe,
// Supadata call, audio+ASR run) records one event here. The /waterfall command
// and the HTTP dashboard read these to show which tier served — or failed —
// each video. Recording is fire-and-forget: observability must never break
// (or slow) the pipeline itself.

export type WaterfallTier = 'cache' | 'supadata' | 'audio' | 'audio:groq' | 'audio:openai'
export type WaterfallOutcome = 'hit' | 'miss' | 'rate_limited' | 'error'

export interface WaterfallEvent {
  tier: string
  outcome: string
  detail: string | null
  duration_ms: number | null
  created_at: string
}

export async function recordWaterfall(
  videoId: string,
  tier: WaterfallTier,
  outcome: WaterfallOutcome,
  opts: { detail?: string; durationMs?: number } = {},
): Promise<void> {
  try {
    await query(
      `insert into waterfall_events(video_id, tier, outcome, detail, duration_ms)
       values($1, $2, $3, $4, $5)`,
      [videoId, tier, outcome, opts.detail ? scrub(opts.detail).slice(0, 300) : null, opts.durationMs != null ? Math.round(opts.durationMs) : null],
    )
  } catch (e) {
    log.warn('waterfall event insert failed (non-fatal)', String(e))
  }
}

export interface JourneyRow {
  video_id: string
  title: string | null
  url: string | null
  status: string
  skip_reason: string | null
  created_at: string
  processed_at: string | null
  transcript_source: string | null
  char_len: number | null
  events: WaterfallEvent[]
  /** Attempts older than the per-video display cap (retry stalls can pile up hundreds). */
  dropped_events: number
}

/** A journey is for reading, not archiving: keep only the LAST N attempts per video.
 *  Bounds both the Telegram reply and the dashboard payload during retry stalls. */
const MAX_EVENTS_PER_JOURNEY = 12

/** Latest N videos with their attempt journeys (newest video first). */
export async function recentJourneys(limit = 30): Promise<JourneyRow[]> {
  const rows = await query<Omit<JourneyRow, 'events' | 'dropped_events'>>(
    `select v.video_id, v.title, v.url, v.status, v.skip_reason,
            v.created_at::text, v.processed_at::text,
            t.source as transcript_source, t.char_len
     from videos v
     left join transcripts t on t.video_id = v.video_id
     order by v.created_at desc
     limit $1`,
    [limit],
  )
  if (!rows.length) return []
  // Newest N per video via the window; re-sorted ascending for display.
  const events = await query<WaterfallEvent & { video_id: string }>(
    `select video_id, tier, outcome, detail, duration_ms, created_at, total from (
       select video_id, tier, outcome, detail, duration_ms, created_at::text, id,
              row_number() over (partition by video_id order by id desc) as rn,
              count(*) over (partition by video_id) as total
       from waterfall_events
       where video_id = any($1)
     ) w
     where rn <= ${MAX_EVENTS_PER_JOURNEY}
     order by id asc`,
    [rows.map((r) => r.video_id)],
  )
  const byVideo = new Map<string, { events: WaterfallEvent[]; total: number }>()
  for (const e of events as (WaterfallEvent & { video_id: string; total: string | number })[]) {
    const entry = byVideo.get(e.video_id) ?? { events: [], total: Number(e.total) }
    entry.events.push({ tier: e.tier, outcome: e.outcome, detail: e.detail, duration_ms: e.duration_ms, created_at: e.created_at })
    byVideo.set(e.video_id, entry)
  }
  return rows.map((r) => {
    const entry = byVideo.get(r.video_id)
    return {
      ...r,
      events: entry?.events ?? [],
      dropped_events: entry ? Math.max(0, entry.total - entry.events.length) : 0,
    }
  })
}

export interface TierStat {
  tier: string
  outcome: string
  n: number
}

/** Attempt counts per tier+outcome over the trailing window. */
export async function tierStats(days = 30): Promise<TierStat[]> {
  return query<TierStat>(
    `select tier, outcome, count(*)::int as n
     from waterfall_events
     where created_at > now() - make_interval(days => $1)
     group by tier, outcome
     order by tier, outcome`,
    [days],
  )
}

/** How every cached transcript was obtained (all-time). */
export async function sourceCounts(): Promise<{ source: string | null; n: number }[]> {
  return query<{ source: string | null; n: number }>(
    `select source, count(*)::int as n from transcripts group by source order by n desc`,
  )
}

export interface SpendSummary {
  today_usd: number
  last30_usd: number
  by_provider: { provider: string | null; kind: string; usd: number; calls: number }[]
}

/** LLM + ASR spend from the existing cost ledger (usage_events). */
export async function spendSummary(): Promise<SpendSummary> {
  const today = await one<{ usd: string }>(
    `select coalesce(sum(cost_usd), 0)::text as usd from usage_events where created_at::date = now()::date`,
  )
  const last30 = await one<{ usd: string }>(
    `select coalesce(sum(cost_usd), 0)::text as usd from usage_events where created_at > now() - interval '30 days'`,
  )
  const byProvider = await query<{ provider: string | null; kind: string; usd: string; calls: string }>(
    `select provider, kind, coalesce(sum(cost_usd), 0)::text as usd, count(*)::text as calls
     from usage_events
     where created_at > now() - interval '30 days'
     group by provider, kind
     order by sum(cost_usd) desc`,
  )
  return {
    today_usd: Number(today?.usd ?? 0),
    last30_usd: Number(last30?.usd ?? 0),
    by_provider: byProvider.map((r) => ({ provider: r.provider, kind: r.kind, usd: Number(r.usd), calls: Number(r.calls) })),
  }
}
