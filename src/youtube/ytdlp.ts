// Transcript engine: yt-dlp (residential proxy + a PO-token-free client) pulls
// metadata + audio, ffmpeg downsamples, Groq Whisper transcribes. This works
// where caption-scraping fails: caption-disabled videos AND cloud-IP blocks
// (the proxy clears the IP gate; the android_vr client dodges SABR/PO-tokens).
// (Filename kept so imports don't churn.)
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { audioAsrEnabled, config } from '../config'
import { parseVideoId, videoUrl } from '../util/youtube'
import { retry } from '../util/retry'
import { log } from '../util/logger'

const pexec = promisify(execFile)

const GROQ_MAX_BYTES = 24 * 1024 * 1024 // stay under Groq's ~25 MB cap
const CHUNK_SECONDS = 1500 // ~25 min audio chunks when a file is too big
const MAX_TRANSCRIPT_CHARS = 300_000

export interface VideoMeta {
  id: string
  title: string | null
  channel: string | null
  durationSeconds: number | null
  liveStatus: string | null
}

export interface VideoData {
  meta: VideoMeta
}

/** Common yt-dlp flags: proxy (if set) + the PO-token-free client. */
function ytArgs(extra: string[]): string[] {
  const a = ['--no-warnings', '--extractor-args', `youtube:player_client=${config.YT_PLAYER_CLIENT}`]
  if (config.YT_PROXY) a.push('--proxy', config.YT_PROXY)
  return [...a, ...extra]
}

/** Metadata (duration / live status / title) via a cheap yt-dlp -J dump. */
export async function fetchVideoData(url: string): Promise<VideoData> {
  const fallbackId = parseVideoId(url) ?? ''
  try {
    const { stdout } = await retry(
      () => pexec('yt-dlp', ytArgs(['--skip-download', '-J', url]), { maxBuffer: 1 << 27, timeout: 120_000 }),
      { tries: 3, baseMs: 3000, label: 'yt-dlp-meta' },
    )
    const j = JSON.parse(stdout) as Record<string, unknown>
    return {
      meta: {
        id: String(j.id ?? fallbackId),
        title: (j.title as string) ?? null,
        channel: (j.channel as string) ?? (j.uploader as string) ?? null,
        durationSeconds: typeof j.duration === 'number' ? Math.round(j.duration as number) : null,
        liveStatus: (j.live_status as string) ?? null,
      },
    }
  } catch (e) {
    // Metadata failed (block / change). Proceed with unknowns — the long-form
    // filter fails open and the transcript step will still try.
    log.warn('yt-dlp metadata failed', String(e))
    return { meta: { id: fallbackId, title: null, channel: null, durationSeconds: null, liveStatus: null } }
  }
}

/** Download audio → downsample → Groq Whisper. Returns clean transcript text or null. */
export async function getTranscript(data: VideoData): Promise<string | null> {
  if (!audioAsrEnabled) {
    log.warn('GROQ_API_KEY not set — cannot transcribe')
    return null
  }
  if (!data.meta.id) return null
  const dir = await mkdtemp(join(tmpdir(), 'mm-'))
  try {
    // 1. audio-only download (proxy + PO-token-free client)
    await retry(
      () =>
        pexec(
          'yt-dlp',
          ytArgs(['-f', 'bestaudio/best', '-o', join(dir, 'a.%(ext)s'), videoUrl(data.meta.id)]),
          { maxBuffer: 1 << 27, timeout: 300_000 },
        ),
      { tries: 3, baseMs: 4000, label: 'yt-dlp-audio' },
    )
    const raw = (await readdir(dir)).find((f) => f.startsWith('a.'))
    if (!raw) return null

    // 2. downsample to 16 kHz mono (Whisper's native rate) to shrink it
    const mono = join(dir, 'mono.mp3')
    await pexec('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(dir, raw), '-ar', '16000', '-ac', '1', '-b:a', '28k', mono], {
      timeout: 180_000,
    })

    // 3. transcribe (chunk if over Groq's size cap)
    let text: string
    if ((await stat(mono)).size <= GROQ_MAX_BYTES) {
      text = await groqTranscribe(mono)
    } else {
      const cdir = join(dir, 'chunks')
      await mkdir(cdir, { recursive: true })
      await pexec(
        'ffmpeg',
        ['-y', '-loglevel', 'error', '-i', mono, '-f', 'segment', '-segment_time', String(CHUNK_SECONDS), '-c', 'copy', join(cdir, 'c%03d.mp3')],
        { timeout: 180_000 },
      )
      const chunks = (await readdir(cdir)).filter((f) => f.endsWith('.mp3')).sort()
      const parts: string[] = []
      for (const c of chunks) parts.push(await groqTranscribe(join(cdir, c)))
      text = parts.join(' ')
    }

    text = text.replace(/\s+/g, ' ').trim()
    if (!text) return null
    if (text.length > MAX_TRANSCRIPT_CHARS) text = `${text.slice(0, MAX_TRANSCRIPT_CHARS)} …[transcript truncated]`
    return text
  } catch (e) {
    log.warn('audio→Groq transcription failed', String(e))
    return null
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

async function groqTranscribe(filePath: string): Promise<string> {
  const buf = await readFile(filePath)
  return retry(
    async () => {
      const form = new FormData()
      form.append('file', new Blob([buf]), 'audio.mp3')
      form.append('model', config.GROQ_MODEL)
      form.append('response_format', 'text')
      const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.GROQ_API_KEY}` },
        body: form,
      })
      if (!res.ok) throw new Error(`Groq HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
      return res.text()
    },
    { tries: 3, baseMs: 2000, label: 'groq' },
  )
}
