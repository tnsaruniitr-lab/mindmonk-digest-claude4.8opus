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
