import { one, query } from '../db/db'
import type { ChannelRow } from '../types'
import { resolveChannel } from '../util/youtube'

export async function addChannel(input: string): Promise<ChannelRow> {
  const r = await resolveChannel(input)
  const row = await one<ChannelRow>(
    `insert into channels(youtube_channel_id, title, handle, url, active)
     values($1, $2, $3, $4, true)
     on conflict(youtube_channel_id) do update
       set title = excluded.title, handle = excluded.handle, url = excluded.url, active = true
     returning *`,
    [r.channelId, r.title, r.handle, r.url],
  )
  return row as ChannelRow
}

/**
 * Catalog-only channel resolution for NON-owner subscriptions (Phase 1): ensure a
 * catalog row exists but NEVER flip `channels.active`. `active` still means "the
 * owner's poller tracks this"; a non-owner subscribing must not enroll a channel
 * into the owner's global feed/spend (that's Phase 2's per-user fan-out). New rows
 * land inert (active=false); existing rows are left exactly as they are.
 */
export async function catalogChannel(input: string): Promise<ChannelRow> {
  const r = await resolveChannel(input)
  let row = await one<ChannelRow>(
    `insert into channels(youtube_channel_id, title, handle, url, active)
     values($1, $2, $3, $4, false)
     on conflict(youtube_channel_id) do nothing
     returning *`,
    [r.channelId, r.title, r.handle, r.url],
  )
  if (!row) row = await one<ChannelRow>('select * from channels where youtube_channel_id = $1', [r.channelId])
  return row as ChannelRow
}

export async function listChannels(activeOnly = true): Promise<ChannelRow[]> {
  return activeOnly
    ? query<ChannelRow>('select * from channels where active = true order by created_at asc')
    : query<ChannelRow>('select * from channels order by created_at asc')
}

/** Soft-delete by youtube_channel_id, handle, or a title fragment. */
export async function removeChannel(needle: string): Promise<ChannelRow | null> {
  const channels = await listChannels(true)
  const n = needle.trim().toLowerCase()
  const match = channels.find(
    (c) =>
      c.youtube_channel_id.toLowerCase() === n ||
      (c.handle ?? '').toLowerCase() === n ||
      (c.handle ?? '').toLowerCase() === `@${n}` ||
      (c.title ?? '').toLowerCase().includes(n),
  )
  if (!match) return null
  await query('update channels set active = false where id = $1', [match.id])
  return match
}

export async function markChannelChecked(id: string): Promise<void> {
  await query('update channels set last_checked_at = now() where id = $1', [id])
}

/** Does the OWNER follow this channel? (`channels.active` keeps its legacy meaning:
 *  "in the owner's polled set"; subscriber interest lives on subscriptions.) */
export async function channelIsActive(id: string): Promise<boolean> {
  const row = await one<{ active: boolean }>('select active from channels where id = $1', [id])
  return row?.active ?? false
}
