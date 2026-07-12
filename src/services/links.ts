import { randomBytes } from 'node:crypto'
import { one, query } from '../db/db'
import { config } from '../config'
import type { User } from './auth'

// Telegram linking (spec §6): one-time short-TTL tokens carried in the
// t.me/<bot>?start=<token> deep link; the bot's /start handler redeems them.

const LINK_TTL_MINUTES = 10

export async function createLinkToken(userId: string): Promise<string> {
  const token = randomBytes(18).toString('base64url') // 24 url-safe chars
  await query(
    `insert into link_tokens(token, user_id, expires_at)
     values($1, $2, now() + make_interval(mins => $3))`,
    [token, userId, LINK_TTL_MINUTES],
  )
  return token
}

export type RedeemResult =
  | { kind: 'linked'; email: string }
  | { kind: 'expired' }
  | { kind: 'invalid' }
  | { kind: 'chat_taken'; email: string }

/** Redeem a /start payload: single-use, TTL-bound; links chat_id ↔ user. */
export async function redeemLinkToken(token: string, chatId: string): Promise<RedeemResult> {
  const row = await one<{ user_id: string; email: string }>(
    `update link_tokens set used_at = now()
     where token = $1 and used_at is null and expires_at > now()
     returning user_id, (select email from users where id = link_tokens.user_id) as email`,
    [token],
  )
  if (!row) {
    const stale = await one('select 1 from link_tokens where token = $1', [token])
    return stale ? { kind: 'expired' } : { kind: 'invalid' }
  }
  // One chat ↔ one user: a chat already linked to a DIFFERENT account is refused.
  const existing = await one<{ user_id: string; email: string }>(
    `select tl.user_id, u.email from telegram_links tl join users u on u.id = tl.user_id where tl.chat_id = $1`,
    [chatId],
  )
  if (existing && existing.user_id !== row.user_id) return { kind: 'chat_taken', email: existing.email }
  // Detect a FRESH link (no prior telegram_links row) before the upsert: an
  // unlink→relink must not resurrect stale subscription watermarks — the user
  // couldn't receive anything while unlinked, and fanning out that whole gap
  // backlog would burn transcript+extract spend in one burst.
  const hadLink = !!(await one('select 1 from telegram_links where user_id = $1', [row.user_id]))
  await query(
    `insert into telegram_links(user_id, chat_id) values($1, $2)
     on conflict(user_id) do update set chat_id = excluded.chat_id, linked_at = now()`,
    [row.user_id, chatId],
  )
  if (!hadLink) {
    await query(`update subscriptions set since = now() where user_id = $1 and active`, [row.user_id])
  }
  // Linking is also the recovery path from a Telegram-403 pause: they clearly
  // want (and can now receive) deliveries again.
  await query(`update users set status = 'active' where id = $1 and status = 'paused'`, [row.user_id])
  // Digests that rendered while they were web-only ("telegram not linked" skips)
  // can now actually be sent — requeue them; the persisted render is reused, so
  // this re-pays nothing.
  await query(
    `update user_deliveries set status = 'pending', run_after = now(), claimed_at = null, skip_reason = null
      where user_id = $1 and status = 'skipped' and skip_reason = 'telegram not linked'`,
    [row.user_id],
  )
  // Owner bootstrap (spec §8): the account that links the historical owner chat
  // becomes the owner and inherits every existing catalog channel as subscriptions.
  // Gated on OWNER_EMAIL so ownership can't be transferred by phishing the owner into
  // scanning an attacker's QR — only the pre-declared owner account is promoted.
  const isOwnerClaim =
    chatId === config.TELEGRAM_CHAT_ID &&
    config.OWNER_EMAIL !== '' &&
    row.email.toLowerCase() === config.OWNER_EMAIL.toLowerCase()
  if (isOwnerClaim) {
    await query('update users set is_owner = true where id = $1', [row.user_id])
    await query(
      `insert into subscriptions(user_id, channel_id)
       select $1, id from channels where active = true
       on conflict(user_id, channel_id) do update set active = true`,
      [row.user_id],
    )
    const p = await one<{ profile_text: string }>('select profile_text from user_profile where id = 1')
    if (p?.profile_text) {
      await query(
        `insert into user_profiles(user_id, profile_text, updated_at) values($1, $2, now())
         on conflict(user_id) do update set profile_text = excluded.profile_text, updated_at = now()`,
        [row.user_id, p.profile_text],
      )
    }
  }
  return { kind: 'linked', email: row.email }
}

export async function linkedChatId(userId: string): Promise<string | null> {
  const row = await one<{ chat_id: string }>('select chat_id from telegram_links where user_id = $1', [userId])
  return row?.chat_id ?? null
}

export async function unlinkTelegram(userId: string): Promise<boolean> {
  const rows = await query('delete from telegram_links where user_id = $1 returning user_id', [userId])
  return rows.length > 0
}

export async function userByChatId(chatId: string): Promise<User | null> {
  return one<User>(
    `select u.id, u.email, u.is_owner from telegram_links tl join users u on u.id = tl.user_id
     where tl.chat_id = $1`,
    [chatId],
  )
}
