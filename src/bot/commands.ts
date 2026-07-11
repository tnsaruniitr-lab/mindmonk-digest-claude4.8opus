import { Context } from 'telegraf'
import { bot } from './bot'
import { config, graderConfigured } from '../config'
import { addChannel, listChannels, removeChannel } from '../services/channels'
import { getProfile, setProfile } from '../services/profile'
import { getMinDurationMinutes, setSetting } from '../services/settings'
import { statusCounts } from '../services/videos'
import { runVideoNow } from '../services/run-now'
import { redeemLinkToken, unlinkTelegram, userByChatId } from '../services/links'
import { unpauseUser } from '../services/user-deliveries'
import { recentJourneys } from '../services/waterfall'
import { formatJourney } from '../util/journey'
import { backfillLatest, latestVideo, runPoller } from '../scheduler/poller'
import { scrub } from '../util/logger'
import { parseVideoId, resolveChannel } from '../util/youtube'

/** Everything after the first space of a command message. */
function arg(text: string | undefined): string {
  if (!text) return ''
  const sp = text.indexOf(' ')
  return sp === -1 ? '' : text.slice(sp + 1).trim()
}

/**
 * Summarize one video on demand and deliver its digest (shared pipeline in
 * services/run-now.ts — same path the dashboard test console uses).
 */
async function runVideoNowTg(
  ctx: Context,
  videoId: string,
  meta: { channelId?: string | null; title?: string | null; publishedAt?: string | null } = {},
): Promise<void> {
  const res = await runVideoNow(videoId, meta)
  switch (res.kind) {
    case 'delivered':
      return // the digest itself is the reply
    case 'no_record':
      await ctx.reply('Could not create the video record.')
      return
    case 'already_processing':
      await ctx.reply('That video is already being processed — hang tight.')
      return
    case 'skipped':
      await ctx.reply(`Skipped (${res.reason}).`)
      return
    case 'requeued':
      await ctx.reply(
        res.reason === 'rate_limited'
          ? '⏳ Transcription is rate-limited right now (Groq free-tier audio cap — ~2h of audio/hour). I’ve queued it; your digest will arrive automatically within the hour. No need to resend.'
          : '💸 Daily spend cap reached — I’ve queued this; your digest will arrive automatically after the cap resets (next server day). No need to resend.',
      )
      return
    case 'failed':
      await ctx.reply(
        res.noTranscript
          ? 'Couldn’t get a usable transcript for that video — captions are unavailable and audio transcription returned nothing.'
          : 'Error: ' + res.error,
      )
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
/waterfall — which transcript tier served each recent video
/grader — grader configuration`

// /start carries the QR deep-link payload: t.me/<bot>?start=<one-time-token>.
// Redeeming it links this Telegram chat to the web account that minted the token.
bot.start(async (ctx) => {
  const payload = (ctx as unknown as { payload?: string }).payload?.trim() ?? ''
  if (payload) {
    const r = await redeemLinkToken(payload, ctx.chat.id.toString())
    switch (r.kind) {
      case 'linked':
        return ctx.reply(`🔗 Linked! This Telegram is now connected to ${r.email}. Manage your channels and profile in the web app — new episodes from your channels will be digested and delivered here.`)
      case 'expired':
        return ctx.reply('That link code has expired or was already used — open the web app and tap "Link Telegram" again for a fresh QR.')
      case 'chat_taken':
        return ctx.reply(`This Telegram is already linked to ${r.email}. Unlink it first with /unlink if you want to switch accounts.`)
      case 'invalid':
        return ctx.reply('That link code isn’t valid — open the web app and tap "Link Telegram" for a fresh QR.')
    }
  }
  const isOwner = ctx.chat.id.toString() === config.TELEGRAM_CHAT_ID
  if (isOwner) return ctx.reply('👋 Ready. Add a channel with /add <url>, then /help for everything.')
  // A plain /start from an already-linked chat is the "I unblocked the bot" signal —
  // clear a Telegram-403 pause so their deliveries resume.
  const linkedUser = await userByChatId(ctx.chat.id.toString())
  if (linkedUser) {
    await unpauseUser(linkedUser.id)
    return ctx.reply(`👋 You're linked as ${linkedUser.email} — digests for your channels arrive here. Manage them in the web app.`)
  }
  return ctx.reply('👋 To connect this bot, sign in to the MindMonk web app and scan the "Link Telegram" QR code.')
})

bot.command('unlink', async (ctx) => {
  const user = await userByChatId(ctx.chat.id.toString())
  if (!user) return ctx.reply('This chat isn’t linked to any web account.')
  await unlinkTelegram(user.id)
  await ctx.reply(`Unlinked from ${user.email}. Scan a fresh QR in the web app to re-link any time.`)
})

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
    await ctx.reply('Could not add that channel: ' + scrub(String(e)).slice(0, 300))
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
  await runVideoNowTg(ctx, vid)
})
bot.command('test', async (ctx) => {
  const vid = parseVideoId(arg(ctx.message?.text))
  if (!vid) return ctx.reply('Usage: /test <youtube video url or 11-char id>')
  await ctx.reply('⏳ Summarizing that video now…')
  await runVideoNowTg(ctx, vid)
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
    await runVideoNowTg(ctx, latest.videoId, { title: latest.title, publishedAt: latest.publishedAt })
  } catch (e) {
    await ctx.reply('Could not fetch that channel: ' + scrub(String(e)).slice(0, 300))
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

// Transcript-waterfall observability: per-video journey of which tier hit/failed.
bot.command('waterfall', async (ctx) => {
  const rows = await recentJourneys(10)
  if (!rows.length) return ctx.reply('No videos yet — the waterfall log fills as videos are processed.')
  const badge: Record<string, string> = { done: '✅', failed: '❌', no_transcript: '🚫', skipped: '⏭️', pending: '⏳', processing: '⚙️' }
  const lines = rows.map((r) => {
    const title = (r.title ?? r.video_id).slice(0, 48)
    const dropped = r.dropped_events > 0 ? `(+${r.dropped_events} earlier attempts) ` : ''
    const journey =
      formatJourney(r.events) ||
      (r.status === 'pending' || r.status === 'processing'
        ? '(queued — not attempted yet)'
        : '(no attempts logged — pre-dates waterfall logging, or never reached the transcript step)')
    const src = r.transcript_source ? ` [${r.transcript_source}]` : ''
    return `${badge[r.status] ?? '❔'} ${title}${src}\n      ${dropped}${journey}`
  })
  const text = '🔀 Transcript waterfall — last 10 videos:\n\n' + lines.join('\n') // plain text — no HTML parse mode
  await ctx.reply(text.length > 4096 ? `${text.slice(0, 4095)}…` : text) // Telegram hard limit
})

bot.command('grader', async (ctx) => {
  await ctx.reply(
    graderConfigured
      ? `Grader: ${config.GRADER_PROVIDER} / ${config.GRADER_MODEL}`
      : 'Grader NOT configured. Set GRADER_API_KEY in .env to enable section ③ (the independent grade).',
  )
})
