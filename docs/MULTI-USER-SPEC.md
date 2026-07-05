# MindMonk — Multi-User Architecture Spec

**Date:** 2026-07-05 · **Status:** proposed, not built · **Author:** design pass (5-agent understand fleet, partial — token limit; completed by direct analysis)

Turns the single-owner digest bot into a loginable, multi-user web app: email+password signup/login, a per-user web console (add channels, fetch videos, view own digests), and a **QR-code → Telegram handshake** that links a web account to a Telegram chat with one scan. Owner's current experience keeps working throughout.

---

## 1. The core decision: fresh auth layer, NOT a phase-2b merge

There's an existing hardened-but-undeployed `phase-2b-multitenant-pipeline` branch (~5,800 lines: users/subscriptions/user_deliveries/quota/fan-out, 50 green tests). **We do not merge it.** We build the auth + fan-out fresh on the deployed `waterfall-dashboard` branch, lifting phase-2b's *table shapes and quota logic as a reference*, not its code.

Why:
1. **phase-2b has zero web auth.** It identifies users by Telegram chat ID (Telegram-first). Signup/login/password/session/QR — the bulk of this ask — is net-new either way.
2. **Heavy merge conflict.** phase-2b predates this session's work (waterfall logging woven into the pipeline, dashboard/console, cost routing). Both branches edit the same hot files: `process-video.ts`, `delivery.ts`, `schema.sql`, `commands.ts`.
3. **The cut line is already clean.** The pipeline splits shared work (①②③ transcript+digest caches, keyed by YouTube video ID — reusable across all users unchanged) from per-user work (④ personalize + render + deliver at `process-video.ts:120-150`). Fanning that out per subscriber is surgical.

---

## 2. What's shared vs per-user

| Layer | Scope | Why |
|---|---|---|
| Transcript cache (`transcripts`) | **Shared**, keyed by video_id | Pure function of the video; transcribe once, reuse for all |
| ①②③ digest cache (`video_digests`) | **Shared**, keyed by video_id | Insights/patterns/grade are content facts, not user-specific |
| `videos` queue + waterfall | **Shared** | One video processed once; cost scales with distinct videos, not users |
| Channels (`channels`) | **Shared catalog** | Same YouTube channel; per-user interest tracked separately |
| Subscriptions | **Per-user** | Who follows what, with per-sub watermark + min-duration |
| Section ④ + rendered digest | **Per-user** | Tailored to each user's profile |
| Delivery | **Per-user** | Each user's own Telegram chat |
| Profile, settings | **Per-user** | |

**Cost consequence (important):** 10 users all subscribed to Lex Fridman = **1** transcript + **1** extract + **1** grade (shared), + 10× the cheap Haiku ④ personalization. Multi-user does NOT multiply the expensive stages.

---

## 3. Data model

### New tables
```sql
create table users (
  id            uuid primary key default gen_random_uuid(),
  email         text unique not null,           -- citext-lowercased at app layer
  password_hash text not null,                  -- scrypt: salt$N$r$p$hash (see §5)
  is_owner      boolean not null default false,
  created_at    timestamptz not null default now()
);

create table sessions (
  token_hash  text primary key,                 -- sha256(random 32B); raw token only in cookie
  user_id     uuid not null references users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,             -- rolling 30d
  user_agent  text
);
create index sessions_user_idx on sessions(user_id);

create table link_tokens (
  token       text primary key,                 -- 24+ url-safe chars; used in t.me/<bot>?start=<token>
  user_id     uuid not null references users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,             -- 10 min TTL
  used_at     timestamptz                        -- one-time: null until redeemed
);

create table telegram_links (
  user_id     uuid primary key references users(id) on delete cascade,
  chat_id     text unique not null,             -- one chat ↔ one user
  linked_at   timestamptz not null default now()
);

create table subscriptions (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references users(id) on delete cascade,
  channel_id           uuid not null references channels(id) on delete cascade,
  active               boolean not null default true,
  min_duration_minutes int,                     -- per-sub override; null = user default
  since                timestamptz not null default now(),  -- per-sub "new upload" watermark
  created_at           timestamptz not null default now(),
  unique(user_id, channel_id)
);

create table user_deliveries (                  -- per-user delivery state for a video
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  video_id    text not null,                    -- youtube id (shared ①②③ lives in video_digests)
  status      text not null default 'pending',  -- pending|delivered|skipped|failed
  tailored    jsonb,                            -- section ④
  rendered    text,                             -- final per-user Telegram HTML
  created_at  timestamptz not null default now(),
  delivered_at timestamptz,
  unique(user_id, video_id)
);
create index user_deliveries_user_idx on user_deliveries(user_id, created_at desc);

create table user_profiles (
  user_id      uuid primary key references users(id) on delete cascade,
  profile_text text not null default '',
  updated_at   timestamptz not null default now()
);
```

### Altered existing tables (needs the migration mechanism — see §4)
- `usage_events` → add `user_id uuid` (nullable; for per-user cost attribution + quotas).
- `digests` / `user_profile` singleton → **retired** in favour of `user_deliveries` / `user_profiles`. Keep the old tables read-only during transition; drop in a later migration.
- `channels.min_duration_minutes` → stays as a catalog default; per-user override lives on `subscriptions`.

---

## 4. Migration mechanism (PREREQUISITE — blocks everything)

`migrate.ts` today only replays create-only `schema.sql`; it **cannot** `ALTER` existing tables. This was flagged critical in the very first review. Fix first:

- Add `schema_migrations(version text primary key, applied_at timestamptz)`.
- Numbered files `src/db/migrations/NNNN_*.sql`, applied in order inside a transaction, each recorded. `schema.sql` stays as the fresh-DB bootstrap only.
- First migration `0001_multiuser.sql` = all the new tables + the `usage_events.user_id` add.

Effort: ~half day. Everything else depends on it.

---

## 5. Auth design

- **Hashing:** Node built-in `crypto.scryptSync` (N=16384, r=8, p=1), format `scrypt$N$r$p$salt$hash`. No native module → no Docker build pain (rules out bcrypt/argon2 native builds). Constant-time compare via `timingSafeEqual`.
- **Sessions:** opaque 32-byte random token → stored as `sha256` in `sessions.token_hash`; raw token only ever in the cookie. **Cookie:** `httpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000` (30d rolling — refresh `expires_at` on use). Logout deletes the row; "logout everywhere" = delete all rows for the user.
- **CSRF:** same-origin app, `SameSite=Strict` cookie + require a `X-Requested-With: fetch` custom header on all state-changing POSTs (a cross-site form can't set custom headers). No token dance needed at this scale.
- **Login throttle:** in-memory per-IP sliding window (5 failures / 15 min → 429), no Redis. Generic "invalid email or password" (no user enumeration).
- **Endpoints** (extend the existing `node:http` router in `src/http/server.ts`):
  - `POST /api/signup {email,password}` → create user + profile, set session cookie.
  - `POST /api/login {email,password}` → set session cookie.
  - `POST /api/logout` → clear.
  - `GET /api/me` → `{email, telegramLinked}`.
  - All existing `/api/*` console routes move from `?key=` gating to **session-cookie auth**, scoped to `req.user`.

Note: `DASHBOARD_SECRET` gating is retired for user routes but **kept for an owner/admin view** (`/admin?key=` → global waterfall, all-user spend, health). Clean separation: users get sessions, owner keeps the god-view.

---

## 6. Telegram QR handshake (the min-friction link)

```
Web (logged in) ──"Link Telegram"──▶ POST /api/link/start
     │  server: issue link_token (10-min, one-time), return t.me/<bot>?start=<token>
     ▼
Page renders QR of that URL  (qrcode npm, server-side → data: URI inline; CSP-safe, no CDN)
     │
User scans with phone camera ──▶ Telegram opens the bot ──▶ user taps Start
     ▼
Bot /start handler reads ctx.startPayload (== token)
     │  validate: exists, not expired, not used → mark used_at, upsert telegram_links(user_id, chat_id)
     ▼
Bot replies "✅ Linked to <email>. Your digests will arrive here."
Web polls GET /api/link/status → flips to "linked", shows the chat.
```

Details:
- **Token:** 24 url-safe chars, single-use, 10-min TTL. If expired/used → bot replies "link expired, generate a new QR on the web."
- **Unlink:** `POST /api/link/unlink` deletes the `telegram_links` row; bot `/unlink` does the same from Telegram's side.
- **The current hard gate must change:** `src/bot/bot.ts:15-20` today silently drops every chat except `TELEGRAM_CHAT_ID`. New behaviour: look up `telegram_links.chat_id → user`. Unlinked chat that sends `/start <token>` → run the handshake; unlinked chat with no token → reply "Open the web app and scan the QR to link." Linked chat → commands act as that user.
- **Fallback:** the same `t.me/<bot>?start=<token>` link is a tappable button on the page (desktop users click; mobile users scan). Telegram Login Widget is an alternative but needs domain setup and is worse for a bot-first product — deferred.

---

## 7. Web UI

Session replaces `?key=`. Routes:
- `/` → if no session: **login/signup page**. If session: **the user console**.
- **User console** = today's dashboard/test-console, re-skinned per-user: add-channel (writes a subscription), fetch-a-video (live waterfall loader — already built), *my* channels, *my* digests (from `user_deliveries`), "Link Telegram" QR panel + link status.
- `/admin?key=<DASHBOARD_SECRET>` → owner god-view (global waterfall, all-user spend, health, tier stats). The existing dashboard becomes this.

XSS/rendering: `user_deliveries.rendered` is self-generated Telegram HTML (already escaped server-side in `render.ts`) — safe to inline, same as today.

---

## 8. Pipeline fan-out

Change `process-video.ts` so that after the shared ①②③ are computed/cached once:
```
for each active subscription whose min-duration + watermark accept this video:
    profile   = user_profiles[sub.user_id]
    tailored  = personalize(extract, profile)      # cheap Haiku, per-user
    rendered  = renderDigest(..., tailored)
    upsert user_deliveries(user_id, video_id, tailored, rendered)
    deliver(rendered, chatId = telegram_links[user_id].chat_id)   # deliver() gains a chatId param
```
- `deliver()` / `notify()` (`delivery.ts:54,70`) take an explicit `chatId` instead of reading `config.TELEGRAM_CHAT_ID`.
- Per-user long-form filter: a video can be long-form for user A and too-short for user B (per-sub `min_duration_minutes`).
- `videos.status` stays a *shared* "have we produced ①②③" flag; per-user delivery state lives in `user_deliveries`.
- On-demand `/fetch` (web console) delivers only to the requesting user; force-recompute of ①②③ is owner/admin-only to protect the shared cache.
- **Quotas** (from phase-2b's model): per-user channel cap + fetches/day by tier, tracked via `usage_events.user_id`. Global daily spend cap stays as the platform kill-switch.

---

## 9. Owner migration (zero downtime)

Boot-time bootstrap, idempotent:
1. Create owner `users` row (`is_owner=true`) from an `OWNER_EMAIL` env (password set via a one-time reset link, or a seeded hash).
2. `telegram_links(owner, TELEGRAM_CHAT_ID)` from the existing env.
3. Convert every existing global `channels` row into an owner `subscription`.
4. Migrate the singleton `user_profile` into `user_profiles[owner]`.
5. `TELEGRAM_CHAT_ID` demotes from required to an owner-bootstrap hint.

Result: the owner's channels, profile, and Telegram delivery keep working the instant the migration runs; new users layer on top.

---

## 10. Security checklist

- [ ] scrypt hashing, constant-time compare, generic auth errors (no enumeration)
- [ ] session token stored hashed; raw only in httpOnly+Secure+SameSite=Strict cookie
- [ ] CSRF: custom-header requirement on POSTs
- [ ] login rate-limit per IP
- [ ] link tokens: single-use, short TTL, unguessable
- [ ] every per-user query filtered by `req.user.id` (no IDOR — a user can't read another's digests/channels)
- [ ] force-recompute of shared caches restricted to owner
- [ ] admin god-view stays behind `DASHBOARD_SECRET`, separate from user sessions
- [ ] no secrets in URLs (retire `?key=` for user flows)

---

## 11. Phased plan

**Phase 1 — Auth + linking works end-to-end (~1 week):**
migration mechanism → users/sessions/link_tokens/telegram_links tables → signup/login/logout/me + session middleware → login/signup page → owner bootstrap → QR link handshake (link/start, /start payload handler, link/status, unlink) → per-user "add channel" (subscriptions) + "my channels". *Deliverable: a new person signs up, scans the QR, links Telegram, adds a channel — all on the web.*

**Phase 2 — Per-user digests flowing (~4-5 days):**
subscription-aware poller (per-sub watermark) → pipeline fan-out (per-user ④/render/deliver, `deliver(chatId)`) → `user_deliveries` + "my digests" view → per-user min-duration → retire the `digests`/`user_profile` singletons.

**Phase 3 — Scale + safety (~3-4 days, as needed):**
per-user quotas + tiers (usage_events.user_id) → Telegram global rate-limit (token bucket, from phase-2b) → email verification + password reset → admin user management → account delete (GDPR).

---

## 12. Open decisions for you

1. **Signups open or invite-only** at first? (Recommend invite-code gate initially — you control who joins while it stabilizes.)
2. **Email sending** (verification, password reset) — needs an email provider (Resend/Postmark/SES). Or defer email verification to Phase 3 and launch with password-only?
3. **Free tier limits** — channels per user, fetches per day? (phase-2b had a tier system to lift.)
4. **Keep `/admin?key=` god-view**, or fold owner into a normal `is_owner` account with an admin tab? (Recommend keeping the separate key view — simplest, already built.)
