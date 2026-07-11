import { query } from '../db/db'
import { config, extractModel, graderConfigured, supadataEnabled } from '../config'
import type { ExtractResult, GradeResult, VideoRow } from '../types'
import { fetchVideoData, getTranscript } from '../youtube/ytdlp'
import { supadataTranscript } from '../youtube/supadata'
import { getCachedTranscript, saveTranscript } from '../services/transcripts'
import { getVideoDigest, saveVideoDigest, updateVideoDigestGrade } from '../services/video-digests'
import { getMinDurationMinutes } from '../services/settings'
import { getProfile } from '../services/profile'
import { channelIsActive } from '../services/channels'
import { minSubscriberDurationMinutes } from '../services/subscriptions'
import { fanOutVideo } from '../services/user-deliveries'
import { deliver } from '../services/delivery'
import { extractInsights } from './extract'
import { gradeIdeas } from './grade'
import { personalize } from './personalize'
import { renderDigest } from './render'
import { log } from '../util/logger'
import { assertUnderDailyCap, recordSupadataUsage, DailySpendCapExceeded } from '../cost/ledger'

/** Thrown when captions aren't available yet (retryable — auto-captions can lag). */
export class NoTranscriptYet extends Error {}

export type ProcessResult = { kind: 'delivered' } | { kind: 'skipped'; reason: string }

export async function processVideo(
  video: VideoRow,
  opts: { force?: boolean } = {},
): Promise<ProcessResult> {
  // Pre-flight: if the daily spend cap is already hit, pause before ANY work
  // (proxy metadata fetch, transcript, LLM) — avoids half-spends and churn.
  await assertUnderDailyCap()
  const data = await fetchVideoData(video.url)
  const meta = data.meta
  const dur = meta.durationSeconds
  const title = meta.title ?? video.title

  await query('update videos set duration_seconds = $1, title = $2 where id = $3', [dur, title, video.id])

  // Who is interested in this video? (Phase 2)
  // - ownerFollows: channels.active keeps its legacy meaning ("in the owner's set").
  //   Rows without a channel (on-demand /fetch) are owner-requested by definition.
  // - subsMin: the most permissive min-duration any fan-out-eligible subscriber
  //   would accept (null = no subscribers).
  const globalMin = await getMinDurationMinutes()
  const ownerFollows = video.channel_id ? await channelIsActive(video.channel_id) : true
  const subsMin = video.channel_id ? await minSubscriberDurationMinutes(video.channel_id, globalMin) : null

  // --- long-form filter (skipped for on-demand /fetch & /channel via force) ---
  // Shared work runs if ANYONE accepts the video; each party's own threshold is
  // re-applied at their delivery step (owner inline below, subscribers in fan-out).
  if (!opts.force) {
    if (meta.liveStatus === 'is_live' || meta.liveStatus === 'is_upcoming') {
      return { kind: 'skipped', reason: 'live_or_upcoming' }
    }
    if (meta.liveStatus === 'post_live') {
      // Stream just ended — duration/captions are still finalizing. Retry later.
      throw new NoTranscriptYet('stream just ended; finalizing')
    }
    const thresholds = [ownerFollows ? globalMin : null, subsMin].filter((m): m is number => m != null)
    if (thresholds.length === 0) {
      // Nobody follows this channel anymore (unsubscribed between enqueue and process).
      return { kind: 'skipped', reason: 'no_subscribers' }
    }
    const minMin = Math.min(...thresholds)
    if (dur != null && dur < minMin * 60) {
      return { kind: 'skipped', reason: `too_short_under_${minMin}m` }
    }
  }

  // --- transcript: cache → 3-tier waterfall (transcribe at most once). Immutable, so a
  //     force recompute still reuses it — only ①②③/④ are recomputed, never re-paying ASR. ---
  // NOTE: deliberately NOT recorded in waterfall_events — a journey is the story of
  // ACQUIRING the transcript once; cache hits on re-runs would append noise to it.
  let transcript = await getCachedTranscript(video.video_id)
  if (transcript) {
    log.info(`Transcript via cache: ${video.video_id}`)
  } else {
    let source = ''
    // Tier 0: Supadata (managed; no proxy/yt-dlp/download). Tried first when configured;
    // sidesteps IP blocks, SABR, 403s and proxy-IP burn. Falls through on any failure.
    if (supadataEnabled) {
      await assertUnderDailyCap()
      transcript = await supadataTranscript(meta.id)
      if (transcript) {
        source = 'supadata'
        log.info(`Transcript via Supadata: ${meta.id}`)
        await recordSupadataUsage({ seconds: meta.durationSeconds ?? undefined, videoId: meta.id })
      }
    }
    // Tier 1+2: yt-dlp audio -> ffmpeg -> Groq -> OpenAI. Throws TranscriptRateLimited
    // on a quota throttle (recoverable, handled upstream); null = no usable transcript.
    if (!transcript) {
      transcript = await getTranscript(data)
      if (transcript) source = 'audio'
    }
    if (!transcript) throw new NoTranscriptYet('no transcript produced')
    await saveTranscript(video.video_id, transcript, source)
  }

  // --- ①②③ are pure functions of the transcript: compute once per video, cache, reuse ---
  // On-demand (force) recomputes + overwrites; the scheduled path reuses the cache.
  let extract: ExtractResult
  let grade: GradeResult | null = null
  const cachedDigest = opts.force ? null : await getVideoDigest(video.video_id)
  if (cachedDigest) {
    extract = cachedDigest.extract
    grade = cachedDigest.grade
    log.info(`Reusing cached ①②③ digest for ${video.video_id}`)
    // Backfill ③ if it was cached without a grade (grader off/failed earlier) and the
    // grader is now available — stops a grader-off→on flip from stranding section ③.
    if (grade === null && graderConfigured) {
      try {
        grade = await gradeIdeas({ title, extract })
        await updateVideoDigestGrade(video.video_id, grade, config.GRADER_MODEL)
        log.info(`Backfilled section ③ grade for ${video.video_id}`)
      } catch (e) {
        if (e instanceof DailySpendCapExceeded) throw e
        log.warn('grade backfill failed; delivering without grade', String(e))
      }
    }
  } else {
    extract = await extractInsights({ title, channel: meta.channel, transcript })
    if (graderConfigured) {
      try {
        grade = await gradeIdeas({ title, extract })
      } catch (e) {
        if (e instanceof DailySpendCapExceeded) throw e // pause cleanly, don't degrade
        log.warn('grader failed; delivering without grade', String(e))
      }
    }
    await saveVideoDigest(
      video.video_id,
      { extract, grade, extractModel, graderModel: graderConfigured ? config.GRADER_MODEL : null },
      { overwrite: opts.force },
    )
  }

  // --- Phase 2 fan-out (Stage A → Stage B hand-off) --------------------------------
  // The shared ①②③ are cached; enqueue one user_deliveries row per eligible
  // subscriber. Runs on the FORCE path too — otherwise an owner /fetch of a fresh
  // upload would mark it done and permanently starve subscribers of it. Back-catalog
  // blast protection lives inside fanOutVideo: null published_at never fans out, the
  // per-sub `since` watermark excludes older videos, per-sub min-duration is
  // re-checked in SQL, and unique(user_id, video_id) makes re-runs no-ops.
  if (video.channel_id) {
    const fanned = await fanOutVideo({
      videoId: video.video_id,
      channelId: video.channel_id,
      publishedAt: video.published_at,
      durationSeconds: dur,
      globalMinMinutes: globalMin,
    })
    if (fanned > 0) log.info(`Fanned out ${video.video_id} to ${fanned} subscriber(s)`)
  }

  // --- owner inline delivery (the legacy path, unchanged semantics) ----------------
  // Fires when the owner follows the channel (or explicitly requested the video) and
  // the video clears THEIR threshold — a video kept alive only by a subscriber's
  // lower threshold must not land in the owner's chat.
  const ownerWants = opts.force || (ownerFollows && (dur == null || dur >= globalMin * 60))
  if (ownerWants) {
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
        cachedDigest?.extractModel ?? extractModel,
        cachedDigest?.graderModel ?? (graderConfigured ? config.GRADER_MODEL : null),
      ],
    )

    await deliver(html, video.id)
  }
  return { kind: 'delivered' }
}
