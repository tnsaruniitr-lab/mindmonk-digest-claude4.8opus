// Stage B of the two-stage fan-out (spec §8). Drains user_deliveries: for each
// pending delivery, personalize section ④ against THAT user's profile, render, and
// deliver to their linked Telegram chat. Sections ①②③ come from the shared
// video_digests cache (computed once in Stage A), so per-user cost is just one
// cheap personalize call.
import { one } from '../db/db'
import {
  claimNextDelivery,
  markDeliveryDone,
  markDeliveryFailed,
  markDeliverySkipped,
  pauseUser,
  reapStaleDeliveries,
  requeueDelivery,
  requeueDeliveryWithAttempt,
  saveDeliveryProgress,
  saveDeliveryRender,
} from '../services/user-deliveries'
import { getVideoDigest } from '../services/video-digests'
import { getVideoByVideoId } from '../services/videos'
import { personalize } from '../pipeline/personalize'
import { renderDigest } from '../pipeline/render'
import { deliverToChat, PartialDeliveryError } from '../services/delivery'
import { UserBlockedError } from '../services/telegram-rate'
import { assertUnderDailyCap, DailySpendCapExceeded } from '../cost/ledger'
import { log, scrub } from '../util/logger'
import type { UserDeliveryRow } from '../types'

// Drain hard per tick — the Telegram rate limiter (telegram-rate) paces the actual
// sends to ~25/s global · ~1/s per chat, so this just keeps the queue moving.
const MAX_PER_TICK = 500
// A delivery whose send keeps throwing is retried with exponential backoff up to this
// many times, then marked failed (terminal) so it stops consuming the worker.
const MAX_DELIVERY_ATTEMPTS = 6
// A delivery claimed but never finished (worker crash / redeploy mid-send) is returned
// to 'pending' once it's been 'processing' this long.
const STALE_PROCESSING_MIN = 15
// If Stage A's digest still isn't visible this long after the delivery was enqueued
// (defensive — fan-out normally runs AFTER the digest is cached), give up.
const STAGE_A_DEADLINE_MS = 2 * 60 * 60 * 1000

let running = false

/** Drain pending per-user deliveries (paced by the rate limiter). */
export async function runDeliveryWorker(): Promise<void> {
  if (running) return
  running = true
  try {
    // Rescue deliveries stranded in 'processing' by a crash before claiming new ones.
    const reaped = await reapStaleDeliveries(STALE_PROCESSING_MIN)
    if (reaped > 0) log.warn(`Reaped ${reaped} stale 'processing' deliveries back to pending`)
    for (let i = 0; i < MAX_PER_TICK; i++) {
      const d = await claimNextDelivery()
      if (!d) break
      if ((await deliverOne(d)) === 'paused') break
    }
  } finally {
    running = false
  }
}

interface DeliveryUser {
  id: string
  status: string
  chat_id: string | null
  profile_text: string
}

/** The user + their linked chat + their profile, in one read. */
async function deliveryUser(userId: string): Promise<DeliveryUser | null> {
  return one<DeliveryUser>(
    `select u.id, u.status, tl.chat_id, coalesce(up.profile_text, '') as profile_text
       from users u
       left join telegram_links tl on tl.user_id = u.id
       left join user_profiles up on up.user_id = u.id
      where u.id = $1`,
    [userId],
  )
}

async function deliverOne(d: UserDeliveryRow): Promise<'paused' | void> {
  // Hoisted so the catch can persist progress if a multi-chunk send fails partway.
  let html = d.rendered ?? ''
  const alreadySent = Array.isArray(d.message_ids) ? (d.message_ids as number[]) : []
  try {
    const user = await deliveryUser(d.user_id)
    if (!user) {
      await markDeliveryFailed(d.id, 'user no longer exists')
      return
    }
    if (user.status === 'paused') {
      await markDeliverySkipped(d.id, 'user paused')
      return
    }

    if (!html) {
      // First attempt: personalize ④ from the shared Stage-A digest. This is the only LLM
      // spend in Stage B — cap-check before it. A retry reuses the persisted render (below),
      // so it neither re-pays ④ nor risks a different chunking.
      await assertUnderDailyCap()
      const [digest, video] = await Promise.all([getVideoDigest(d.video_id), getVideoByVideoId(d.video_id)])
      if (!digest || !video) {
        // Shared Stage-A output not visible (should be rare — fan-out runs after the digest
        // is cached, but a force-recompute could be mid-overwrite). Back off, with a deadline.
        const ageMs = Date.now() - new Date(d.created_at).getTime()
        if (ageMs > STAGE_A_DEADLINE_MS) {
          await markDeliveryFailed(d.id, 'stage A never produced a digest (deadline exceeded)')
          log.warn(`Delivery ${d.id} for ${d.video_id} failed: no digest after ${Math.round(ageMs / 60000)}m`)
        } else {
          await requeueDelivery(d.id, 60) // no attempt bump — a Stage-A stall isn't a delivery error
        }
        return
      }
      const channelName = video.channel_id
        ? (await one<{ title: string | null }>('select title from channels where id = $1', [video.channel_id]))
            ?.title ?? null
        : null
      const personalizeRes = await personalize({
        extract: digest.extract,
        profile: user.profile_text,
        userId: d.user_id,
        videoId: d.video_id,
      })
      html = renderDigest({
        title: video.title,
        channel: channelName,
        url: video.url,
        durationSeconds: video.duration_seconds,
        extract: digest.extract,
        grade: digest.grade,
        personalize: personalizeRes,
      })
      // Persist ④ + the exact html BEFORE sending, so a crash/retry resumes with the
      // same content (and the web "my digests" view can show it).
      await saveDeliveryRender(d.id, personalizeRes, html)
    }

    if (!user.chat_id) {
      // They unlinked between fan-out and delivery. The render above is persisted, so
      // the digest IS readable on the web ("my digests") — Telegram just can't receive
      // it. Checked AFTER rendering for exactly that reason.
      await markDeliverySkipped(d.id, 'telegram not linked')
      return
    }

    // Checkpoint message ids after EVERY chunk — a crash/redeploy mid-send then
    // duplicates at most one chunk on retry instead of the whole digest, and a
    // markDeliveryDone failure retries as a no-op send.
    const messageIds = await deliverToChat(user.chat_id, html, alreadySent, (ids) =>
      saveDeliveryProgress(d.id, ids),
    )
    await markDeliveryDone(d.id, messageIds)
    log.info(`Delivered to user ${d.user_id}: ${d.video_id}${alreadySent.length ? ' (resumed)' : ''}`)
  } catch (err) {
    // A multi-chunk send failed partway: persist the chunks already delivered so the
    // retry resumes past them (never re-sending), then classify the cause.
    if (err instanceof PartialDeliveryError) {
      await saveDeliveryProgress(d.id, err.messageIds)
      err = err.cause
    }
    if (err instanceof DailySpendCapExceeded) {
      // Global cap hit — re-queue (no attempt bump) and stop this tick; the rest would
      // just hit the same cap.
      await requeueDelivery(d.id)
      log.warn(`Daily spend cap hit; re-queued delivery ${d.id} (no attempt bump)`)
      return 'paused'
    }
    if (err instanceof UserBlockedError) {
      // User blocked the bot — pause them so we stop trying, and skip this delivery.
      await pauseUser(d.user_id)
      await markDeliverySkipped(d.id, 'user blocked the bot; paused')
      log.warn(`User ${d.user_id} blocked the bot — paused`)
      return
    }
    // Transient send/personalize error (Telegram 5xx, sustained 429, LLM blip): retry with
    // exponential backoff instead of failing terminally. Only give up after the attempt cap.
    const reason = scrub(String(err)).slice(0, 300)
    if (d.attempts + 1 >= MAX_DELIVERY_ATTEMPTS) {
      await markDeliveryFailed(d.id, reason)
      log.error(`Delivery failed permanently (${d.attempts + 1} attempts) for ${d.video_id} → user ${d.user_id}`, reason)
    } else {
      const backoffSec = Math.min(30 * 2 ** d.attempts, 1800) // 30s,60s,120s… capped at 30m
      await requeueDeliveryWithAttempt(d.id, backoffSec)
      log.warn(`Delivery error for ${d.video_id} → user ${d.user_id} (attempt ${d.attempts + 1}); retry in ${backoffSec}s: ${reason}`)
    }
  }
}
