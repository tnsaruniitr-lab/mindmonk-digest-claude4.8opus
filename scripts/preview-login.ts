// Local visual preview of the landing/login page (no DB, no secrets): serves
// LOGIN_PAGE plus the hero video with the same Range semantics as prod.
//   npx tsx scripts/preview-login.ts   → http://localhost:5184
import { createServer } from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { LOGIN_PAGE } from '../src/http/app-page'

const HERO = fileURLToPath(new URL('../assets/hero.mp4', import.meta.url))
const PORT = 5184

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname === '/assets/hero.mp4') {
    const size = statSync(HERO).size
    const m = typeof req.headers.range === 'string' ? req.headers.range.match(/^bytes=(\d*)-(\d*)$/) : null
    if (m && (m[1] || m[2])) {
      const start = m[1] ? parseInt(m[1], 10) : Math.max(0, size - parseInt(m[2], 10))
      const end = m[1] && m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1
      res.writeHead(206, {
        'content-type': 'video/mp4',
        'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': end - start + 1,
      })
      createReadStream(HERO, { start, end }).pipe(res)
    } else {
      res.writeHead(200, { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': size })
      createReadStream(HERO).pipe(res)
    }
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(LOGIN_PAGE)
}).listen(PORT, () => console.log(`login preview on http://localhost:${PORT}`))
