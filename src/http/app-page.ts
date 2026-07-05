// Multi-user pages (spec §7): login/signup + the per-user console. Same
// self-contained dark theme as the admin dashboard; no external assets.

const THEME = `
  :root { --bg:#0e1116; --panel:#161b22; --border:#262d38; --text:#dbe2ea; --dim:#8b98a9;
          --green:#3fb950; --red:#f85149; --blue:#58a6ff; --amber:#d29922; }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--text); font:15px/1.55 ui-sans-serif,system-ui,sans-serif; }
  input[type=text],input[type=email],input[type=password] { width:100%; background:var(--bg); border:1px solid var(--border);
    border-radius:6px; color:var(--text); padding:10px 12px; font:inherit; }
  input:focus { outline:none; border-color:var(--blue); }
  button { background:#1f6feb; border:none; border-radius:6px; color:#fff; padding:10px 16px; font:inherit;
    font-weight:550; cursor:pointer; }
  button:hover { filter:brightness(1.1); }
  button.secondary { background:#21262d; border:1px solid var(--border); color:var(--text); }
  button:disabled { opacity:.5; cursor:default; }
  .muted { color:var(--dim); }
  .err { color:var(--red); }
  .ok { color:var(--green); }
`

export const LOGIN_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>MindMonk — Sign in</title>
<style>${THEME}
  main { max-width:400px; margin:9vh auto; padding:0 16px; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:26px; }
  h1 { font-size:20px; margin-bottom:4px; }
  .sub { color:var(--dim); font-size:13px; margin-bottom:20px; }
  .tabs { display:flex; gap:6px; margin-bottom:18px; }
  .tabs button { flex:1; background:#21262d; border:1px solid var(--border); color:var(--dim); }
  .tabs button.active { background:#1f6feb; border-color:#1f6feb; color:#fff; }
  label { display:block; font-size:13px; color:var(--dim); margin:12px 0 5px; }
  #msg { margin-top:14px; font-size:14px; min-height:20px; }
  .go { width:100%; margin-top:18px; }
</style>
</head>
<body>
<main><div class="card">
  <h1>🎙️ MindMonk</h1>
  <div class="sub">Hours of podcasts, distilled to minutes — in your Telegram.</div>
  <div class="tabs"><button id="tabIn" class="active">Sign in</button><button id="tabUp">Create account</button></div>
  <form id="f">
    <label>Email</label><input type="email" id="email" autocomplete="username" required>
    <label>Password</label><input type="password" id="pw" autocomplete="current-password" required minlength="10">
    <div id="inviteRow" style="display:none"><label>Invite code</label><input type="text" id="invite" autocomplete="off"></div>
    <button class="go" id="go" type="submit">Sign in</button>
  </form>
  <div id="msg"></div>
</div></main>
<script>
(function () {
  var mode = 'in'
  function setMode(m) {
    mode = m
    document.getElementById('tabIn').className = m === 'in' ? 'active' : ''
    document.getElementById('tabUp').className = m === 'up' ? 'active' : ''
    document.getElementById('inviteRow').style.display = m === 'up' ? 'block' : 'none'
    document.getElementById('go').textContent = m === 'in' ? 'Sign in' : 'Create account'
    document.getElementById('pw').autocomplete = m === 'in' ? 'current-password' : 'new-password'
    document.getElementById('msg').textContent = ''
  }
  document.getElementById('tabIn').addEventListener('click', function (e) { e.preventDefault(); setMode('in') })
  document.getElementById('tabUp').addEventListener('click', function (e) { e.preventDefault(); setMode('up') })
  document.getElementById('f').addEventListener('submit', function (e) {
    e.preventDefault()
    var msg = document.getElementById('msg'); var go = document.getElementById('go')
    go.disabled = true; msg.className = 'muted'; msg.textContent = '…'
    fetch(mode === 'in' ? '/api/login' : '/api/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' },
      body: JSON.stringify({
        email: document.getElementById('email').value.trim(),
        password: document.getElementById('pw').value,
        invite: document.getElementById('invite').value.trim(),
      }),
    }).then(function (res) { return res.json().then(function (j) { return { ok: res.ok, j: j } }) })
      .then(function (r) {
        go.disabled = false
        if (r.ok) { location.href = '/app' } else { msg.className = 'err'; msg.textContent = r.j.error || 'failed' }
      })
      .catch(function () { go.disabled = false; msg.className = 'err'; msg.textContent = 'network error' })
  })
})()
</script>
</body>
</html>`

export const APP_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>MindMonk — My channels</title>
<style>${THEME}
  main { max-width:660px; margin:0 auto; padding:26px 16px 60px; }
  header { display:flex; justify-content:space-between; align-items:center; margin-bottom:22px; }
  h1 { font-size:19px; }
  h2 { font-size:13px; font-weight:600; color:var(--dim); text-transform:uppercase; letter-spacing:.06em; margin:26px 0 10px; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:18px; }
  .row { display:flex; gap:8px; align-items:center; }
  .row input { flex:1; }
  ul { list-style:none; }
  li { display:flex; justify-content:space-between; align-items:center; padding:10px 4px; border-bottom:1px solid var(--border); }
  li:last-child { border-bottom:none; }
  li a { color:var(--blue); text-decoration:none; }
  .x { background:none; border:none; color:var(--dim); cursor:pointer; font-size:15px; padding:4px 8px; }
  .x:hover { color:var(--red); }
  #qrbox { text-align:center; padding:10px 0; display:none; }
  #qrbox img { width:220px; height:220px; border-radius:8px; background:#fff; padding:8px; }
  #qrbox .dl { margin-top:10px; font-size:13px; overflow-wrap:anywhere; word-break:break-all; }
  .pill { display:inline-block; border-radius:999px; padding:2px 11px; font-size:12px; font-weight:550; }
  .pill.on { background:#12261a; color:var(--green); }
  .pill.off { background:#2b2211; color:var(--amber); }
  #note { font-size:13px; color:var(--dim); margin-top:8px; }
</style>
</head>
<body>
<main>
  <header><h1>🎙️ MindMonk</h1>
    <div class="row"><span class="muted" id="who"></span><button class="secondary" id="logout">Sign out</button></div>
  </header>

  <h2>Telegram</h2>
  <div class="card">
    <div class="row" style="justify-content:space-between">
      <div>Status: <span id="tg" class="pill off">checking…</span></div>
      <div class="row">
        <button id="linkBtn">Link Telegram</button>
        <button id="unlinkBtn" class="secondary" style="display:none">Unlink</button>
      </div>
    </div>
    <div id="qrbox">
      <p class="muted" style="margin-bottom:10px">Scan with your phone — it opens Telegram and links this account. Expires in <span id="ttl">10:00</span>.</p>
      <img id="qr" alt="QR code">
      <div class="dl">or tap: <a id="deep" target="_blank" rel="noreferrer"></a></div>
    </div>
    <div id="note">Link your Telegram so your digests can be delivered there. Per-account delivery is rolling out — for now your channels are saved to your account.</div>
  </div>

  <h2>My channels</h2>
  <div class="card">
    <div class="row">
      <input type="text" id="chInput" placeholder="YouTube channel url, @handle, or UC… id" autocomplete="off">
      <button id="chAdd">Add</button>
    </div>
    <div id="chMsg" class="muted" style="min-height:20px; margin-top:8px"></div>
    <ul id="chList"></ul>
  </div>
</main>
<script>
(function () {
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] }) }
  function post(path, body) {
    return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify(body || {}) })
      .then(function (res) { if (res.status === 401) { location.href = '/login'; throw new Error('401') } return res.json().then(function (j) { return { ok: res.ok, j: j } }) })
  }
  function get(path) {
    return fetch(path, { headers: { 'x-requested-with': 'fetch' } })
      .then(function (res) { if (res.status === 401) { location.href = '/login'; throw new Error('401') } return res.json() })
  }

  var linked = false, qrTimer = null, ttlTimer = null

  function setLinked(v) {
    linked = v
    var el = document.getElementById('tg')
    el.className = 'pill ' + (v ? 'on' : 'off')
    el.textContent = v ? 'linked ✓' : 'not linked'
    document.getElementById('linkBtn').style.display = v ? 'none' : ''
    document.getElementById('unlinkBtn').style.display = v ? '' : 'none'
    if (v) hideQr()
  }
  function hideQr() {
    document.getElementById('qrbox').style.display = 'none'
    if (qrTimer) { clearInterval(qrTimer); qrTimer = null }
    if (ttlTimer) { clearInterval(ttlTimer); ttlTimer = null }
  }

  function refreshMe() {
    get('/api/me').then(function (me) {
      document.getElementById('who').textContent = me.email
      setLinked(me.linked)
    })
  }

  var linkBtn = document.getElementById('linkBtn')
  linkBtn.addEventListener('click', function () {
    if (linkBtn.disabled) return
    linkBtn.disabled = true
    hideQr() // clear any prior QR's timers before starting a fresh one (no zombie intervals)
    post('/api/link/start').then(function (r) {
      linkBtn.disabled = false
      if (!r.ok) { document.getElementById('note').textContent = 'Could not start linking — try again.'; return }
      document.getElementById('qr').src = r.j.qr
      var a = document.getElementById('deep'); a.href = r.j.deepLink; a.textContent = r.j.deepLink
      document.getElementById('qrbox').style.display = 'block'
      // Deadline-based countdown (not decrement) so a throttled background tab can't
      // show a "valid" QR after the token has actually expired.
      var deadline = Date.now() + r.j.expiresInSeconds * 1000
      ttlTimer = setInterval(function () {
        var left = Math.round((deadline - Date.now()) / 1000)
        if (left <= 0) { hideQr(); return }
        var m = Math.floor(left / 60), s = left % 60
        document.getElementById('ttl').textContent = m + ':' + (s < 10 ? '0' : '') + s
      }, 1000)
      qrTimer = setInterval(function () {
        get('/api/link/status').then(function (s) { if (s.linked) { setLinked(true) } }).catch(function () {})
      }, 3000)
    }).catch(function () { linkBtn.disabled = false; document.getElementById('note').textContent = 'Network error — try again.' })
  })
  document.getElementById('unlinkBtn').addEventListener('click', function () {
    post('/api/link/unlink').then(function () { setLinked(false) })
  })
  document.getElementById('logout').addEventListener('click', function () {
    post('/api/logout').then(function () { location.href = '/login' })
  })

  function renderSubs(subs) {
    document.getElementById('chList').innerHTML = subs.map(function (s) {
      var name = s.title || s.handle || '?'
      var link = s.url ? '<a href="' + esc(s.url) + '" target="_blank" rel="noreferrer">' + esc(name) + '</a>' : esc(name)
      return '<li><span>' + link + '</span><button class="x" data-id="' + esc(s.id) + '" title="unsubscribe">✕</button></li>'
    }).join('') || '<li class="muted">no channels yet — add your first above</li>'
  }
  function refreshSubs() { get('/api/subscriptions').then(function (r) { renderSubs(r.subscriptions) }) }

  document.getElementById('chAdd').addEventListener('click', function () {
    var input = document.getElementById('chInput'); var msg = document.getElementById('chMsg')
    if (!input.value.trim()) { msg.textContent = 'paste a channel url or @handle first'; return }
    var btn = document.getElementById('chAdd'); btn.disabled = true; msg.textContent = 'resolving…'
    post('/api/subscriptions', { input: input.value.trim() }).then(function (r) {
      btn.disabled = false
      if (!r.ok) { msg.className = 'err'; msg.textContent = r.j.error || 'failed'; return }
      msg.className = 'ok'; msg.textContent = '✓ subscribed to ' + r.j.title
      input.value = ''
      refreshSubs()
    }).catch(function () { btn.disabled = false })
  })
  document.getElementById('chList').addEventListener('click', function (e) {
    var id = e.target && e.target.getAttribute && e.target.getAttribute('data-id')
    if (!id) return
    post('/api/subscriptions/remove', { id: id }).then(refreshSubs)
  })

  refreshMe(); refreshSubs()
})()
</script>
</body>
</html>`
