// Caption-only transcript + lightweight watch-page metadata.
// NO yt-dlp: we never touch YouTube's media/player layer, so we avoid the
// "Sign in to confirm you're not a bot" challenge that blocks yt-dlp from
// cloud/datacenter IPs (Railway). We hit the same surface as the "Show
// transcript" button: watch page -> caption tracks -> timedtext.
// (Filename kept so imports don't churn.)
import { YoutubeTranscript } from 'youtube-transcript'
import { parseVideoId } from '../util/youtube'
import { retry } from '../util/retry'

export interface VideoMeta {
  id: string
  title: string | null
  channel: string | null
  durationSeconds: number | null
  liveStatus: string | null // is_live | is_upcoming | not_live | null
}

export interface VideoData {
  meta: VideoMeta
}

/** Lightweight metadata from the watch page (no media layer, no yt-dlp). */
export async function fetchVideoData(url: string): Promise<VideoData> {
  const id = parseVideoId(url)
  if (!id) throw new Error(`Could not parse a video id from: ${url}`)
  return { meta: await fetchMeta(id) }
}

async function fetchMeta(id: string): Promise<VideoMeta> {
  const base: VideoMeta = { id, title: null, channel: null, durationSeconds: null, liveStatus: 'not_live' }
  try {
    const html = await fetchText(`https://www.youtube.com/watch?v=${id}`)
    const json = extractBalancedJson(html, 'ytInitialPlayerResponse')
    if (!json) return base
    const pr = JSON.parse(json) as { videoDetails?: Record<string, unknown> }
    const vd = pr.videoDetails ?? {}
    return {
      id,
      title: (vd.title as string) ?? null,
      channel: (vd.author as string) ?? null,
      durationSeconds: vd.lengthSeconds ? Number(vd.lengthSeconds) : null,
      liveStatus: vd.isLive ? 'is_live' : vd.isUpcoming ? 'is_upcoming' : 'not_live',
    }
  } catch {
    // Watch page blocked/changed — proceed; the long-form filter just fails open.
    return base
  }
}

const MAX_TRANSCRIPT_CHARS = 300_000

/** Fetch captions via youtube-transcript (watch page -> caption tracks -> timedtext). */
export async function getTranscript(data: VideoData): Promise<string | null> {
  try {
    const items = await retry(() => YoutubeTranscript.fetchTranscript(data.meta.id), {
      tries: 3,
      baseMs: 2000,
      label: 'youtube-transcript',
    })
    if (!items || items.length === 0) return null
    let text = items
      .map((i) => decodeEntities(i.text))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) return null
    if (text.length > MAX_TRANSCRIPT_CHARS) text = `${text.slice(0, MAX_TRANSCRIPT_CHARS)} …[transcript truncated]`
    return text
  } catch {
    // captions disabled / unavailable / blocked -> NoTranscriptYet upstream
    return null
  }
}

async function fetchText(url: string): Promise<string> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 20_000)
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'accept-language': 'en-US,en;q=0.9',
      },
      signal: ac.signal,
    })
    if (!res.ok) throw new Error(`watch page HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

/** Extract the first balanced {...} object following a marker (e.g. ytInitialPlayerResponse). */
function extractBalancedJson(html: string, marker: string): string | null {
  const m = html.indexOf(marker)
  if (m === -1) return null
  const start = html.indexOf('{', m)
  if (start === -1) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let j = start; j < html.length; j++) {
    const c = html[j]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
    } else if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return html.slice(start, j + 1)
    }
  }
  return null
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;#39;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;quot;/g, '"')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}
