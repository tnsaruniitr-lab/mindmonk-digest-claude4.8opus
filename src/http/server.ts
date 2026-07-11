import { createServer, type IncomingMessage } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import QRCode from 'qrcode'
import { config } from '../config'
import { log, scrub } from '../util/logger'
import { DASHBOARD_PAGE, digestDetailPage } from './page'
import { APP_PAGE, LOGIN_PAGE } from './app-page'
import { clearSessionCookie, csrfOk, redirect, requestUser, sessionCookie, sessionTokenFrom } from './session'
import { authenticate, createSession, createUser, deleteSession, loginThrottled, recordLoginFailure } from '../services/auth'
import { createLinkToken, linkedChatId, unlinkTelegram } from '../services/links'
import { listSubscriptions, subscribe, unsubscribe } from '../services/subscriptions'
import { getDeliveryForUser, listDeliveries } from '../services/user-deliveries'
import { getUserProfileText, setUserProfileText } from '../services/profile'
import { bot } from '../bot/bot'
import { recentJourneys, sourceCounts, spendSummary, tierStats } from '../services/waterfall'
import { channelsOverview, getDigestRendered, jobState, latestDigest, recentDigests } from '../services/overview'
import { statusCounts } from '../services/videos'
import { addChannel } from '../services/channels'
import { backfillLatest } from '../scheduler/poller'
import { executeVideoNow, prepareVideoNow } from '../services/run-now'
import { parseVideoId } from '../util/youtube'

// Minimal observability HTTP surface (the service is otherwise long-polling only):
//   GET /healthz            — liveness, no auth
//   GET /  or  /dashboard   — the waterfall dashboard (auth: ?key=DASHBOARD_SECRET)
//   GET /api/waterfall      — JSON feeding the dashboard (same auth)
// Off by default: without DASHBOARD_SECRET nothing listens, so the bot's
// no-inbound-port deployment stays byte-identical unless explicitly enabled.

function authorized(url: URL): boolean {
  const given = Buffer.from(url.searchParams.get('key') ?? '')
  const want = Buffer.from(config.DASHBOARD_SECRET)
  return given.length === want.length && timingSafeEqual(given, want)
}

const MAX_BODY_BYTES = 16 * 1024

/** Read + parse a small JSON request body (test-console POSTs). */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {})
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body))
}

function html(res: import('node:http').ServerResponse, page: string): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page)
}

/**
 * Client IP for auth throttling. Railway's edge APPENDS the real client IP as the
 * LAST x-forwarded-for hop, so we take the rightmost entry — the leftmost hops are
 * client-supplied and spoofable (taking [0] would let an attacker rotate the key
 * and bypass the throttle entirely).
 */
function clientIp(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for']
  const chain = (Array.isArray(xff) ? xff.join(',') : xff ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return chain[chain.length - 1] || req.socket.remoteAddress || 'unknown'
}

let cachedBotUsername = ''
async function botUsername(): Promise<string> {
  if (!cachedBotUsername) cachedBotUsername = (await bot.telegram.getMe()).username
  return cachedBotUsername
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

async function waterfallData(): Promise<Record<string, unknown>> {
  const [recent, tiers, sources, spend, statuses, channels, digests] = await Promise.all([
    recentJourneys(30),
    tierStats(30),
    sourceCounts(),
    spendSummary(),
    statusCounts(),
    channelsOverview(),
    recentDigests(20),
  ])
  return { generatedAt: new Date().toISOString(), recent, tiers, sources, spend, statuses, channels, digests }
}

const MIN_SECRET_LENGTH = 16

export function startHttpServer(): void {
  if (!config.DASHBOARD_SECRET) {
    log.info('Dashboard disabled (set DASHBOARD_SECRET to enable the HTTP waterfall dashboard)')
    return
  }
  // This guards a publicly-routed endpoint — refuse to serve behind a guessable key.
  if (config.DASHBOARD_SECRET.length < MIN_SECRET_LENGTH) {
    log.warn(`Dashboard NOT started: DASHBOARD_SECRET is under ${MIN_SECRET_LENGTH} chars — use e.g. \`openssl rand -hex 16\``)
    return
  }
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method !== 'GET' && req.method !== 'POST') {
        res.writeHead(405).end('method not allowed')
        return
      }
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
        return
      }

      // ---- Multi-user app: session-cookie auth (spec §5–§7) -------------------
      if (req.method === 'GET' && url.pathname === '/') {
        return redirect(res, (await requestUser(req)) ? '/app' : '/login')
      }
      if (req.method === 'GET' && url.pathname === '/login') {
        if (await requestUser(req)) return redirect(res, '/app')
        return html(res, LOGIN_PAGE)
      }
      if (req.method === 'GET' && url.pathname === '/app') {
        if (!(await requestUser(req))) return redirect(res, '/login')
        return html(res, APP_PAGE)
      }
      if (req.method === 'POST' && (url.pathname === '/api/signup' || url.pathname === '/api/login')) {
        if (!csrfOk(req)) return json(res, 403, { error: 'bad request origin' })
        const body = await readJsonBody(req)
        const email = typeof body.email === 'string' ? body.email.trim() : ''
        const password = typeof body.password === 'string' ? body.password : ''
        const ip = clientIp(req)
        // Both signup and login are throttled per IP — signup also burns scrypt CPU
        // and can be used for invite-code brute force / enumeration.
        if (loginThrottled(ip)) return json(res, 429, { error: 'too many attempts — wait 15 minutes' })
        if (url.pathname === '/api/signup') {
          if (config.INVITE_CODE && (typeof body.invite === 'string' ? body.invite.trim() : '') !== config.INVITE_CODE) {
            recordLoginFailure(ip)
            return json(res, 403, { error: 'invalid invite code' })
          }
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: 'valid email required' })
          if (password.length < 10) return json(res, 400, { error: 'password must be at least 10 characters' })
          const user = await createUser(email, password)
          if (!user) return json(res, 409, { error: 'that email is already registered' })
          const tok = await createSession(user.id, String(req.headers['user-agent'] ?? ''))
          res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': sessionCookie(tok, 30 * 24 * 3600) }).end('{"ok":true}')
          log.info(`New signup: ${user.email}`)
          return
        }
        if (loginThrottled(ip)) return json(res, 429, { error: 'too many attempts — wait 15 minutes' })
        const user = await authenticate(email, password)
        if (!user) {
          recordLoginFailure(ip)
          log.warn(`login failed from ${ip}`)
          return json(res, 401, { error: 'wrong email or password' })
        }
        const tok = await createSession(user.id, String(req.headers['user-agent'] ?? ''))
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': sessionCookie(tok, 30 * 24 * 3600) }).end('{"ok":true}')
        return
      }
      const SESSION_PATHS = new Set(['/api/me', '/api/logout', '/api/link/start', '/api/link/status', '/api/link/unlink', '/api/subscriptions', '/api/subscriptions/remove', '/api/digests', '/api/profile'])
      if (SESSION_PATHS.has(url.pathname)) {
        const u = await requestUser(req)
        if (!u) return json(res, 401, { error: 'not signed in' })
        if (req.method === 'POST' && !csrfOk(req)) return json(res, 403, { error: 'bad request origin' })
        if (req.method === 'GET' && url.pathname === '/api/me') {
          return json(res, 200, { email: u.email, is_owner: u.is_owner, linked: !!(await linkedChatId(u.id)) })
        }
        if (req.method === 'GET' && url.pathname === '/api/link/status') {
          return json(res, 200, { linked: !!(await linkedChatId(u.id)) })
        }
        if (req.method === 'GET' && url.pathname === '/api/subscriptions') {
          return json(res, 200, { subscriptions: await listSubscriptions(u.id) })
        }
        if (req.method === 'GET' && url.pathname === '/api/digests') {
          return json(res, 200, { digests: await listDeliveries(u.id, 20) })
        }
        if (req.method === 'GET' && url.pathname === '/api/profile') {
          return json(res, 200, { profile: await getUserProfileText(u.id) })
        }
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        if (url.pathname === '/api/logout') {
          await deleteSession(sessionTokenFrom(req))
          res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': clearSessionCookie() }).end('{"ok":true}')
          return
        }
        if (url.pathname === '/api/link/start') {
          const token = await createLinkToken(u.id)
          const deepLink = `https://t.me/${await botUsername()}?start=${token}`
          const qr = await QRCode.toDataURL(deepLink, { margin: 1, width: 440 })
          return json(res, 200, { deepLink, qr, expiresInSeconds: 600 })
        }
        if (url.pathname === '/api/link/unlink') {
          await unlinkTelegram(u.id)
          return json(res, 200, { ok: true })
        }
        if (url.pathname === '/api/subscriptions') {
          const b = await readJsonBody(req)
          const input = typeof b.input === 'string' ? b.input.trim() : ''
          if (!input) return json(res, 400, { error: 'channel url, @handle, or UC… id required' })
          try {
            const r = await subscribe(u, input)
            return r.ok ? json(res, 200, r) : json(res, 422, r)
          } catch (e) {
            return json(res, 422, { error: scrub(String(e)).slice(0, 300) })
          }
        }
        if (url.pathname === '/api/subscriptions/remove') {
          const b = await readJsonBody(req)
          const id = typeof b.id === 'string' ? b.id : ''
          if (!UUID_RE.test(id)) return json(res, 400, { error: 'bad id' })
          await unsubscribe(u.id, id)
          return json(res, 200, { ok: true })
        }
        if (url.pathname === '/api/profile') {
          const b = await readJsonBody(req)
          const text = typeof b.text === 'string' ? b.text.trim() : ''
          if (text.length > 4000) return json(res, 400, { error: 'profile too long (max 4000 chars)' })
          await setUserProfileText(u.id, text)
          return json(res, 200, { ok: true })
        }
      }

      // ---- Session-authed digest viewer ("my digests" → full text) -------------
      // Parameterized path, so it can't live in the exact-string SESSION_PATHS set.
      // Both predicates in getDeliveryForUser (id AND user_id) are the IDOR guard.
      const myDigest = url.pathname.match(/^\/app\/digest\/([0-9a-f-]{36})$/)
      if (req.method === 'GET' && myDigest) {
        const u = await requestUser(req)
        if (!u) return redirect(res, '/login')
        // Strict shape check — a 36-char non-uuid (e.g. all dashes) would otherwise
        // hit an unhandled uuid-cast error in Postgres and 500 instead of 404.
        if (!UUID_RE.test(myDigest[1])) {
          res.writeHead(404, { 'content-type': 'text/plain' }).end('digest not found')
          return
        }
        const d = await getDeliveryForUser(myDigest[1], u.id)
        if (!d || !d.rendered) {
          res.writeHead(404, { 'content-type': 'text/plain' }).end('digest not found')
          return
        }
        res
          .writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          .end(digestDetailPage(d.title, d.created_at, d.rendered))
        return
      }

      // ---- Admin surface (owner god-view, ?key=DASHBOARD_SECRET) ---------------
      if (!authorized(url)) {
        // Loud on purpose: a brute-force attempt should be visible in Railway logs.
        log.warn(`dashboard 401: ${url.pathname} from ${req.socket.remoteAddress ?? 'unknown'}`)
        res.writeHead(401, { 'content-type': 'text/plain' }).end('unauthorized — append ?key=<DASHBOARD_SECRET>')
        return
      }

      // ---- Test console (POST) ------------------------------------------------
      if (req.method === 'POST' && url.pathname === '/api/channels') {
        const body = await readJsonBody(req)
        const input = typeof body.input === 'string' ? body.input.trim() : ''
        if (!input) return json(res, 400, { error: 'input required: channel url, @handle, or UC… id' })
        try {
          const ch = await addChannel(input)
          let backfilled = 0
          if (body.backfill === true) backfilled = await backfillLatest(ch, 1)
          return json(res, 200, { added: ch.title ?? ch.handle ?? ch.youtube_channel_id, backfilled })
        } catch (e) {
          return json(res, 422, { error: scrub(String(e)).slice(0, 300) })
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/fetch') {
        const body = await readJsonBody(req)
        const vid = parseVideoId(typeof body.url === 'string' ? body.url.trim() : '')
        if (!vid) return json(res, 400, { error: 'not a YouTube video url or 11-char id' })
        const prep = await prepareVideoNow(vid)
        if (prep.kind === 'already_processing') return json(res, 409, { error: 'already being processed', videoId: vid })
        if (prep.kind === 'no_record') return json(res, 500, { error: 'could not create the video record' })
        // Long part runs async; the client polls /api/job. Same pipeline as Telegram
        // /fetch — the digest ALSO goes to Telegram, by design.
        void executeVideoNow(prep.video).catch((e) => log.error('console fetch failed', String(e)))
        return json(res, 202, { videoId: vid })
      }
      if (req.method === 'POST') {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
        return
      }

      // ---- Pages + read APIs (GET) --------------------------------------------
      if (url.pathname === '/dashboard') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(DASHBOARD_PAGE)
        return
      }
      if (url.pathname === '/api/job') {
        const vid = url.searchParams.get('video') ?? ''
        const state = vid ? await jobState(vid) : null
        if (!state) return json(res, 404, { error: 'unknown video' })
        return json(res, 200, state)
      }
      if (url.pathname === '/api/last-digest') {
        const d = await latestDigest()
        if (!d) return json(res, 404, { error: 'no digests yet' })
        return json(res, 200, d)
      }
      if (url.pathname === '/api/waterfall') {
        const data = await waterfallData()
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(data))
        return
      }
      const digestMatch = url.pathname.match(/^\/digest\/([0-9a-f-]{36})$/)
      if (digestMatch) {
        const d = await getDigestRendered(digestMatch[1])
        if (!d || !d.rendered) {
          res.writeHead(404, { 'content-type': 'text/plain' }).end('digest not found')
          return
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          .end(digestDetailPage(d.title, d.created_at, d.rendered))
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
    })().catch((e) => {
      log.error('dashboard request failed', String(e))
      if (!res.headersSent) res.writeHead(500)
      res.end('internal error')
    })
  })
  server.on('error', (e) => log.error('dashboard server error', String(e)))
  server.listen(config.PORT, () => log.info(`Dashboard listening on :${config.PORT} (path: /dashboard?key=…)`))
}
