# Podcast Digest Bot — System Architecture (Multi-Tenant Target)

**Status:** Architecture reference for the 1,000-user target system
**Source of truth:** `SPEC.md` (this document is its architectural projection)
**Audience:** Engineers building, operating, and reviewing the multi-tenant system

---

## 1. System Context

### 1.1 What the product is

The Podcast Digest Bot is a Telegram-native intelligence service. A user subscribes to YouTube channels; whenever a channel publishes a new long-form episode, the system transcribes it and delivers a structured 4-section digest to the user's Telegram chat:

- **① Key insights** — the episode's substantive takeaways.
- **② Patterns & anti-patterns** — recurring/contrarian structures the episode reveals.
- **③ Independent grade** — a skeptical quality assessment produced by a *separate* model family (independence is the point).
- **④ "For you" personalization** — the insights mapped onto the individual user's written profile.

Today the system is a single-owner appliance: the recipient, the profile, and the channel list are all environment variables. The target system turns every notion of "the user" into data and serves ~1,000 users with isolated subscriptions, profiles, settings, and delivery.

### 1.2 External actors

```
                          ┌─────────────────────────────────────────────┐
                          │             Podcast Digest Bot              │
                          │            (this system)                    │
                          └─────────────────────────────────────────────┘
   ACTOR                  DIRECTION   PURPOSE
   ─────────────────────  ─────────   ────────────────────────────────────────────
   Telegram users         in  ←→ out  /commands in; digests + replies out
   Telegram Bot API       in  ←→ out  getUpdates/webhook in; sendMessage out
   YouTube / RSS feeds     →  in      new-episode discovery (poller fan-in)
   Supadata               out →  in   Tier-0 managed transcription (primary at scale)
   Groq (Whisper turbo)   out →  in   Tier-2 ASR (free ~2 audio-h/hr window)
   OpenAI (whisper-1)     out →  in   Tier-3 ASR last-resort; ③ grader family (gpt-4o-mini)
   Anthropic (Claude)     out →  in   ①② extraction (Sonnet) · ④ personalization (Haiku)
   OpenRouter             out →  in   routing layer for the independent ③ grader model
   Residential proxy      out →  in   yt-dlp audio fetch path (Tier-1)
```

### 1.3 Central design principle

> **Sections ①②③ of a digest are pure functions of the transcript. Only section ④ depends on the user's profile.**

Everything expensive — the **transcript** (the binding cost/throughput constraint), the **①② extraction** call, and the **③ grade** call — is computed **once per video** and **fanned out** to every subscriber of that video's channel. Only **④** (personalization) and per-user delivery state are genuinely per-user.

Consequence: a popular episode followed by 400 of 1,000 users costs **1** transcript + **1** extract + **1** grade, then **400** cheap personalizations. Cost scales with *distinct videos on subscribed channels*, not with users. This is the single structural insight the entire architecture is built to express — the shared ①②③ cache (`video_digests`) and the per-user state (`user_deliveries`) are physically separate rows.

---

## 2. Component Architecture

### 2.1 Three deployables off one image, keyed by `ROLE`

`main()` splits by `ROLE ∈ {telegram-io, worker, poller}` into three entrypoints. **Same repo, same Docker image** — differentiated only by the `ROLE` env var and which secrets each is given.

| Service | `ROLE` | Replicas | Owns | Bot token? | ASR/LLM keys? |
|---|---|---|---|---|---|
| **telegram-io** | `telegram-io` | **1** (long-poll) / 2+ (webhook) | All Bot API I/O: command handlers (write DB rows only) + **all** outbound `sendMessage`. The delivery token-bucket lives here. | **Yes** | No |
| **worker** | `worker` | **3–4**, scale on queue depth | Pure DB→work→DB. Drains the video queue (Stage A) and the delivery/personalize queue (Stage B). No `bot` import, no `bot.launch()`, no `sendMessage`. | No | **Yes** |
| **poller** | `poller` | **1** (advisory-lock-guarded) | RSS/YouTube fan-in only over channels with ≥1 active subscriber. | No | No |

**Why exactly three:**
- **telegram-io** is the only thing bound to the bot token, so it owns *both* the 409 single-poller constraint *and* the per-token outbound rate budget — in one place, at `replicas=1`.
- **worker** has zero Telegram coupling, so it's the knob you turn under load. Stateless; horizontally scalable; coordinated only through Postgres.
- **poller** is cheap (cost is `O(distinct channels)`) and stays single-replica via a DB advisory lock (leader election).

### 2.2 Component diagram

```
                          ┌──────────────────────────────┐
                          │           Telegram            │
                          └───┬──────────────────────▲────┘
                webhook/poll  │                      │ sendMessage
                getUpdates    ▼                      │ (≤25/s global, ≤1/s per chat)
        ┌──────────────────────────────────────────┴───────────────────────┐
        │ SERVICE 1: telegram-io        (replicas: 1 long-poll | 2+ webhook)│
        │   • command handlers (commands.ts) → write DB rows ONLY           │
        │   • OWNS all outbound sends; drains delivery via token bucket     │
        │   • 409 constraint + per-token rate budget isolated here          │
        └───────────────┬──────────────────────────────────┬───────────────┘
       enqueue cmd rows │                                   │ claim delivery work
   (subscriptions, etc.)▼                                   │ (FOR UPDATE SKIP LOCKED)
   ┌─────────────────────────────────────────────────────────────────────────────┐
   │ POSTGRES (Railway) — queue + shared cache + per-user state + coordination     │
   │                                                                               │
   │  IDENTITY:  users · subscriptions · user_profiles · user_settings            │
   │  GLOBAL:    channels(deduped) · videos(global work queue)                     │
   │  SHARED:    video_digests   (①②③ — ONE row per video, the cache)              │
   │  CACHE:     transcripts     (text per video_id, survives reaps)               │
   │  PER-USER:  user_deliveries (④ + rendered HTML + delivery state, video×user)  │
   │  COORD:     pgmigrations · advisory locks · groq_cooldown_until(settings)     │
   └───┬─────────────────────────────▲────────────────────────────┬───────────────┘
       │ insert new videos            │ Stage A: claim pending     │ Stage B: claim
       │ (on conflict do nothing)     │ video → video_digests      │ pending user_delivery
       ▼                              │ then FAN OUT               ▼
   ┌──────────────────────┐   ┌───────┴───────────────────────────────────────────┐
   │ SERVICE 3: poller    │   │ SERVICE 2: worker        (replicas: 3–4, stateless)│
   │  (replicas: 1,       │   │                                                    │
   │   advisory-locked)   │   │  STAGE A (per video, once):                        │
   │  • RSS fan-in over   │   │    fetchVideoData → transcript waterfall           │
   │    channels w/ ≥1    │   │      (Supadata→Groq→OpenAI) → extract ①②           │
   │    active subscriber │   │      → grade ③  → write video_digests → FAN OUT    │
   │  • O(distinct chans) │   │  STAGE B (per user, fanned out):                   │
   └──────────┬───────────┘   │    load video_digests + profile → personalize ④   │
              │               │      → render → enqueue delivery                   │
              ▼               └──────────┬─────────────────────────────────────────┘
   ┌──────────────────────────────────┐ │  external calls (worker only)
   │ YouTube / RSS feeds              │ ▼
   └──────────────────────────────────┘ ┌───────────────────────────────────────────┐
                                        │ Supadata · Groq · OpenAI · Anthropic ·    │
                                        │ OpenRouter · residential proxy (yt-dlp)   │
                                        └───────────────────────────────────────────┘
```

Note: delivery is **enqueued** by the worker (Stage B writes a `personalized` row) but **sent** only by telegram-io, which claims those rows under the global token bucket. The worker never calls `sendMessage`.

---

## 3. Deployment Topology

### 3.1 Railway services

All three services run the **same image**; Railway differentiates them by the `ROLE` env var and per-service secret scoping. Postgres is Railway-managed.

| Railway service | `ROLE` | Replicas | Secrets injected | Health |
|---|---|---|---|---|
| telegram-io | `telegram-io` | 1 (long-poll) | `TELEGRAM_BOT_TOKEN`, `DATABASE_URL` | `/healthz`, `/readyz` |
| worker | `worker` | 3–4 | `ANTHROPIC_*`, `GROQ_*`, `OPENAI_*`, `SUPADATA_*`, `GRADER_*`, `YT_PROXY`, `DATABASE_URL` | `/healthz` |
| poller | `poller` | 1 | `DATABASE_URL` | `/healthz` |

### 3.2 Migrations as a release command

Migrations run via `node-pg-migrate up` as a Railway **release command** (one-shot, single container, runs before the new revision goes live). Application instances **do not** migrate:

- The **release command** acquires a Postgres advisory lock, runs `up`, releases.
- **worker** and **telegram-io** call a lightweight `assertMigrated()` (check `pgmigrations` max id ≥ expected) on boot and **refuse to start if behind**.
- `schema.sql` is retained only as documentation: "baseline = migration 0001; do not edit, write a new migration."

### 3.3 Deployment diagram

```
   git tag v* ──────────────► Railway (Production)            git push main ──► Railway (Staging)
                                                                                  own SEPARATE
   ┌──────────────────────────────────────────────────────┐    TELEGRAM_BOT_TOKEN (non-negotiable:
   │ RELEASE COMMAND (one-shot, single container)          │    409 means staging can't share prod's)
   │   node-pg-migrate up   (advisory-lock guarded)        │
   └───────────────────────────┬──────────────────────────┘
                               │ schema ready → app revisions start
        ┌──────────────────────┼───────────────────────────────────┐
        ▼                      ▼                                    ▼
  ┌─────────────┐       ┌─────────────┐                      ┌─────────────┐
  │ telegram-io │       │   worker    │  × 3–4 replicas      │   poller    │
  │ replicas=1  │       │ replicas=3–4│  (scale on depth)    │ replicas=1  │
  │ ROLE=       │       │ ROLE=worker │                      │ ROLE=poller │
  │  telegram-io│       │ pool max    │                      │ advisory-   │
  │ pool max ~5 │       │  ~10–15     │                      │ lock leader │
  │ /healthz    │       │ /healthz    │                      │ /healthz    │
  │ /readyz     │       │ assertMigr. │                      │ assertMigr. │
  └──────┬──────┘       └──────┬──────┘                      └──────┬──────┘
         │                     │                                    │
         └─────────────────────┴───────────────┬────────────────────┘
                                                ▼
                              ┌────────────────────────────────────┐
                              │   Railway Postgres                 │
                              │   direct conns now;                │
                              │   ── PgBouncer (transaction pool)  │
                              │      inserted HERE when total      │
                              │      conns approach ~80–100 ──     │
                              └────────────────────────────────────┘
```

**Connection budget & PgBouncer trigger.** Per-replica pool maxes: telegram-io ~5, each worker ~10–15, poller ~2. At 3–4 workers that is ~40–65 connections plus headroom for the release command and `/check` bursts. **Trigger point:** when total connections approach the Postgres `max_connections` ceiling (~80–100 on smaller Railway plans) — i.e. when scaling workers past ~4–5 or adopting webhook multi-replica telegram-io — insert **PgBouncer in transaction-pooling mode** between the app fleet and Postgres. The `SKIP LOCKED` claim queries are transaction-scoped and PgBouncer-safe; advisory **session** locks (poller leader, migrate) must use a dedicated non-pooled connection or session pinning.

**Health endpoints.** `/healthz` = `select 1` (liveness). `/readyz` (telegram-io) = migrated **and** bot ready. These let Railway catch the nastiest failure: a **silently wedged poller** (process up, `getUpdates`/poll loop dead, no digest in hours).

---

## 4. Data Model

### 4.1 Tables and what scales them

| Table | Scope | Grows with |
|---|---|---|
| `users` | PER-USER (identity) | user count |
| `user_profiles` | PER-USER | user count |
| `user_settings` | PER-USER (k/v) | user count × settings |
| `subscriptions` | PER-USER (user×channel join) | Σ subscriptions |
| `channels` | **GLOBAL / SHARED** (deduped by `youtube_channel_id`) | distinct channels |
| `videos` | **GLOBAL** (work queue) | distinct videos |
| `transcripts` | **GLOBAL / SHARED** (cache, keyed by `video_id`) | distinct videos |
| `video_digests` | **GLOBAL / SHARED** (①②③, one row per video — *the cache*) | distinct videos |
| `user_deliveries` | **PER-USER** (④ + render + delivery state, video×user) | Σ (video × subscriber) |

The hard line: everything **GLOBAL/SHARED** is computed once per video and read by many; everything **PER-USER** is the only thing that multiplies with users. `④` (in `user_deliveries`) is the only expensive-ish line that scales with users, and it is the cheapest call (Haiku).

### 4.2 ERD

```
   ┌──────────────────────┐
   │ users                │  PER-USER (identity)
   │  id (uuid) PK        │  telegram_user_id (bigint, unique natural key)
   │  telegram_chat_id    │  tier(free|pro), status, is_owner, pro_until
   └───┬─────┬─────┬──────┘
       │ 1:1 │ 1:N │ 1:N
       ▼     │     │
   ┌──────────────────────┐ │     │
   │ user_profiles        │ │     │  PER-USER (profile text)
   │  user_id PK,FK ──────┘ │     │  profile_text  → feeds ④ only
   └──────────────────────┘ │     │
                            ▼     │
   ┌──────────────────────┐       │  PER-USER (k/v)
   │ user_settings        │       │  (user_id,key) PK
   │  user_id FK ─────────┘       │  min_duration, language, delivery_mode,
   └──────────────────────┘       │  quiet_start/end, tz, grader_enabled
                                  ▼
   ┌──────────────────────┐           ┌──────────────────────┐
   │ subscriptions        │  N ──────► │ channels             │  GLOBAL / SHARED
   │  id PK               │  user×chan │  id PK               │  (deduped by
   │  user_id FK          │   join     │  youtube_channel_id  │   youtube_channel_id)
   │  channel_id FK ──────┼──────────► │   (unique)           │  min_duration_minutes
   │  active              │            │  active              │   (intrinsic floor)
   │  min_duration (ovr)  │            └──────────┬───────────┘
   │  subscribed_at       │                       │ 1:N
   │  UNIQUE(user,channel)│                       ▼
   └──────────────────────┘            ┌──────────────────────┐
                                       │ videos               │  GLOBAL work queue
                                       │  id PK               │  status(pending|
                                       │  channel_id FK ──────┘  processing|done|...)
                                       │  duration, status    │  partial idx on pending
                                       └───┬──────────┬───────┘
                          1:1 (cache)      │          │ 1:1 (cache)
            ┌─────────────────────────────┘          └──────────────────┐
            ▼                                                            ▼
   ┌──────────────────────┐                              ┌──────────────────────┐
   │ transcripts          │  GLOBAL / SHARED             │ video_digests        │  GLOBAL / SHARED
   │  video_id PK,FK      │  text (300k clamp)           │  id PK               │  ①②③ — ONE per video
   │  source_tier         │  survives video reaps        │  video_id FK UNIQUE  │  key_insights ①
   │  char_len, created   │                              │  patterns/antipat ②  │  grading ③ (nullable)
   └──────────────────────┘                              │  extract_model       │  grader_model
                                                         └──────────┬───────────┘
                                                                    │ (fan-out: INSERT…SELECT
                                                                    │  one row per active subscriber)
                                                                    ▼
                                                         ┌──────────────────────┐
                                                         │ user_deliveries      │  PER-USER
                                                         │  id PK               │  (absorbs old digests
                                                         │  user_id FK ─────────┼── per-user half +
                                                         │  video_id FK         │   old delivery_log)
                                                         │  tailored ④          │  rendered(HTML)
                                                         │  state, skip_reason  │  message_ids
                                                         │  run_after (backoff) │  delivered_at
                                                         │  UNIQUE(user,video)  │  ← idempotency guard
                                                         └──────────────────────┘
```

**Key relationships & invariants:**
- `subscriptions UNIQUE(user_id, channel_id)` — one subscription per user per channel; `active` is the soft-unsubscribe flag.
- `video_digests.video_id UNIQUE` — exactly one shared ①②③ row per video; the fan-out INSERT uses `on conflict (video_id) do nothing`.
- `user_deliveries UNIQUE(user_id, video_id)` — **a user never gets the same video twice**, even across restarts and reaps. This is the cross-stage idempotency guard.
- `grading` (③) is nullable by design — the digest ships even when the grader fails or is gated off.
- Deletion: `user_profiles`/`subscriptions`/`user_settings`/`user_deliveries` are `ON DELETE CASCADE` from `users` — account deletion is a single delete that leaves shared data (serving others) untouched.

---

## 5. Core Data Flows

### 5.1 (a) Onboarding / subscribe

```
User            telegram-io                 Postgres                         worker
 │  /start          │                          │                               │
 │─────────────────►│ upsert user from ctx.from│                               │
 │                  │─────────────────────────►│ users (insert/update)         │
 │  welcome + CTA   │◄─────────────────────────│                               │
 │◄─────────────────│                          │                               │
 │  /add <url>      │                          │                               │
 │─────────────────►│ validate host=youtube.com│                               │
 │                  │ resolveChannel           │                               │
 │                  │ upsert global channel ───►│ channels (on conflict        │
 │                  │ insert subscription ─────►│   youtube_channel_id nothing)│
 │                  │   (enforce channel cap)  │ subscriptions(user,channel)  │
 │                  │ BACKFILL_ON_ADD:         │                               │
 │                  │ enqueue latest episode ──►│ videos (pending) ────────────┼──► picked up
 │  "added; sample  │                          │                               │    by Stage A
 │   on its way"    │◄─────────────────────────│                               │
 │◄─────────────────│                          │                               │
 │ ... later: /setprofile <text>               │                               │
 │─────────────────►│ cap length, store ───────►│ user_profiles(user_id)       │
 │  "④ is personal  │                          │  (NOT seeded by default —     │
 │   from next one" │                          │   activation = sub + profile) │
 │◄─────────────────│                          │                               │
```

Activation = **≥1 active subscription AND `profile_text != ''`**. No default profile is seeded — a generic seed would make ④ *look* personalized while being noise.

### 5.2 (b) Poll → enqueue video

```
poller (replicas=1, advisory-locked)        Postgres                   external
 │  POLL_CRON fires                            │                          │
 │  pg_try_advisory_lock(LOCK_KEY) ───────────►│                          │
 │  got? ──no──► return (another replica leads)│                          │
 │  got=yes:                                   │                          │
 │  listPollableChannels()                     │                          │
 │   (channels w/ ≥1 active subscriber) ◄──────│ join subscriptions       │
 │  for each channel: fetch RSS ───────────────┼─────────────────────────►│ YouTube RSS
 │   compute "since" =                         │                          │
 │     min(subscriptions.subscribed_at, active)│                          │
 │   for each upload newer than since:         │                          │
 │     enqueueVideo ──────────────────────────►│ videos (insert,          │
 │       on conflict do nothing                │   on conflict do nothing)│
 │  pg_advisory_unlock(LOCK_KEY) ─────────────►│                          │
```

Cost is `O(distinct channels with ≥1 active sub)`, not `O(users)`. The advisory lock replaces the old in-memory `polling` boolean so multiple poller replicas (or an overlapping cron) cannot double-poll.

### 5.3 (c) Stage A — per video, exactly once

```
worker (any replica)                  Postgres                        external
 │ claimNext(videos):                   │                               │
 │  WHERE status='pending'              │                               │
 │  ORDER BY created_at LIMIT 1         │                               │
 │  FOR UPDATE SKIP LOCKED ────────────►│ → row 'processing'            │
 │                                      │                               │
 │ fetchVideoData ──────────────────────┼──────────────────────────────►│ YouTube
 │ transcript cache hit? ──────────────►│ transcripts(video_id)?        │
 │   if yes → use cached text           │                               │
 │   if no → WATERFALL:                  │                               │
 │     Tier0 Supadata ──────────────────┼──────────────────────────────►│ Supadata
 │       null? → Tier1 yt-dlp+proxy ────┼──────────────────────────────►│ proxy→YouTube
 │       → ffmpeg → Tier2 Groq whisper ─┼──────────────────────────────►│ Groq
 │         429? throw TranscriptRate-   │                               │
 │              Limited → re-queue,     │                               │
 │              set groq_cooldown ──────►│ settings.groq_cooldown_until │
 │       Groq 429 only → Tier3 whisper-1┼──────────────────────────────►│ OpenAI
 │     store transcript ────────────────►│ transcripts (cache)          │
 │ DURATION GATE: transcribe iff         │                               │
 │   min(applicable thresholds) ≤ dur    │                               │
 │ extractInsights ①② ──────────────────┼──────────────────────────────►│ Anthropic (Sonnet)
 │ gradeIdeas ③ (gated; may fail) ──────┼──────────────────────────────►│ OpenRouter (gpt-4o-mini)
 │ write video_digests ─────────────────►│ video_digests                │
 │   on conflict(video_id) do nothing   │  (①②③, grading may be null)   │
 │ set videos.status='done' ────────────►│                               │
 │ FAN OUT (see 5.4) ───────────────────►│ user_deliveries              │
```

The grader is independent and non-blocking: `grading` may be null and Stage B still ships. The duration gate is per-*any-subscriber* — Stage A transcribes if **any** subscriber's resolved threshold accepts the duration; Stage B drops it for those whose threshold excludes it.

### 5.4 (d) Stage B fan-out — per subscriber

```
worker (Stage A completion)            Postgres
 │ FAN-OUT (single idempotent INSERT…SELECT):
 │   insert into user_deliveries (user_id, video_id, state)
 │   select s.user_id, v.id, 'pending'
 │   from subscriptions s
 │   join videos v on v.id = $1
 │   where s.channel_id = v.channel_id
 │     and s.active and s.subscribed_at <= now()
 │   on conflict (user_id, video_id) do nothing; ──────► one 'pending' row per
 │                                                        active subscriber
 │
worker (Stage B drainer, any replica)
 │ claimNext(user_deliveries):
 │   WHERE state='pending' AND run_after<=now()
 │   ORDER BY run_after LIMIT N FOR UPDATE SKIP LOCKED ──► claim
 │ resolve per-(user,channel) min_duration:
 │   1 subscriptions.min_duration_minutes
 │   2 user_settings['min_duration_minutes']
 │   3 channels.min_duration_minutes
 │   4 config.MIN_DURATION_MINUTES
 │ duration excluded for this user?
 │   → state='skipped', skip_reason  (STOP)
 │ load shared video_digests + this user's profile
 │ personalize ④ ──► Anthropic (Haiku) ──► tailored
 │ renderDigest (localize per user_settings.language) ──► rendered HTML
 │ set state='personalized', run_after = now() + smoothing
 │   (then telegram-io picks it up — see 5.5)
```

A popular episode followed by 400 users = **1** Stage-A pipeline + **400** Stage-B personalize/render ops. The `unique(user_id, video_id)` constraint guarantees exactly-once delivery per user.

### 5.5 (e) Delivery under the global token bucket

Delivery is **removed from the worker** and drained by **telegram-io**, which owns the bot token and therefore the per-token send budget.

```
telegram-io delivery drainer (replicas=1)        Postgres / Telegram
 │ loop (~every tick):
 │  claim N personalized rows:
 │    WHERE state='personalized' AND run_after<=now()
 │      AND user NOT messaged in last 1s   ◄── per-chat 1/s guard
 │    ORDER BY run_after LIMIT N
 │    FOR UPDATE SKIP LOCKED ──────────────────► claim
 │  GLOBAL TOKEN BUCKET: ≤25 msg/s (headroom under Telegram's ~30/s)
 │    (webhook/multi-replica: back the bucket with an atomic rate_window row)
 │  for each row:
 │    chunkHtml(rendered) → ≤4096-char chunks
 │    sendMessage(user.telegram_chat_id, chunk) ─► Telegram
 │      429? read retry_after:
 │        set row.run_after = now()+retry_after ─► requeue (NO crash)
 │        pause bucket for that window
 │      403 (blocked)? user.status='paused', skip
 │      ok? append message_ids; state='delivered', delivered_at=now()
 │
 │ PRE-SMOOTHING (set at fan-out / personalize time):
 │   run_after = now() + (row_number()/25) sec
 │   → 1,000 messages spread over ~40s; no chat exceeds 1/s across its
 │     multi-chunk digest.
```

The three Telegram limits are all handled here: **~30/s global** (token bucket at 25), **~1/s per chat** (claim skips recently-messaged users), and **429 `retry_after`** (graceful requeue + bucket pause, replacing "crash on failure").

---

## 6. Queue & Concurrency

### 6.1 Two Postgres `SKIP LOCKED` queues

The system runs **two** hand-rolled Postgres queues (no Kafka, no pg-boss). Both use the identical claim discipline proven in the original `videos.ts`:

| Queue | Table | Claimed by | States |
|---|---|---|---|
| **Video queue** (Stage A) | `videos` | worker fleet | `pending → processing → done` (`failed`, `no_transcript`) |
| **Delivery/personalize queue** (Stage B) | `user_deliveries` | worker (personalize) + telegram-io (send) | `pending → personalized → delivered` (`failed`, `skipped`) |

**Claim** (atomic, multi-instance-safe):

```sql
SELECT ... FROM <table>
WHERE state = 'pending' AND run_after <= now()
ORDER BY <ordering> LIMIT $n
FOR UPDATE SKIP LOCKED;
```

`SKIP LOCKED` lets the worker fleet scale freely: two workers claiming concurrently get **different** rows, never the same one. The original `WORKER_CRON` + `PER_TICK=4` ceiling (~80 videos/hr) is replaced by **continuous claim-loops** per queue.

### 6.2 Retry, reaper, DLQ

- **Retry:** failures increment an attempt counter and set `run_after = now() + backoff`. **Exception:** `TranscriptRateLimited` re-queues to `pending` **without** incrementing attempts (a throttle is not a failure) — this is a reliability invariant.
- **Reaper:** `reapStale()` requeues any row stuck `processing`/in-flight past `STALE_MINUTES` (15), recovering work orphaned by a crashed worker. Parameterized to run against both queues.
- **DLQ:** rows exceeding max attempts move to a terminal `failed`/`no_transcript` state (the dead-letter), surfaced via metrics and Sentry rather than silently retried forever.

### 6.3 Advisory-lock leader election (poller)

```ts
const LOCK_KEY = 4815162342n
const { rows } = await pool.query('select pg_try_advisory_lock($1) as got', [LOCK_KEY])
if (!rows[0].got) return            // another poller replica holds it
try { await runPoller() } finally { await pool.query('select pg_advisory_unlock($1)', [LOCK_KEY]) }
```

This replaces the useless in-memory `polling` boolean. A separate session advisory lock guards migrations so exactly one booting actor (the release command) migrates.

### 6.4 DB-shared Groq cooldown

The per-process 8-minute `groqCooldownUntil` is promoted to a **shared `groq_cooldown_until` row** (in `settings`). Without this, a fleet of workers would each independently hammer Groq after a 429. With it, one worker's 429 sets a cooldown all workers observe — the waterfall skips Tier-2 fleet-wide until it expires.

### 6.5 Idempotency keys

- `videos`: `on conflict do nothing` on the natural video key — the poller can't enqueue the same upload twice.
- `video_digests.video_id UNIQUE`: Stage A's write is `on conflict (video_id) do nothing` — extraction is pinned to once-per-video.
- `user_deliveries UNIQUE(user_id, video_id)`: the fan-out INSERT and every claim are idempotent — **no user receives a video twice** across restarts, reaps, or duplicate fan-outs.

---

## 7. Failure Modes & Resilience

| Failure | Detection | Response |
|---|---|---|
| **Supadata (Tier 0) fails/quota** | returns `null` | fall through to Tier 1 (yt-dlp+proxy) |
| **Groq (Tier 2) 429** | `TranscriptRateLimited` thrown | re-queue to `pending` **without** burning attempts; set shared `groq_cooldown_until`; fleet skips Tier 2 until expiry; Tier 3 (`whisper-1`) only on Groq 429 |
| **Whisper-1 (Tier 3) overrun** | per-day spend counter | last-resort only, behind a daily spend cap; alert when approaching |
| **Transcript permanently unavailable** | all tiers exhausted | `videos.status='no_transcript'` (DLQ); Sentry; no digest sent |
| **Grader (③) fails** | call error / gated | `grading=null`; digest ships ①②④ — non-blocking by design |
| **Telegram 429 on send** | `retry_after` in response | set `run_after=now()+retry_after`; pause bucket; requeue (no crash) |
| **Telegram 403 (user blocked bot)** | send error | `users.status='paused'`; skip; don't retry |
| **Worker crash mid-pipeline** | row stuck `processing` | `reapStale()` requeues after `STALE_MINUTES`; another worker reclaims via `SKIP LOCKED` |
| **Partial fan-out** (crash between Stage A done and full INSERT…SELECT) | next Stage-A reclaim re-runs fan-out | fan-out is idempotent (`on conflict do nothing`); missing subscriber rows backfilled; existing rows untouched |
| **Poller crash** | leader lock released on disconnect; `/healthz` | another replica (or next cron) acquires the lock; stall watchdog pages if no poll in N hours |
| **409 Conflict (second poller on bot token)** | duplicate `getUpdates` | structurally prevented: telegram-io is `replicas=1`; webhook mode eliminates `getUpdates` entirely |
| **Silently wedged poller/io** (process up, loop dead) | `/readyz` + stall watchdog (zero `delivered` in 6h while `pending`>0) | Railway restart on failed health check; Telegram alert |

The unifying property: **every external failure becomes a re-queue, not a crash.** The only terminal states are `failed`/`no_transcript`/`skipped`, all observable.

---

## 8. Scaling Characteristics & Limits

### 8.1 What scales horizontally

- **worker fleet** — stateless; add replicas to drain queues faster. Coordinated entirely through Postgres (`SKIP LOCKED` + shared cooldown). This is the primary scaling knob, turned on queue depth.
- **Cost** — scales with **distinct videos on subscribed channels**, *not* user count, because ①②③ are cached per video. The only user-scaling line (④) is the cheapest call (Haiku).

### 8.2 Known ceilings

| Ceiling | Limit | Mitigation / scale-path |
|---|---|---|
| **Single poller** | one leader (advisory lock) | poller is `O(distinct channels)` and cheap — single replica is sufficient far past 1,000 users; not the bottleneck |
| **Telegram send rate** | ~30 msg/s global per token | token bucket at 25/s + per-chat 1/s + pre-smoothing; **one token = one telegram-io**; webhook mode lets telegram-io scale >1 only once delivery is fully queue-backed |
| **Telegram 409** | one long-poller per token | isolated to `replicas=1` telegram-io; webhook eliminates it |
| **Postgres connections** | ~80–100 on small plans | per-role pool caps; **PgBouncer (transaction pooling)** when total conns approach the ceiling |
| **Transcription (ASR)** | Groq free ≈ 336 audio-h/wk | the binding throughput constraint; **Supadata-primary at scale** (no audio download, sidesteps proxy burn + Groq cooldown); transcript cache pins to once-per-video; `whisper-1` capped |

### 8.3 Documented scale-path

1. **Now:** 3 services, direct Postgres connections, single long-poll telegram-io, Groq-free + Supadata ASR.
2. **Under DB connection pressure (scaling workers >4–5):** insert PgBouncer (transaction pooling); keep session advisory locks on dedicated connections.
3. **Under ASR pressure:** make Supadata primary; demote `whisper-1` behind a per-day spend cap; rely on the transcript cache + dedup.
4. **Under telegram-io send pressure:** move to webhook mode (`bot.createWebhook()`) so telegram-io scales >1, backing the rate bucket with an atomic DB `rate_window` row.
5. **Beyond Railway (documented, not near-term):** the same image + `ROLE` split maps onto any container platform; no Kafka/Kubernetes is required to reach the 1,000-user target.

---

## 9. Cross-Cutting Concerns

### 9.1 Config & secrets

- **All config is env-driven**; the same image is parameterized by `ROLE` plus per-service secret scoping (telegram-io gets the bot token; worker gets ASR/LLM/proxy keys; poller gets only `DATABASE_URL`).
- **Model routing is split** into per-stage env vars — `EXTRACT_MODEL` (Sonnet, shared ①②), `PERSONALIZE_MODEL` (Haiku, per-user ④), `GRADER_MODEL` (gpt-4o-mini, independent ③) — not one global `ANTHROPIC_MODEL` knob.
- **Secrets live only in Railway env.** Rotate all keys (Telegram, Anthropic, OpenAI, Groq, OpenRouter, Supadata, proxy creds, Postgres password); verify `.env` was never committed; secrets never appear in chat or logs.

### 9.2 Observability

- **Logging:** structured **pino** with `video_id`/`channel_id`/`user_id` fields so one episode's journey is greppable across services. `pino.redact` plus a `scrub()` regex strip proxy credentials (`//user:pass@` → `//***:***@`) and `DATABASE_URL` from every `String(e)` — closing the real `--proxy` argv log-leak in the yt-dlp path.
- **Metrics:** queue depth (both queues), transcription-tier hit-rate (`supadata_hit`/`groq_hit`/`openai_fallback_hit`/`rate_limited`), delivery success ratio from `user_deliveries.state`, per-stage latency, token/audio-second cost counters from API `usage`, cooldown-trip count.
- **Errors:** **Sentry** at the three places errors vanish — `uncaughtException`/`unhandledRejection`, `bot.catch`, and terminal `failed`/`no_transcript` worker branches (tagged with `video_id`/`user_id`).
- **Health:** `/healthz` (`select 1`), `/readyz` (migrated + bot ready); a **stall watchdog** (zero `delivered` in 6h while `pending`>0 → "pipeline stalled") and a Railway restart-count alert, both wired to the operator's Telegram.

### 9.3 Migrations

Versioned `node-pg-migrate` files, run **off-boot** as a Railway release command under an advisory lock; app instances `assertMigrated()` and refuse to start if behind. The owner→multi-tenant cutover is a sequenced, reversible plan: **0001** additive new tables, **0002** owner backfill (the global `channels` list becomes the owner's `subscriptions`; old `digests` split into `video_digests` + `user_deliveries`), **0003** deploy multi-tenant code, **0004** retire legacy tables (the only destructive step, gated on soak verification). No destructive drop until the app reads from the new tables.

### 9.4 Security

- **Identity & authz:** the blanket owner-gate becomes an upsert middleware; admin-only operations gate on an `ADMIN_USER_IDS` allowlist checked per-command.
- **Rate limiting:** per-`user_id` token buckets on expensive command paths (`/fetch`/`/channel`/`/test` each force a full transcribe + 3 LLM calls); channel caps and per-user queue-depth caps prevent one user starving the shared `videos` queue.
- **Input validation:** `resolveChannel` validates the fetch host is `youtube.com` (SSRF defense); `/setprofile` length-capped (~2000 chars) and treated as untrusted, clearly delimited in the personalize prompt (prompt-injection defense). All SQL is parameterized.
- **Account data:** the cache split keeps each user's footprint to `user_profiles`/`subscriptions`/`user_settings`/`user_deliveries` (all `ON DELETE CASCADE`). `/export` and `/delete-account` (hard-delete + tombstone) touch no shared data; `user_deliveries` is pruned per tier (Free 14d / Pro 365d) nightly to bound storage.
