import { one, query } from '../db/db'
import type { VideoRow, VideoStatus } from '../types'
import { videoUrl } from '../util/youtube'

/** Insert a discovered video as pending. Returns null if the video_id already exists. */
export async function enqueueVideo(input: {
  videoId: string
  channelId: string | null
  title: string | null
  publishedAt: string | null
}): Promise<VideoRow | null> {
  return one<VideoRow>(
    `insert into videos(video_id, channel_id, title, url, published_at, status)
     values($1, $2, $3, $4, $5, 'pending')
     on conflict(video_id) do nothing
     returning *`,
    [input.videoId, input.channelId, input.title, videoUrl(input.videoId), input.publishedAt],
  )
}

export async function videoExists(videoId: string): Promise<boolean> {
  const row = await one('select id from videos where video_id = $1', [videoId])
  return !!row
}

/** Atomically claim the oldest pending video (FOR UPDATE SKIP LOCKED — race-safe). */
export async function claimNextPending(): Promise<VideoRow | null> {
  return one<VideoRow>(
    `update videos set status = 'processing', claimed_at = now()
     where id = (
       select id from videos where status = 'pending'
       order by created_at asc limit 1
       for update skip locked
     )
     returning *`,
  )
}

/** Claim a specific video iff still pending (used by /test, race-safe). */
export async function claimById(id: string): Promise<VideoRow | null> {
  return one<VideoRow>(
    `update videos set status = 'processing', claimed_at = now()
     where id = $1 and status = 'pending'
     returning *`,
    [id],
  )
}

/** Requeue videos stranded in 'processing' (worker died mid-task). */
export async function reapStale(minutes: number): Promise<number> {
  const rows = await query<{ id: string }>(
    `update videos set status = 'pending'
     where status = 'processing' and claimed_at < now() - make_interval(mins => $1)
     returning id`,
    [minutes],
  )
  return rows.length
}

export interface StatusPatch {
  status: VideoStatus
  skip_reason?: string | null
  duration_seconds?: number | null
  is_long_form?: boolean | null
  title?: string | null
  incAttempts?: boolean
  incTranscriptAttempts?: boolean
  markProcessed?: boolean
}

export async function setVideoStatus(id: string, patch: StatusPatch): Promise<void> {
  const sets: string[] = []
  const params: unknown[] = []
  const add = (col: string, val: unknown) => {
    params.push(val)
    sets.push(`${col} = $${params.length}`)
  }
  add('status', patch.status)
  if (patch.skip_reason !== undefined) add('skip_reason', patch.skip_reason)
  if (patch.duration_seconds !== undefined) add('duration_seconds', patch.duration_seconds)
  if (patch.is_long_form !== undefined) add('is_long_form', patch.is_long_form)
  if (patch.title !== undefined) add('title', patch.title)
  if (patch.markProcessed) sets.push('processed_at = now()')
  if (patch.incAttempts) sets.push('attempts = attempts + 1')
  if (patch.incTranscriptAttempts) sets.push('transcript_attempts = transcript_attempts + 1')
  params.push(id)
  await query(`update videos set ${sets.join(', ')} where id = $${params.length}`, params)
}

export async function statusCounts(): Promise<Record<string, number>> {
  const rows = await query<{ status: string; count: number }>(
    'select status, count(*)::int as count from videos group by status',
  )
  const counts: Record<string, number> = {}
  for (const r of rows) counts[r.status] = Number(r.count)
  return counts
}

export async function getVideoByVideoId(videoId: string): Promise<VideoRow | null> {
  return one<VideoRow>('select * from videos where video_id = $1', [videoId])
}

/** Reset a video so it (re)processes from scratch — used by the on-demand fetch path.
 *  Refuses rows currently 'processing' so it can't steal an in-flight claim (the cron
 *  worker, or a concurrent fetch of the same video). Returns true iff it was reset. */
export async function resetVideo(id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `update videos set status = 'pending', attempts = 0, transcript_attempts = 0,
       processed_at = null, skip_reason = null, claimed_at = null
     where id = $1 and status <> 'processing'
     returning id`,
    [id],
  )
  return rows.length > 0
}
