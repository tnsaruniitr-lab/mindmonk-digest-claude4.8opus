// Tier 0 of the transcription waterfall: Supadata's managed API.
//
// Unlike the audio chain (yt-dlp + proxy + ffmpeg + Groq/OpenAI), this fetches the
// transcript from Supadata's OWN infrastructure: videoId -> transcript text. No
// download, no proxy, no yt-dlp. That sidesteps the failure modes that bite the
// self-hosted path — datacenter-IP blocks, SABR/PO-token changes, HTTP 403 on the
// media download, and proxy-IP burn — none of which touch Supadata. It also handles
// caption-disabled videos via their own ASR.
//
// Returns null on ANY failure (incl. its own rate limit) so the caller transparently
// falls back to the audio chain. This module is intentionally standalone — it does
// not import or affect the existing flow.
import { config } from '../config'
import { retry } from '../util/retry'
import { log } from '../util/logger'

const MAX_TRANSCRIPT_CHARS = 300_000
const ENDPOINT = 'https://api.supadata.ai/v1/youtube/transcript'

interface SupadataResponse {
  content?: string
  lang?: string
  jobId?: string // only the async (long-ASR) path returns this; see note below
}

/**
 * Fetch a clean transcript for a YouTube video via Supadata. Verified synchronous
 * for videos up to at least 1h16m (returns `content` directly, no job polling).
 * Returns null on any failure so the caller falls back to the audio chain.
 */
export async function supadataTranscript(videoId: string): Promise<string | null> {
  if (!videoId || !config.SUPADATA_API_KEY) return null
  try {
    const raw = await retry(() => fetchSupadata(videoId), { tries: 3, baseMs: 2000, label: 'supadata' })
    if (!raw) return null
    let text = raw.replace(/\s+/g, ' ').trim()
    if (!text) return null
    if (text.length > MAX_TRANSCRIPT_CHARS) text = `${text.slice(0, MAX_TRANSCRIPT_CHARS)} …[transcript truncated]`
    return text
  } catch (e) {
    // Any failure (incl. 429) is non-fatal here — fall back to the audio chain.
    log.warn('Supadata transcript failed; falling back to audio chain', String(e))
    return null
  }
}

async function fetchSupadata(videoId: string): Promise<string | null> {
  const url = `${ENDPOINT}?videoId=${encodeURIComponent(videoId)}&text=true`
  const res = await fetch(url, { headers: { 'x-api-key': config.SUPADATA_API_KEY } })

  // Quota exhausted — not retryable in seconds. Return null so we fall back rather
  // than burning retries; the audio chain (Groq) may still have budget.
  if (res.status === 429) {
    log.warn('Supadata rate-limited (429) — falling back to audio chain')
    return null
  }
  if (!res.ok) throw new Error(`Supadata HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)

  const data = (await res.json()) as SupadataResponse
  if (typeof data.content === 'string') return data.content

  // Defensive: the youtube/transcript endpoint has been synchronous in all testing
  // (incl. 1h16m). If a future very-long video ever returns an async jobId instead,
  // don't guess the (unverified) polling contract — fall back to the audio chain.
  if (data.jobId) {
    log.warn(`Supadata returned async jobId ${data.jobId}; falling back to audio chain`)
    return null
  }
  return null
}
