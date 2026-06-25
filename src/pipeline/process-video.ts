import { query } from '../db/db'
import { config, graderConfigured, supadataEnabled } from '../config'
import type { GradeResult, VideoRow } from '../types'
import { fetchVideoData, getTranscript } from '../youtube/ytdlp'
import { supadataTranscript } from '../youtube/supadata'
import { getMinDurationMinutes } from '../services/settings'
import { getProfile } from '../services/profile'
import { deliver } from '../services/delivery'
import { extractInsights } from './extract'
import { gradeIdeas } from './grade'
import { personalize } from './personalize'
import { renderDigest } from './render'
import { log } from '../util/logger'

/** Thrown when captions aren't available yet (retryable — auto-captions can lag). */
export class NoTranscriptYet extends Error {}

export type ProcessResult = { kind: 'delivered' } | { kind: 'skipped'; reason: string }

export async function processVideo(
  video: VideoRow,
  opts: { force?: boolean } = {},
): Promise<ProcessResult> {
  const data = await fetchVideoData(video.url)
  const meta = data.meta
  const dur = meta.durationSeconds
  const title = meta.title ?? video.title

  await query('update videos set duration_seconds = $1, title = $2 where id = $3', [dur, title, video.id])

  // --- long-form filter (skipped for on-demand /fetch & /channel via force) ---
  if (!opts.force) {
    if (meta.liveStatus === 'is_live' || meta.liveStatus === 'is_upcoming') {
      return { kind: 'skipped', reason: 'live_or_upcoming' }
    }
    if (meta.liveStatus === 'post_live') {
      // Stream just ended — duration/captions are still finalizing. Retry later.
      throw new NoTranscriptYet('stream just ended; finalizing')
    }
    const minMin = await getMinDurationMinutes()
    if (dur != null && dur < minMin * 60) {
      return { kind: 'skipped', reason: `too_short_under_${minMin}m` }
    }
  }

  // --- transcript: 3-tier waterfall ---
  // Tier 0: Supadata (managed; no proxy/yt-dlp/download). Tried first when configured;
  // sidesteps IP blocks, SABR, 403s and proxy-IP burn. Falls through on any failure.
  let transcript: string | null = null
  if (supadataEnabled) {
    transcript = await supadataTranscript(meta.id)
    if (transcript) log.info(`Transcript via Supadata: ${meta.id}`)
  }
  // Tier 1+2: yt-dlp audio -> ffmpeg -> Groq -> OpenAI. Throws TranscriptRateLimited
  // on a quota throttle (recoverable, handled upstream); null = no usable transcript.
  if (!transcript) transcript = await getTranscript(data)
  if (!transcript) throw new NoTranscriptYet('no transcript produced')

  // --- 4-section pipeline ---
  const extract = await extractInsights({ title, channel: meta.channel, transcript })

  let grade: GradeResult | null = null
  if (graderConfigured) {
    try {
      grade = await gradeIdeas({ title, extract })
    } catch (e) {
      log.warn('grader failed; delivering without grade', String(e))
    }
  }

  const profile = await getProfile()
  const personalizeRes = await personalize({ extract, profile })

  const html = renderDigest({
    title,
    channel: meta.channel,
    url: video.url,
    durationSeconds: dur,
    extract,
    grade,
    personalize: personalizeRes,
  })

  await query(
    `insert into digests(video_id, key_insights, patterns, antipatterns, grading, tailored, rendered, primary_model, grader_model)
     values($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      video.id,
      JSON.stringify(extract.key_insights),
      JSON.stringify(extract.patterns),
      JSON.stringify(extract.antipatterns),
      grade ? JSON.stringify(grade) : null,
      JSON.stringify(personalizeRes),
      html,
      config.ANTHROPIC_MODEL,
      graderConfigured ? config.GRADER_MODEL : null,
    ],
  )

  await deliver(html, video.id)
  return { kind: 'delivered' }
}
