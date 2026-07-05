export interface ResolvedChannel {
  channelId: string
  title: string | null
  handle: string | null
  url: string
}

const CHANNEL_ID_RE = /^UC[\w-]{22}$/

/** Pull an 11-char video id out of a URL or accept a bare id. */
export function parseVideoId(input: string): string | null {
  const patterns = [
    /[?&]v=([\w-]{11})/,
    /youtu\.be\/([\w-]{11})/,
    /\/shorts\/([\w-]{11})/,
    /\/embed\/([\w-]{11})/,
    /\/live\/([\w-]{11})/,
  ]
  for (const p of patterns) {
    const m = input.match(p)
    if (m) return m[1]
  }
  if (/^[\w-]{11}$/.test(input.trim())) return input.trim()
  return null
}

/** Resolve a channel URL / @handle / UC… id to a channel id + title (no API key). */
export async function resolveChannel(input: string): Promise<ResolvedChannel> {
  const raw = input.trim()
  if (CHANNEL_ID_RE.test(raw)) {
    return { channelId: raw, title: null, handle: null, url: `https://www.youtube.com/channel/${raw}` }
  }

  let url = raw
  if (raw.startsWith('@')) url = `https://www.youtube.com/${raw}`
  else if (!/^https?:\/\//.test(raw)) url = `https://www.youtube.com/@${raw.replace(/^@/, '')}`

  // Only ever fetch a YouTube host — the input reaches here from authenticated web
  // users, so a raw http(s):// value must not become a blind server-side fetch (SSRF).
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    throw new Error('That doesn’t look like a channel URL, @handle, or UC… id.')
  }
  if (host !== 'youtube.com' && host !== 'www.youtube.com' && host !== 'm.youtube.com') {
    throw new Error('Only youtube.com channel URLs, @handles, or UC… ids are supported.')
  }

  const html = await fetchText(url)
  const channelId =
    html.match(/"channelId":"(UC[\w-]{22})"/)?.[1] ??
    html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})">/)?.[1]
  if (!channelId) {
    if (/consent\.youtube\.com|"consentBumpV2"|action="https:\/\/consent\.youtube/.test(html)) {
      throw new Error(
        'YouTube returned a consent/region wall instead of the channel page. Paste the UC… channel id directly instead.',
      )
    }
    throw new Error(
      'Could not resolve a channel id from that input. Paste the channel page URL (e.g. youtube.com/@handle) or the UC… id directly.',
    )
  }

  const title = decodeHtml(html.match(/<meta property="og:title" content="([^"]+)"/)?.[1] ?? null)
  const handle =
    raw.startsWith('@') ? raw : (html.match(/"canonicalBaseUrl":"\/(@[^"]+)"/)?.[1] ?? null)

  return { channelId, title, handle, url: `https://www.youtube.com/channel/${channelId}` }
}

export function feedUrl(channelId: string): string {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`
}

export function videoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`
}

async function fetchText(url: string): Promise<string> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 20_000)
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; PodcastDigestBot/1.0)', 'accept-language': 'en' },
      signal: ac.signal,
    })
    if (!res.ok) throw new Error(`Fetch ${url} -> HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

function decodeHtml(s: string | null): string | null {
  if (!s) return s
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}
