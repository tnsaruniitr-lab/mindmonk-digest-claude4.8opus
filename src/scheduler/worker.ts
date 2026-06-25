import type { VideoRow } from '../types'
import { claimNextPending, reapStale, setVideoStatus } from '../services/videos'
import { NoTranscriptYet, processVideo } from '../pipeline/process-video'
import { log } from '../util/logger'

const PER_TICK = 4
const MAX_ATTEMPTS_PROCESS = 6 // hard failures (network/model) before giving up
const MAX_ATTEMPTS_TRANSCRIPT = 20 // ~retry window for lagging auto-captions
const STALE_MINUTES = 15 // requeue videos stuck in 'processing' this long

let running = false

/** Drain up to PER_TICK pending videos. Guarded against overlapping ticks. */
export async function runWorker(): Promise<void> {
  if (running) return
  running = true
  try {
    const reaped = await reapStale(STALE_MINUTES)
    if (reaped) log.warn(`Requeued ${reaped} video(s) stuck in 'processing'`)

    for (let i = 0; i < PER_TICK; i++) {
      const v = await claimNextPending()
      if (!v) break
      await processOne(v)
    }
  } finally {
    running = false
  }
}

/** Process a single (already-claimed) video and set its final status. */
export async function processOne(v: VideoRow): Promise<void> {
  try {
    const res = await processVideo(v)
    if (res.kind === 'delivered') {
      await setVideoStatus(v.id, { status: 'done', markProcessed: true, is_long_form: true })
      log.info(`Delivered digest: ${v.title ?? v.video_id}`)
    } else {
      await setVideoStatus(v.id, {
        status: 'skipped',
        skip_reason: res.reason,
        markProcessed: true,
        is_long_form: false,
      })
      log.info(`Skipped ${v.video_id}: ${res.reason}`)
    }
  } catch (err) {
    if (err instanceof NoTranscriptYet) {
      // Transcript-wait retries use their OWN counter, separate from hard failures.
      if (v.transcript_attempts + 1 >= MAX_ATTEMPTS_TRANSCRIPT) {
        await setVideoStatus(v.id, {
          status: 'no_transcript',
          skip_reason: 'no captions available',
          markProcessed: true,
          incTranscriptAttempts: true,
        })
        log.warn(`Gave up waiting for captions: ${v.video_id}`)
      } else {
        await setVideoStatus(v.id, {
          status: 'pending',
          skip_reason: 'awaiting_captions',
          incTranscriptAttempts: true,
        })
      }
    } else if (v.attempts + 1 >= MAX_ATTEMPTS_PROCESS) {
      await setVideoStatus(v.id, {
        status: 'failed',
        skip_reason: String(err).slice(0, 300),
        markProcessed: true,
        incAttempts: true,
      })
      log.error(`Failed permanently: ${v.video_id}`, String(err))
    } else {
      await setVideoStatus(v.id, { status: 'pending', incAttempts: true })
      log.warn(`Error on ${v.video_id}; will retry`, String(err))
    }
  }
}
