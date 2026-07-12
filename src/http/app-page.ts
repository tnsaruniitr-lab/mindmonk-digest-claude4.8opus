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
<title>MindMonk — Hours of podcasts, distilled to minutes</title>
<style>
  * { box-sizing:border-box; margin:0; }
  :root { --ink:#0a0f14; --text:#eef3f6; --dim:#a8b8c2; --line:rgba(255,255,255,.09);
          --red:#ff8f85; --green:#7ee2a0; }
  html,body { height:100%; }
  body { background:var(--ink); color:var(--text); font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
         overflow-x:hidden; }

  /* ---- cinematic backdrop: slow-drifting aerial forest, kept bright + natural.
     The veil only darkens where text sits (left column + bottom edge) so the
     forest's true greens stay clear and vivid on the right. ---- */
  .bg, .bg video, .veil { position:fixed; inset:0; }
  .bg { z-index:-2; background:linear-gradient(160deg,#10301f 0%,#17422c 50%,#1d4f34 100%); }
  .bg video { width:100%; height:100%; object-fit:cover; animation:drift 42s ease-in-out infinite alternate; }
  @keyframes drift { from { transform:scale(1.02) translateY(0); } to { transform:scale(1.13) translateY(-2.2%); } }
  .veil { z-index:-1; background:
      linear-gradient(100deg, rgba(6,14,10,.78) 0%, rgba(6,14,10,.45) 40%, rgba(6,14,10,.08) 66%, rgba(6,14,10,0) 100%),
      linear-gradient(to top, rgba(6,14,10,.55), transparent 26%); }

  /* ---- layout ---- */
  .wrap { min-height:100%; display:grid; grid-template-columns:minmax(0,1.15fr) minmax(340px,420px);
          gap:6vw; align-items:center; max-width:1200px; margin:0 auto; padding:9vh 6vw; }
  @media (max-width:900px) { .wrap { grid-template-columns:1fr; gap:44px; padding:7vh 22px; } }

  /* ---- hero copy ---- */
  .brand { display:flex; align-items:center; gap:10px; margin-bottom:5.5vh; font-weight:650; letter-spacing:.02em; }
  .brand .dot { width:34px; height:34px; border-radius:11px; display:grid; place-items:center; font-size:17px;
    background:linear-gradient(135deg, rgba(240,160,70,.9), rgba(200,90,50,.85)); box-shadow:0 6px 24px rgba(230,140,60,.35); }
  h1 { font-size:clamp(34px,4.6vw,58px); line-height:1.06; letter-spacing:-.022em; font-weight:760; }
  h1 em { font-family:Georgia,'Times New Roman',serif; font-style:italic; font-weight:500;
    background:linear-gradient(92deg,#ffd9a0,#f09b4a 60%,#e37b45); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .lede { margin-top:18px; max-width:46ch; color:var(--dim); font-size:clamp(15px,1.35vw,17.5px); }
  .points { margin-top:4.5vh; display:grid; gap:13px; max-width:52ch; }
  .pt { display:flex; gap:12px; align-items:baseline; color:#cdd9e1; font-size:14.5px; }
  .pt b { color:var(--text); font-weight:640; }
  .pt .n { flex:none; font-size:13px; color:#f3b56e; }
  .beta { margin-top:4.5vh; font-size:12.5px; letter-spacing:.14em; text-transform:uppercase; color:rgba(240,180,120,.75); }

  /* ---- staged entrance ---- */
  .up { opacity:0; transform:translateY(18px); animation:up .9s cubic-bezier(.16,.84,.32,1) forwards; }
  .d1{animation-delay:.08s} .d2{animation-delay:.22s} .d3{animation-delay:.38s} .d4{animation-delay:.55s}
  .d5{animation-delay:.72s} .d6{animation-delay:.92s}
  @keyframes up { to { opacity:1; transform:none; } }

  /* ---- glass card ---- */
  .card { background:rgba(11,16,22,.52); backdrop-filter:blur(20px) saturate(150%); -webkit-backdrop-filter:blur(20px) saturate(150%);
    border:1px solid var(--line); border-radius:18px; padding:30px 28px 26px;
    box-shadow:0 30px 80px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.06); }
  .card h2 { font-size:17px; font-weight:650; margin-bottom:18px; }
  .tabs { display:flex; background:rgba(255,255,255,.06); border-radius:11px; padding:4px; margin-bottom:20px; }
  .tabs button { flex:1; background:transparent; border:none; border-radius:8px; color:var(--dim); padding:9px 0;
    font:inherit; font-size:14px; font-weight:600; cursor:pointer; transition:all .25s ease; }
  .tabs button.active { background:linear-gradient(135deg,#e89543,#d06a3e); color:#fff; box-shadow:0 4px 18px rgba(224,128,60,.35); }
  label { display:block; font-size:12.5px; letter-spacing:.03em; color:var(--dim); margin:14px 0 6px; }
  input[type=text],input[type=email],input[type=password] { width:100%; background:rgba(8,12,17,.65); border:1px solid var(--line);
    border-radius:10px; color:var(--text); padding:12px 14px; font:inherit; transition:border-color .2s, box-shadow .2s; }
  input:focus { outline:none; border-color:rgba(240,160,80,.65); box-shadow:0 0 0 3px rgba(240,160,80,.18); }
  .go { width:100%; margin-top:22px; background:linear-gradient(135deg,#efa14b,#d3653b); border:none; border-radius:11px;
    color:#fff; padding:13px 16px; font:inherit; font-size:15px; font-weight:680; letter-spacing:.01em; cursor:pointer;
    box-shadow:0 10px 30px rgba(228,130,60,.35); transition:transform .18s ease, box-shadow .25s ease, filter .2s; }
  .go:hover { transform:translateY(-1px); filter:brightness(1.07); box-shadow:0 14px 36px rgba(228,130,60,.45); }
  .go:active { transform:translateY(0); }
  .go:disabled { opacity:.55; cursor:default; transform:none; }
  #msg { margin-top:14px; font-size:14px; min-height:20px; }
  .muted{color:var(--dim)} .err{color:var(--red)} .ok{color:var(--green)}
  .fine { margin-top:16px; font-size:12.5px; color:rgba(168,184,194,.75); text-align:center; }

  @media (prefers-reduced-motion: reduce) {
    .bg video { animation:none; }
    .up { opacity:1; transform:none; animation:none; }
    .go, .tabs button { transition:none; }
  }
</style>
</head>
<body>
<div class="bg" aria-hidden="true">
  <video autoplay muted loop playsinline preload="metadata" src="/assets/hero.mp4"></video>
</div>
<div class="veil" aria-hidden="true"></div>
<div class="wrap">
  <section>
    <div class="brand up d1"><span class="dot">🎙️</span> MindMonk</div>
    <h1><span class="up d2" style="display:block">Hours of podcasts,</span>
        <span class="up d3" style="display:block"><em>distilled</em> to minutes.</span></h1>
    <p class="lede up d4">Follow the voices you trust. Every new long-form episode arrives in your Telegram as a calm,
      four-part digest — graded for substance by a second, independent AI, and tailored to what you're building.</p>
    <div class="points up d5">
      <div class="pt"><span class="n">①</span><span><b>Key insights</b> — the ideas a sharp listener would underline</span></div>
      <div class="pt"><span class="n">②</span><span><b>Patterns &amp; antipatterns</b> — what works, what to avoid</span></div>
      <div class="pt"><span class="n">③</span><span><b>Second-opinion grade</b> — a separate model marks the homework</span></div>
      <div class="pt"><span class="n">④</span><span><b>For you</b> — mapped to your goals, with concrete next actions</span></div>
    </div>
    <div class="beta up d6">Invite-only beta · digests delivered on Telegram</div>
  </section>

  <main class="card up d4">
    <h2>Welcome</h2>
    <div class="tabs"><button id="tabIn" class="active">Sign in</button><button id="tabUp">Create account</button></div>
    <form id="f">
      <label>Email</label><input type="email" id="email" autocomplete="username" required>
      <label>Password</label><input type="password" id="pw" autocomplete="current-password" required minlength="10">
      <div id="inviteRow" style="display:none"><label>Invite code</label><input type="text" id="invite" autocomplete="off"></div>
      <button class="go" id="go" type="submit">Sign in</button>
    </form>
    <div id="msg"></div>
    <div class="fine">One QR scan links your Telegram — digests flow from there.</div>
  </main>
</div>
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
    <div id="note">Link your Telegram — digests for your channels are delivered there, personalized to your profile below.</div>
  </div>

  <h2>My channels</h2>
  <div class="card">
    <div class="row">
      <input type="text" id="chInput" placeholder="YouTube channel url, @handle, or UC… id" autocomplete="off">
      <button id="chAdd">Add</button>
    </div>
    <div id="chMsg" class="muted" style="min-height:20px; margin-top:8px"></div>
    <ul id="chList"></ul>
    <div class="muted" style="font-size:13px; margin-top:6px">A sample digest of the latest episode arrives shortly after you subscribe — then every new long-form upload.</div>
  </div>

  <h2>My profile</h2>
  <div class="card">
    <textarea id="pfText" rows="5" maxlength="4000" placeholder="Who you are, your goals, current projects — section ④ of every digest is tailored to this." style="width:100%; resize:vertical"></textarea>
    <div class="row" style="justify-content:space-between; margin-top:8px">
      <span id="pfMsg" class="muted"></span>
      <button id="pfSave">Save profile</button>
    </div>
  </div>

  <h2>My digests</h2>
  <div class="card">
    <ul id="dgList"></ul>
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
      msg.className = 'ok'; msg.textContent = '✓ subscribed to ' + r.j.title + ' — sample digest on its way (a few minutes)'
      input.value = ''
      refreshSubs(); setTimeout(refreshDigests, 4000)
    }).catch(function () { btn.disabled = false })
  })
  document.getElementById('chList').addEventListener('click', function (e) {
    var id = e.target && e.target.getAttribute && e.target.getAttribute('data-id')
    if (!id) return
    post('/api/subscriptions/remove', { id: id }).then(refreshSubs)
  })

  function refreshProfile() {
    get('/api/profile').then(function (r) { document.getElementById('pfText').value = r.profile || '' })
  }
  document.getElementById('pfSave').addEventListener('click', function () {
    var btn = document.getElementById('pfSave'); var msg = document.getElementById('pfMsg')
    btn.disabled = true; msg.textContent = 'saving…'
    post('/api/profile', { text: document.getElementById('pfText').value }).then(function (r) {
      btn.disabled = false
      msg.className = r.ok ? 'ok' : 'err'
      msg.textContent = r.ok ? '✓ saved' : (r.j.error || 'failed')
    }).catch(function () { btn.disabled = false; msg.className = 'err'; msg.textContent = 'network error' })
  })

  function renderDigests(digests) {
    document.getElementById('dgList').innerHTML = digests.map(function (d) {
      var name = d.title || '(untitled)'
      var body = d.has_render ? '<a href="/app/digest/' + esc(d.id) + '">' + esc(name) + '</a>' : esc(name)
      return '<li><span>' + body + '</span><span class="pill ' + (d.status === 'delivered' ? 'on' : 'off') + '">' + esc(d.status) + '</span></li>'
    }).join('') || '<li class="muted">no digests yet — they arrive as your channels publish new episodes</li>'
  }
  function refreshDigests() { get('/api/digests').then(function (r) { renderDigests(r.digests) }) }

  refreshMe(); refreshSubs(); refreshProfile(); refreshDigests()
})()
</script>
</body>
</html>`
