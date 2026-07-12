import Parser from 'rss-parser'
import type { ChannelRow } from '../types'
import { markChannelChecked } from '../services/channels'
import { listPollableChannels, type PollableChannel } from '../services/subscriptions'
import { enqueueDelivery, reviveDelivery } from '../services/user-deliveries'
import { enqueueVideo, getVideoByVideoId, resetVideo, videoExists } from '../services/videos'
import { feedUrl, parseVideoId } from '../util/youtube'
import { log } from '../util/logger'

const parser = new Parser({ timeout: 30_000 })

function itemVideoId(item: { link?: string; id?: string }): string | null {
  return parseVideoId(item.link ?? '') ?? (item.id ? item.id.split(':').pop() ?? null : null)
}

let polling = false

/** Poll every pollable channel's RSS feed and enqueue genuinely-new uploads.
 *  Pollable = the owner's active channels PLUS catalog channels with at least one
 *  fan-out-eligible subscription (Phase 2). */
export async function runPoller(): Promise<void> {
  if (polling) return // guard against overlapping cron ticks / manual /check
  polling = true
  try {
    const channels = await listPollableChannels()
    for (const ch of channels) {
      try {
        await pollChannel(ch)
      } catch (e) {
        log.error(`Poll failed for ${ch.youtube_channel_id}`, String(e))
      }
    }
  } finally {
    polling = false
  }
}

async function pollChannel(ch: PollableChannel): Promise<void> {
  const feed = await parser.parseURL(feedUrl(ch.youtube_channel_id))
  // Only treat uploads published AFTER the earliest interested party's watermark as
  // "new" — the owner's watermark is channel.created_at, a subscriber's is their
  // subscription's `since` (LEAST of the two, computed in listPollableChannels).
  // Fan-out then re-filters per subscriber, so a video enqueued because of one
  // user's watermark never leaks to another whose watermark is later.
  const since = new Date(ch.poll_since ?? ch.created_at).getTime()
  let queued = 0
  for (const item of feed.items) {
    const vid = itemVideoId(item)
    if (!vid) continue
    const pub = item.isoDate ? new Date(item.isoDate).getTime() : 0
    if (pub <= since) continue
    const row = await enqueueVideo({
      videoId: vid,
      channelId: ch.id,
      title: item.title ?? null,
      publishedAt: item.isoDate ?? null,
    })
    if (row) queued++
  }
  if (queued) log.info(`${ch.title ?? ch.youtube_channel_id}: queued ${queued} new episode(s)`)
  await markChannelChecked(ch.id)
}

/** Newest video on a channel from its RSS feed (used on /channel). */
export async function latestVideo(
  channelId: string,
): Promise<{ videoId: string; title: string | null; publishedAt: string | null } | null> {
  const feed = await parser.parseURL(feedUrl(channelId))
  for (const item of feed.items) {
    const vid = itemVideoId(item)
    if (vid) return { videoId: vid, title: item.title ?? null, publishedAt: item.isoDate ?? null }
  }
  return null
}

/** Sample a channel's LATEST episode for a fresh subscriber: enqueue the video for
 *  Stage A (no-op if it's already known/digested) and, for non-owners, a delivery
 *  row that bypasses the since watermark — so subscribing produces a visible digest
 *  instead of "wait for the next upload". The owner is served by the inline path.
 *  Fire-and-forget from the subscribe handler; failures only cost the sample. */
export async function sampleLatestForSubscriber(
  userId: string,
  isOwner: boolean,
  ch: ChannelRow,
): Promise<void> {
  const latest = await latestVideo(ch.youtube_channel_id)
  if (!latest) return
  await enqueueVideo({
    videoId: latest.videoId,
    channelId: ch.id,
    title: latest.title,
    publishedAt: latest.publishedAt,
  })
  // A re-subscribe is an explicit "try again": revive a video that previously ended
  // terminal (e.g. skipped no_subscribers before this user counted, or a transcript
  // that wasn't available yet) so the sample actually reprocesses.
  const existing = await getVideoByVideoId(latest.videoId)
  if (existing && ['skipped', 'failed', 'no_transcript'].includes(existing.status)) {
    await resetVideo(existing.id)
  }
  if (!isOwner) {
    const fresh = await enqueueDelivery(userId, latest.videoId)
    if (!fresh) await reviveDelivery(userId, latest.videoId)
  }
  log.info(`Sample queued for new subscriber: ${latest.videoId} (${ch.title ?? ch.youtube_channel_id})`)
}

/** Queue the latest N items from a channel regardless of age (used on /add). */
export async function backfillLatest(ch: ChannelRow, count = 1): Promise<number> {
  const feed = await parser.parseURL(feedUrl(ch.youtube_channel_id))
  let n = 0
  for (const item of feed.items.slice(0, count)) {
    const vid = itemVideoId(item)
    if (!vid) continue
    if (await videoExists(vid)) continue
    await enqueueVideo({
      videoId: vid,
      channelId: ch.id,
      title: item.title ?? null,
      publishedAt: item.isoDate ?? null,
    })
    n++
  }
  return n
}
