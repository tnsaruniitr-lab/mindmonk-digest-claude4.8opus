import { config } from '../config'
import { query, one } from '../db/db'
import { log } from '../util/logger'
import { decideCap, estimateAsrCostUsd, estimateLlmCostUsd, SUPADATA_PER_CALL_USD } from './pricing'

/**
 * Thrown when the global daily spend cap is reached. Treated as a transient PAUSE
 * (re-queue without burning the failure budget), NOT a hard failure — see worker.ts.
 */
export class DailySpendCapExceeded extends Error {}

interface UsageRow {
  kind: 'llm' | 'asr' | 'transcript'
  provider: string
  model: string
  inputTokens?: number
  outputTokens?: number
  audioSeconds?: number
  costUsd: number
  videoId?: string | null
  userId?: string | null // per-user attribution (Stage B ④ spend); null = platform cost
}

async function insertUsage(r: UsageRow): Promise<void> {
  // Best-effort: cost telemetry must never break the pipeline.
  try {
    await query(
      `insert into usage_events(kind, provider, model, input_tokens, output_tokens, audio_seconds, cost_usd, video_id, user_id)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        r.kind,
        r.provider,
        r.model,
        r.inputTokens ?? null,
        r.outputTokens ?? null,
        r.audioSeconds ?? null,
        r.costUsd,
        r.videoId ?? null,
        r.userId ?? null,
      ],
    )
  } catch (e) {
    log.warn('usage ledger insert failed (continuing)', String(e))
  }
}

export async function recordLlmUsage(p: {
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  videoId?: string | null
  userId?: string | null
}): Promise<void> {
  const costUsd = estimateLlmCostUsd(p.model, p.inputTokens, p.outputTokens)
  await insertUsage({
    kind: 'llm',
    provider: p.provider,
    model: p.model,
    inputTokens: p.inputTokens,
    outputTokens: p.outputTokens,
    costUsd,
    videoId: p.videoId,
    userId: p.userId,
  })
}

export async function recordAsrUsage(p: {
  provider: string
  model: string
  seconds: number
  videoId?: string | null
}): Promise<void> {
  const costUsd = estimateAsrCostUsd(p.model, p.seconds)
  await insertUsage({
    kind: 'asr',
    provider: p.provider,
    model: p.model,
    audioSeconds: Math.round(Math.max(0, p.seconds)),
    costUsd,
    videoId: p.videoId,
  })
}

/** Record a Supadata managed-transcript call (Tier 0). Flat per-call estimate — Supadata
 *  bills per request, not per token/minute. */
export async function recordSupadataUsage(p: { seconds?: number; videoId?: string | null }): Promise<void> {
  await insertUsage({
    kind: 'transcript',
    provider: 'supadata',
    model: 'supadata',
    audioSeconds: p.seconds != null ? Math.round(Math.max(0, p.seconds)) : undefined,
    costUsd: SUPADATA_PER_CALL_USD,
    videoId: p.videoId,
  })
}

/** Estimated USD spend recorded so far in the current day (server time). */
export async function spentTodayUsd(): Promise<number> {
  const row = await one<{ s: string }>(
    `select coalesce(sum(cost_usd), 0)::text as s
       from usage_events
      where created_at >= date_trunc('day', now())`,
  )
  return row ? Number(row.s) : 0
}

/**
 * Throw DailySpendCapExceeded if today's recorded spend has reached the cap.
 * Cap of 0 disables the guard. Fails OPEN on a DB read error so a transient blip
 * doesn't wedge the whole pipeline (a dead DB stops everything anyway).
 *
 * Best-effort CUMULATIVE soft ceiling: the check runs before a call and recording
 * after, so one in-flight call can overshoot by ~its own cost before the next is
 * blocked. processVideo also pre-flights this at the top to avoid half-spends.
 */
export async function assertUnderDailyCap(): Promise<void> {
  const cap = config.GLOBAL_DAILY_SPEND_CAP_USD
  if (!(cap > 0)) return
  let spent: number
  try {
    spent = await spentTodayUsd()
  } catch (e) {
    log.warn('spend-cap check could not read ledger; allowing this call', String(e))
    return
  }
  if (decideCap(spent, cap)) {
    throw new DailySpendCapExceeded(
      `global daily spend cap reached: ~$${spent.toFixed(2)} >= $${cap.toFixed(2)} ` +
        `(set GLOBAL_DAILY_SPEND_CAP_USD=0 to disable)`,
    )
  }
}
