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

/** Owner gate: the bot only ever talks to TELEGRAM_CHAT_ID. */
bot.use(async (ctx, next) => {
  if (ctx.chat && ctx.chat.id.toString() !== config.TELEGRAM_CHAT_ID) {
    return // silently ignore everyone else
  }
  return next()
})
