import { bot } from '../bot/bot'
import { config } from '../config'
import { query } from '../db/db'
import { sendThrottled } from './telegram-rate'
import { log, scrub } from '../util/logger'

const TELEGRAM_LIMIT = 4096

/**
 * Split an HTML message into <=limit chunks on line boundaries (each render.ts
 * line keeps its own tags balanced, so splitting between lines stays valid).
 * Any single line longer than the limit is hard-split at a space as a backstop.
 */
export function chunkHtml(html: string, limit = TELEGRAM_LIMIT - 96): string[] {
  const chunks: string[] = []
  let buf = ''
  const flush = () => {
    if (buf) chunks.push(buf)
    buf = ''
  }
  for (const line of html.split('\n')) {
    const pieces = line.length > limit ? hardSplit(line, limit) : [line]
    for (const piece of pieces) {
      if (buf.length + piece.length + 1 > limit) {
        flush()
        buf = piece
      } else {
        buf = buf ? `${buf}\n${piece}` : piece
      }
    }
  }
  flush()
  return chunks
}

function hardSplit(line: string, limit: number): string[] {
  const parts: string[] = []
  let rest = line
  while (rest.length > limit) {
    let cut = rest.lastIndexOf(' ', limit)
    if (cut <= 0) cut = limit
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\s+/, '')
  }
  if (rest) parts.push(rest)
  return parts
}

/** Send an HTML message (chunked) to the owner and log the delivery. */
export async function deliver(html: string, videoDbId: string | null): Promise<void> {
  const chunks = chunkHtml(html)
  const messageIds: number[] = []
  try {
    for (const chunk of chunks) {
      const msg = await sendThrottled(config.TELEGRAM_CHAT_ID, chunk, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      })
      messageIds.push(msg.message_id)
    }
    await logDelivery(videoDbId, messageIds, true, null)
  } catch (err) {
    log.error('Telegram delivery failed', String(err))
    await logDelivery(videoDbId, messageIds, false, scrub(String(err)))
    throw err
  }
}

/** A multi-chunk send failed partway. Carries the ids already delivered so the caller can
 *  persist progress and resume — never re-sending a chunk the user already received. */
export class PartialDeliveryError extends Error {
  constructor(public readonly messageIds: number[], public readonly cause: unknown) {
    super('partial delivery')
  }
}

/** Send a (chunked) HTML digest to a specific chat and return the message ids. Resumes from
 *  `alreadySent` (chunks delivered on a prior attempt) so a retry of the SAME html never
 *  re-sends a chunk — callers MUST pass the same html across retries (Stage B persists the
 *  rendered text on the delivery row for exactly this). Throws PartialDeliveryError if a
 *  chunk fails after others succeeded, so the caller can save progress before re-queueing. */
export async function deliverToChat(chatId: string, html: string, alreadySent: number[] = []): Promise<number[]> {
  const chunks = chunkHtml(html)
  const messageIds = [...alreadySent]
  for (let i = alreadySent.length; i < chunks.length; i++) {
    try {
      const msg = await sendThrottled(chatId, chunks[i], {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      })
      messageIds.push(msg.message_id)
    } catch (err) {
      // Surface partial progress only if we'd actually sent something this run; otherwise
      // let the original error through unchanged (nothing to resume).
      if (messageIds.length > alreadySent.length) throw new PartialDeliveryError(messageIds, err)
      throw err
    }
  }
  return messageIds
}

/** Plain helper for command replies / notices (single message, HTML-escaped by caller). */
export async function notify(text: string): Promise<void> {
  await bot.telegram.sendMessage(config.TELEGRAM_CHAT_ID, text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  })
}

async function logDelivery(
  videoDbId: string | null,
  messageIds: number[],
  ok: boolean,
  error: string | null,
): Promise<void> {
  await query(
    'insert into delivery_log(video_id, chat_id, message_ids, ok, error) values($1, $2, $3, $4, $5)',
    [videoDbId, config.TELEGRAM_CHAT_ID, JSON.stringify(messageIds), ok, error],
  )
}
