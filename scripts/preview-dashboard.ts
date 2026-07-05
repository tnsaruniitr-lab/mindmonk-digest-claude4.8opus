// Standalone dashboard preview with canned data — no DB, no Telegram, no .env.
// (Deliberately does NOT import src/config or src/index: booting the real bot
// locally would steal Telegram long-polling from prod and 409 it.)
//   npx tsx scripts/preview-dashboard.ts   → http://localhost:5183/dashboard?key=preview
import { createServer } from 'node:http'
import { DASHBOARD_PAGE } from '../src/http/page'

const now = Date.now()
const iso = (msAgo: number) => new Date(now - msAgo).toISOString()

const MOCK = {
  generatedAt: new Date(now).toISOString(),
  statuses: { done: 42, pending: 2, failed: 1, no_transcript: 1, skipped: 6 },
  channels: [
    { title: 'Lex Fridman', handle: '@lexfridman', url: 'https://youtube.com/@lexfridman', active: true, min_duration_minutes: null, last_checked_at: iso(7 * 60_000), last_published: iso(2 * 86_400_000), videos: 18, digests: 15 },
    { title: 'My First Million', handle: '@MyFirstMillionPod', url: 'https://youtube.com/@MyFirstMillionPod', active: true, min_duration_minutes: 30, last_checked_at: iso(7 * 60_000), last_published: iso(6 * 3_600_000), videos: 22, digests: 20 },
    { title: 'Paused Channel <img src=x onerror=alert(2)>', handle: '@paused', url: 'https://youtube.com/@paused', active: false, min_duration_minutes: null, last_checked_at: iso(12 * 86_400_000), last_published: null, videos: 12, digests: 7 },
  ],
  digests: [
    { id: '11111111-1111-4111-8111-111111111111', created_at: iso(31 * 60_000), title: 'How to Build a Second Brain — deep dive', url: 'https://youtube.com/watch?v=aaa111', primary_model: 'claude-opus-4-8', grader_model: 'gpt-4o-mini', has_grade: true, rendered_len: 3812 },
    { id: '22222222-2222-4222-8222-222222222222', created_at: iso(2.8 * 3_600_000), title: 'Marathon interview: 3h on AI agents', url: 'https://youtube.com/watch?v=bbb222', primary_model: 'claude-opus-4-8', grader_model: null, has_grade: false, rendered_len: 3540 },
    { id: '33333333-3333-4333-8333-333333333333', created_at: iso(20 * 3_600_000), title: 'Quota-stall survivor: retried for hours, then delivered', url: 'https://youtube.com/watch?v=ccc333', primary_model: 'claude-opus-4-8', grader_model: 'gpt-4o-mini', has_grade: true, rendered_len: 4020 },
  ],
  sources: [
    { source: 'supadata', n: 31 },
    { source: 'audio', n: 11 },
  ],
  spend: {
    today_usd: 0.42,
    last30_usd: 9.87,
    by_provider: [
      { provider: 'anthropic', kind: 'llm', usd: 8.1, calls: 96 },
      { provider: 'groq', kind: 'asr', usd: 0.9, calls: 11 },
      { provider: 'supadata', kind: 'asr', usd: 0.62, calls: 31 },
      { provider: 'openai', kind: 'asr', usd: 0.25, calls: 1 },
    ],
  },
  tiers: [
    { tier: 'supadata', outcome: 'hit', n: 31 },
    { tier: 'supadata', outcome: 'miss', n: 8 },
    { tier: 'supadata', outcome: 'rate_limited', n: 2 },
    { tier: 'supadata', outcome: 'error', n: 1 },
    { tier: 'audio:groq', outcome: 'hit', n: 10 },
    { tier: 'audio:groq', outcome: 'rate_limited', n: 1 },
    { tier: 'audio:openai', outcome: 'hit', n: 1 },
    { tier: 'audio', outcome: 'rate_limited', n: 3 },
    { tier: 'audio', outcome: 'error', n: 2 },
  ],
  recent: [
    {
      video_id: 'zzz000', title: 'Freshly queued — worker has not picked it up yet',
      url: 'https://youtube.com/watch?v=zzz000', status: 'pending', skip_reason: null,
      created_at: iso(40_000), processed_at: null, transcript_source: null, char_len: null,
      events: [], dropped_events: 0,
    },
    {
      video_id: 'aaa111', title: 'How to Build a Second Brain — deep dive <script>alert(1)</script>',
      url: 'https://youtube.com/watch?v=aaa111', status: 'done', skip_reason: null,
      created_at: iso(35 * 60_000), processed_at: iso(31 * 60_000), transcript_source: 'supadata', char_len: 84213,
      events: [{ tier: 'supadata', outcome: 'hit', detail: null, duration_ms: 2100, created_at: iso(34 * 60_000) }],
      dropped_events: 0,
    },
    {
      video_id: 'bbb222', title: 'Marathon interview: 3h on AI agents (captions disabled)',
      url: 'https://youtube.com/watch?v=bbb222', status: 'done', skip_reason: null,
      created_at: iso(3 * 3_600_000), processed_at: iso(2.8 * 3_600_000), transcript_source: 'audio', char_len: 156002,
      events: [
        { tier: 'supadata', outcome: 'miss', detail: 'no transcript content in response', duration_ms: 1800, created_at: iso(3 * 3_600_000) },
        { tier: 'audio:groq', outcome: 'rate_limited', detail: 'Groq 429 — fell back to OpenAI', duration_ms: null, created_at: iso(2.95 * 3_600_000) },
        { tier: 'audio:openai', outcome: 'hit', detail: null, duration_ms: 214_000, created_at: iso(2.9 * 3_600_000) },
      ],
      dropped_events: 0,
    },
    {
      video_id: 'ccc333', title: 'Quota-stall survivor: retried for hours, then delivered',
      url: 'https://youtube.com/watch?v=ccc333', status: 'done', skip_reason: null,
      created_at: iso(26 * 3_600_000), processed_at: iso(20 * 3_600_000), transcript_source: 'audio', char_len: 91230,
      events: [
        { tier: 'supadata', outcome: 'miss', detail: 'no transcript content in response', duration_ms: 1400, created_at: iso(21 * 3_600_000) },
        { tier: 'audio', outcome: 'rate_limited', detail: 'Groq 429 (audio quota)', duration_ms: 12_000, created_at: iso(20.6 * 3_600_000) },
        { tier: 'audio:groq', outcome: 'hit', detail: null, duration_ms: 96_000, created_at: iso(20.1 * 3_600_000) },
      ],
      dropped_events: 37,
    },
    {
      video_id: 'ddd444', title: 'Deleted video that keeps failing',
      url: 'https://youtube.com/watch?v=ddd444', status: 'failed', skip_reason: 'audio transcription failed',
      created_at: iso(3 * 86_400_000), processed_at: iso(3 * 86_400_000), transcript_source: null, char_len: null,
      events: [
        { tier: 'supadata', outcome: 'error', detail: 'Supadata HTTP 500: upstream', duration_ms: 900, created_at: iso(3 * 86_400_000) },
        { tier: 'audio', outcome: 'error', detail: 'yt-dlp produced no audio file', duration_ms: 31_000, created_at: iso(3 * 86_400_000) },
      ],
      dropped_events: 0,
    },
    {
      video_id: 'eee555', title: 'Short clip skipped by the long-form filter',
      url: 'https://youtube.com/watch?v=eee555', status: 'skipped', skip_reason: 'too_short_under_20m',
      created_at: iso(4 * 86_400_000), processed_at: iso(4 * 86_400_000), transcript_source: null, char_len: null,
      events: [], dropped_events: 0,
    },
  ],
}

const SAMPLE_DIGEST = [
  '🎙️ <b>Simulated episode — the test console works</b>',
  '<i>Mock Channel · 1h12m</i> · <a href="https://youtube.com">watch</a>',
  '',
  '<b>① Key insights</b>',
  '• <b>The loader polls /api/job every 2.5s</b> — journey chips appear as tiers report in.',
  '• <b>The digest renders inline</b> — same Telegram HTML, right in the browser.',
  '',
  '<b>② Patterns &amp; antipatterns</b>',
  '✅ <b>One pipeline, two front doors</b> — web console and /fetch share run-now.ts.',
  '⛔ <b>Stale-done race</b> — avoided: prepare() claims before the 202 returns.',
  '',
  '<b>③ Unbiased grade</b> <i>(by gpt-4o-mini)</i>',
  'Overall: <b>8/10</b> — a fair simulation of the real thing.',
  '',
  '<b>④ For you</b> <i>(relevance: high)</i>',
  '• <b>Click Fetch &amp; digest on a real video</b> — this exact panel shows the live waterfall.',
].join('\n')

// Scripted job progression: each /api/job poll advances one stage.
let jobPolls = 0
const JOB_STAGES = [
  { status: 'processing', transcript_source: null, transcript_chars: null, events: [], digest: null },
  { status: 'processing', transcript_source: null, transcript_chars: null, events: [
    { tier: 'supadata', outcome: 'miss', detail: 'no transcript content in response', duration_ms: 1700, created_at: new Date(now).toISOString() },
  ], digest: null },
  { status: 'processing', transcript_source: 'audio', transcript_chars: 88412, events: [
    { tier: 'supadata', outcome: 'miss', detail: 'no transcript content in response', duration_ms: 1700, created_at: new Date(now).toISOString() },
    { tier: 'audio:groq', outcome: 'hit', detail: null, duration_ms: 64_000, created_at: new Date(now).toISOString() },
  ], digest: null },
  { status: 'done', transcript_source: 'audio', transcript_chars: 88412, events: [
    { tier: 'supadata', outcome: 'miss', detail: 'no transcript content in response', duration_ms: 1700, created_at: new Date(now).toISOString() },
    { tier: 'audio:groq', outcome: 'hit', detail: null, duration_ms: 64_000, created_at: new Date(now).toISOString() },
  ], digest: { id: '99999999-9999-4999-8999-999999999999', created_at: new Date(now).toISOString(), rendered: SAMPLE_DIGEST } },
]

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const j = (body: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  if (req.method === 'POST' && url.pathname === '/api/channels') {
    j({ added: 'Mock Channel', backfilled: 1 })
  } else if (req.method === 'POST' && url.pathname === '/api/fetch') {
    jobPolls = 0
    j({ videoId: 'sim0000001' }, 202)
  } else if (url.pathname === '/api/job') {
    const stage = JOB_STAGES[Math.min(jobPolls++, JOB_STAGES.length - 1)]
    j({ video_id: 'sim0000001', title: 'Simulated episode — the test console works', url: 'https://youtube.com', skip_reason: null, ...stage })
  } else if (url.pathname === '/api/last-digest') {
    j({ id: '99999999-9999-4999-8999-999999999999', title: 'Simulated episode — the test console works', rendered: SAMPLE_DIGEST, created_at: new Date(now - 3_600_000).toISOString() })
  } else if (url.pathname === '/api/waterfall') {
    j(MOCK)
  } else {
    // Big banner so mock data is never mistaken for the real system.
    const banner = '<div style="background:#7a1f1f;color:#fff;text-align:center;padding:10px;font:600 14px system-ui">'
      + '⚠️ LOCAL SIMULATOR — every input returns canned fake data. The real dashboard is your Railway URL.</div>'
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(DASHBOARD_PAGE.replace('<body>', '<body>' + banner))
  }
}).listen(5183, () => console.log('preview (SIMULATED DATA): http://localhost:5183/dashboard?key=preview'))
