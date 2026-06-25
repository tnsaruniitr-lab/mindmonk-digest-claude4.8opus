import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { retry } from '../util/retry'

const pexec = promisify(execFile)

export interface VideoMeta {
  id: string
  title: string | null
  channel: string | null
  durationSeconds: number | null
  liveStatus: string | null // is_live | was_live | not_live | is_upcoming | post_live | null
}

interface CaptionTrack {
  ext: string
  url: string
}

export interface VideoData {
  meta: VideoMeta
  /** lang -> tracks, for manual subtitles and auto-captions respectively */
  subtitles: Record<string, CaptionTrack[]>
  autoCaptions: Record<string, CaptionTrack[]>
}

/** One yt-dlp call gives us duration, live status, and caption track URLs. */
export async function fetchVideoData(url: string): Promise<VideoData> {
  const { stdout } = await retry(
    () =>
      pexec('yt-dlp', ['--skip-download', '--no-warnings', '-J', url], {
        maxBuffer: 1024 * 1024 * 128,
        timeout: 120_000,
      }),
    { tries: 3, baseMs: 3000, label: 'yt-dlp' },
  )
  const j = JSON.parse(stdout) as Record<string, unknown>
  return {
    meta: {
      id: String(j.id ?? ''),
      title: (j.title as string) ?? null,
      channel: (j.channel as string) ?? (j.uploader as string) ?? null,
      durationSeconds: typeof j.duration === 'number' ? Math.round(j.duration as number) : null,
      liveStatus: (j.live_status as string) ?? null,
    },
    subtitles: (j.subtitles as Record<string, CaptionTrack[]>) ?? {},
    autoCaptions: (j.automatic_captions as Record<string, CaptionTrack[]>) ?? {},
  }
}

const MAX_TRANSCRIPT_CHARS = 300_000

/**
 * Pick the best caption track (manual EN > auto EN > any manual > any auto),
 * fetch it, and return clean plain text. Returns null when no captions exist.
 */
export async function getTranscript(data: VideoData): Promise<string | null> {
  const track = pickTrack(data.subtitles) ?? pickTrack(data.autoCaptions)
  if (!track) return null

  const res = await fetch(track.url, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; PodcastDigestBot/1.0)' },
  })
  if (!res.ok) throw new Error(`Caption fetch HTTP ${res.status}`)
  const body = await res.text()

  let text = track.ext === 'json3' ? json3ToText(body) : vttToText(body)
  text = text.replace(/\s+/g, ' ').trim()
  if (!text) return null
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    text = text.slice(0, MAX_TRANSCRIPT_CHARS) + ' …[transcript truncated]'
  }
  return text
}

function pickTrack(obj: Record<string, CaptionTrack[]>): CaptionTrack | null {
  const langs = Object.keys(obj)
  if (langs.length === 0) return null
  const en = langs.find((l) => l.toLowerCase().startsWith('en'))
  const tracks = obj[en ?? langs[0]]
  if (!tracks || tracks.length === 0) return null
  return (
    tracks.find((t) => t.ext === 'json3') ??
    tracks.find((t) => t.ext === 'vtt') ??
    tracks.find((t) => t.ext === 'srv3') ??
    tracks[0]
  )
}

function json3ToText(body: string): string {
  try {
    const j = JSON.parse(body) as { events?: { segs?: { utf8?: string }[] }[] }
    return (j.events ?? [])
      .map((e) => (e.segs ?? []).map((s) => s.utf8 ?? '').join(''))
      .join(' ')
  } catch {
    return ''
  }
}

function vttToText(body: string): string {
  const out: string[] = []
  let prev = ''
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (!line || line === 'WEBVTT') continue
    if (line.includes('-->')) continue
    if (/^\d+$/.test(line)) continue
    if (/^(NOTE|Kind:|Language:)/.test(line)) continue
    const clean = line.replace(/<[^>]+>/g, '').trim() // strip <00:00:00.000> / <c> tags
    if (!clean || clean === prev) continue
    out.push(clean)
    prev = clean
  }
  return out.join(' ')
}
