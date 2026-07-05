import { createServer, type IncomingMessage } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { config } from '../config'
import { log, scrub } from '../util/logger'
import { DASHBOARD_PAGE, digestDetailPage } from './page'
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
      if (url.pathname === '/' || url.pathname === '/dashboard') {
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
