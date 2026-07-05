import cron from 'node-cron'
import { config } from './config'
import { bot } from './bot/bot'
import './bot/commands' // registers command handlers on the shared bot
import { migrate } from './db/migrate'
import { ensureProfileSeeded } from './services/profile'
import { runPoller } from './scheduler/poller'
import { runWorker } from './scheduler/worker'
import { startHttpServer } from './http/server'
import { purgeExpiredSessions } from './services/auth'
import { log } from './util/logger'

process.on('unhandledRejection', (reason) => log.error('unhandledRejection', String(reason)))
process.on('uncaughtException', (err) => {
  log.error('uncaughtException — exiting for supervisor restart', String(err))
  process.exit(1)
})

async function main(): Promise<void> {
  await migrate()
  await ensureProfileSeeded()
  startHttpServer() // no-op unless DASHBOARD_SECRET is set

  // Daily hygiene: drop expired sessions + stale link tokens.
  cron.schedule('30 4 * * *', () => {
    purgeExpiredSessions().catch((e) => log.warn('session purge failed', String(e)))
  })

  // Detect new uploads, then process the queue.
  cron.schedule(config.POLL_CRON, () => {
    runPoller().catch((e) => log.error('poller tick failed', String(e)))
  })
  cron.schedule(config.WORKER_CRON, () => {
    runWorker().catch((e) => log.error('worker tick failed', String(e)))
  })

  // Telegraf long-polling. Do NOT await — the promise resolves only on stop.
  // If polling dies (token revoked, 409 conflict, network), exit so the
  // supervisor (Railway) restarts the whole process.
  bot.launch().catch((e) => {
    log.error('bot polling stopped/failed — exiting for restart', String(e))
    process.exit(1)
  })
  log.info(`Bot launched. poll="${config.POLL_CRON}" worker="${config.WORKER_CRON}" model=${config.ANTHROPIC_MODEL}`)

  // Kick an initial poll + worker pass a few seconds after boot.
  setTimeout(() => {
    runPoller()
      .then(() => runWorker())
      .catch((e) => log.error('initial pass failed', String(e)))
  }, 5_000)

  process.once('SIGINT', () => bot.stop('SIGINT'))
  process.once('SIGTERM', () => bot.stop('SIGTERM'))
}

main().catch((e) => {
  log.error('fatal startup error', String(e))
  process.exit(1)
})
