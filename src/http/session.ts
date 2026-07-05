import type { IncomingMessage, ServerResponse } from 'node:http'
import { getSessionUser, type User } from '../services/auth'
import { COOKIE_NAME, parseCookies } from './cookies'

// Session plumbing for the multi-user app (spec §5). Pure cookie helpers live
// in ./cookies; this module adds the DB-backed session resolution.

export { clearSessionCookie, sessionCookie } from './cookies'

export function sessionTokenFrom(req: IncomingMessage): string {
  return parseCookies(req.headers.cookie)[COOKIE_NAME] ?? ''
}

/** Resolve the request's session to a user (null = not logged in). */
export async function requestUser(req: IncomingMessage): Promise<User | null> {
  return getSessionUser(sessionTokenFrom(req))
}

/**
 * CSRF stance for cookie-authed JSON POSTs (spec §5): SameSite=Strict cookie
 * PLUS a required custom header — cross-origin forms can't set custom headers,
 * and Strict cookies don't ride cross-site subrequests anyway. Belt and braces.
 */
export function csrfOk(req: IncomingMessage): boolean {
  return (req.headers['x-requested-with'] ?? '') === 'fetch'
}

export function redirect(res: ServerResponse, to: string): void {
  res.writeHead(302, { location: to }).end()
}
