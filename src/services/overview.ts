import { one, query } from '../db/db'

// Read models for the dashboard's Channels + Digest-records sections.

export interface ChannelOverview {
  title: string | null
  handle: string | null
  url: string | null
  active: boolean
  min_duration_minutes: number | null
  last_checked_at: string | null
  videos: number
  digests: number
  last_published: string | null
}

export async function channelsOverview(): Promise<ChannelOverview[]> {
  return query<ChannelOverview>(
    `select c.title, c.handle, c.url, c.active, c.min_duration_minutes, c.last_checked_at::text,
            count(v.id)::int as videos,
            count(d.id)::int as digests,
            max(v.published_at)::text as last_published
     from channels c
     left join videos v on v.channel_id = c.id
     left join digests d on d.video_id = v.id
     group by c.id
     order by c.created_at asc`,
  )
}

export interface DigestRecord {
  id: string
  created_at: string
  title: string | null
  url: string | null
  primary_model: string | null
  grader_model: string | null
  has_grade: boolean
  rendered_len: number | null
}

/** Latest delivered digests (summary records), newest first. */
export async function recentDigests(limit = 20): Promise<DigestRecord[]> {
  return query<DigestRecord>(
    `select d.id, d.created_at::text, v.title, v.url, d.primary_model, d.grader_model,
            (d.grading is not null) as has_grade,
            length(d.rendered)::int as rendered_len
     from digests d
     left join videos v on v.id = d.video_id
     order by d.created_at desc
     limit $1`,
    [limit],
  )
}

/** Full rendered digest (Telegram HTML) for the detail view. */
export async function getDigestRendered(id: string): Promise<{ title: string | null; rendered: string | null; created_at: string } | null> {
  return one<{ title: string | null; rendered: string | null; created_at: string }>(
    `select v.title, d.rendered, d.created_at::text
     from digests d
     left join videos v on v.id = d.video_id
     where d.id = $1`,
    [id],
  )
}

/** Newest delivered digest with its full rendered text (test console: "show latest"). */
export async function latestDigest(): Promise<{ id: string; title: string | null; rendered: string | null; created_at: string } | null> {
  return one<{ id: string; title: string | null; rendered: string | null; created_at: string }>(
    `select d.id, v.title, d.rendered, d.created_at::text
     from digests d
     left join videos v on v.id = d.video_id
     order by d.created_at desc
     limit 1`,
  )
}

export interface JobState {
  video_id: string
  title: string | null
  url: string | null
  status: string
  skip_reason: string | null
  transcript_source: string | null
  transcript_chars: number | null
  events: { tier: string; outcome: string; detail: string | null; duration_ms: number | null; created_at: string }[]
  digest: { id: string; created_at: string; rendered: string } | null
}

/** Live state of one fetch job, polled by the test console while it runs. */
export async function jobState(videoId: string): Promise<JobState | null> {
  const video = await one<{ id: string; video_id: string; title: string | null; url: string | null; status: string; skip_reason: string | null; transcript_source: string | null; transcript_chars: number | null }>(
    `select v.id, v.video_id, v.title, v.url, v.status, v.skip_reason,
            t.source as transcript_source, t.char_len as transcript_chars
     from videos v
     left join transcripts t on t.video_id = v.video_id
     where v.video_id = $1`,
    [videoId],
  )
  if (!video) return null
  const events = await query<{ tier: string; outcome: string; detail: string | null; duration_ms: number | null; created_at: string }>(
    `select tier, outcome, detail, duration_ms, created_at::text
     from waterfall_events where video_id = $1
     order by id desc limit 12`,
    [videoId],
  )
  events.reverse()
  const digest = await one<{ id: string; created_at: string; rendered: string }>(
    `select id, created_at::text, rendered from digests
     where video_id = $1 order by created_at desc limit 1`,
    [video.id],
  )
  return {
    video_id: video.video_id,
    title: video.title,
    url: video.url,
    status: video.status,
    skip_reason: video.skip_reason,
    transcript_source: video.transcript_source,
    transcript_chars: video.transcript_chars,
    events,
    digest,
  }
}
