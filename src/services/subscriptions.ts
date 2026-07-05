import { one, query } from '../db/db'
import { addChannel, catalogChannel } from './channels'
import type { User } from './auth'

// Per-user channel subscriptions (spec §3): channels stay a shared catalog;
// who-follows-what lives here. Phase 1 = management only; Phase 2 wires the
// poller/pipeline fan-out to these rows.

const MAX_CHANNELS_PER_USER = 10

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

export async function subscribe(user: User, channelInput: string): Promise<{ ok: true; title: string } | { ok: false; error: string }> {
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
  await query(
    `insert into subscriptions(user_id, channel_id) values($1, $2)
     on conflict(user_id, channel_id) do update set active = true`,
    [user.id, ch.id],
  )
  return { ok: true, title: ch.title ?? ch.handle ?? ch.youtube_channel_id }
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
