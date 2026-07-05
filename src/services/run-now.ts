import { claimById, enqueueVideo, getVideoByVideoId, resetVideo, setVideoStatus } from './videos'
import { NoTranscriptYet, processVideo } from '../pipeline/process-video'
import { TranscriptRateLimited } from '../youtube/ytdlp'
import { DailySpendCapExceeded } from '../cost/ledger'
import { scrub } from '../util/logger'
import type { VideoRow } from '../types'

// Shared "digest this one video right now" used by BOTH the Telegram /fetch
// command and the dashboard test console — one code path, two front doors.
// The long-form filter is bypassed (force): explicitly requested = any length.
//
// Split into prepare (sync: enqueue + reset + atomic claim, so the video is
// visibly 'processing' before the caller returns) and execute (the long part),
// so the HTTP endpoint can respond immediately and let the client poll without
// racing a stale 'done' status from a previous run.

export type PrepareResult =
  | { kind: 'claimed'; video: VideoRow }
  | { kind: 'no_record' }
  | { kind: 'already_processing' }

export type ExecuteResult =
  | { kind: 'delivered' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'requeued'; reason: 'rate_limited' | 'spend_cap' }
  | { kind: 'failed'; error: string; noTranscript: boolean }

export type RunNowResult = ExecuteResult | Exclude<PrepareResult, { kind: 'claimed' }>

export async function prepareVideoNow(
  videoId: string,
  meta: { channelId?: string | null; title?: string | null; publishedAt?: string | null } = {},
): Promise<PrepareResult> {
  let row = await getVideoByVideoId(videoId)
  if (!row) row = await enqueueVideo({ videoId, channelId: meta.channelId ?? null, title: meta.title ?? null, publishedAt: meta.publishedAt ?? null })
  if (!row) row = await getVideoByVideoId(videoId)
  if (!row) return { kind: 'no_record' }
  // resetVideo refuses 'processing' rows, so a video the worker (or another fetch) is
  // mid-flight on stays claimed by them — we don't steal it and double-process.
  const wasReset = await resetVideo(row.id)
  if (!wasReset) return { kind: 'already_processing' }
  const claimed = await claimById(row.id) // atomic — worker may still win the tiny gap
  if (!claimed) return { kind: 'already_processing' }
  return { kind: 'claimed', video: claimed }
}

export async function executeVideoNow(claimed: VideoRow): Promise<ExecuteResult> {
  try {
    const res = await processVideo(claimed, { force: true })
    if (res.kind === 'delivered') {
      await setVideoStatus(claimed.id, { status: 'done', markProcessed: true, is_long_form: true })
      return { kind: 'delivered' }
    }
    await setVideoStatus(claimed.id, { status: 'skipped', skip_reason: res.reason, markProcessed: true })
    return { kind: 'skipped', reason: res.reason }
  } catch (e) {
    if (e instanceof TranscriptRateLimited) {
      // The audio downloaded fine — transcription is just throttled. Leave it
      // queued (NOT failed) so the worker delivers it once the quota frees up.
      await setVideoStatus(claimed.id, { status: 'pending', skip_reason: 'rate_limited' })
      return { kind: 'requeued', reason: 'rate_limited' }
    }
    if (e instanceof DailySpendCapExceeded) {
      // Transient daily cap — re-queue (NOT failed) so the worker delivers it once the
      // cap resets; do NOT markProcessed (the worker only ever claims 'pending').
      await setVideoStatus(claimed.id, { status: 'pending', skip_reason: 'spend_cap' })
      return { kind: 'requeued', reason: 'spend_cap' }
    }
    await setVideoStatus(claimed.id, { status: 'failed', skip_reason: scrub(String(e)).slice(0, 200), markProcessed: true })
    return { kind: 'failed', error: scrub(String(e)).slice(0, 300), noTranscript: e instanceof NoTranscriptYet }
  }
}

/** Prepare + execute in one call (the Telegram path — replies after completion). */
export async function runVideoNow(
  videoId: string,
  meta: { channelId?: string | null; title?: string | null; publishedAt?: string | null } = {},
): Promise<RunNowResult> {
  const prep = await prepareVideoNow(videoId, meta)
  if (prep.kind !== 'claimed') return prep
  return executeVideoNow(prep.video)
}
