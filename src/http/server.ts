import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { config } from '../config'
import { log } from '../util/logger'
import { DASHBOARD_PAGE, digestDetailPage } from './page'
import { recentJourneys, sourceCounts, spendSummary, tierStats } from '../services/waterfall'
import { channelsOverview, getDigestRendered, recentDigests } from '../services/overview'
import { statusCounts } from '../services/videos'

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
      if (req.method !== 'GET') {
        res.writeHead(405).end('method not allowed')
        return
      }
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
        return
      }
      if (!authorized(url)) {
        // Loud on purpose: a brute-force attempt should be visible in Railway logs.
        log.warn(`dashboard 401: ${url.pathname} from ${req.socket.remoteAddress ?? 'unknown'}`)
        res.writeHead(401, { 'content-type': 'text/plain' }).end('unauthorized — append ?key=<DASHBOARD_SECRET>')
        return
      }
      if (url.pathname === '/' || url.pathname === '/dashboard') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(DASHBOARD_PAGE)
        return
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
