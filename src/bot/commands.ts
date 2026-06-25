import { bot } from './bot'
import { config, graderConfigured } from '../config'
import { addChannel, listChannels, removeChannel } from '../services/channels'
import { getProfile, setProfile } from '../services/profile'
import { getMinDurationMinutes, setSetting } from '../services/settings'
import { claimById, enqueueVideo, getVideoByVideoId, resetVideo, statusCounts } from '../services/videos'
import { backfillLatest, runPoller } from '../scheduler/poller'
import { processOne } from '../scheduler/worker'
import { parseVideoId } from '../util/youtube'

/** Everything after the first space of a command message. */
function arg(text: string | undefined): string {
  if (!text) return ''
  const sp = text.indexOf(' ')
  return sp === -1 ? '' : text.slice(sp + 1).trim()
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
/test &lt;video url&gt; — run the pipeline on one video now
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

bot.command('test', async (ctx) => {
  const a = arg(ctx.message?.text)
  const vid = parseVideoId(a)
  if (!vid) return ctx.reply('Usage: /test <youtube video url or 11-char id>')
  await ctx.reply('⏳ Processing that episode now…')
  try {
    let row = await getVideoByVideoId(vid)
    if (!row) row = await enqueueVideo({ videoId: vid, channelId: null, title: null, publishedAt: null })
    if (!row) row = await getVideoByVideoId(vid)
    if (!row) return ctx.reply('Could not create the video record.')
    await resetVideo(row.id)
    const claimed = await claimById(row.id) // atomic — won't race the worker
    if (!claimed) return ctx.reply('That episode is already being processed.')
    await processOne(claimed)
  } catch (e) {
    await ctx.reply('Error: ' + String(e).slice(0, 300))
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
