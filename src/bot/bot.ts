import { Telegraf } from 'telegraf'
import { config } from '../config'
import { log } from '../util/logger'

/** Single shared bot instance (commands register here; delivery sends here). */
export const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN)

// Any error thrown inside a command handler lands here instead of becoming an
// unhandled rejection that could take the process down.
bot.catch((err, ctx) => {
  log.error(`telegraf handler error (update ${ctx.updateType})`, String(err))
})

/**
 * Access gate (spec §6): the owner chat gets every command, as before.
 * Other chats are allowed through ONLY for the linking handshake (/start with
 * a token) and /unlink — everything else gets one polite pointer to the web
 * app (commands only; plain text from strangers is still ignored).
 */
bot.use(async (ctx, next) => {
  if (!ctx.chat) return
  if (ctx.chat.id.toString() === config.TELEGRAM_CHAT_ID) return next()
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : ''
  // Only the linking handshake is allowed for other chats.
  if (/^\/(start|unlink)(@\w+)?(\s|$)/.test(text)) return next()
  // A polite pointer, but ONLY in a 1:1 private chat (never chime into group chats
  // the bot happens to be in, or answer commands addressed to other bots).
  if (ctx.chat.type === 'private' && text.startsWith('/')) {
    await ctx.reply('This bot is managed through the MindMonk web app — sign in there to link Telegram and add channels.')
  }
})
