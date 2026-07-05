import { randomBytes, createHash } from 'node:crypto'
import { one, query } from '../db/db'
import { hashPassword, normalizeEmail, verifyPassword } from '../util/password'

// Auth core (spec §5): scrypt password hashing (pure helpers in util/password),
// DB-backed opaque session tokens (stored hashed; raw token only in the cookie),
// and an in-memory per-IP login throttle.

export interface User {
  id: string
  email: string
  is_owner: boolean
}

// ---- users -----------------------------------------------------------------

export async function createUser(email: string, password: string, isOwner = false): Promise<User | null> {
  const row = await one<User>(
    `insert into users(email, password_hash, is_owner) values($1, $2, $3)
     on conflict(email) do nothing
     returning id, email, is_owner`,
    [normalizeEmail(email), hashPassword(password), isOwner],
  )
  if (row) {
    await query(`insert into user_profiles(user_id) values($1) on conflict do nothing`, [row.id])
  }
  return row
}

export async function authenticate(email: string, password: string): Promise<User | null> {
  const row = await one<User & { password_hash: string }>(
    'select id, email, is_owner, password_hash from users where email = $1',
    [normalizeEmail(email)],
  )
  // Hash something even when the user doesn't exist — keeps timing flat.
  if (!row) {
    verifyPassword(password, hashPassword('timing-equalizer'))
    return null
  }
  if (!verifyPassword(password, row.password_hash)) return null
  return { id: row.id, email: row.email, is_owner: row.is_owner }
}

// ---- sessions ----------------------------------------------------------------

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

/** Create a session; returns the RAW token (goes into the cookie, never the DB). */
export async function createSession(userId: string, userAgent?: string): Promise<string> {
  const raw = randomBytes(32).toString('base64url')
  await query(
    `insert into sessions(token_hash, user_id, expires_at, user_agent)
     values($1, $2, now() + interval '30 days', $3)`,
    [hashToken(raw), userId, (userAgent ?? '').slice(0, 200)],
  )
  return raw
}

/** Resolve a session cookie to a user; rolls the expiry forward on use. */
export async function getSessionUser(rawToken: string): Promise<User | null> {
  if (!rawToken) return null
  return one<User>(
    `with s as (
       update sessions set expires_at = now() + interval '30 days'
       where token_hash = $1 and expires_at > now()
       returning user_id
     )
     select u.id, u.email, u.is_owner from users u join s on s.user_id = u.id`,
    [hashToken(rawToken)],
  )
}

export async function deleteSession(rawToken: string): Promise<void> {
  await query('delete from sessions where token_hash = $1', [hashToken(rawToken)])
}

// Occasional cleanup — called opportunistically from the heartbeat/worker.
export async function purgeExpiredSessions(): Promise<void> {
  await query(`delete from sessions where expires_at < now()`)
  await query(`delete from link_tokens where expires_at < now() - interval '1 day'`)
}

// ---- login throttle (per-IP sliding window, in-memory) -----------------------

const WINDOW_MS = 15 * 60 * 1000
const MAX_FAILURES = 5
const failures = new Map<string, number[]>()

export function loginThrottled(ip: string): boolean {
  const now = Date.now()
  const recent = (failures.get(ip) ?? []).filter((t) => now - t < WINDOW_MS)
  failures.set(ip, recent)
  return recent.length >= MAX_FAILURES
}

export function recordLoginFailure(ip: string): void {
  const list = failures.get(ip) ?? []
  list.push(Date.now())
  failures.set(ip, list)
  if (failures.size > 10_000) failures.clear() // memory backstop
}
