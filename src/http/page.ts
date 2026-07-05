// The dashboard page: a single self-contained HTML document (inline CSS + JS,
// no external assets). Kept free of config/db imports so it can be previewed
// standalone. It reads ?key= from its own URL and calls /api/waterfall with it.

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Detail view for one digest record. `rendered` is the bot's own Telegram HTML
 *  (only <b>/<i>/<a> tags, user content already escaped by render.ts) — safe to embed. */
export function digestDetailPage(title: string | null, createdAt: string, rendered: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escHtml(title ?? 'Digest')}</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { background: #0e1116; color: #dbe2ea; font: 15px/1.65 ui-sans-serif, system-ui, sans-serif; padding: 32px; }
  main { max-width: 720px; margin: 0 auto; background: #161b22; border: 1px solid #262d38; border-radius: 10px; padding: 24px 28px; overflow-wrap: break-word; }
  a { color: #58a6ff; }
  .meta { color: #8b98a9; font-size: 12px; margin-bottom: 16px; }
</style>
</head>
<body>
<main>
  <div class="meta">delivered ${escHtml(createdAt)}</div>
  <div>${rendered.replace(/\n/g, '<br>')}</div>
</main>
</body>
</html>`
}

export const DASHBOARD_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>MindMonk — Transcript Waterfall</title>
<style>
  :root {
    --bg: #0e1116; --panel: #161b22; --border: #262d38; --text: #dbe2ea; --dim: #8b98a9;
    --green: #3fb950; --amber: #d29922; --red: #f85149; --gray: #6e7681; --blue: #58a6ff;
  }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--text); font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; padding: 24px; }
  h1 { font-size: 18px; font-weight: 600; }
  h2 { font-size: 13px; font-weight: 600; color: var(--dim); text-transform: uppercase; letter-spacing: .06em; margin: 28px 0 10px; }
  .sub { color: var(--dim); font-size: 12px; margin-top: 2px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-top: 16px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; }
  .card .v { font-size: 20px; font-weight: 650; margin-top: 2px; }
  .card .k { color: var(--dim); font-size: 12px; }
  .card .d { color: var(--dim); font-size: 11px; margin-top: 4px; }
  .tablewrap { overflow-x: auto; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); white-space: nowrap; font-size: 13px; }
  th { color: var(--dim); font-weight: 500; font-size: 12px; }
  tr:last-child td { border-bottom: none; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .chip { display: inline-block; border-radius: 999px; padding: 1px 9px; font-size: 12px; margin-right: 4px; border: 1px solid var(--border); cursor: default; }
  .chip.hit { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); }
  .chip.miss { color: var(--gray); }
  .chip.rate_limited { color: var(--amber); border-color: color-mix(in srgb, var(--amber) 40%, transparent); }
  .chip.error { color: var(--red); border-color: color-mix(in srgb, var(--red) 40%, transparent); }
  .arrow { color: var(--dim); margin-right: 4px; }
  .badge { display: inline-block; border-radius: 5px; padding: 1px 7px; font-size: 12px; font-weight: 550; }
  .badge.done { background: #12261a; color: var(--green); }
  .badge.failed, .badge.no_transcript { background: #2d1416; color: var(--red); }
  .badge.pending, .badge.processing { background: #2b2211; color: var(--amber); }
  .badge.skipped { background: #1c222b; color: var(--gray); }
  a { color: var(--blue); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .title-cell { max-width: 380px; overflow: hidden; text-overflow: ellipsis; }
  #err { display: none; background: #2d1416; color: var(--red); border: 1px solid var(--red); border-radius: 8px; padding: 10px 14px; margin-top: 16px; }
  .muted { color: var(--dim); }
  footer { color: var(--dim); font-size: 12px; margin-top: 28px; }
  .console { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px; display: grid; gap: 10px; }
  .crow { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .crow input[type=text] { flex: 1; min-width: 260px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; color: var(--text); padding: 8px 10px; font: inherit; }
  .crow input[type=text]:focus { outline: none; border-color: var(--blue); }
  button { background: #1f6feb; border: none; border-radius: 6px; color: #fff; padding: 8px 14px; font: inherit; font-weight: 550; cursor: pointer; }
  button:hover { filter: brightness(1.1); }
  button.secondary { background: #21262d; border: 1px solid var(--border); color: var(--text); }
  button:disabled { opacity: .5; cursor: default; }
  .chk { color: var(--dim); font-size: 13px; display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
  #job { border-top: 1px solid var(--border); padding-top: 10px; display: none; }
  .pulse { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--amber); margin-right: 7px; animation: pulse 1.2s ease-in-out infinite; vertical-align: 1px; }
  @keyframes pulse { 0%,100% { opacity: .25 } 50% { opacity: 1 } }
  #jobjourney { margin-top: 8px; }
  #digestout { border-top: 1px solid var(--border); padding-top: 12px; display: none; }
  .dhead { color: var(--dim); font-size: 12px; margin-bottom: 8px; }
  .dbody { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 16px 18px; line-height: 1.65; overflow-wrap: break-word; max-height: 560px; overflow-y: auto; }
</style>
</head>
<body>
  <h1>🔀 MindMonk — Transcript Waterfall</h1>
  <div class="sub" id="meta">loading…</div>
  <div id="err"></div>
  <h2>Test console</h2>
  <div class="console">
    <div class="crow">
      <input type="text" id="chInput" placeholder="Add channel: url, @handle, or UC… id" autocomplete="off">
      <label class="chk"><input type="checkbox" id="chBackfill"> also digest its latest video</label>
      <button id="chAdd">Add channel</button>
      <span id="chMsg" class="muted"></span>
    </div>
    <div class="crow">
      <input type="text" id="vidInput" placeholder="Fetch a video: paste any YouTube url — live waterfall + digest below" autocomplete="off">
      <button id="vidFetch">Fetch &amp; digest</button>
      <button id="lastBtn" class="secondary">Show latest digest</button>
    </div>
    <div id="job">
      <div id="jobstatus"></div>
      <div id="jobjourney"></div>
    </div>
    <div id="digestout"></div>
  </div>
  <div class="cards" id="cards"></div>
  <h2>Channels</h2>
  <div class="tablewrap"><table id="channels"><thead><tr>
    <th>Channel</th><th>Active</th><th>Min dur</th><th>Last checked</th><th>Last upload</th><th class="num">Videos</th><th class="num">Digests</th>
  </tr></thead><tbody></tbody></table></div>
  <h2>Waterfall tiers — last 30 days</h2>
  <div class="tablewrap"><table id="tiers"><thead><tr>
    <th>Tier</th><th class="num">Hit ✓</th><th class="num">Miss —</th><th class="num">Rate-limited ⏳</th><th class="num">Error ✗</th>
  </tr></thead><tbody></tbody></table></div>
  <h2>Recent videos</h2>
  <div class="tablewrap"><table id="recent"><thead><tr>
    <th>When</th><th>Video</th><th>Status</th><th>Journey (hover a chip for detail)</th><th>Source</th><th class="num">Chars</th>
  </tr></thead><tbody></tbody></table></div>
  <h2>Digest records</h2>
  <div class="tablewrap"><table id="digests"><thead><tr>
    <th>Delivered</th><th>Video</th><th>Extract model</th><th>③ Grade</th><th class="num">Length</th><th></th>
  </tr></thead><tbody></tbody></table></div>
  <footer>Auto-refreshes every 60s · times shown in your local timezone</footer>
<script>
(function () {
  var KEY = new URLSearchParams(location.search).get('key') || ''

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }
  function ago(iso) {
    if (!iso) return ''
    var s = (Date.now() - new Date(iso).getTime()) / 1000
    if (!isFinite(s)) return ''
    if (s < 90) return Math.round(s) + 's ago'
    if (s < 5400) return Math.round(s / 60) + 'm ago'
    if (s < 129600) return Math.round(s / 3600) + 'h ago'
    return Math.round(s / 86400) + 'd ago'
  }
  function usd(n) { return '$' + Number(n || 0).toFixed(2) }

  function card(k, v, d) {
    return '<div class="card"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div>'
      + (d ? '<div class="d">' + esc(d) + '</div>' : '') + '</div>'
  }

  function journeyHtml(events, dropped, status) {
    if (!events || !events.length) {
      return '<span class="muted">' + (status === 'pending' || status === 'processing'
        ? '(queued — not attempted yet)' : '(no attempts logged)') + '</span>'
    }
    var prefix = dropped > 0 ? '<span class="chip miss" title="older attempts beyond the 12-per-video display cap">+' + Number(dropped) + ' earlier</span><span class="arrow">→</span>' : ''
    return prefix + events.map(function (e, i) {
      var icon = { hit: '✓', miss: '—', rate_limited: '⏳', error: '✗' }[e.outcome] || '?'
      var secs = e.duration_ms >= 1000 ? ' ' + Math.round(e.duration_ms / 1000) + 's' : ''
      var tip = e.detail ? ' title="' + esc(e.detail) + '"' : ''
      return (i ? '<span class="arrow">→</span>' : '')
        + '<span class="chip ' + esc(e.outcome) + '"' + tip + '>' + esc(e.tier) + ' ' + icon + esc(secs) + '</span>'
    }).join('')
  }

  function render(d) {
    document.getElementById('meta').textContent =
      'generated ' + new Date(d.generatedAt).toLocaleString() + ' · refreshed ' + new Date().toLocaleTimeString()

    var statuses = Object.entries(d.statuses || {}).map(function (kv) { return kv[0] + ' ' + kv[1] }).join(' · ') || 'none'
    var sources = (d.sources || []).map(function (s) { return (s.source || '?') + ' ' + s.n }).join(' · ') || 'none yet'
    var byProv = (d.spend.by_provider || []).map(function (p) {
      return (p.provider || '?') + '/' + p.kind + ' ' + usd(p.usd)
    }).join(' · ')
    document.getElementById('cards').innerHTML =
      card('Spend today', usd(d.spend.today_usd), 'daily cap pauses the pipeline, never loses jobs')
      + card('Spend — 30 days', usd(d.spend.last30_usd), byProv)
      + card('Videos by status', statuses)
      + card('Transcript sources (all-time)', sources)

    document.querySelector('#channels tbody').innerHTML = (d.channels || []).map(function (c) {
      var name = c.title || c.handle || '?'
      var link = c.url ? '<a href="' + esc(c.url) + '" target="_blank" rel="noreferrer">' + esc(name) + '</a>' : esc(name)
      return '<tr><td class="title-cell">' + link + '</td>'
        + '<td>' + (c.active ? '<span class="badge done">active</span>' : '<span class="badge skipped">paused</span>') + '</td>'
        + '<td>' + (c.min_duration_minutes != null ? esc(c.min_duration_minutes) + 'm' : '<span class="muted">global</span>') + '</td>'
        + '<td title="' + esc(c.last_checked_at) + '">' + esc(ago(c.last_checked_at) || 'never') + '</td>'
        + '<td title="' + esc(c.last_published) + '">' + esc(ago(c.last_published) || '—') + '</td>'
        + '<td class="num">' + Number(c.videos || 0) + '</td>'
        + '<td class="num">' + Number(c.digests || 0) + '</td></tr>'
    }).join('') || '<tr><td colspan="7" class="muted">no channels tracked — add one with /add in Telegram</td></tr>'

    var order = ['cache', 'supadata', 'audio', 'audio:groq', 'audio:openai']
    var byTier = {}
    ;(d.tiers || []).forEach(function (t) {
      byTier[t.tier] = byTier[t.tier] || {}
      byTier[t.tier][t.outcome] = t.n
    })
    var tiers = Object.keys(byTier).sort(function (a, b) {
      var ia = order.indexOf(a), ib = order.indexOf(b)
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
    })
    document.querySelector('#tiers tbody').innerHTML = tiers.length ? tiers.map(function (t) {
      var o = byTier[t]
      function n(k) { return o[k] ? String(o[k]) : '<span class="muted">·</span>' }
      return '<tr><td>' + esc(t) + '</td><td class="num">' + n('hit') + '</td><td class="num">' + n('miss')
        + '</td><td class="num">' + n('rate_limited') + '</td><td class="num">' + n('error') + '</td></tr>'
    }).join('') : '<tr><td colspan="5" class="muted">no attempts recorded yet — events appear as new videos are processed</td></tr>'

    document.querySelector('#recent tbody').innerHTML = (d.recent || []).map(function (r) {
      var title = r.title || r.video_id
      var link = r.url ? '<a href="' + esc(r.url) + '" target="_blank" rel="noreferrer">' + esc(title) + '</a>' : esc(title)
      var status = '<span class="badge ' + esc(r.status) + '">' + esc(r.status) + '</span>'
        + (r.skip_reason ? ' <span class="muted" title="' + esc(r.skip_reason) + '">ⓘ</span>' : '')
      return '<tr><td title="' + esc(r.created_at) + '">' + esc(ago(r.created_at)) + '</td>'
        + '<td class="title-cell">' + link + '</td>'
        + '<td>' + status + '</td>'
        + '<td>' + journeyHtml(r.events, r.dropped_events, r.status) + '</td>'
        + '<td>' + esc(r.transcript_source || '') + '</td>'
        + '<td class="num">' + (r.char_len ? Number(r.char_len).toLocaleString() : '') + '</td></tr>'
    }).join('') || '<tr><td colspan="6" class="muted">no videos yet</td></tr>'

    document.querySelector('#digests tbody').innerHTML = (d.digests || []).map(function (g) {
      var title = g.title || '(untitled)'
      var link = g.url ? '<a href="' + esc(g.url) + '" target="_blank" rel="noreferrer">' + esc(title) + '</a>' : esc(title)
      var grade = g.has_grade
        ? '<span class="badge done" title="' + esc(g.grader_model) + '">✓ ' + esc(g.grader_model || 'on') + '</span>'
        : '<span class="badge failed">missing</span>'
      var view = '<a href="/digest/' + esc(g.id) + '?key=' + encodeURIComponent(KEY) + '" target="_blank" rel="noreferrer">view</a>'
      return '<tr><td title="' + esc(g.created_at) + '">' + esc(ago(g.created_at)) + '</td>'
        + '<td class="title-cell">' + link + '</td>'
        + '<td>' + esc(g.primary_model || '') + '</td>'
        + '<td>' + grade + '</td>'
        + '<td class="num">' + (g.rendered_len ? Number(g.rendered_len).toLocaleString() : '') + '</td>'
        + '<td>' + view + '</td></tr>'
    }).join('') || '<tr><td colspan="6" class="muted">no digests delivered yet</td></tr>'
  }

  // ---- Test console -----------------------------------------------------
  function postJson(path, body) {
    return fetch(path + '?key=' + encodeURIComponent(KEY), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (res) { return res.json().then(function (j) { return { ok: res.ok, status: res.status, body: j } }) })
  }

  function showDigest(title, createdAt, rendered) {
    var out = document.getElementById('digestout')
    out.style.display = 'block'
    out.innerHTML = '<div class="dhead">' + esc(title || 'Digest') + ' · delivered ' + esc(ago(createdAt) || createdAt) + '</div>'
      + '<div class="dbody">' + String(rendered || '').replace(/\\n/g, '<br>') + '</div>'
    out.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  var pollTimer = null
  var pollStarted = 0

  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null } }

  function setJobStatus(html) {
    var j = document.getElementById('job')
    j.style.display = 'block'
    document.getElementById('jobstatus').innerHTML = html
  }

  function pollJob(videoId) {
    fetch('/api/job?video=' + encodeURIComponent(videoId) + '&key=' + encodeURIComponent(KEY))
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json() })
      .then(function (s) {
        var title = s.title || s.video_id
        document.getElementById('jobjourney').innerHTML = journeyHtml(s.events, 0, s.status)
        if (s.status === 'processing' || (s.status === 'pending' && !s.skip_reason)) {
          var stage = s.transcript_source
            ? 'transcript ✓ via ' + esc(s.transcript_source) + (s.transcript_chars ? ' (' + Number(s.transcript_chars).toLocaleString() + ' chars)' : '') + ' — extracting ①②③④…'
            : 'acquiring transcript — waterfall running…'
          setJobStatus('<span class="pulse"></span><b>' + esc(title) + '</b> — ' + stage)
          if (Date.now() - pollStarted > 15 * 60 * 1000) { stopPolling(); setJobStatus('⏱ still running after 15 min — check Telegram or refresh later') }
          return
        }
        stopPolling()
        load() // refresh tables once terminal
        if (s.status === 'done' && s.digest) {
          setJobStatus('✅ <b>' + esc(title) + '</b> — delivered (also sent to Telegram)')
          showDigest(title, s.digest.created_at, s.digest.rendered)
        } else if (s.status === 'pending' && (s.skip_reason === 'rate_limited' || s.skip_reason === 'spend_cap')) {
          setJobStatus('⏳ <b>' + esc(title) + '</b> — ' + (s.skip_reason === 'rate_limited'
            ? 'ASR rate-limited; queued — the worker will deliver it automatically within the hour'
            : 'daily spend cap reached; queued — delivers after the cap resets'))
        } else if (s.status === 'skipped') {
          setJobStatus('⏭️ <b>' + esc(title) + '</b> — skipped (' + esc(s.skip_reason || '') + ')')
        } else {
          setJobStatus('❌ <b>' + esc(title) + '</b> — ' + esc(s.skip_reason || s.status))
        }
      })
      .catch(function () { /* transient poll error — keep the timer running */ })
  }

  document.getElementById('chAdd').addEventListener('click', function () {
    var input = document.getElementById('chInput').value.trim()
    var msg = document.getElementById('chMsg')
    if (!input) { msg.textContent = 'paste a channel url / @handle first'; return }
    var btn = document.getElementById('chAdd')
    btn.disabled = true
    msg.textContent = 'resolving channel…'
    postJson('/api/channels', { input: input, backfill: document.getElementById('chBackfill').checked })
      .then(function (r) {
        btn.disabled = false
        if (!r.ok) { msg.textContent = '✗ ' + (r.body.error || 'failed'); return }
        msg.textContent = '✅ added ' + r.body.added + (r.body.backfilled ? ' — latest video queued, digest coming' : '')
        document.getElementById('chInput').value = ''
        load()
      })
      .catch(function (e) { btn.disabled = false; msg.textContent = '✗ ' + e.message })
  })

  document.getElementById('vidFetch').addEventListener('click', function () {
    var url = document.getElementById('vidInput').value.trim()
    if (!url) { setJobStatus('paste a YouTube video url first'); return }
    stopPolling()
    document.getElementById('digestout').style.display = 'none'
    setJobStatus('<span class="pulse"></span>starting…')
    document.getElementById('jobjourney').innerHTML = ''
    postJson('/api/fetch', { url: url })
      .then(function (r) {
        if (!r.ok && r.status !== 409) { setJobStatus('✗ ' + (r.body.error || 'failed to start')); return }
        pollStarted = Date.now()
        var vid = r.body.videoId
        pollJob(vid)
        pollTimer = setInterval(function () { pollJob(vid) }, 2500)
      })
      .catch(function (e) { setJobStatus('✗ ' + e.message) })
  })

  document.getElementById('lastBtn').addEventListener('click', function () {
    fetch('/api/last-digest?key=' + encodeURIComponent(KEY))
      .then(function (res) { if (!res.ok) throw new Error(res.status === 404 ? 'no digests yet' : 'HTTP ' + res.status); return res.json() })
      .then(function (d) { showDigest(d.title, d.created_at, d.rendered) })
      .catch(function (e) { setJobStatus('✗ ' + e.message) })
  })

  function load() {
    fetch('/api/waterfall?key=' + encodeURIComponent(KEY))
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status + (res.status === 401 ? ' — add ?key=<DASHBOARD_SECRET> to the URL' : ''))
        return res.json()
      })
      .then(function (d) { document.getElementById('err').style.display = 'none'; render(d) })
      .catch(function (e) {
        var el = document.getElementById('err')
        el.textContent = 'Failed to load: ' + e.message
        el.style.display = 'block'
      })
  }
  load()
  setInterval(load, 60000)
})()
</script>
</body>
</html>
`
