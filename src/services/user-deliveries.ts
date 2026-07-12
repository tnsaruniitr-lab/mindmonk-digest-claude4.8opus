// Per-user delivery queue — Stage B of the two-stage fan-out (spec §8).
// Stage A computes the shared ①②③ once per video (video_digests); fanOutVideo()
// then enqueues one delivery per eligible subscriber; the delivery worker claims
// each, personalizes ④ against THAT user's profile, renders, and delivers to their
// linked Telegram chat. Mirrors the race-safe videos queue (FOR UPDATE SKIP LOCKED).

import { one, query } from '../db/db'
import { config } from '../config'
import type { UserDeliveryRow } from '../types'

/**
 * Enqueue one pending delivery per eligible subscriber of the channel. Eligible =
 * active subscription of an active, non-owner user with a LINKED Telegram chat,
 * whose per-sub watermark (`since`) and min-duration accept this video.
 * - A linked Telegram is NOT required: the rendered digest is readable on the web,
 *   and Stage B skips only the Telegram send for unlinked users (after rendering).
 * - The owner is excluded: they're served by the legacy inline path in process-video.
 *   That exclusion is DOUBLE-keyed — is_owner AND the owner's chat id — so a linked
 *   web account that was never promoted (OWNER_EMAIL unset/mismatched) can't receive
 *   a second copy of what the inline path already sent to TELEGRAM_CHAT_ID.
 * - Videos without a published_at never fan out (only on-demand rows lack it — an
 *   on-demand fetch must not blast subscribers with back-catalog).
 * - Unknown duration is included (matches the shared pipeline's fail-open filter).
 * Idempotent via unique(user_id, video_id); returns the number of NEW rows.
 */
export async function fanOutVideo(input: {
  videoId: string
  channelId: string
  publishedAt: string | null
  durationSeconds: number | null
  globalMinMinutes: number
}): Promise<number> {
  if (!input.publishedAt) return 0
  const rows = await query<{ id: string }>(
    `insert into user_deliveries(user_id, video_id)
       select s.user_id, $1
         from subscriptions s
         join users u                on u.id = s.user_id
         left join telegram_links tl on tl.user_id = s.user_id
        where s.channel_id = $2 and s.active
          and u.status = 'active' and not u.is_owner
          and (tl.chat_id is null or tl.chat_id <> $6)
          and $3::timestamptz > s.since
          and ($4::int is null or $4 >= coalesce(s.min_duration_minutes, $5) * 60)
     on conflict(user_id, video_id) do nothing
     returning id`,
    [
      input.videoId,
      input.channelId,
      input.publishedAt,
      input.durationSeconds,
      input.globalMinMinutes,
      config.TELEGRAM_CHAT_ID,
    ],
  )
  return rows.length
}

/** Enqueue a single delivery for ONE user, bypassing the since watermark — used to
 *  sample a channel's LATEST episode right after they subscribe, so the click
 *  produces a visible result instead of "wait for the next upload". Idempotent;
 *  true iff a NEW row was created. */
export async function enqueueDelivery(userId: string, videoId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `insert into user_deliveries(user_id, video_id) values($1, $2)
     on conflict(user_id, video_id) do nothing returning id`,
    [userId, videoId],
  )
  return rows.length > 0
}

/** Re-open a terminally skipped/failed delivery (explicit re-subscribe = the user
 *  asking again). Fresh attempt budget; pending rows are left untouched. */
export async function reviveDelivery(userId: string, videoId: string): Promise<void> {
  await query(
    `update user_deliveries
        set status = 'pending', run_after = now(), claimed_at = null,
            skip_reason = null, error = null, attempts = 0
      where user_id = $1 and video_id = $2 and status in ('skipped', 'failed')`,
    [userId, videoId],
  )
}

/** Atomically claim the next due delivery (FOR UPDATE SKIP LOCKED — race-safe). */
export async function claimNextDelivery(): Promise<UserDeliveryRow | null> {
  return one<UserDeliveryRow>(
    `update user_deliveries set status = 'processing', claimed_at = now()
       where id = (
         select id from user_deliveries
          where status = 'pending' and run_after <= now()
          order by run_after asc limit 1
          for update skip locked
       )
       returning *`,
  )
}

/** Persist the per-user ④ + rendered html BEFORE the send, so any retry re-sends the
 *  SAME content (never re-paying ④, never re-chunking differently). */
export async function saveDeliveryRender(id: string, tailored: unknown, rendered: string): Promise<void> {
  await query(`update user_deliveries set tailored = $2, rendered = $3 where id = $1`, [
    id,
    JSON.stringify(tailored),
    rendered,
  ])
}

/** Persist the chunk ids already delivered mid-send, so deliverToChat resumes past them.
 *  Status is left for the caller to requeue. */
export async function saveDeliveryProgress(id: string, messageIds: number[]): Promise<void> {
  await query(`update user_deliveries set message_ids = $2 where id = $1`, [id, JSON.stringify(messageIds)])
}

export async function markDeliveryDone(id: string, messageIds: number[]): Promise<void> {
  await query(
    `update user_deliveries set status = 'delivered', message_ids = $2, delivered_at = now() where id = $1`,
    [id, JSON.stringify(messageIds)],
  )
}

export async function markDeliveryFailed(id: string, error: string): Promise<void> {
  await query(
    `update user_deliveries set status = 'failed', error = $2, attempts = attempts + 1 where id = $1`,
    [id, error],
  )
}

export async function markDeliverySkipped(id: string, reason: string): Promise<void> {
  await query(`update user_deliveries set status = 'skipped', skip_reason = $2 where id = $1`, [id, reason])
}

/** Return a claimed delivery to the queue (spend-cap pause / Stage-A-not-ready).
 *  No attempt bump — these stalls must never burn the retry budget. */
export async function requeueDelivery(id: string, delaySeconds = 0): Promise<void> {
  await query(
    `update user_deliveries set status = 'pending', claimed_at = null,
            run_after = now() + make_interval(secs => $2) where id = $1`,
    [id, delaySeconds],
  )
}

/** Requeue after a transient delivery error, WITH an attempt bump + backoff. */
export async function requeueDeliveryWithAttempt(id: string, delaySeconds: number): Promise<void> {
  await query(
    `update user_deliveries set status = 'pending', claimed_at = null, attempts = attempts + 1,
            run_after = now() + make_interval(secs => $2) where id = $1`,
    [id, delaySeconds],
  )
}

/** Requeue deliveries stranded in 'processing' (a worker crashed mid-delivery). */
export async function reapStaleDeliveries(minutes: number): Promise<number> {
  const rows = await query<{ id: string }>(
    `update user_deliveries set status = 'pending', claimed_at = null
      where status = 'processing' and claimed_at < now() - make_interval(mins => $1)
      returning id`,
    [minutes],
  )
  return rows.length
}

/** Count pending per-user deliveries — a queue-depth signal for /status and ops. */
export async function pendingDeliveryCount(): Promise<number> {
  const row = await one<{ n: number }>(`select count(*)::int as n from user_deliveries where status = 'pending'`)
  return row?.n ?? 0
}

/** Telegram said 403 — the user blocked the bot. Stop delivering to them. */
export async function pauseUser(userId: string): Promise<void> {
  await query(`update users set status = 'paused' where id = $1`, [userId])
}

/** Recovery path for pauseUser: called when the user re-links Telegram or sends
 *  /start again (they unblocked the bot) — deliveries resume. */
export async function unpauseUser(userId: string): Promise<void> {
  await query(`update users set status = 'active' where id = $1 and status = 'paused'`, [userId])
}

// ----- Session-scoped reads for the web console ("my digests") ------------------

export interface DeliveryListItem {
  id: string
  status: string
  title: string | null
  url: string | null
  has_render: boolean // rendered digest exists → the web viewer can show it
  video_status: string | null // shared Stage-A state: pending|processing|done|skipped|failed|no_transcript
  video_skip_reason: string | null
  skip_reason: string | null // this delivery's own skip reason (e.g. telegram not linked)
  error: string | null
  created_at: string
  delivered_at: string | null
}

/** Newest-first digests for ONE user, with enough funnel state for the UI to show
 *  live progress (IDOR guard: always filtered by user_id). */
export async function listDeliveries(userId: string, limit = 20): Promise<DeliveryListItem[]> {
  return query<DeliveryListItem>(
    `select ud.id, ud.status, v.title, v.url, (ud.rendered is not null) as has_render,
            v.status as video_status, v.skip_reason as video_skip_reason,
            ud.skip_reason, ud.error,
            ud.created_at::text, ud.delivered_at::text
       from user_deliveries ud
       left join videos v on v.video_id = ud.video_id
      where ud.user_id = $1
      order by ud.created_at desc
      limit $2`,
    [userId, limit],
  )
}

/** One rendered digest, readable ONLY by its owner (both predicates = the IDOR guard). */
export async function getDeliveryForUser(
  deliveryId: string,
  userId: string,
): Promise<{ title: string | null; rendered: string | null; created_at: string } | null> {
  return one(
    `select v.title, ud.rendered, ud.created_at::text
       from user_deliveries ud
       left join videos v on v.video_id = ud.video_id
      where ud.id = $1 and ud.user_id = $2`,
    [deliveryId, userId],
  )
}
