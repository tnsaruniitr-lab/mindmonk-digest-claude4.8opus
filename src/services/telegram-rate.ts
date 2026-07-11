// Telegram delivery rate limiting (Phase 2 fan-out). One bot token can send ~30 msg/s
// globally and ~1 msg/s per chat; exceeding that returns HTTP 429 with a retry_after.
// At fan-out scale this throttles every send through a global token bucket + per-chat
// spacing, honours 429 retry_after, and surfaces 403 (the user blocked the bot) so the
// caller can pause that user. In-process is sufficient on a single instance.
import { bot } from '../bot/bot'
import { TokenBucket, PerChatThrottle } from '../util/rate-limit'

const GLOBAL_PER_SEC = 25 // headroom under Telegram's ~30/s global ceiling
const PER_CHAT_GAP_MS = 1100 // ~1 msg/s per chat, with margin

/** The user blocked the bot (Telegram 403) — caller should pause them, not retry. */
export class UserBlockedError extends Error {
  constructor(public readonly chatId: string) {
    super(`Telegram 403: chat ${chatId} blocked the bot`)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const globalBucket = new TokenBucket(GLOBAL_PER_SEC, GLOBAL_PER_SEC, Date.now())
const chatThrottle = new PerChatThrottle()
let sendCount = 0

interface SendExtra {
  parse_mode?: 'HTML' | 'Markdown'
  link_preview_options?: { is_disabled: boolean }
}

/** Send one message under the global + per-chat limits, honouring 429 retry_after.
 *  Throws UserBlockedError on 403 so the caller can pause the user. */
export async function sendThrottled(
  chatId: string,
  text: string,
  extra: SendExtra,
): Promise<Awaited<ReturnType<typeof bot.telegram.sendMessage>>> {
  const chatWait = chatThrottle.reserve(chatId, Date.now(), PER_CHAT_GAP_MS)
  // Opportunistically drop expired per-chat reservations so the map stays bounded.
  if (++sendCount % 500 === 0) chatThrottle.prune(Date.now())
  if (chatWait > 0) await sleep(chatWait)
  for (;;) {
    const wait = globalBucket.take(Date.now())
    if (wait === 0) break
    await sleep(wait)
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await bot.telegram.sendMessage(chatId, text, extra)
    } catch (err) {
      const e = err as { response?: { error_code?: number; parameters?: { retry_after?: number } } }
      const retryAfter = e.response?.parameters?.retry_after
      if (retryAfter) {
        await sleep((retryAfter + 1) * 1000)
        continue
      }
      if (e.response?.error_code === 403) throw new UserBlockedError(chatId)
      throw err
    }
  }
  throw new Error(`Telegram send to ${chatId} failed after retries`)
}
