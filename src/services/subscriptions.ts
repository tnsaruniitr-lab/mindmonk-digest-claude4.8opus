import { one, query } from '../db/db'
import { config } from '../config'
import { addChannel, catalogChannel } from './channels'
import type { ChannelRow } from '../types'
import type { User } from './auth'

// Per-user channel subscriptions (spec §3): channels stay a shared catalog;
// who-follows-what lives here. Phase 2 wires the poller + pipeline fan-out to
// these rows: a linked, active, non-owner user's active subscription makes its
// channel pollable and receives per-user deliveries (user_deliveries).

const MAX_CHANNELS_PER_USER = 10

// The recurring eligibility legs for fan-out-driving subscriptions: the user is
// active (not paused via Telegram 403) and their subscription is live. A linked
// Telegram is NOT required — digests render into user_deliveries and are readable
// on the web ("my digests"); linking just adds Telegram delivery. The owner is
// excluded — they're served by the legacy inline path in process-video — and the
// exclusion is double-keyed (is_owner AND the owner's chat id) so a linked account
// that was never promoted can't double-drive polling or receive dupes.
// `ownerChatParam` is the SQL placeholder (e.g. '$1') bound to config.TELEGRAM_CHAT_ID.
const fanoutSubJoin = (ownerChatParam: string) => `
  from subscriptions s
  join users u                on u.id = s.user_id
  left join telegram_links tl on tl.user_id = s.user_id
 where s.active and u.status = 'active' and not u.is_owner
   and (tl.chat_id is null or tl.chat_id <> ${ownerChatParam})`

export interface SubscriptionRow {
  id: string
  channel_id: string
  title: string | null
  handle: string | null
  url: string | null
  active: boolean
  min_duration_minutes: number | null
  created_at: string
}

export async function subscribe(
  user: User,
  channelInput: string,
): Promise<{ ok: true; title: string; channel: ChannelRow } | { ok: false; error: string }> {
  const count = await one<{ n: number }>(
    `select count(*)::int as n from subscriptions where user_id = $1 and active = true`,
    [user.id],
  )
  if ((count?.n ?? 0) >= MAX_CHANNELS_PER_USER) {
    return { ok: false, error: `channel limit reached (${MAX_CHANNELS_PER_USER})` }
  }
  // Owner's web adds behave exactly like /add (active → polled + delivered to owner).
  // Non-owner adds are catalog-only + inert until Phase 2's per-user delivery, so they
  // can't enroll a channel into the owner's feed/spend (the critical Phase-1 leak).
  const ch = user.is_owner ? await addChannel(channelInput) : await catalogChannel(channelInput)
  // Reactivating a previously-unsubscribed row resets its `since` watermark to now()
  // — otherwise the re-subscriber would be fanned the entire gap backlog.
  await query(
    `insert into subscriptions(user_id, channel_id) values($1, $2)
     on conflict(user_id, channel_id) do update
       set active = true,
           since = case when subscriptions.active then subscriptions.since else now() end`,
    [user.id, ch.id],
  )
  return { ok: true, title: ch.title ?? ch.handle ?? ch.youtube_channel_id, channel: ch }
}

export async function listSubscriptions(userId: string): Promise<SubscriptionRow[]> {
  return query<SubscriptionRow>(
    `select s.id, s.channel_id, c.title, c.handle, c.url, s.active, s.min_duration_minutes, s.created_at::text
     from subscriptions s join channels c on c.id = s.channel_id
     where s.user_id = $1 and s.active = true
     order by s.created_at asc`,
    [userId],
  )
}

/** Deactivate one of the user's own subscriptions (catalog row untouched). */
export async function unsubscribe(userId: string, subscriptionId: string): Promise<boolean> {
  const rows = await query(
    `update subscriptions set active = false where id = $1 and user_id = $2 returning id`,
    [subscriptionId, userId],
  )
  return rows.length > 0
}

// ----- Phase 2: what the poller + Stage A need to know about subscribers --------

/** A channel the poller should track, with the earliest watermark it must honor:
 *  the owner's (channel.created_at, when channels.active) and/or the earliest
 *  active subscriber's `since`. LEAST() ignores NULLs in Postgres. */
export type PollableChannel = ChannelRow & { poll_since: string }

/** Channels to poll = the owner's active set PLUS any catalog channel with at least
 *  one fan-out-eligible subscription (linked, active, non-owner user). */
export async function listPollableChannels(): Promise<PollableChannel[]> {
  return query<PollableChannel>(
    `select c.*,
            least(case when c.active then c.created_at end, sw.min_since)::text as poll_since
       from channels c
       left join lateral (
         select min(s.since) as min_since
           ${fanoutSubJoin('$1')} and s.channel_id = c.id
       ) sw on true
      where c.active = true or sw.min_since is not null
      order by c.created_at asc`,
    [config.TELEGRAM_CHAT_ID],
  )
}

/** The most permissive min-duration (minutes) any fan-out-eligible subscriber of the
 *  channel would accept (per-sub override, else the global default). Null = none. */
export async function minSubscriberDurationMinutes(
  channelId: string,
  globalMinMinutes: number,
): Promise<number | null> {
  const row = await one<{ m: number | null }>(
    `select min(coalesce(s.min_duration_minutes, $2))::int as m
       ${fanoutSubJoin('$3')} and s.channel_id = $1`,
    [channelId, globalMinMinutes, config.TELEGRAM_CHAT_ID],
  )
  return row?.m ?? null
}
