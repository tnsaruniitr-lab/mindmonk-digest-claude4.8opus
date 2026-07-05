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
