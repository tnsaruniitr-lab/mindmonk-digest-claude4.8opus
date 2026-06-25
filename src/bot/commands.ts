import { Context } from 'telegraf'
import { bot } from './bot'
import { config, graderConfigured } from '../config'
import { addChannel, listChannels, removeChannel } from '../services/channels'
import { getProfile, setProfile } from '../services/profile'
import { getMinDurationMinutes, setSetting } from '../services/settings'
import { claimById, enqueueVideo, getVideoByVideoId, resetVideo, setVideoStatus, statusCounts } from '../services/videos'
import { backfillLatest, latestVideo, runPoller } from '../scheduler/poller'
import { NoTranscriptYet, processVideo } from '../pipeline/process-video'
import { parseVideoId, resolveChannel } from '../util/youtube'

/** Everything after the first space of a command message. */
function arg(text: string | undefined): string {
  if (!text) return ''
  const sp = text.indexOf(' ')
  return sp === -1 ? '' : text.slice(sp + 1).trim()
}

/**
 * Summarize one video on demand and deliver its digest. The long-form filter
 * is bypassed (force) — if you explicitly ask for a video, you get it, any length.
 */
async function runVideoNow(
  ctx: Context,
  videoId: string,
  meta: { channelId?: string | null; title?: string | null; publishedAt?: string | null } = {},
): Promise<void> {
  let row = await getVideoByVideoId(videoId)
  if (!row) row = await enqueueVideo({ videoId, channelId: meta.channelId ?? null, title: meta.title ?? null, publishedAt: meta.publishedAt ?? null })
  if (!row) row = await getVideoByVideoId(videoId)
  if (!row) {
    await ctx.reply('Could not create the video record.')
    return
  }
  await resetVideo(row.id)
  const claimed = await claimById(row.id) // atomic — won't race the worker
  if (!claimed) {
    await ctx.reply('That video is already being processed — hang tight.')
    return
  }
  try {
    const res = await processVideo(claimed, { force: true })
    if (res.kind === 'delivered') {
      await setVideoStatus(row.id, { status: 'done', markProcessed: true, is_long_form: true })
    } else {
      await setVideoStatus(row.id, { status: 'skipped', skip_reason: res.reason, markProcessed: true })
      await ctx.reply(`Skipped (${res.reason}).`)
    }
  } catch (e) {
    await setVideoStatus(row.id, { status: 'failed', skip_reason: String(e).slice(0, 200), markProcessed: true })
    if (e instanceof NoTranscriptYet) {
      await ctx.reply('No captions/transcript are available for that video, so I can’t summarize it.')
    } else {
      await ctx.reply('Error: ' + String(e).slice(0, 300))
    }
  }
}

const HELP = `🎙️ <b>Podcast Digest Bot</b>

I watch your favourite YouTube channels and, when they publish a new long-form episode, send you a 4-section digest:
① Key insights
② Patterns &amp; antipatterns
③ Unbiased grade (by a separate LLM)
④ Tailored to your profile

<b>Commands</b>
/add &lt;url | @handle | UC…id&gt; — track a channel
/channels — list tracked channels
/remove &lt;handle | id | title&gt; — stop tracking
/profile — show the profile used for section ④
/setprofile &lt;text&gt; — update your profile
/minduration &lt;minutes&gt; — long-form threshold (now ${'{min}'})
/fetch &lt;video url&gt; — summarize any video right now (any length)
/channel &lt;channel url&gt; — summarize a channel's latest video
/check — check all channels for new episodes now
/status — counts &amp; config
/grader — grader configuration`

bot.start((ctx) => ctx.reply('👋 Ready. Add a channel with /add <url>, then /help for everything.'))

bot.help(async (ctx) => {
  const min = await getMinDurationMinutes()
  await ctx.reply(HELP.replace('{min}', `${min}m`), { parse_mode: 'HTML' })
})

bot.command('add', async (ctx) => {
  const a = arg(ctx.message?.text)
  if (!a) return ctx.reply('Usage: /add <channel url, @handle, or UC… id>')
  try {
    const ch = await addChannel(a)
    let note = ''
    if (config.BACKFILL_ON_ADD) {
      const n = await backfillLatest(ch, 1)
      note = n > 0 ? ' Queued its latest episode as a sample — digest coming shortly.' : ''
    }
    await ctx.reply(
      `✅ Added: ${ch.title ?? ch.handle ?? ch.youtube_channel_id}.${note}\nYou'll get a digest whenever it publishes a new long-form episode.`,
    )
  } catch (e) {
    await ctx.reply('Could not add that channel: ' + String(e).slice(0, 300))
  }
})

bot.command('channels', async (ctx) => {
  const chs = await listChannels(true)
  if (!chs.length) return ctx.reply('No channels yet. Add one with /add <url>.')
  const text = chs.map((c, i) => `${i + 1}. ${c.title ?? c.handle ?? c.youtube_channel_id}`).join('\n')
  await ctx.reply('📺 Tracked channels:\n' + text)
})

bot.command('remove', async (ctx) => {
  const a = arg(ctx.message?.text)
  if (!a) return ctx.reply('Usage: /remove <handle, UC… id, or title fragment>')
  const removed = await removeChannel(a)
  await ctx.reply(removed ? `🗑️ Removed ${removed.title ?? removed.youtube_channel_id}.` : 'No matching channel found.')
})

bot.command('profile', async (ctx) => {
  const p = await getProfile()
  await ctx.reply('🧭 Profile used for section ④:\n\n' + (p || '(empty)'))
})

bot.command('setprofile', async (ctx) => {
  const a = arg(ctx.message?.text)
  if (!a) return ctx.reply('Usage: /setprofile <text about you, your goals, and what to prioritise>')
  await setProfile(a)
  await ctx.reply('✅ Profile updated.')
})

bot.command('minduration', async (ctx) => {
  const a = arg(ctx.message?.text)
  if (!a) {
    const m = await getMinDurationMinutes()
    return ctx.reply(`Long-form threshold is ${m} minutes. Change with /minduration <minutes>.`)
  }
  const n = Number(a)
  if (!Number.isFinite(n) || n <= 0) return ctx.reply('Give a positive number of minutes.')
  await setSetting('min_duration_minutes', String(Math.round(n)))
  await ctx.reply(`✅ Long-form threshold set to ${Math.round(n)} minutes.`)
})

bot.command('check', async (ctx) => {
  await ctx.reply('🔄 Checking channels for new episodes…')
  await runPoller()
  await ctx.reply('Done — any new episodes are queued and will be processed shortly.')
})

// Summarize any single video on demand. /test kept as an alias.
bot.command('fetch', async (ctx) => {
  const vid = parseVideoId(arg(ctx.message?.text))
  if (!vid) return ctx.reply('Usage: /fetch <youtube video url or 11-char id>')
  await ctx.reply('⏳ Summarizing that video now…')
  await runVideoNow(ctx, vid)
})
bot.command('test', async (ctx) => {
  const vid = parseVideoId(arg(ctx.message?.text))
  if (!vid) return ctx.reply('Usage: /test <youtube video url or 11-char id>')
  await ctx.reply('⏳ Summarizing that video now…')
  await runVideoNow(ctx, vid)
})

// Summarize the latest video on a channel (one-off — does not subscribe).
bot.command('channel', async (ctx) => {
  const a = arg(ctx.message?.text)
  if (!a) return ctx.reply('Usage: /channel <channel url, @handle, or UC… id>')
  await ctx.reply('🔎 Finding the latest video on that channel…')
  try {
    const ch = await resolveChannel(a)
    const latest = await latestVideo(ch.channelId)
    if (!latest) return ctx.reply('Could not find any videos on that channel.')
    await ctx.reply(`📺 Latest: ${latest.title ?? latest.videoId} — summarizing now…`)
    await runVideoNow(ctx, latest.videoId, { title: latest.title, publishedAt: latest.publishedAt })
  } catch (e) {
    await ctx.reply('Could not fetch that channel: ' + String(e).slice(0, 300))
  }
})

bot.command('status', async (ctx) => {
  const chs = await listChannels(true)
  const counts = await statusCounts()
  const min = await getMinDurationMinutes()
  const lines = [
    '📊 Status',
    `Channels tracked: ${chs.length}`,
    `Videos: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ') || 'none yet'}`,
    `Long-form threshold: ${min}m`,
    `Primary model: ${config.ANTHROPIC_MODEL}`,
    `Grader: ${graderConfigured ? config.GRADER_MODEL : 'not configured'}`,
  ]
  await ctx.reply(lines.join('\n')) // plain text — no HTML escaping needed
})

bot.command('grader', async (ctx) => {
  await ctx.reply(
    graderConfigured
      ? `Grader: ${config.GRADER_PROVIDER} / ${config.GRADER_MODEL}`
      : 'Grader NOT configured. Set GRADER_API_KEY in .env to enable section ③ (the independent grade).',
  )
})
