# Podcast Digest Bot → Multi-Tenant Product: Product & Implementation Spec

**Status:** Implementation-ready
**Target:** 1,000 users
**Source of truth:** `/Users/arunsharma/Documents/New project/podcast-digest-bot/src/`
**Date:** 2026-06-25

---

## 1. Executive Summary

The Podcast Digest Bot is today a **single-owner appliance**: one Node process long-polls Telegram, polls a global list of YouTube channels, transcribes new long-form episodes through a multi-tier fallback waterfall, and pushes the owner a 4-section digest (① key insights, ② patterns/anti-patterns, ③ an independent grade by a separate LLM, ④ "for you" personalization). It is correct and resilient *as an appliance* — atomic `FOR UPDATE SKIP LOCKED` queue claims, stale-claim reaping, rate-limit-aware re-queueing, and a Supadata→Groq→OpenAI transcript fallback. But every notion of "the user" is an environment variable, not data: the recipient is `TELEGRAM_CHAT_ID`, the profile is a DB-enforced singleton (`user_profile` with `check (id = 1)`), and the `channels` list *is* the one owner's subscriptions.

This spec turns that appliance into a multi-tenant product. **The entire design rests on one structural insight:**

> **Sections ①②③ of a digest are pure functions of the transcript. Only section ④ depends on the user's profile.**

Everything expensive — the transcript (the binding cost/throughput constraint), the Claude extraction call (①②), and the independent grader call (③) — can be **computed once per video and fanned out** to every subscriber of that video's channel. Only ④ (`personalize.ts`) and delivery state are genuinely per-user. The current `digests` table fatally co-mingles both halves in a single row keyed only by `video_id`, with one cached `rendered` HTML blob — it physically cannot represent N users' renders. **Splitting that row is the single change that unlocks the whole product**: cost scales with *distinct videos on subscribed channels*, not with users; a popular episode followed by 400 people costs one transcript + one extract + one grade, then 400 cheap personalizations.

The changes, in order of leverage:

1. **Identity becomes data.** New `users`, `subscriptions`, `user_profiles`, `user_settings` tables. The owner-gate middleware (`bot.ts:15-20`) becomes an upsert; `channels` stays global and deduped (its biggest existing strength).
2. **The digest row splits** into shared `video_digests` (①②③, one per video) and per-user `user_deliveries` (④ + rendered HTML + delivery state, one per video×user). This absorbs both the old `digests` and `delivery_log`.
3. **The pipeline splits into two stages**: a per-video stage (transcribe + ①②③ → `video_digests`) that fans out to a per-user stage (④ + render + send → `user_deliveries`).
4. **The monolith splits into three deployables** keyed by a `ROLE` env: a single Telegram I/O service (the 409-constrained poller/sender), a horizontally-scalable stateless worker fleet, and a single advisory-lock-guarded poller. In-memory guards and the per-process Groq cooldown move into the database so the fleet coordinates.
5. **Cheap work moves off Opus.** Extraction routes to Sonnet, personalization to Haiku, the grader to a cheaper skeptical model — cutting the projected 1,000-user bill from ~$32.7k/mo (do-nothing) to ~$4.4k/mo.
6. **Engineering hygiene** (Vitest, CI gate, versioned migrations, pino+Sentry, secret rotation, the proxy-credential log-leak fix) makes all of the above safe to ship.
7. **A freemium product** (Free/Pro) bounds per-user cost via channel caps, on-demand `/fetch` quotas, and a Pro-gated grader — never gating §4, which is the moat.

The result is a system whose only line that scales with user count (Haiku §4) is its cheapest call, while its expensive lines (ASR + extraction) scale with distinct videos and are pinned to once-each by the cache.

---

## 2. Goals, Non-Goals & Assumptions

### Goals

- Serve ~1,000 users with per-user subscriptions, profiles, settings, and isolated delivery — **without** rewriting the proven queue-claim, transcript-waterfall, or 4-section pipeline.
- Compute shared work (transcript + ①②③) **once per video**; compute per-user work (④ + render) once per (video × user).
- Keep cost bounded and predictable (~$4–5/user/mo at 1,000 users) via caching, model routing, and freemium quotas.
- Make the codebase testable, observable, CI-gated, and safely deployable by a single operator.

### Non-Goals

- No Kafka/Kubernetes/service-mesh. The queue stays a hand-rolled Postgres `SKIP LOCKED` queue (it is exactly what pg-boss does internally; adopting pg-boss would rewrite audited code and still wouldn't express the two-stage fan-out or the global delivery budget).
- No ORM adoption (Drizzle/Prisma). The codebase uses raw `pg`; migrations use `node-pg-migrate` to match.
- No web/mobile app. Telegram-first (see assumptions).
- No move off Railway in the near term (a scale-path is documented).

### Explicit Assumptions (flagged as decisions)

| # | Assumption / Decision | Rationale |
|---|---|---|
| **A1** | **Freemium monetization** (Free + Pro tiers). | The cost model has a clear shared/per-user split that maps cleanly onto quotas; Pro gates the genuinely-expensive optional work (grader, on-demand fetches, lower duration floors), never §4. |
| **A2** | **Telegram-first.** Identity = `ctx.from.id`; delivery = `users.telegram_chat_id`. No email/passwords/web. | Entire current surface is in-Telegram; native rails (Stars billing) and lowest-friction onboarding follow. |
| **A3** | **Railway, with a scale-path.** Stay on Railway with three services off one image; PgBouncer + paid ASR tiers are the documented next steps when limits bind. | Minimal operational change; the single-operator deploy story stays simple. |
| **A4** | **Billing rail = Telegram Stars for v1**, behind a `grantPro/revokePro` abstraction so Stripe can be swapped in later. | Zero merchant-onboarding overhead; validates willingness-to-pay fast. (Open decision — §10.) |
| **A5** | **One bot token = one Telegram I/O process.** The 409-Conflict single-poller constraint is isolated to one tiny service (replicas=1), not the whole system. | Lets the worker fleet scale freely. |

---

## 3. Current State (condensed)

**One process, three concurrent loops** (`index.ts:17-47`): a single Telegraf long-poller (`bot.launch()`, not awaited; `process.exit(1)` on failure so Railway restarts), a poller cron (`POLL_CRON`, default `*/15`), and a worker cron (`WORKER_CRON`, default `*/3`). The worker drains `PER_TICK = 4` videos/tick, serially (`worker.ts:7,22-26`) — a ceiling of ~80 videos/hr. Re-entrancy guarded by **in-memory** `polling`/`running` booleans (useless across processes); only the DB claim is multi-instance-safe.

**Queue:** Postgres via `pg` (pool `max: 5`). Worker claims the oldest `pending` video with `FOR UPDATE SKIP LOCKED` (`videos.ts:27-37`); `reapStale()` requeues rows stuck `processing` > `STALE_MINUTES = 15`.

**Schema (7 tables, `schema.sql`):** `channels` (GLOBAL, no user FK — *is* the owner's subscription list), `videos` (GLOBAL work queue), `digests` (one row/video, co-mingles ①②③ + `tailored` §4 + `rendered` HTML), `user_profile` (DB-enforced singleton, `check (id = 1)`), `settings` (global k/v bag), `delivery_log` (audit; `chat_id` always `TELEGRAM_CHAT_ID`). **No `users` table.** Schema is auto-applied raw on every boot (`migrate.ts:7-11`) — no versioning, no history.

**4-section pipeline (`process-video.ts:20-102`):** ① insights + ② patterns from one Claude call (`extract.ts`, model `ANTHROPIC_MODEL`, default `claude-opus-4-8`); ③ grade from a separate skeptical model (`GRADER_MODEL`, default `openai/gpt-4o` via OpenRouter; gated, digest still ships without it); ④ personalization from Claude against the singleton profile. Rendered by `renderDigest()`, chunked to Telegram's 4096-char limit (`delivery.ts:13,49-66`).

**Transcript waterfall (`process-video.ts:46-57`):** Tier 0 Supadata (managed, tried first, returns `null` on any failure) → Tier 1 yt-dlp + residential proxy + ffmpeg (`android_vr` client) → Tier 2 Groq Whisper (`whisper-large-v3-turbo`, free ~2h-audio/hr; throws `TranscriptRateLimited` on 429) → Tier 3 OpenAI `whisper-1` (only when Groq 429'd; no hourly cap, pricier). On full throttle the worker re-queues without burning attempt counters and a per-process 8-min Groq cooldown (`ytdlp.ts:32-33`) holds. Transcripts clamped to 300,000 chars.

**Hard single-user blockers:** identity is an env var; profile is a DB singleton; channels/settings have no user dimension; single-process polling caps horizontal scale (409); throughput ceiling `PER_TICK=4`; transcription is the binding constraint; no fan-out/dedup of shareable work; per-process global state (`groqCooldownUntil`, tmpdir); raw boot-time DDL.

---

## 4. Target Architecture

### 4.1 The bot/worker split — three Railway services, one image, keyed by `ROLE`

`main()` (`index.ts:17-47`) is split by an env flag `ROLE ∈ {telegram-io, worker, poller}` into three entrypoints. Same repo, same Docker image; differentiated only by env.

| Service | `ROLE` | Replicas | Owns | Has Telegram token? | Has ASR/LLM keys? |
|---|---|---|---|---|---|
| **telegram-io** | `telegram-io` | **1** (long-poll) or **2+** (webhook) | All Bot API I/O: command handlers (write DB rows only), **all** outbound `sendMessage` (delivery throttle lives here) | **Yes** (`TELEGRAM_BOT_TOKEN`) | No |
| **worker** | `worker` | **3–4**, scale on queue depth | Pure DB→work→DB: drains transcription + digest queues, runs the pipeline. No `bot` import, no `bot.launch()`, no `sendMessage`. | No | **Yes** (`ANTHROPIC/GROQ/OPENAI/SUPADATA/GRADER`, `YT_PROXY`) |
| **poller** | `poller` | **1** (advisory-lock-guarded) | RSS fan-in only (`runPoller()` on `POLL_CRON`) | No | No |

**Why exactly three:** telegram-io is the only thing bound to the bot token, so it owns both the 409 constraint and the per-token outbound rate budget in one place. worker has zero Telegram coupling, so it's the knob you turn under load. poller is cheap (cost is `O(distinct channels)`, see fan-in) and stays single-replica.

**Per-role boot:**
- `ROLE=telegram-io`: register `commands.ts`; start webhook **or** `bot.launch()`; start the **delivery drainer** loop. No poller/worker cron.
- `ROLE=worker`: no `bot` import, no `migrate()`. Start the transcription drainer and the per-user (digest) drainer as continuous claim-loops (replacing the single `WORKER_CRON`). Raise pool `max` to ~10–15.
- `ROLE=poller`: only `runPoller()` on `POLL_CRON`, guarded by a DB advisory lock replacing the in-memory `polling` boolean:

```ts
// poller leader election — replaces the `polling` boolean (poller.ts:14)
const LOCK_KEY = 4815162342n
const { rows } = await pool.query('select pg_try_advisory_lock($1) as got', [LOCK_KEY])
if (!rows[0].got) return            // another poller replica holds it
try { await runPoller() } finally { await pool.query('select pg_advisory_unlock($1)', [LOCK_KEY]) }
```

### 4.2 Two-stage fan-out: per-video (once) → per-user (per subscriber)

`processVideo()` (`process-video.ts:20-102`) decomposes into two stages around the cache split.

**Stage A — per VIDEO, exactly once.** Input: a `videos` row. Work: `fetchVideoData` → transcript waterfall → `extractInsights` (①②) → `gradeIdeas` (③). Output: one `video_digests` row (the shared cache). This is `process-video.ts:24-69` **minus** the `getProfile()`/`personalize()`/`renderDigest()`/`deliver()` tail (lines 71-101). The grade-failure tolerance (`process-video.ts:62-69`) stays: §3 may be null and Stage B still ships.

On reaching `done`, Stage A **fans out** one per-user row per active subscriber of the video's channel — a single idempotent INSERT…SELECT:

```sql
-- fan-out: one user_deliveries row per active subscriber of this video's channel
insert into user_deliveries (user_id, video_id, state)
select s.user_id, v.id, 'pending'
from subscriptions s
join videos v on v.id = $1
where s.channel_id = v.channel_id
  and s.active
  and s.subscribed_at <= now()
on conflict (user_id, video_id) do nothing;
```

**Stage B — per USER, fanned out.** Input: a `pending` `user_deliveries` row. Work: load the shared `video_digests` row + that user's profile → `personalize()` (④) → `renderDigest()` → enqueue/send to *their* `telegram_chat_id`. Claimed with the same `FOR UPDATE SKIP LOCKED` discipline proven in `videos.ts:27-37`. `unique(user_id, video_id)` is the idempotency guard — **a user never gets the same video twice**, even across restarts/reaps.

**Why it's the win:** a popular episode followed by 400 of 1,000 users costs **1** transcription + **1** extract + **1** grade (Stage A), then **400** cheap personalize+render ops (Stage B) — instead of 400 full pipelines. The binding constraint (transcription) and the two shared LLM calls are paid once per video, not once per subscriber.

### 4.3 Component + data-flow diagram

```
                          ┌──────────────────────────────┐
                          │           Telegram            │
                          └───┬──────────────────────▲────┘
                webhook/poll  │                      │ sendMessage (≤25/s global,
                getUpdates    ▼                      │            ≤1/s per chat)
        ┌──────────────────────────────────────────┴───────────────────────┐
        │ SERVICE 1: telegram-io   (replicas: 1 long-poll | 2+ webhook)     │
        │  • command handlers (commands.ts) → write DB rows ONLY            │
        │  • OWNS all outbound sends; drains delivery via token bucket      │
        └───────────────┬──────────────────────────────────┬───────────────┘
       enqueue cmd rows │                                   │ claim delivery work
   (subscriptions, etc.)▼                                   │ (FOR UPDATE SKIP LOCKED)
   ┌─────────────────────────────────────────────────────────────────────────────┐
   │ POSTGRES (Railway) — queue + shared cache + per-user state + coordination     │
   │                                                                               │
   │  IDENTITY:  users · subscriptions · user_profiles · user_settings            │
   │  GLOBAL:    channels(deduped) · videos(global work queue)                     │
   │  SHARED:    video_digests  (①②③ — ONE row per video, the cache)               │
   │  PER-USER:  user_deliveries(④ + rendered HTML + delivery state, video×user)   │
   │  COORD:     pgmigrations · advisory locks · groq_cooldown_until(settings)     │
   └───┬─────────────────────────────▲────────────────────────────┬───────────────┘
       │ insert new videos            │ Stage A: claim pending     │ Stage B: claim
       │ (on conflict do nothing)     │ video → video_digests      │ pending user_delivery
       ▼                              │ then fan-out               ▼
   ┌──────────────────────┐   ┌───────┴───────────────────────────────────────────┐
   │ SERVICE 3: poller    │   │ SERVICE 2: worker      (replicas: 3–4, stateless)  │
   │  (replicas: 1,       │   │                                                    │
   │   advisory-locked)   │   │  STAGE A (per video, once):                        │
   │  • RSS fan-in over    │   │    fetchVideoData → transcript waterfall           │
   │    channels w/ ≥1     │   │      (Supadata→Groq→OpenAI) → extract ①②           │
   │    active subscriber  │   │      → grade ③  → write video_digests → FAN OUT    │
   │  • O(distinct chans)  │   │  STAGE B (per user, fanned out):                   │
   └──────────────────────┘   │    load video_digests + profile → personalize ④    │
                              │      → render → enqueue delivery (telegram-io sends)│
                              └────────────────────────────────────────────────────┘
```

### 4.4 Telegram rate limits & the 409 single-poller constraint

**The 409 constraint.** Only one client may long-poll a given `TELEGRAM_BOT_TOKEN`; a second `getUpdates` collides and one side 409s (the code treats this as fatal, `index.ts:32-35`). Two acceptable shapes:

- **Option 1 — single long-poller (recommended first step).** Keep `bot.launch()` in telegram-io, set Railway **replicas = 1** for that service only. The 409 is structurally impossible. Workers scale independently. This isolates the constraint to one tiny service.
- **Option 2 — webhooks (lets telegram-io scale >1).** Replace `bot.launch()` with `bot.createWebhook()` behind Railway HTTPS; updates become stateless HTTP, no `getUpdates`, no 409. **Caveat:** the outbound rate limiter must then be DB-backed (the `user_deliveries`-drained design already provides this), because the 30 msg/s ceiling is per-token, global across replicas. Adopt only after delivery is fully queue-backed.

**Outbound rate limits.** Telegram enforces ~**30 msg/s globally** and ~**1 msg/s per chat** per token. A popular episode fanned to 400 users, each digest chunked to multiple 4096-char messages, is easily 1,000+ outbound messages. Delivery is therefore **removed from the worker** and drained by telegram-io under a global token bucket (~25/s for headroom):

1. **Global budget:** drain ~25/s; under webhook/multi-replica, back it with a `rate_window` row updated atomically.
2. **Per-chat 1/s:** the claim query skips any user who received a message in the last second.
3. **429 handling:** read `retry_after`, set the delivery row's `run_after = now() + retry_after`, and pause the bucket for that window — graceful backpressure replacing "crash on failure."
4. **Pre-smoothing:** during fan-out, stagger `run_after = now() + (row_number()/25) seconds` so 1,000 messages spread over ~40s and no chat exceeds 1/s across its multi-chunk digest. `chunkHtml` (`delivery.ts:13-46`) is reused unchanged, moved into the delivery drainer.

---

## 5. Multi-Tenant Data Model

### 5.1 Naming convention (resolved across dimension inputs)

The dimension designs proposed overlapping names for the same concepts. **This spec standardizes on:**

| Concept | Canonical table | Rejected aliases |
|---|---|---|
| Shared ①②③ per video | **`video_digests`** | `video_extractions`, reuse of `digests` |
| Per-user §4 + render + delivery state | **`user_deliveries`** | `user_digests`, `digest_user` |
| Per-user profile | **`user_profiles`** | `profiles` |
| Per-user k/v settings | **`user_settings`** | — |
| Identity | **`users`** | — |
| User×channel join | **`subscriptions`** | — |

`user_deliveries` deliberately absorbs both the per-user half of the old `digests` **and** the old `delivery_log` (message_ids, ok→state, error, delivered_at), so there is exactly one per-user-per-video row.

UUID PKs everywhere except `users` (which can use UUID; `telegram_user_id bigint` is the unique natural key). Telegram ids are 64-bit integers stored as `bigint`, not `text` (the current code stringifies only to compare against an env var).

### 5.2 Final DDL

```sql
-- ── IDENTITY ────────────────────────────────────────────────────────────────
create table if not exists users (
  id                uuid primary key default gen_random_uuid(),
  telegram_user_id  bigint unique not null,          -- ctx.from.id — durable identity
  telegram_chat_id  bigint not null,                 -- send target (= user id for DMs)
  username          text,
  first_name        text,
  tier              text not null default 'free',    -- free | pro
  status            text not null default 'active',  -- active | paused | deleted
  is_owner          boolean not null default false,  -- the backfilled single owner
  pro_until         timestamptz,                     -- null = free; subscription expiry
  created_at        timestamptz not null default now(),
  last_seen_at      timestamptz,
  deleted_at        timestamptz
);
create index if not exists users_chat_idx on users(telegram_chat_id);

create table if not exists user_profiles (
  user_id      uuid primary key references users(id) on delete cascade,
  profile_text text not null default '',
  updated_at   timestamptz not null default now()
);

create table if not exists user_settings (
  user_id  uuid not null references users(id) on delete cascade,
  key      text not null,         -- 'min_duration_minutes' | 'language' |
                                  -- 'delivery_mode' | 'quiet_start' | 'quiet_end' |
                                  -- 'tz' | 'grader_enabled'
  value    text,
  primary key (user_id, key)
);

-- ── GLOBAL (unchanged shape; reinterpreted) ─────────────────────────────────
-- channels: KEPT AS-IS. youtube_channel_id unique = the dedup key that already
--   guarantees one row per channel. min_duration_minutes is now the channel's
--   intrinsic floor (null = use the subscriber's own threshold).
-- videos:   KEPT AS-IS (global work queue). DO NOT add user_id. Only new index:
create index if not exists videos_pending_idx on videos(created_at) where status = 'pending';

create table if not exists subscriptions (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references users(id) on delete cascade,
  channel_id            uuid not null references channels(id) on delete cascade,
  active                boolean not null default true,   -- per-user soft unsubscribe
  min_duration_minutes  int,                             -- per-(user,channel) override
  subscribed_at         timestamptz not null default now(),
  unique (user_id, channel_id)
);
create index if not exists subs_user_idx    on subscriptions(user_id)    where active;
create index if not exists subs_channel_idx on subscriptions(channel_id) where active;

-- ── SHARED CACHE: sections ①②③, exactly one row per video ───────────────────
create table if not exists video_digests (
  id            uuid primary key default gen_random_uuid(),
  video_id      uuid not null unique references videos(id) on delete cascade,
  key_insights  jsonb,        -- ①
  patterns      jsonb,        -- ② patterns
  antipatterns  jsonb,        -- ② antipatterns
  grading       jsonb,        -- ③ (user-independent by design; may be null)
  extract_model text,
  grader_model  text,
  computed_at   timestamptz not null default now()
);

-- ── PER-USER: §4 + per-user render + delivery state (absorbs delivery_log) ──
create table if not exists user_deliveries (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references users(id)  on delete cascade,
  video_id             uuid not null references videos(id) on delete cascade,
  tailored             jsonb,                              -- ④ (per-user)
  rendered             text,                               -- this user's final HTML
  state                text not null default 'pending',    -- pending|personalized|
                                                          -- delivered|failed|skipped
  skip_reason          text,
  message_ids          jsonb,                              -- was delivery_log.message_ids
  error                text,
  personalize_attempts int not null default 0,
  run_after            timestamptz not null default now(), -- backoff / send smoothing
  created_at           timestamptz not null default now(),
  delivered_at         timestamptz,
  unique (user_id, video_id)                               -- idempotency guard
);
create index if not exists uvd_claim_idx on user_deliveries(state, run_after)
  where state in ('pending','personalized');
create index if not exists uvd_video_idx on user_deliveries(video_id);
```

### 5.3 `min_duration_minutes` resolution & the transcribe-once consequence

Resolve per `(user, channel)` at filter time, most-specific first:

1. `subscriptions.min_duration_minutes` (this user, this channel)
2. `user_settings['min_duration_minutes']` (this user's default)
3. `channels.min_duration_minutes` (channel intrinsic floor)
4. `config.MIN_DURATION_MINUTES` (process default)

**Critical consequence:** the long-form filter is now per-user, so it **cannot gate transcription** (today `process-video.ts:40-43` skips short videos before transcribing). User A may want ≥20 min, user B ≥5 min for the *same* video. So Stage A transcribes + computes ①②③ if **any** subscriber would accept the duration (`min(applicable thresholds) ≤ duration`); Stage B independently drops the video for users whose threshold excludes it (`state='skipped'`, `skip_reason`). This preserves transcribe-once while honoring per-user thresholds.

### 5.4 Index → hot-path map

| Hot path | Query | Index |
|---|---|---|
| Claim pending video (`videos.ts:27-37`) | `where status='pending' order by created_at limit 1 for update skip locked` | `videos_pending_idx` (partial) |
| List a user's subscriptions (`/channels`) | `where user_id=$1 and active` | `subs_user_idx` (partial) |
| Find subscribers of a channel (fan-out) | `where channel_id=$1 and active` | `subs_channel_idx` (partial) |
| Channels worth polling | channels w/ ≥1 active sub | join + `subs_channel_idx` |
| Claim next per-user delivery | `where state in (...) order by run_after limit N for update skip locked` | `uvd_claim_idx` (partial) |
| Already delivered to user? | `where user_id=$1 and video_id=$2` | `unique(user_id,video_id)` |
| Shared digest cache lookup | `where video_id=$1` | `unique(video_id)` |

### 5.5 Query scoping (concrete diffs)

- **Owner gate** (`bot.ts:15-20`): replace env-compare with upsert-then-proceed. `bot.use` upserts the user from `ctx.from`, attaches `ctx.state.user`. (Optional allowlist during rollout.)
- **`getProfile`/`setProfile`** (`profile.ts:5,11`): take `userId`; key on `user_id`. `ensureProfileSeeded()` becomes per-user seeding from the `/start` handler, **not** boot.
- **`getMinDurationMinutes`** (`settings.ts:16`): becomes `getMinDuration(userId, channelId)` per §5.3.
- **`listChannels`** (`channels.ts:18` / `poller.ts:21`): split into `listUserChannels(userId)` (join subscriptions, for `/channels`) and `listPollableChannels()` (channels with ≥1 active subscriber — the poll-gating fan-in; cost is `O(distinct channels)`).
- **`addChannel`** (`channels.ts:5-16`): keep the global channel upsert; **also** upsert a `subscriptions` row for `ctx.state.user`.
- **`removeChannel`** (`channels.ts:25-38`): set `subscriptions.active=false` for `(userId, channelId)`. Do **not** touch `channels.active`. (Optional GC flips `channels.active=false` once zero active subs remain — not required; poll-gating already excludes it.)
- **`enqueueVideo`** + poller "since" logic: enqueue any upload newer than `min(subscriptions.subscribed_at where active)` for the channel; fan-out restricts delivery to users whose `subscribed_at <=` the video's discovery.
- **Digest write** (`process-video.ts:84-98`): split into Stage A write (`video_digests`, `on conflict(video_id) do nothing`) + fan-out INSERT…SELECT + Stage B per-user write. `personalize()`/`renderDigest()` move out of Stage A.
- **`deliver`/`notify`** (`delivery.ts:49-86`): take an explicit `chatId` (the user's `telegram_chat_id`) instead of `config.TELEGRAM_CHAT_ID`. `logDelivery` is **deleted** — its data lives in `user_deliveries`.
- **`statusCounts`** (`videos.ts:90`): stays global for `/status`; add a per-user count from `user_deliveries where user_id=$1`.

### 5.6 Migration tooling: replace boot-time `schema.sql` auto-apply

**Adopt `node-pg-migrate`** — raw SQL/JS migrations against the existing `pg` `Pool`, a `pgmigrations` history table, CLI + programmatic API. (Drizzle migrator rejected: no Drizzle here. Flyway/Sqitch rejected: JVM/Perl runtime.)

**Multi-instance safety via a Postgres advisory lock** so exactly one booting instance migrates and others wait, then see the finished schema:

```ts
// src/db/migrate.ts — replaces the schema.sql blob apply (migrate.ts:7-11)
import migrationRunner from 'node-pg-migrate'
import { pool } from './db'
import { log } from '../util/logger'

const LOCK_KEY = 0x7064_6967 // 'pdig' — any stable bigint, shared by all instances

export async function migrate(): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_KEY])  // blocking
    await migrationRunner({
      dbClient: client, dir: 'migrations', direction: 'up',
      migrationsTable: 'pgmigrations', noLock: false,
      log: (m) => log.info(m),
    })
    log.info('Migrations applied/verified')
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {})
    client.release()
  }
}
```

**Deploy posture:** run `node-pg-migrate up` as a Railway **release command** (one-shot, single container) — not in every app instance. **Workers and telegram-io must NOT run `migrate()`**; they call a lightweight `assertMigrated()` (check `pgmigrations` max id ≥ expected) and refuse to start if behind. Keep `schema.sql` only as documentation marked "baseline = migration 0001; do not edit, write a new migration."

### 5.7 Step-by-step migration plan (single owner → multi-tenant)

Sequenced as reversible `node-pg-migrate` files. **Hard rule: no destructive drop until the new tables are populated and the app reads from them.**

**001 — create new tables (additive, zero downtime).** `users`, `subscriptions`, `user_profiles`, `user_settings`, `video_digests`, `user_deliveries` + all §5.4 indexes + `videos_pending_idx`. Touch nothing existing. (down = drop new tables.)

**002 — backfill the single owner** (`:owner_id` injected from `TELEGRAM_CHAT_ID`):

```sql
insert into users (telegram_user_id, telegram_chat_id, status, is_owner, tier)
values (:owner_id, :owner_id, 'active', true, 'pro')
on conflict (telegram_user_id) do nothing;

insert into user_profiles (user_id, profile_text, updated_at)
select u.id, p.profile_text, p.updated_at
from users u, user_profile p where u.is_owner and p.id = 1
on conflict (user_id) do nothing;

insert into user_settings (user_id, key, value)
select u.id, s.key, s.value
from users u, settings s where u.is_owner and s.key = 'min_duration_minutes'
on conflict (user_id, key) do nothing;

-- the conceptual heart: the global channels table WAS the owner's subscription list
insert into subscriptions (user_id, channel_id, active, min_duration_minutes, subscribed_at)
select u.id, c.id, true, c.min_duration_minutes, c.created_at
from users u, channels c where u.is_owner and c.active
on conflict (user_id, channel_id) do nothing;

-- split existing digests into shared + per-user
insert into video_digests (video_id, key_insights, patterns, antipatterns, grading, extract_model, grader_model, computed_at)
select d.video_id, d.key_insights, d.patterns, d.antipatterns, d.grading, d.primary_model, d.grader_model, d.created_at
from digests d on conflict (video_id) do nothing;

insert into user_deliveries (user_id, video_id, tailored, rendered, state, created_at, delivered_at)
select u.id, d.video_id, d.tailored, d.rendered, 'delivered', d.created_at, d.created_at
from digests d, users u where u.is_owner
on conflict (user_id, video_id) do nothing;

-- fold delivery_log message_ids into user_deliveries for the owner
update user_deliveries uvd set message_ids = dl.message_ids
from delivery_log dl
where dl.video_id = uvd.video_id and uvd.user_id = (select id from users where is_owner);
```
(down = truncate new tables; old data untouched.)

**003 — deploy multi-tenant code** (ship §5.5 + §4 changes). Owner keeps working (rows exist from 002); new users can `/start` and `/add`. Old `digests`/`user_profile`/`settings`/`delivery_log` still exist but are no longer written. (down = revert image.)

**004 — verify, then retire legacy** (after soak):
```sql
drop table if exists digests;        -- → video_digests + user_deliveries
drop table if exists user_profile;   -- → user_profiles
drop table if exists delivery_log;   -- → user_deliveries
-- keep `settings` ONLY for true process-wide keys (e.g. groq_cooldown_until); else drop
```
(down = reconstruct legacy by reverse-projecting the new tables for the owner.) This is the only destructive step; gated on verification.

---

## 6. Transcription & LLM Economics

### 6.1 Pricing correction & model menu

The brief cites Opus at "$15/$75"; current `claude-opus-4-8` is **$5/$25 per MTok**. All numbers below use real current rates.

| Model | ID | $/MTok in | $/MTok out |
|---|---|---|---|
| Opus 4.8 | `claude-opus-4-8` | $5 | $25 |
| Sonnet 4.6 | `claude-sonnet-4-6` | $3 | $15 |
| Haiku 4.5 | `claude-haiku-4-5` | $1 | $5 |

### 6.2 Load formulas

Cost is driven by **distinct videos**, not users — that is the whole point of the cache split. With `U` users, `c̄` channels/user, `O` overlap factor (fraction of subscription slots resolving to distinct channels after dedup), `e` episodes/channel/week, `L̄` avg length:

```
DistinctChannels      = U × c̄ × O
DistinctVideos / wk   = DistinctChannels × e          → drives ASR + ①② + ③
Personalizations / wk = U × c̄ × e                     → drives ④ (flat in O)
Fan-out factor        = Personalizations / DistinctVideos = 1 / O
ASR audio-hours / wk  = DistinctVideos/wk × L̄
```

Assumptions: `c̄=8`, `e=2`, `L̄=75 min (1.25h)`, transcript ≈ 24k input tokens (300k-char clamp ≈ ~75k tok, only hit by 4h+ episodes). Output caps from code: `extract.ts` 6,000 (①②), `grade.ts` 2,000 (③), `personalize.ts` 3,000 (④); ④ input ≈ 2.5k (profile + ideas digest, **never the transcript**).

### 6.3 Transcription waterfall economics

| Tier | Code | Unit cost / 1.25h episode | Failure mode |
|---|---|---|---|
| 0 — Supadata | `supadata.ts` | ~$0.005 (managed) | own quota → 429 → `null` → fall through |
| 1+2 — yt-dlp + Groq turbo | `ytdlp.ts:151` | **$0 within ~2 audio-h/hr free cap**, else ~$0.05 | 429 → `TranscriptRateLimited` → 8-min cooldown + requeue. Residential-proxy bandwidth is the real metered cost. |
| 3 — OpenAI `whisper-1` | `ytdlp.ts:197` | ~$0.45 (no hourly cap) | last-resort only |

Groq free ≈ 336 audio-h/wk. At 1,000 users / O=0.25 → 4,000 distinct videos/wk → ~5,000 audio-h/wk = **15× over** the free window. Do-nothing overflow to `whisper-1` ($0.36/h) ≈ **$7,270/mo** — and dominates the bill. Overflow to paid Supadata/Groq (~$0.04/h) ≈ **$810/mo**.

**ASR recommendation:** make **Supadata (Tier 0) the primary at scale** (no audio download → sidesteps proxy-IP burn, SABR, and the per-process Groq cooldown). Keep Groq-free as a cost-shaver under its 2h/hr window. **Demote `whisper-1` to true last-resort behind a per-day spend cap.** The biggest lever is dedup, already guaranteed by the cache: transcribe **once per `video_id`**. Add a `transcripts(video_id pk, text, char_len, source_tier, created_at)` table so a transcript survives even if its `videos`/`video_digests` rows are reaped.

### 6.4 Per-call LLM cost & routing decision

**①② Extraction** (input ~24k, output ≤6k) — **shared, once per video:** Opus $0.270, Sonnet $0.162, Haiku $0.054.
**④ Personalization** (input ~2.5k, output ≤3k) — **per (video×user):** Opus $0.0875, Sonnet $0.0525, Haiku $0.0175.

- **①② → Sonnet 4.6 (default).** Shared per-video, so even Opus is affordable, but Sonnet saves ~40% with negligible loss on a structured-extraction task (`structured()` strict-retry). Reserve Opus behind a per-channel "premium analysis" flag.
- **④ → Haiku 4.5.** Per-user, must be cheap. It's a template/matching task ("map pre-extracted ideas onto a profile, rate relevance"). **Moving ④ off Opus to Haiku saves ~$4,850/mo at 1,000 users.**
- **③ → `openai/gpt-4o-mini`.** Keep a *different family* for independence (`llm/grader.ts:5`), just cheaper.

Split the single `ANTHROPIC_MODEL` knob into per-stage env vars and pass `model` into `callClaude`:

```ts
// config.ts
EXTRACT_MODEL:     z.string().default('claude-sonnet-4-6'),   // shared ①②
PERSONALIZE_MODEL: z.string().default('claude-haiku-4-5'),    // per-user ④
GRADER_MODEL:      z.string().default('openai/gpt-4o-mini'),  // independent ③
```
`extract.ts` passes `EXTRACT_MODEL`; `personalize.ts` passes `PERSONALIZE_MODEL`. Do **not** enable thinking on these terse-JSON tasks (it inflates output tokens).

### 6.5 Monthly cost table (weekly × 4.33; recommended routing; Supadata-primary ASR)

**1,000 users, sensitivity to overlap `O`:**

| Line | O=0.10 (1,600 vid/wk) | O=0.25 (4,000 vid/wk) | O=0.40 (6,400 vid/wk) |
|---|---|---|---|
| Transcription (Supadata-primary) | ~$35 | ~$87 | ~$140 |
| ③ Grade (gpt-4o-mini, per video) | ~$45 | ~$112 | ~$180 |
| ①② Extract (Sonnet, per video) | $1,123 | $2,810 | $4,490 |
| ④ Personalize (Haiku, per user×video — **flat in O**) | $1,213 | $1,213 | $1,213 |
| Infra (Railway 2–3 svc + PG + proxy) | ~$120 | ~$180 | ~$260 |
| **Total / mo** | **~$2,536** | **~$4,402** | **~$6,283** |
| **Per user / mo** | ~$2.54 | ~$4.40 | ~$6.28 |

**100 users:**

| Line | O=0.25 (400 vid/wk) | O=0.40 (640 vid/wk) |
|---|---|---|
| Transcription | ~$28 | ~$45 |
| ③ Grade | ~$11 | ~$18 |
| ①② Extract (Sonnet) | $281 | $449 |
| ④ Personalize (Haiku) | $121 | $121 |
| Infra (single svc + PG) | ~$40 | ~$50 |
| **Total / mo** | **~$481** | **~$683** |
| **Per user / mo** | ~$4.81 | ~$6.83 |

**Do-nothing anti-table (1,000 / O=0.25, all-Opus, recompute-per-user, whisper spillover):** ASR ~$7,270 + Opus ①② recomputed 16,000× ~$18,700 + Opus ④ ~$6,067 + grade ~$450 + infra ~$200 = **~$32,700/mo**. The shared-cache + routing + Supadata design takes this to **~$4.4k/mo — an ~87% cut** (~$32.70 → ~$4.40/user). The two biggest cuts: caching extraction once-per-video (16,000→4,000 calls) and routing ④ to Haiku.

### 6.6 Quota design that bounds cost

Cost is bounded by (i) capping per-user demand and (ii) guaranteeing shared work runs once. ④ (the only line that scales with users) is the cheapest call; the expensive lines scale with distinct videos, pinned to once-each by the cache. Five levers, in priority order:

1. **Transcript cache** — never re-transcribe a `video_id` (the `transcripts` table above). Largest, structurally-free saving.
2. **The `digests` split** (§5) — extraction from `U×c̄×e` calls down to `DistinctVideos` calls.
3. **Prompt-cache the ideas digest** across a video's personalizations (`cache_control: ephemeral` after the shared ideas block, profile after it). Fire the first ④ for a video, await its first token, then fan out the rest so they hit the warm cache. Marginal on Haiku, ~90% off ④ input on a Sonnet/Opus premium tier.
4. **Batch ④ via the Batches API** for non-urgent fan-out (50% off) — trims the ④ line from ~$1,213/mo toward ~$607/mo at 1,000/O=0.25.
5. **Gate ③** — run the grader for a video **only if ≥1 subscriber is Pro with grader on**; cache in `video_digests.grading`; omit from free renders. At free-heavy mixes this removes most of the ③ line.

With all five, the 1,000/O=0.25 total moves toward **~$3.8k/mo (~$3.80/user)**.

---

## 7. Engineering Practices (prioritized)

The single most leveraged fact: every interesting decision already lives next to an I/O call as a near-pure function (`extractJson` in `util/json.ts`, `chunkHtml` in `delivery.ts:13`, `renderDigest` in `render.ts`, the waterfall ordering, the `processOne` error ladder in `worker.ts:33-85`). Testing and code-structure work are therefore the same work.

### 7.1 Testing — Vitest

Vitest over Jest (repo is native ESM on `tsx`; reads `tsconfig.json` directly; `vi.mock` for boundaries; built-in v8 coverage). Two projects (unit always; integration on demand). Add `typecheck`/`lint`/`test`/`test:unit`/`test:int` scripts.

**Unit (no DB, no network) — highest value:**
- `extractJson` JSON-repair: fenced/unfenced, leading/trailing prose, and the **pinned failure mode** (`}` inside a string before the real end) as a documented `toThrow`.
- `structured()` retry-once contract (inject the `call` fn, already a param): valid first; garbage→valid; garbage→garbage throws the *strict* ZodError; valid-JSON-wrong-shape repair path.
- Zod schemas in `extract.ts`/`grade.ts`/`personalize.ts` against good + malformed fixtures, so a prompt change fails CI not prod.
- `renderDigest` snapshots: all-four; `grade:null` + configured ("grading failed"); `grade:null` + unconfigured ("grading skipped"); empty insights; empty tailored. Plus `esc` and the `ec` clamp boundaries — a raw `<` in a title must come out `&lt;` or Telegram HTML parse-mode 400s.
- `chunkHtml`/`hardSplit` 4096 boundary (every chunk ≤ 4096-96; long lines split at a space then hard index; tags never split mid-tag).
- **Transcript-tier decision** extracted to a pure `transcriptTierOrder()` + ASR provider selection (inject the two transcribe fns) — the logic controlling spend and 429 behavior, testable in ms.
- **Worker error-classification ladder** (`processOne`): refactor to inject `process` and `setStatus`; assert the seven status transitions including the invariant "`TranscriptRateLimited` → `pending` with **no** attempt increment" (`worker.ts:49-54`). These seven rows are the bot's reliability contract.
- **Cooldown** lifted into an injectable clock-driven object (also what later makes it DB-backed for the fleet).

**Integration (`@testcontainers/postgresql` — real PG 16; schema uses `gen_random_uuid()`/`make_interval`, `pg-mem` insufficient):** mock external APIs at the **network boundary** via `undici` `MockAgent` (anthropic/groq/openai/supadata/openrouter/telegram); inject `pexec` for yt-dlp/ffmpeg; inject a fake `telegram` for delivery. Tests that earn their keep: concurrent `claimNextPending()` from two connections get different rows (proves `SKIP LOCKED`); `reapStale` flips a stale row; `processVideo` end-to-end produces the right rows and the Supadata short-circuit skips the `pexec` path; `migrate()` applies clean + idempotently.

### 7.2 CI/CD

Add ESLint first (the repo has `eslint-disable` comments but **no eslint installed** — they're dead). GitHub Actions on every PR + `main`: `check` job (typecheck, lint, unit) + `integration` job (Docker is free on ubuntu runners → testcontainers works) + a `docker build .` job (catches a broken image, e.g. yt-dlp download 404, in CI not at Railway build). Make `check` + `integration` **required status checks** on `main` — that *is* the deploy gate.

**Two Railway environments:** **staging** auto-deploys from `main` with its **own separate `TELEGRAM_BOT_TOKEN`** (non-negotiable — the 409 constraint means staging cannot share the prod token, the two pollers would crash-loop). **Production** deploys on a git tag (`v*`) or manual promote after a staging smoke-check. Alert on Railway restart count (a crash-loop that exhausts `restartPolicyMaxRetries` must page you, since "crash and restart" otherwise silently masks a bad deploy).

### 7.3 Migrations — covered in §5.6 (off-boot, versioned, advisory-lock-safe, run-on-deploy as a release command; workers skip).

### 7.4 Observability

- **pino** replacing the `console.log`-with-timestamp `util/logger.ts` (keep the `log.info/warn/error(msg, meta)` signature; ~40 call sites unchanged). Add `video_id`/`channel_id`/`user_id` fields so one episode's journey is greppable. **Wire pino `redact` to the proxy-leak fix (§7.6).**
- **Sentry** (`@sentry/node`) at the three places errors vanish: `uncaughtException`/`unhandledRejection`, `bot.catch`, and the worker's terminal `failed`/`no_transcript` branches (tag `video_id`/`user_id`).
- **Metrics** (a periodic `log.info('metrics', {...})` line or `/metrics`): queue depth via the existing `statusCounts()` every tick; transcription-tier hit-rate (`supadata_hit`/`groq_hit`/`openai_fallback_hit`/`rate_limited`); delivery success ratio from `user_deliveries.state`; per-stage latency (the four pipeline stages); **cost counters** from `res.usage` (input/output tokens) + audio-seconds; cooldown-trip count.
- **Health:** add a tiny HTTP server (`/healthz` = `select 1`; `/readyz` = migrated + bot ready) so Railway catches a **silently wedged poller** — the nastiest failure (process up, `getUpdates` dead, no digest in hours).
- **Alerting** to your existing Telegram: Sentry→Telegram on new failures; a **stall watchdog** (zero `delivered` in 6h while `pending`>0 → "pipeline stalled"); restart-count alert.

### 7.5 Code structure — handlers vs domain + repository ports

Two structural blockers to testability: Telegram `ctx` threaded into domain logic, and services reaching straight into `db/db.ts`. Fix both mechanically:

- **Separate handlers from domain.** `runVideoNow` (`commands.ts:24-67`) duplicates the worker's `processOne` error ladder welded to `ctx.reply`. Collapse: a new `src/app/` domain layer (zero Telegram imports) where `summarizeVideoNow(videoId, opts)` returns a discriminated union `{kind:'delivered'|'skipped'|'rate_limited'|'failed', detail}`; handlers become ~3 lines that map the result to copy via a pure `replyFor(r)` (snapshot-tested). The classification logic then exists **once**, shared by worker and command.
- **Repository ports** (`services/ports.ts`): interfaces from the *existing* function shapes (`VideoRepo`, `DigestRepo`, `ProfileRepo`, `Deliverer`); `services/*.ts` become the Postgres impls (SQL unchanged); domain functions take ports with production defaults. Payoff: the seven-row worker test and the pipeline test become pure unit tests with in-memory fakes; the same domain code re-runs against real PG in integration. Doing this **now** (7 tables) makes the multi-worker future a matter of swapping a repo impl.

### 7.6 Secrets & security

1. **Rotate everything now** (secrets have been pasted in chat; `.env.example` enumerates all 17 keys). Revoke/reissue the Telegram token (BotFather), roll Anthropic/OpenAI/Groq/OpenRouter/Supadata keys, rotate proxy creds + Railway Postgres password. Verify `.env` was never committed (`git log --all -p -- .env`); BFG-scrub if it was. Secrets live only in Railway env going forward.
2. **Fix the proxy-creds-in-logs leak** (real, locatable): `ytArgs` pushes `--proxy http://user:pass@host:port` (`ytdlp.ts:48-52`); on failure Node's `execFile` error includes the full argv in `.cmd`, logged verbatim at `ytdlp.ts:75,141,144` (`String(e)`). Two fixes, do both: pino `redact` **and** a `scrub(s)` that regex-replaces `//user:pass@` → `//***:***@` and the raw `YT_PROXY` substring, applied to every `String(e)` here (+ unit test). Same treatment for `DATABASE_URL`.
3. **Per-user rate limiting** on the expensive command paths before opening to users: `/fetch`/`/channel`/`/test` immediately `runVideoNow` (full transcribe + 3 LLM calls). Token bucket per `user_id` (N `/fetch`/hr, M `/add`/day) backed by a `rate_limits` table; cap total channels and per-user queue depth so one user can't starve the shared `videos` queue.
4. **Input validation** on user-controlled paths: `resolveChannel` `fetch`es a URL built from raw input → validate host is `youtube.com` (SSRF); cap `/setprofile` length (~2000 chars) and treat profile text as untrusted, clearly delimited in the personalize prompt (prompt-injection). SQL is already parameterized everywhere — keep it.
5. **Admin auth** via an `ADMIN_USER_IDS` allowlist checked per-command (the blanket owner gate is gone). Global-mutating ops (e.g. process-wide settings) gate to admins explicitly.

### 7.7 Priority order

1. **Rotate secrets + fix the proxy-log leak** (active exposure).
2. **Vitest + pure-logic unit tests + the `processOne`/`summarizeVideoNow` dedup** (unlocks safe change; no infra).
3. **CI gate** (typecheck+lint+unit required on PR).
4. **pino + Sentry + stall watchdog + `/healthz`** (so you *know* when digests stop).
5. **Versioned migrations off-boot + repository ports** (groundwork; before, not during, the multi-user build).
6. **Rate-limiting + SSRF/prompt-injection validation + admin scoping** (required before opening beyond the owner).

---

## 8. Product Spec

### 8.1 Onboarding — three taps and one paste, value before profile

- **`/start` auto-provisions** (upsert middleware replacing the owner gate, `bot.ts:15-20`). Identity = `ctx.from.id`; `telegram_chat_id` captured for delivery. No passwords/email.
- **Welcome** leads with the value prop + a single CTA: *"Add your first channel to see it work → `/add <url or @handle>`."*
- **First `/add` triggers the sample digest** (the existing `BACKFILL_ON_ADD` queues the latest episode — keep it; it *is* the payoff). The sample runs ①②③ (shared) + a **generic ④** (no profile yet). After delivery, prompt: *"Section ④ is generic right now — `/setprofile …` to make it personal."*
- **`/setprofile`** writes `user_profiles`; from the next digest on, ④ is tailored.
- **Activation = ≥1 active subscription AND `profile_text != ''`.** Do **not** seed a default profile (the current owner-only `ensureProfileSeeded()` must not run for new signups — a generic seed would make ④ *look* personalized while being noise, undermining the differentiator).

### 8.2 Free vs Pro (concrete numbers)

Quotas bound the real cost drivers (distinct channels + on-demand `/fetch`), **never** §4 (cheap and the moat) and **never** the shared cache (channel overlap is free).

| Lever | **Free** | **Pro** | Why |
|---|---|---|---|
| Channels tracked (active subs) | **3** | **25** | Each channel adds polling + potential transcripts. |
| Scheduling | Instant only | Instant **or** windowed (quiet hours, daily roll-up) | Near-zero marginal compute → ideal convenience differentiator. |
| History retention (`user_deliveries`) | **14 days** | **365 days** | Nightly prune to bound storage cost. |
| §3 grader (`grader_enabled`) | **Forced OFF** | Toggleable (default ON) | The single most expensive optional call; clearest premium signal. |
| On-demand `/fetch` & `/channel` | **3 / day** | **30 / day** | Forces an immediate transcript (most expensive single action); count per `user_id` per UTC day. |
| Min-duration floor | **≥ 20 min** (fixed) | Configurable **≥ 10 min** | Lower floors → more qualifying videos → more transcripts. |
| Profile / §4 | ✅ Full | ✅ Full | **Never gate the differentiator.** |

**Enforcement (all in existing handlers):** `/add` counts active subs before `addChannel`; `/fetch`/`/channel`/`/test` check a daily counter; **§3 runs once per video if any Pro subscriber wants it**, cached in `video_digests.grading`, omitted from free renders (never run twice).

### 8.3 Monetization

**Recommendation: launch on Telegram Stars (XTR)** — native in-app rail, zero PCI/merchant overhead, recurring `subscription_period` maps to `pro_until`, API refunds. Pricing placeholder **Pro ≈ 250 Stars/mo (~$5)**. Billing writes exactly two fields (`users.tier`, `users.pro_until`); a nightly job downgrades expired Pro. Keep a `grantPro(user_id, until)/revokePro(user_id)` abstraction so swapping in Stripe later touches only the webhook handler. (The Stars-vs-Stripe trade-off is an open decision — §10.)

### 8.4 Command set (scoped by `ctx.state.user`)

| Command | Multi-user behavior |
|---|---|
| `/start` | Provisions account + welcome + first-add CTA. |
| `/add` | Dedup into global `channels` → insert `subscriptions(user_id, channel_id)`; enforce channel cap; sample fires. |
| `/channels` | Lists the user's subscriptions. |
| `/remove` | Soft-deletes the user's subscription only. |
| `/profile`, `/setprofile` | Read/write `user_profiles(user_id)`. |
| `/fetch`, `/test`, `/channel` | `summarizeVideoNow` scoped to user; counts against daily quota; renders ④ with their profile to their chat. |
| `/status` | Per-user: channel count, tier, `pro_until`, today's `/fetch` usage, grader on/off. |
| `/check` | Poll *my* channels now (gated ~once/5min/user). |
| `/settings` | Inline-keyboard editor for `user_settings` (language, min duration, delivery mode, quiet hours, tz, grader [Pro]). |
| `/minduration` | Alias into `/settings`. |
| `/grader` | This user's §3 state (tier + toggle). |
| `/upgrade` | Stars invoice (`sendInvoice`, `currency:'XTR'`); on payment → `grantPro`. |
| `/help` | Tier-aware help. |
| `/export` | Download your own data — profile, subscriptions, settings, digest history (§8.7). |
| `/delete-account` | Delete your account and all your data (§8.7). |
| `/admin_*` | `_stats`, `_broadcast`, `_grant`, `_user`, `_reap` — gated by `ADMIN_USER_IDS`. |

### 8.5 Per-user settings (in `user_settings`)

| Setting | Effect | Wires into |
|---|---|---|
| Language | Per-user output language. **Cache ①②③ in a base language and localize at render** into `user_deliveries.rendered` — do NOT fork the ①②③ cache per language or you lose the fan-out win. | `render.ts`, `personalize.ts` |
| Min duration | Per-user floor (§5.3 precedence). Free pinned ≥20. | poller filter / Stage B skip |
| Delivery mode + quiet hours (Pro) | `instant` sends on fan-out; `digest_window` buffers `state='personalized'` rows and flushes in a window respecting `quiet_start/end/tz`. | delivery drainer |
| Grader toggle (Pro) | §3 on/off in their render; shared §3 computed once if any Pro subscriber wants it. | Stage A + `render.ts:60-67` (already omits §3 gracefully) |

Defaults seed from current config (`MIN_DURATION_MINUTES=20`, `SUMMARY_LANGUAGE='English'`, grader off). Free users see Pro-only settings greyed with an `/upgrade` hint.

### 8.6 Lifecycle

- **First-value moment:** the sample digest from first `/add` — instrument it. `/start` but no `/add` in 24h → one nudge.
- **Activation nudge:** added a channel but no profile → one-time nudge that ④ is generic without it.
- **Re-engagement:** zero delivered digests in 14d → "your channels have been quiet — add a more active one?"
- **Churn signals:** `last_seen_at` stale >30d; subs dropped to 0; Pro lapsed unrenewed; high `/fetch` transcript failures.
- **Broadcasts:** `/admin_broadcast` writes a queue drained at ≤~25 msg/s with 429 backoff, skipping non-`active` users and catching `403` (blocked → `status='paused'`). Never loop `sendMessage` synchronously.

### 8.7 Account data & deletion

The profile is user-authored free-text. The cache split keeps each user's footprint narrow: `user_profiles` + `subscriptions` + `user_settings` + `user_deliveries`; ①②③ are shared, non-user-specific content.

- **Export — `/export`:** JSON of their `users` row (minus internal flags), profile, subscriptions (channel titles), settings, and delivered-digest timestamps. Scoped to the requesting user only.
- **Deletion — `/delete-account`:** two-step confirm, then hard-delete `user_profiles`/`subscriptions`/`user_settings`/`user_deliveries` (all `ON DELETE CASCADE`); set `users.status='deleted'`, `deleted_at=now()`, null `username` (tombstone). Do **not** touch shared `video_digests`/`videos`/`channels` (serve others). Confirm in-chat.
- **Retention:** `user_deliveries` pruned per tier (Free 14d / Pro 365d) nightly to bound storage. Global cache persists.
- **Disclosure:** a short note linked from `/help`/onboarding — what's stored and which processors see data (Anthropic/OpenAI/Groq/Supadata/OpenRouter receive *transcripts*, not identity; profile text goes to Anthropic only to generate §4).

---

## 9. Phased Implementation Roadmap

Each task ties to real files. Effort is rough engineer-days for one developer.

### P0 — Multi-tenant foundation (~10–14 days)

*Goal: identity is data; the digest row is split; the owner is backfilled and unbroken.*

1. Stand up `node-pg-migrate`; convert `schema.sql` → `migrations/0001_init`; rewrite `db/migrate.ts` with the advisory lock; remove `migrate()` from app boot, run as a Railway release command (`db/migrate.ts`, `index.ts`, `package.json`). *(2d)*
2. Migration `0001` new tables + indexes; `0002` owner backfill (§5.7) (`migrations/`). *(1.5d)*
3. Owner gate → upsert middleware; `ctx.state.user` (`bot/bot.ts`). *(1d)*
4. Scope `getProfile/setProfile` → `user_id`; per-user seed on `/start` (`services/profile.ts`, `bot/commands.ts`). *(0.5d)*
5. Add `subscriptions`; rewrite `addChannel`/`removeChannel`/`listChannels` → `listUserChannels` + `listPollableChannels` (`services/channels.ts`, `scheduler/poller.ts`). *(1.5d)*
6. **Split the digest write:** Stage A → `video_digests`; new fan-out INSERT…SELECT; Stage B per-user (`personalize`→`render`→deliver) reading `user_deliveries`; `deliver(chatId)`; delete `logDelivery` (`pipeline/process-video.ts`, `services/delivery.ts`, `services/videos.ts`). *(3d)*
7. Per-user `min_duration` precedence + the transcribe-if-any-subscriber-accepts / skip-per-user logic (`settings.ts`, `process-video.ts`). *(1d)*
8. Migrations `0003` (deploy) → soak → `0004` (retire legacy). *(0.5d + soak)*

### P1 — Scale & fan-out (~8–11 days)

*Goal: three services; the worker fleet parallelizes; coordination moves to the DB.*

1. Split `index.ts` by `ROLE` into telegram-io / worker / poller entrypoints; per-role pool sizes; `assertMigrated()` on worker/io (`index.ts`, `db/db.ts`). *(2d)*
2. Poller advisory-lock leader election replacing the `polling` boolean (`scheduler/poller.ts`). *(0.5d)*
3. Replace `PER_TICK=4` cron with continuous per-queue claim-loops; generalize `claimNextPending` → `claimNext(table)` with `run_after <= now()`; parameterize `reapStale` (`scheduler/worker.ts`, `services/videos.ts`). *(2d)*
4. Per-user (Stage B) drainer parallel to the video drainer; promote `groqCooldownUntil` → shared `groq_cooldown_until` row/`run_after` (`scheduler/worker.ts`, `youtube/ytdlp.ts`). *(2d)*
5. Delivery queue drained by telegram-io under the global token bucket + per-chat 1/s + 429 backoff + send-smoothing; move `chunkHtml` into the drainer (`services/delivery.ts`, telegram-io entry). *(2d)*
6. Graceful shutdown per role; `/healthz`+`/readyz` HTTP server; raise pool max; document PgBouncer trigger (`index.ts`, `db/db.ts`). *(1.5d)*
7. (Optional, when telegram-io must scale) webhook mode via `bot.createWebhook()`. *(1d)*

### P2 — Engineering hardening (~7–9 days)

*Goal: safe to change and operate.*

1. **Rotate all secrets + the proxy-log `scrub()` fix + test** (`youtube/ytdlp.ts`). *(0.5d, do first)*
2. Vitest setup, two projects, fixtures; the pure-logic unit suite (json/structured/render/chunk/tier-policy/worker-ladder/cooldown) (`test/unit/`). *(3d)*
3. `summarizeVideoNow` + `replyFor` domain extraction (dedup worker/command ladder); `services/ports.ts` + repo impls (`src/app/`, `services/`). *(2d)*
4. Testcontainers integration suite (queue/SKIP-LOCKED, pipeline, migrate) (`test/integration/`). *(1.5d)*
5. ESLint + GitHub Actions CI (required checks) + `docker build` job; staging env with its own bot token (`.github/`, `package.json`). *(1d)*
6. pino + Sentry + metrics + stall watchdog + restart alert (`util/logger.ts`, `index.ts`, worker/pipeline). *(1.5d)*
7. SSRF host-check, `/setprofile` length cap + injection delimiting, per-user rate-limit table, admin allowlist (`util/youtube.ts`, `bot/commands.ts`). *(1.5d)*

### P3 — Monetization (~5–7 days)

*Goal: Free/Pro live with bounded cost.*

1. `tier`/`pro_until` columns (in P0 `users`); quota enforcement at `/add`, `/fetch`, grader-gating (`bot/commands.ts`, `pipeline/process-video.ts`). *(2d)*
2. Split model knobs (`EXTRACT_MODEL`/`PERSONALIZE_MODEL`/`GRADER_MODEL`); `callClaude(model)`; Supadata-primary ASR + `whisper-1` spend cap; cost counters (`config.ts`, `llm/claude.ts`, `youtube/ytdlp.ts`). *(2d)*
3. `/upgrade` Stars invoice + `pre_checkout_query`/`successful_payment` → `grantPro`; nightly downgrade job; `grantPro/revokePro` abstraction (`bot/commands.ts`). *(2d)*
4. `/settings` inline editor, `/export`, `/delete-account`, retention prune job, lifecycle nudges (`bot/commands.ts`, new scheduler). *(2d)*

**Rough total: ~30–41 engineer-days.** P0 is the unlock and should land whole before P1/P3; P2.1 (secret rotation + log-leak) is hours and runs immediately, in parallel.

---

## 10. Risks & Open Decisions

| # | Risk / Decision | Impact | Resolution / Mitigation |
|---|---|---|---|
| R1 | **Billing rail: Stars vs Stripe** (open). | Stars has withdrawal/FX friction and Stars-denominated pricing; Stripe needs a merchant entity + dunning. | Ship Stars v1 behind `grantPro/revokePro`; decide before real ad spend (migrating paying subscribers is painful). |
| R2 | **ASR cost overrun** if `whisper-1` becomes the spillover path. | ~$7.3k vs ~$0.8k/mo at 1,000/O=0.25. | Supadata-primary; `whisper-1` last-resort behind a per-day spend cap; transcript cache; cost-counter alerts. |
| R3 | **Channel overlap `O` is uncertain** (drives the extraction line). | Total swings ~$2.5k–$6.3k/mo at 1,000 users. | Instrument distinct-videos vs personalizations from day one; Sonnet (not Opus) for ①② keeps the variable line manageable. |
| R4 | **Telegram 409 / single-poller** limits telegram-io scale. | One process per token. | Isolate to a replicas=1 service (Option 1); webhook mode (Option 2) only after delivery is fully queue-backed. |
| R5 | **Destructive migration 0004** drops legacy tables. | Data loss if the split was wrong. | Gated on soak verification; reversible `down`; no drop until app reads new tables. |
| R6 | **Per-language cache fork** would multiply ①②③ cost. | Loses the fan-out win. | Cache ①②③ in a base language; localize only at render into `user_deliveries.rendered`. |
| R7 | **Abuse via `/fetch`/`/add`** once open (free LLM/ASR burn). | Cost + queue starvation. | Per-user token-bucket + channel cap + queue-depth cap before opening beyond the owner. |
| R8 | **Profile prompt-injection / SSRF** in `/setprofile` and `resolveChannel`. | Prompt manipulation; internal-network fetches. | Length cap + delimited-untrusted prompt; `youtube.com` host validation. |
| R9 | **Per-replica global state** (`groqCooldownUntil`, tmpdir) under a fleet. | Independent hammering/cooldown; disk fill. | Promote cooldown to a shared DB row; clean tmpdir in `finally`. |
| R10 | **Secrets exposed** (pasted in chat / `.env.example`). | Token/key compromise. | Rotate all (§7.6) immediately; secrets only in Railway env. |
