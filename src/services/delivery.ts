import { bot } from '../bot/bot'
import { config } from '../config'
import { query } from '../db/db'
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
      const msg = await bot.telegram.sendMessage(config.TELEGRAM_CHAT_ID, chunk, {
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
