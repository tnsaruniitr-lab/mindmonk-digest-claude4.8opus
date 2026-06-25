import { one, query } from '../db/db'

// Per-video transcript cache (Phase 1). Keyed by the YouTube video id so a video is
// transcribed at most once — re-runs (and, later, multiple subscribers) reuse it,
// which removes the most expensive + most fragile step from the hot path.

export async function getCachedTranscript(videoId: string): Promise<string | null> {
  const row = await one<{ text: string }>('select text from transcripts where video_id = $1', [videoId])
  return row?.text ?? null
}

/** Store a freshly-fetched transcript. First writer wins (idempotent on video_id). */
export async function saveTranscript(videoId: string, text: string, source: string): Promise<void> {
  await query(
    `insert into transcripts(video_id, text, source, char_len)
     values($1, $2, $3, $4)
     on conflict(video_id) do nothing`,
    [videoId, text, source, text.length],
  )
}
