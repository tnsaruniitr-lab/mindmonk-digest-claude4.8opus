# Podcast Digest Bot — Architecture

**Status:** Living architecture reference · **Source of truth:** code (Part I) + `SPEC.md` / `PHASES.md` (Part II)

This document has three parts:

- **Part I — Current Architecture (As-Built Today)** — what exists and runs right now (single-user appliance + the 3-tier transcription waterfall).
- **Part II — Target Architecture (What We Will Build)** — the 1,000-user multi-tenant design. Companion to `SPEC.md` (full spec) and `PHASES.md` (phased plan + UATs).
- **Part III — Engineering Best Practices (Reference)** — durable do/don't conventions this codebase is held to.

---

# Part I — Current Architecture (As-Built Today)

> Scope: documents **what exists in the code right now** in `podcast-digest-bot/` (git root `tnsaruniitr-lab/mindmonk-digest-claude4.8opus`, branch `main`). Single-user assumptions are flagged inline as **[SU]** because they are the load-bearing constraints Part II must unwind. Citations are `file:line` against the current tree.

---

## 1. Process & Deployment Model

The bot is **one long-lived Node process** started by `npm start` → `tsx src/index.ts` (`package.json:11`; no build step — `tsx` runs TypeScript directly). `main()` (`src/index.ts:17`) does four things in order, then stays resident:

1. **`await migrate()`** (`src/index.ts:18`) — applies the schema on boot (see §2).
2. **`await ensureProfileSeeded()`** (`src/index.ts:19`) — inserts the seed profile if `user_profile` is empty (`src/services/profile.ts:18`). **[SU]**
3. **Registers two cron loops** (`src/index.ts:22-27`).
4. **Launches Telegraf long-polling** (`src/index.ts:32`).

Inside this single process, **three concurrent loops** run:

| Loop | Mechanism | Cadence | Guard |
|---|---|---|---|
| **Telegram bot** | `bot.launch()` long-poll (`src/index.ts:32`) | continuous | 409-Conflict ⇒ single instance only |
| **Poller** | `cron.schedule(POLL_CRON, …)` (`src/index.ts:22`) | `*/15 * * * *` default (`config.ts:23`) | module-level `polling` bool (`poller.ts:14`) |
| **Worker** | `cron.schedule(WORKER_CRON, …)` (`src/index.ts:25`) | `*/3 * * * *` default (`config.ts:24`) | module-level `running` bool (`worker.ts:12`) |

A one-shot poll→worker pass also fires ~5 s after boot (`src/index.ts:39-43`).

**The 409 single-instance constraint [SU].** `bot.launch()` is deliberately **not awaited** (`src/index.ts:29-35`) — its promise only resolves on stop, so on any polling death (token revoked, **409 Conflict** from a second poller, network drop) the catch handler calls `process.exit(1)` to force a supervisor restart. Telegram permits exactly **one** `getUpdates` long-poller per bot token; running a second copy of this process produces a 409. **This is why the bot cannot be horizontally scaled as-is** — it assumes a single replica. The same restart-on-death philosophy covers `uncaughtException` (`src/index.ts:12-15`).

**Concurrency safety of the two cron loops** rests only on **in-process booleans** (`polling`, `running`) — they prevent *overlapping ticks within this one process*, not across processes. The DB claim (§3) is what actually makes work safe across processes; the booleans are just tick de-dup.

**Railway services (deployment).** The bot is deployed as a Railway worker, built from the repo `Dockerfile` (`railway.json:3-6`, `builder: DOCKERFILE`), started with `npm start`, `restartPolicyType: ON_FAILURE` / `maxRetries: 10` (`railway.json:7-11`) — Railway is the "supervisor" the exit-on-failure code relies on. The container (`Dockerfile`) is `node:20-slim` and installs the **transcription toolchain at the OS level**: `ffmpeg` (apt) + the `yt-dlp` linux binary fetched from GitHub releases (`Dockerfile:5-12`). There is **no inbound HTTP port** — it is a pure outbound worker (Telegram long-poll, not webhook).

The broader Railway project also runs **Railway Postgres** (the bot's only datastore) and a **separate `mindmonk-landing` static site** — an independent service unrelated to the bot's runtime (no code dependency in this repo).

**Schema auto-apply on boot.** `migrate()` reads `src/db/schema.sql` off disk and runs the whole file as one `pool.query` (`src/db/migrate.ts:7-11`). Every statement is `create table if not exists …` / `create index if not exists …`, so boot is **idempotent** — no separate migration tool, no manual SQL step on Railway. There is **no migration versioning**; schema changes are made by editing `schema.sql` and they only apply additively (existing columns are never altered).

---

## 2. Data Model

`schema.sql` defines **6 tables** (the spec said 7; the code has 6 — there is no separate transcripts table, transcripts are never persisted). All single-user assumptions are baked into the shapes below.

| Table | Key columns | Notes / **[SU]** |
|---|---|---|
| **channels** (`schema.sql:8`) | `id` uuid PK, `youtube_channel_id` text **unique**, `title`, `handle`, `url`, `active` bool, `min_duration_minutes` int (per-channel override, null⇒global), `last_checked_at`, `created_at` | **[SU] Global, un-scoped** — no `user_id`. Every channel is followed by *the* user. Soft-delete via `active=false` (`channels.ts:36`). |
| **videos** (`schema.sql:21`) | `id` uuid PK, `video_id` text **unique**, `channel_id`→channels (cascade), `title`, `url`, `published_at`, `duration_seconds`, `is_long_form`, `status` text default `'pending'`, `skip_reason`, **`attempts`** int, **`transcript_attempts`** int, `created_at`, `processed_at`, `claimed_at` | The work queue. **`video_id` unique ⇒ a video processed once is processed once globally** (`videos.ts:14-15` `on conflict do nothing`). **[SU]** Indexed on `status` and `channel_id` (`schema.sql:39-40`). |
| **digests** (`schema.sql:43`) | `id` uuid PK, `video_id`→videos (cascade), `key_insights` jsonb (§1), `patterns` jsonb (§2), `antipatterns` jsonb (§2), `grading` jsonb (§3), `tailored` jsonb (§4), `rendered` text (final Telegram HTML), `primary_model`, `grader_model`, `created_at` | **One digest row per video [SU]** — §4 `tailored` is the *single* user's personalization, stored on the video-level digest, not per-recipient. |
| **user_profile** (`schema.sql:59`) | `id` int PK default **1**, `profile_text` text, `updated_at`, **`constraint user_profile_singleton check (id = 1)`** | **[SU] DB-enforced singleton.** Exactly one profile can ever exist. Read/written hard-coded to `id = 1` (`profile.ts:5,11`). This is the strongest single-user lock in the schema. |
| **settings** (`schema.sql:67`) | `key` text PK, `value` text | **[SU] Global k/v.** e.g. `min_duration_minutes` (`settings.ts:16-20`). One namespace for the whole app, not per-user. |
| **delivery_log** (`schema.sql:73`) | `id` uuid PK, `video_id`→videos (set null), `chat_id` text, `message_ids` jsonb, `ok` bool, `error`, `delivered_at` | Audit trail. `chat_id` is always `config.TELEGRAM_CHAT_ID` (`delivery.ts:84`). **[SU]** |

**The single-recipient axiom [SU].** Delivery never reads a recipient from the DB — it always sends to `config.TELEGRAM_CHAT_ID` from env (`delivery.ts:54`, `delivery.ts:70`). The bot's owner gate (`bot.ts:15-20`) silently drops any update whose `chat.id` ≠ `TELEGRAM_CHAT_ID`. **There is exactly one recipient, defined by an env var, not a table.** Combined with the singleton profile, the global channels list, and the global settings, the entire data model is structurally single-tenant.

---

## 3. Queue Mechanics

The queue is the `videos` table; there is no external broker.

- **Connection pool.** A single `pg.Pool`, `max: 5`, SSL gated by `DATABASE_SSL` (`src/db/db.ts:6-11`). Thin `query()` / `one()` helpers (`db.ts:13-21`).

- **Atomic claim — `FOR UPDATE SKIP LOCKED`.** `claimNextPending()` (`videos.ts:27-37`) issues a single `UPDATE … SET status='processing', claimed_at=now() WHERE id = (SELECT id … WHERE status='pending' ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`. This is the real concurrency primitive: two workers (even across processes) never claim the same row, and a locked row is skipped rather than blocked. FIFO by `created_at`.

- **Targeted claim — `claimById()`** (`videos.ts:40-47`): `UPDATE … WHERE id=$1 AND status='pending'`. Used by the on-demand `/fetch`,`/channel` path so a manual request can't race the worker that may have already grabbed it (`commands.ts:37`).

- **Stale reaping — `reapStale(minutes)`** (`videos.ts:50-58`): requeues rows stuck in `processing` with `claimed_at < now() - interval` (default **15 min**, `worker.ts:10`). Called at the top of every worker tick (`worker.ts:19`) so a process that dies mid-task self-heals.

- **Two independent counters.** `attempts` = **hard failures** (network/model), cap **`MAX_ATTEMPTS_PROCESS = 6`** (`worker.ts:8`). `transcript_attempts` = **caption-wait retries**, cap **`MAX_ATTEMPTS_TRANSCRIPT = 20`** (`worker.ts:9`). They are incremented separately via `incAttempts` / `incTranscriptAttempts` flags on `setVideoStatus` (`videos.ts:84-85`). The split exists so a video whose auto-captions are merely *lagging* can be retried ~20× without exhausting the 6-strike hard-failure budget.

- **Drain rate.** `PER_TICK = 4` (`worker.ts:7`) — each worker tick claims and processes up to 4 videos sequentially (`worker.ts:22-26`).

- **Status lifecycle** (`VideoStatus`, `types.ts:13-19`):

```
                 enqueue (poller / backfill / /fetch)
                          │
                          ▼
   reapStale ──────►   pending ──claimNextPending/claimById──► processing
   (15m stuck)            ▲                                        │
                          │                                        ▼
        ┌─────────────────┼──────────────┬───────────┬────────────┬─────────────┐
   rate_limited     awaiting_captions   too_short   delivered   hard-fail   captions
   (no counter    (transcript_attempts  /live/etc                (attempts   exhausted
    bump, §5)       <20 → pending)         │           │          ≥6)        (≥20)
        │                 │                 ▼           ▼           ▼            ▼
     pending           pending           skipped      done       failed   no_transcript
```

`done` / `skipped` / `failed` / `no_transcript` are terminal (each `markProcessed:true`). The branching logic lives in `processOne()` (`worker.ts:33-85`); the same branches are duplicated for the on-demand path in `runVideoNow()` (`commands.ts:42-66`).

---

## 4. The 4-Section Digest Pipeline

`processVideo(video, opts)` (`pipeline/process-video.ts:20`) is the whole pipeline. Order of operations:

1. **Metadata** via `fetchVideoData(video.url)` (yt-dlp `-J` dump, `ytdlp.ts:55`); persists `duration_seconds` + `title` (`process-video.ts:29`).
2. **Long-form filter** (skipped when `opts.force`, i.e. `/fetch` & `/channel`): skips live/upcoming, re-queues `post_live` as `NoTranscriptYet`, and skips anything under `getMinDurationMinutes()×60` (`process-video.ts:32-44`). Default threshold 20 min (`config.ts:22`), overridable via `settings` (`/minduration`).
3. **Transcript waterfall** → see §5 (`process-video.ts:46-57`).
4. **The four sections:**

| § | Producer | Model | Level |
|---|---|---|---|
| **① Key insights** + **② Patterns/antipatterns** | `extractInsights()` (`pipeline/extract.ts:14`) | **Claude** `ANTHROPIC_MODEL` (`claude-opus-4-8` default, `config.ts:15`) via `callClaude` (`llm/claude.ts:8`) | **video-level** |
| **③ Unbiased grade** | `gradeIdeas()` (`pipeline/grade.ts:17`), only if `graderConfigured` | **Separate grader LLM** via `callGrader` → OpenRouter `openai/gpt-4o` default (`config.ts:17-20`, `llm/grader.ts:9`) | **video-level** |
| **④ For you** | `personalize()` (`pipeline/personalize.ts:16`) | **Claude** (same primary model) | **per-user [SU]** — but only one user exists |

   §3 is **independent by design**: a different model family than the primary so the grade is a true second opinion, not self-assessment (`.env.example:19-26`, system prompt `grade.ts:27`). It fails **soft** — if the grader throws, the digest ships without §3 (`process-video.ts:63-69`). All three LLM calls go through `structured()` (`util/structured.ts:9`), which validates against Zod and retries **once** with a stricter "JSON only" instruction on parse failure.

5. **Render** `renderDigest()` → Telegram HTML (`pipeline/render.ts:23`).
6. **Persist** one `digests` row (`process-video.ts:84-98`).
7. **Deliver** `deliver(html, video.id)` (`services/delivery.ts:49`) — chunks to ≤4096-char Telegram messages on line boundaries (`delivery.ts:13`), sends to the single `TELEGRAM_CHAT_ID`, logs to `delivery_log`.

**[SU] note:** §4 is conceptually per-user, but `getProfile()` reads the singleton `user_profile` row and `deliver()` targets the one env chat id — so although the pipeline *shape* separates video-level (①②③) from user-level (④), there is only ever **one** user's §4, stored once per video.

---

## 5. The 3-Tier Transcription Waterfall *(centerpiece — exactly what the code does)*

Captions are unreliable on this bot's infra: YouTube blocks caption scraping from datacenter IPs, and some videos have captions disabled entirely. So the system runs a **3-tier fall-through**, orchestrated in `process-video.ts:46-57`:

```
                         processVideo()  (process-video.ts:46-57)
                                  │
                                  ▼
        ┌─────────────────────────────────────────────────────────┐
        │  TIER 0 — SUPADATA  (supadata.ts)         [if SUPADATA_API_KEY set] │
        │  GET api.supadata.ai/v1/youtube/transcript?videoId=…&text=true      │
        │  • managed API: NO proxy, NO yt-dlp, NO audio download              │
        │  • sidesteps IP blocks / SABR / 403 / proxy-IP burn                 │
        │  • handles caption-disabled videos via Supadata's own ASR          │
        │  • 429 or ANY error  ──► returns null  (non-fatal, fall through)    │
        │  • async jobId returned ──► returns null (don't guess polling)      │
        └───────────────┬─────────────────────────────────────────┘
                        │ transcript == null  →  fall through
                        ▼
        ┌─────────────────────────────────────────────────────────┐
        │  TIER 1 — yt-dlp AUDIO PULL  (ytdlp.ts getTranscript)              │
        │  yt-dlp  --extractor-args player_client=android_vr  [--proxy YT_PROXY]│
        │          -f bestaudio/best                                          │
        │    • residential/ISP proxy clears the cloud-IP gate                 │
        │    • android_vr = PO-token-free client that dodges SABR             │
        │  ffmpeg → 16 kHz mono mp3, 28k  (Whisper-native, shrinks file)      │
        │  if > 24 MB (GROQ_MAX_BYTES) → ffmpeg segment into ~25-min chunks   │
        └───────────────┬─────────────────────────────────────────┘
                        │ per chunk/file
                        ▼
        ┌─────────────────────────────────────────────────────────┐
        │  TIER 2 — ASR  (ytdlp.ts transcribeFile)                          │
        │   ┌── Groq Whisper (whisper-large-v3-turbo)  ◄ primary, cheap      │
        │   │     POST api.groq.com/openai/v1/audio/transcriptions           │
        │   │     HTTP 429 (hourly audio quota)  ──► throw TranscriptRateLimited│
        │   │                                          │                      │
        │   │   if fallback configured (OPENAI_API_KEY)│                      │
        │   └──► OpenAI Whisper (whisper-1)  ◄ fallback, pricier, no hourly cap│
        │         POST api.openai.com/v1/audio/transcriptions                 │
        │         its own 429 ──► throw TranscriptRateLimited                 │
        └───────────────┬─────────────────────────────────────────┘
                        │
   ALL providers 429 ──┴──► throw TranscriptRateLimited ──► set 8-min proxy cooldown
                                                            (groqCooldownUntil)
                                                            ──► re-queue, NO attempt bump
```

**Tier 0 — Supadata** (`youtube/supadata.ts`). Tried **first** only when `SUPADATA_API_KEY` is set (`supadataEnabled`, `config.ts:65`; gate at `process-video.ts:50`). `supadataTranscript(videoId)` (`supadata.ts:31`) hits `GET …/youtube/transcript?videoId=…&text=true` with the `x-api-key` header (`supadata.ts:48-49`), wrapped in a 3-try retry (`supadata.ts:34`). It **returns `null` on absolutely any failure** — HTTP 429 (`supadata.ts:53-56`), non-OK (`supadata.ts:57`), or an async `jobId` it deliberately won't poll (`supadata.ts:65-68`) — so the caller transparently falls through. The module is intentionally standalone (no import of the audio chain) and **never throws** to its caller. It handles caption-disabled videos via Supadata's own ASR.

**Tier 1 — yt-dlp + ffmpeg** (`youtube/ytdlp.ts getTranscript`, `ytdlp.ts:81`). Reached when Tier 0 yields nothing (`process-video.ts:56`). `ytArgs()` (`ytdlp.ts:48`) always sets `player_client=android_vr` (PO-token-free, dodges SABR — `config.ts:32`) and adds `--proxy YT_PROXY` when configured (residential/ISP proxy that clears the datacenter-IP block). It downloads `bestaudio/best` to a temp dir (`ytdlp.ts:96-100`), then ffmpeg **downsamples to 16 kHz mono mp3 @ 28k** (`ytdlp.ts:108`) to shrink it; if the file exceeds **`GROQ_MAX_BYTES = 24 MB`** (`ytdlp.ts:18`) it ffmpeg-segments into **`CHUNK_SECONDS = 1500`** (~25-min) chunks (`ytdlp.ts:117-127`) and concatenates the transcripts. Temp dir is always cleaned up in `finally` (`ytdlp.ts:147`).

**Tier 2 — Groq → OpenAI fallback** (`ytdlp.ts transcribeFile`, `ytdlp.ts:183`). Each file/chunk goes to **Groq Whisper** (`whisper-large-v3-turbo`, `groqTranscribe` `ytdlp.ts:151`) first — cheap. On **HTTP 429** Groq throws the typed **`TranscriptRateLimited`** (`ytdlp.ts:168`; class at `ytdlp.ts:27`). If `transcriptFallbackEnabled` (`OPENAI_API_KEY` set, `config.ts:62`), it then falls back to **OpenAI Whisper** (`whisper-1`, `openaiTranscribe` `ytdlp.ts:197`), which surfaces its own 429 as `TranscriptRateLimited` too (`ytdlp.ts:212`). The per-call `retry()` is told **not** to retry a rate-limit (`shouldRetry: (e) => !(e instanceof TranscriptRateLimited)`, `ytdlp.ts:173,217`) so quota errors propagate instantly instead of burning the retry budget.

**The rate-limit contract (the clever part).** When *every* configured provider is throttled, `getTranscript` catches `TranscriptRateLimited`, **sets an 8-minute cooldown** (`GROQ_COOLDOWN_MS = 8*60*1000`, `groqCooldownUntil`, `ytdlp.ts:32-33`, `:139-143`), and **re-throws**. Crucially, while inside that window the next call **skips the audio download entirely** and throws immediately (`ytdlp.ts:88-90`) — this stops re-downloading multi-hundred-MB audio through the *metered* residential proxy when the hourly quota can't possibly have recovered. Upstream, both the worker (`worker.ts:49-54`) and the on-demand command path (`commands.ts:51-58`) treat `TranscriptRateLimited` specially: set status back to `pending` with `skip_reason='rate_limited'` and **do not touch either attempt counter** — so a quota stall can never cause a video to "give up." The user gets a friendly "queued, arrives within the hour" reply (`commands.ts:55-58`). Distinct typed error `NoTranscriptYet` (`process-video.ts:16`) covers genuine "no transcript produced" and rides the `transcript_attempts` retry track instead (`worker.ts:55-71`).

If all three tiers return null, `processVideo` throws `NoTranscriptYet('no transcript produced')` (`process-video.ts:57`).

---

## 6. Deploy Status (honest, git-verified)

Verified from the repo: `origin` = `github.com/tnsaruniitr-lab/mindmonk-digest-claude4.8opus`, local `main` is **2 commits ahead of `origin/main`, 0 behind**.

| Commit | What | Push state | Runtime state |
|---|---|---|---|
| `8c91e8b` | Transcript engine: yt-dlp(proxy+android_vr) + ffmpeg → Groq Whisper (Tier 1+2 core) | pushed | **LIVE + VERIFIED in prod on Railway** (per project memory) |
| `20449af` | Transcript resilience: honest rate-limit handling + **OpenAI Whisper fallback** | **pushed** — it is the current `origin/main` HEAD | On the deployed branch; **Railway's actually-running SHA is not verifiable from the repo alone** — treat as deployed-if-auto-deploy-on-push, otherwise pending |
| `19c1135` | **Supadata Tier 0** | **NOT pushed** (local-only) | **Pending push/deploy** |
| `de8e1e8` | Planning docs (SPEC/ARCHITECTURE/PHASES, multi-tenant) | **NOT pushed** (local-only) | docs only |

**Correction to the brief's framing, stated honestly:** the brief lists the OpenAI Whisper fallback (`20449af`) as "committed locally and pending push." Git shows `20449af` **is** `origin/main`'s HEAD — i.e. **already pushed**. The only **unpushed, local-only** commits are **`19c1135` (Supadata Tier 0)** and `de8e1e8` (docs). So:

- **Definitely live (per memory + push state):** the audio→Groq engine (`8c91e8b`), and the OpenAI fallback (`20449af`) is at minimum on the deployed branch.
- **Definitely pending (local-only, never pushed):** **Supadata Tier 0** (`19c1135`). The waterfall described in §5 is therefore *fully implemented in the working tree* but **Tier 0 is not yet on the remote/Railway** — in production today the waterfall effectively begins at Tier 1 until `19c1135` is pushed (and `SUPADATA_API_KEY` is set in Railway env).
- I cannot read Railway's deployed commit SHA or live env vars from the codebase, so any claim beyond push-state for `20449af` is inferred, not proven.

---

## System Diagram — Current Single-Process Topology

```
                         ┌──────────────────────────────────────────────────────────────┐
   Telegram user ◄──────►│  RAILWAY WORKER  (1 replica only — 409 single-instance) [SU]  │
   (only TELEGRAM_       │  node:20-slim + ffmpeg + yt-dlp ·  tsx src/index.ts           │
    CHAT_ID) [SU]        │                                                              │
                         │   ┌── Telegraf long-poll ──► owner gate (chat==CHAT_ID) [SU] │
                         │   │      /add /channels /remove /profile /setprofile          │
                         │   │      /minduration /fetch /channel /check /status /grader  │
                         │   │                                                          │
                         │   ├── cron POLL_CRON (*/15) ─► runPoller()                   │
                         │   │      RSS per channel ─► enqueue new videos               │
                         │   │                                                          │
                         │   └── cron WORKER_CRON (*/3) ─► runWorker()                  │
                         │          reapStale(15m) ─► claim≤PER_TICK(4) ─► processVideo  │
                         │                                   │                          │
                         │            ┌──────────────────────┴───────────────────┐      │
                         │            ▼                                           ▼      │
                         │   Transcript waterfall (§5)              4-section pipeline   │
                         │   Supadata→yt-dlp/ffmpeg→Groq/OpenAI     ① ② Claude          │
                         │     │              │                     ③  OpenRouter gpt-4o │
                         │     ▼              ▼                     ④  Claude (profile)  │
                         └─────┼──────────────┼──────────────────────────┬──────────────┘
                               │ outbound      │ outbound                 │ pg pool (max 5)
                               ▼               ▼                          ▼
                        api.supadata.ai   Groq / OpenAI /        ┌────────────────────────┐
                        youtube RSS       OpenRouter / Anthropic │  RAILWAY POSTGRES      │
                        + residential                            │  channels · videos ·   │
                          proxy (yt-dlp)                         │  digests · user_profile│
                                                                  │  (singleton id=1)[SU] ·│
                                                                  │  settings · delivery_  │
                                                                  │  log                   │
                                                                  └────────────────────────┘

   Separate Railway service (no code link to the bot):  mindmonk-landing  (static site)
```

---

## Single-User Constraints — Consolidated (these motivate Part II)

1. **One recipient, from env** — `TELEGRAM_CHAT_ID` is the sole delivery target and the sole allowed sender (`bot.ts:15-20`, `delivery.ts:54`). No recipients table.
2. **DB-enforced singleton profile** — `user_profile.id = 1` CHECK constraint (`schema.sql:63`); §4 personalization is global.
3. **Global, un-scoped channels** — no `user_id` on `channels`; one shared follow-list (`schema.sql:8`).
4. **Global k/v settings** — one `min_duration_minutes` etc. for everyone (`settings` table).
5. **One digest per video, globally** — `videos.video_id` unique + one `digests` row per video means §4 cannot differ per user (`schema.sql:22,43`).
6. **One process / one replica** — the Telegram 409 constraint and the in-process cron guards assume exactly one running instance; the DB `FOR UPDATE SKIP LOCKED` claim is the *only* piece already multi-process-safe.

---

Key files: `/Users/arunsharma/Documents/New project/podcast-digest-bot/src/index.ts`, `src/config.ts`, `src/db/{schema.sql,migrate.ts,db.ts}`, `src/bot/{bot.ts,commands.ts}`, `src/scheduler/{poller.ts,worker.ts}`, `src/services/{videos.ts,channels.ts,profile.ts,settings.ts,delivery.ts}`, `src/pipeline/{process-video.ts,extract.ts,grade.ts,personalize.ts,render.ts}`, `src/youtube/{supadata.ts,ytdlp.ts}`, `src/llm/{claude.ts,grader.ts}`, `Dockerfile`, `railway.json`, `.env.example`.

Two factual deltas from the brief, verified against the tree and git, that the parent should note: (1) `schema.sql` has **6 tables, not 7** (no transcripts table; transcripts are never persisted). (2) the OpenAI Whisper fallback `20449af` is **already on `origin/main`** (pushed), so the only **local-only/unpushed** functional commit is **Supadata Tier 0 `19c1135`**.

---

# Part II — Target Architecture (What We Will Build)

*The 1,000-user multi-tenant target. Full product/implementation detail in `SPEC.md`; phased rollout with checklists & UATs in `PHASES.md`.*

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

---

# Part III — Engineering Best Practices (Reference)

This is a durable reference, not a task list. Each practice is framed as **Principle** (the reusable idea) → **In this repo** (the concrete rule for `podcast-digest-bot`, naming real files/symbols) → **Do / Don't**. Consult it before adding a queue, an external call, a migration, a log line, or a config knob.

The most leveraged fact about this codebase: every interesting decision already lives next to an I/O call as a near-pure function — `extractJson` (`util/json.ts`), `structured()` (`util/structured.ts`), `chunkHtml`/`renderDigest` (`delivery.ts`, `render.ts`), the waterfall ordering (`process-video.ts:46-57`), the `processOne` error ladder (`worker.ts:33-85`). Everything below leans on keeping those decisions pure and pushing I/O to the edges.

---

## 1. Idempotency & Queue Discipline

**Principle.** A job queue must survive crashes, restarts, and concurrent workers without losing work or doing it twice. The three load-bearing mechanisms are: atomic claims (no two workers grab the same row), idempotency keys (the same logical work can't be enqueued or delivered twice), and stale-claim reaping (a worker that dies mid-job doesn't strand the row forever). "Exactly once" is a fiction; aim for **at-least-once execution + idempotent effects**.

**In this repo.** The `videos` queue is a hand-rolled Postgres `SKIP LOCKED` queue (the spec explicitly rejects pg-boss/Kafka — §2 Non-Goals). The claim is `claimNextPending()` (`videos.ts:27-37`):

```sql
update videos set status = 'processing', claimed_at = now()
where id = ( select id from videos where status = 'pending'
             order by created_at asc limit 1
             for update skip locked )
returning *
```

Enqueue idempotency is `videos.video_id text unique` + `on conflict(video_id) do nothing` (`enqueueVideo`, `videos.ts:5-19`) — the same YouTube video can never become two queue rows. Stale reaping is `reapStale(minutes)` (`videos.ts:49-58`), flipping `processing → pending` when `claimed_at < now() - interval`, driven by `STALE_MINUTES = 15` (`worker.ts:10,19`). When the multi-tenant fan-out lands, the per-user idempotency key is `user_deliveries UNIQUE(user_id, video_id)` (SPEC §5.2) — **a user never gets the same video twice, even across restarts/reaps** — and fan-out is one `INSERT…SELECT … ON CONFLICT (user_id, video_id) DO NOTHING` (SPEC §4.2). Delivery becomes exactly-once-ish by recording `message_ids` and only sending rows still in `pending`/`personalized`.

A critical, non-obvious rule already encoded here: **attempt counters and the claim lifecycle are separate concerns.** `videos` carries two counters — `attempts` (hard failures) and `transcript_attempts` (caption-lag waits) — and a recoverable rate-limit re-queue burns *neither* (see §2).

**Do**
- Claim with `FOR UPDATE SKIP LOCKED` + `order by created_at limit N`; back it with a partial index (`videos_pending_idx ... where status='pending'`, SPEC §5.2).
- Make every enqueue idempotent on a natural key (`UNIQUE(video_id)`, `UNIQUE(user_id, video_id)`) with `ON CONFLICT DO NOTHING`.
- Reap stale `processing` rows on every tick (`reapStale` runs first in `runWorker`, `worker.ts:19`).
- Keep separate counters for separate retry semantics (process vs transcript), and re-queue rate-limits with **no** counter increment.

**Don't**
- Don't `SELECT … then UPDATE` in two statements to claim work — that's the race `SKIP LOCKED` exists to kill.
- Don't rely on in-memory `running`/`polling` booleans for cross-process safety — they guard one process only (`worker.ts:12`, `poller.ts`); under a fleet, use a DB advisory lock (SPEC §4.1) and DB-backed cooldown.
- Don't reuse one counter for "transient" and "permanent" failures — a quota stall will silently exhaust the budget meant for real errors.
- Don't add an ORM or external queue broker to get these properties; the SQL above already has them.

---

## 2. Resilience Patterns Already In Use

**Principle.** Resilience is mostly about being honest with yourself: degrade where a lower-quality result is acceptable, distinguish "try again later" from "give up," and never let a generic catch-all turn a recoverable condition into a misleading permanent failure.

**In this repo.** Four patterns are already load-bearing — preserve them when refactoring:

1. **Fail-open transcription waterfall** (`process-video.ts:46-57`). Tier 0 Supadata → Tier 1+2 yt-dlp+Groq → Tier 3 OpenAI. Each tier returns `null` on ordinary failure and the next is tried; only when *all* are exhausted does `getTranscript` return `null` and the caller throw `NoTranscriptYet`. A failing managed API never blocks the audio fallback.
2. **Recoverable rate-limit ≠ failure.** `TranscriptRateLimited` (`ytdlp.ts:27`) is a *typed* signal that the audio downloaded fine and only the ASR quota is full. The worker re-queues it (`status='pending'`, no counter bump, `worker.ts:49-54`) and a cooldown (`GROQ_COOLDOWN_MS = 8min`, `ytdlp.ts:32-33`) stops re-downloading through the metered proxy until the rolling window frees up.
3. **`retry()` with a `shouldRetry` predicate** (`retry.ts`). Exponential backoff + jitter, but `shouldRetry: (e) => !(e instanceof TranscriptRateLimited)` (`ytdlp.ts:173,217`) so an hourly-quota error is surfaced *immediately* instead of burning three local retries on something that won't clear in seconds.
4. **Honest errors over comforting lies — the "No captions" bug lesson.** The comment at `ytdlp.ts:135-143` is the scar tissue: a rate-limit must not be reported as "no captions available." Misclassifying a transient throttle as a permanent content problem makes the bot *give up* on videos it could have delivered. The waterfall now distinguishes `TranscriptRateLimited` (re-queue) from genuine no-transcript (`NoTranscriptYet`, capped by `MAX_ATTEMPTS_TRANSCRIPT=20`).

**Do**
- Return `null` to fall through a tier; throw a *typed* error only when every tier is exhausted.
- Model "retry later" as its own error type (`TranscriptRateLimited`) and route it to a re-queue, not a failure.
- Pass `shouldRetry` to `retry()` for any error class that won't clear within the backoff window.
- Make the grade-failure path tolerant: if §3 throws, log and ship the digest without it (`process-video.ts:62-69`) — §3 is enrichment, not a gate.

**Don't**
- Don't swallow a specific recoverable error into a generic `catch` that emits a misleading user-facing message — that *is* the "No captions" bug.
- Don't retry an hourly-quota 429 three times locally; you'll exhaust the budget and still fail.
- Don't let one tier's failure short-circuit the others — each tier's failure must be local.

---

## 3. External-API Integration

**Principle.** Treat the network as hostile: every upstream is slow, flaky, rate-limited, occasionally lying, and metered. Encode each distinct failure mode as a distinct type, chain providers so one outage isn't your outage, and always know what a call costs.

**In this repo.** Five providers (Anthropic, Groq, OpenAI, OpenRouter/grader, Supadata) plus yt-dlp/ffmpeg subprocesses. The patterns to keep:

- **Typed errors per failure mode.** HTTP 429 → `TranscriptRateLimited`; any other non-2xx → a generic `Error` with a *truncated* body (`.slice(0, 200)`, `ytdlp.ts:165,211`). The status code drives behavior (re-queue vs fail), not a string match.
- **Provider fallback chains.** ASR: Supadata → Groq → OpenAI (`transcribeFile`, `ytdlp.ts:183-194`), each with its own 429→`TranscriptRateLimited` mapping. The grader deliberately uses a *different model family* (`GRADER_MODEL` via OpenRouter) so §3's "independent grade" is genuinely independent.
- **Cost-awareness baked into routing.** The SPEC §6 economics are the rule, not a footnote: shared work (transcript + ①② extract + ③ grade) is computed **once per video** and fanned out; only ④ is per-user. Model routing follows cost — ①②→Sonnet, ④→Haiku, ③→`gpt-4o-mini` (SPEC §6.4) — and Whisper-1 is demoted to last-resort behind a per-day spend cap (SPEC §6.3, R2).
- **Never trust upstream availability.** `fetchVideoData` fails *open* — on a metadata block it returns all-`null` meta and lets the transcript step still try (`ytdlp.ts:72-77`). Subprocess calls carry explicit `timeout` + `maxBuffer` (`ytdlp.ts:59,99,108`).

**Do**
- Map each HTTP status that needs distinct handling to a distinct error type; branch on the type, not on substring matching of response bodies.
- Chain providers cheapest/safest-first; keep a different family for any "independent second opinion" call.
- Cap and truncate everything you read from upstream (`.slice(0, 200)` on bodies, `MAX_TRANSCRIPT_CHARS=300_000` clamp).
- Always set `timeout` and `maxBuffer` on `execFile`/`fetch`; emit token/audio-second cost counters from `res.usage` (SPEC §7.4).

**Don't**
- Don't assume a managed API is up — keep the self-hosted fallback (yt-dlp+Groq) wired and tested.
- Don't recompute shared work per user — that's the ~$32.7k→~$4.4k/mo difference (SPEC §6.5).
- Don't route an expensive model to a cheap, per-user, template-shaped task (④ on Opus was a ~$4,850/mo mistake, SPEC §6.4).
- Don't trust upstream-supplied lengths/fields — clamp and default them.

---

## 4. Testing Strategy

**Principle.** Test pure logic exhaustively and cheaply in-process; test I/O wiring sparingly against the real dependency with *external* services mocked at the network boundary. The test pyramid here is wide-at-the-bottom by design because the interesting decisions are already pure.

**In this repo.** Vitest (native ESM on `tsx`, `vi.mock`, v8 coverage — SPEC §7.1), two projects: `unit` always, `integration` on demand.

**Unit — no DB, no network (highest value):**
- `extractJson` JSON-repair (`util/json.ts`): fenced/unfenced, leading/trailing prose, and the **pinned failure mode** (`}` inside a string before the real end) as a documented `toThrow`.
- `structured()` retry-once contract (`util/structured.ts`) — inject the `call` fn (already a param): valid-first; garbage→valid; garbage→garbage throws the *strict* ZodError; valid-JSON-wrong-shape repair path.
- Zod schemas in `extract.ts`/`grade.ts`/`personalize.ts` against good + malformed fixtures, so a prompt change fails CI, not prod.
- `renderDigest` snapshots (`render.ts`): all-four-sections; `grade:null` + configured ("grading failed") vs unconfigured ("grading skipped"); empty insights; empty tailored; plus the `esc`/clamp boundary (a raw `<` in a title must escape or Telegram HTML parse-mode 400s).
- `chunkHtml`/`hardSplit` 4096 boundary (`delivery.ts`): every chunk ≤ 4096−96, tags never split mid-tag.
- **Tier-policy** extracted to a pure `transcriptTierOrder()` + ASR selection (inject the two transcribe fns) — the logic that controls spend and 429 behavior.
- **Worker error-classification ladder** (`processOne`, `worker.ts:33-85`): refactor to inject `process`/`setStatus`; assert all seven status transitions, including the invariant **"`TranscriptRateLimited` → `pending` with no attempt increment."** These seven rows are the bot's reliability contract.
- **Cooldown** lifted into an injectable clock-driven object (the same shape that later makes it DB-backed for the fleet).

**Integration — real Postgres, external APIs mocked (`@testcontainers/postgresql`, PG 16):** the schema uses `gen_random_uuid()`/`make_interval`, so `pg-mem` is insufficient. Mock Anthropic/Groq/OpenAI/Supadata/OpenRouter/Telegram at the network boundary with `undici` `MockAgent`; inject `pexec` for yt-dlp/ffmpeg. Tests that earn their keep: two connections' concurrent `claimNextPending()` get *different* rows (proves `SKIP LOCKED`); `reapStale` flips a stale row; `processVideo` end-to-end writes the right rows and the Supadata short-circuit skips the `pexec` path; `migrate()` applies clean **and** idempotently.

**Do**
- Push every branchy decision into a pure function that takes its dependencies as parameters, then unit-test it in milliseconds.
- Snapshot-test rendering and escaping — Telegram HTML 400s are a class of prod-only bug you can fully prevent.
- Use real Postgres (testcontainers) for queue/SQL semantics; mock everything *external* to the process.

**Don't**
- Don't write a test that hits a live LLM/ASR/Telegram endpoint — mock at the network boundary.
- Don't use an in-memory PG fake for queue tests — `SKIP LOCKED`, advisory locks, and `make_interval` need the real engine.
- Don't test framework glue (Telegraf, `pg`) — test *your* logic (the ladder, the tier order, the chunker, the schemas).

---

## 5. Migrations Discipline

**Principle.** Schema is versioned, ordered, and applied by a single actor at deploy time — never improvised at app boot. Evolve additively, retire only after a soak, and keep every step reversible.

**In this repo.** The current `migrate()` (`db/migrate.ts:7-11`) reads `schema.sql` and runs it raw on **every boot** — no history, no ordering, and under a fleet, N instances racing the same DDL. This is the anti-pattern to replace. The rule (SPEC §5.6, §7.3):

- **Tool: `node-pg-migrate`** (raw SQL/JS against the existing `pg` Pool, a `pgmigrations` history table). Drizzle/Flyway/Sqitch are rejected (no ORM here; no JVM/Perl runtime).
- **Advisory-lock-safe.** Wrap the run in `pg_advisory_lock($LOCK_KEY)` so exactly one booting actor migrates and others wait, then observe the finished schema (SPEC §5.6 snippet).
- **Run-on-deploy, not on-boot.** Run `node-pg-migrate up` as a Railway **release command** (one-shot, single container). **Workers and telegram-io must NOT call `migrate()`** — they call a lightweight `assertMigrated()` (max `pgmigrations` id ≥ expected) and refuse to start if behind.
- **Additive-then-retire.** The plan (SPEC §5.7) is the template: `0001` create new tables (additive, zero-downtime) → `0002` backfill → `0003` deploy code reading new tables → soak → `0004` drop legacy. **Hard rule: no destructive drop until the new tables are populated and the app reads from them.**
- **Reversible.** Every migration ships a `down`. Keep `schema.sql` only as documentation: "baseline = migration 0001; do not edit, write a new migration."

**Do**
- Write one forward-only-numbered migration per change, each with a tested `down`.
- Guard the runner with a Postgres advisory lock; run it as a release/deploy step, once.
- Split risky changes additively: add column/table → backfill → switch reads → drop old, across separate deploys.

**Don't**
- Don't apply DDL on app boot from every instance (the current `migrate.ts` — replace it).
- Don't drop or rename a column in the same deploy that stops writing it; soak first (SPEC R5).
- Don't hand-edit `schema.sql` to "fix" prod — that drifts the documented baseline from reality; write a migration.

---

## 6. Observability

**Principle.** You must be able to answer "is it working, and if not where did it stop?" from telemetry alone — especially for a system whose worst failure is *silent* (process up, pipeline wedged, no digest for hours). Structured logs you can grep by entity, a handful of metrics that track the real constraints, and an active watchdog that pages you.

**In this repo.** Today's logger (`util/logger.ts`) is `console.log` with a timestamp — unstructured strings, no fields, no redaction. The target (SPEC §7.4):

- **Structured logging with redaction.** Swap in **pino**, keeping the `log.info/warn/error(msg, meta)` signature so ~40 call sites are unchanged. Add `video_id`/`channel_id`/`user_id` fields so one episode's journey is greppable. **Wire pino `redact` to the proxy-leak scrub (§7 below)** — secret redaction is a logging concern, not an afterthought.
- **Key metrics** (a periodic `log.info('metrics', {...})` or `/metrics`): **queue depth** via the existing `statusCounts()` (`videos.ts:90`) each tick; **tier hit-rate** (`supadata_hit`/`groq_hit`/`openai_fallback_hit`/`rate_limited`); **delivery success ratio** from `user_deliveries.state`; per-stage latency for the four pipeline stages; **cost counters** from `res.usage` tokens + audio-seconds; cooldown-trip count.
- **Health/readiness endpoints.** A tiny HTTP server: `/healthz` = `select 1`; `/readyz` = migrated + bot ready, so Railway catches a **silently wedged poller**.
- **Stall watchdog + alerting.** Sentry (`@sentry/node`) at the three places errors vanish — `uncaughtException`/`unhandledRejection`, `bot.catch`, and the worker's terminal `failed`/`no_transcript` branches. A watchdog: zero `delivered` in 6h while `pending`>0 → "pipeline stalled" to your Telegram; plus a Railway restart-count alert (a crash-loop must page, not silently mask a bad deploy).

**Do**
- Log structured key/value with entity ids (`video_id`/`user_id`); make redaction a property of the logger, not each call site.
- Emit metrics for each real constraint: queue depth, ASR tier mix, delivery success, token/audio cost.
- Add `/healthz` + `/readyz` and a stall watchdog — the nastiest failure here is "up but doing nothing."

**Don't**
- Don't ship `console.log` string logs you can't filter by entity — debugging one stuck video becomes archaeology.
- Don't let errors vanish in catch-all branches or `bot.launch()` failure — surface them to Sentry/Telegram.
- Don't equate "process running" with "healthy" — a live process with a dead `getUpdates` loop is the failure to alarm on.

---

## 7. Secrets & Security

**Principle.** Secrets live only in the platform's env, never in code/logs/config; once exposed, they're burned and must be rotated. Treat all user-controlled input as hostile, and assume any argv you pass to a subprocess can end up in an error string.

**In this repo.** 17 keys enumerated in `.env.example`; `config.ts` reads them all from env. The rules (SPEC §7.6):

- **Rotate on exposure.** Secrets have been pasted in chat; rotate **all** now — Telegram token (BotFather), Anthropic/OpenAI/Groq/OpenRouter/Supadata keys, proxy creds, Railway Postgres password. Verify `.env` was never committed (`git log --all -p -- .env`); BFG-scrub if it was. Going forward, secrets live only in Railway env.
- **The proxy-credentials-in-logs lesson + the `scrub()` rule.** `ytArgs` pushes `--proxy http://user:pass@host:port` (`ytdlp.ts:48-52`). On failure, Node's `execFile` error includes the full argv in `.cmd`, logged verbatim via `String(e)` at `ytdlp.ts:75,141,144`. **Two fixes, do both:** pino `redact` **and** a `scrub(s)` that regex-replaces `//user:pass@` → `//***:***@` and the raw `YT_PROXY` substring, applied to every `String(e)` here (with a unit test). Same treatment for `DATABASE_URL`.
- **Input validation / SSRF.** `resolveChannel` `fetch`es a URL built from raw user input → validate the host is `youtube.com` before fetching (SSRF guard). Cap `/setprofile` length (~2000 chars).
- **Prompt-injection delimiting.** Profile text is user-authored and untrusted — pass it into the personalize prompt clearly delimited as untrusted data, never as instructions.
- **Per-user rate limiting.** `/fetch`/`/channel`/`/test` each trigger a full transcribe + 3 LLM calls. Before opening beyond the owner, add a per-`user_id` token bucket (N `/fetch`/hr, M `/add`/day) backed by a `rate_limits` table, plus channel and queue-depth caps so one user can't starve the shared `videos` queue (SPEC R7).
- **Parameterized SQL.** Already correct everywhere (`$1,$2,…` via `pg`) — keep it. `setVideoStatus` builds the *column list* dynamically but still parameterizes every *value* (`videos.ts:71-88`); that's the safe pattern.
- **Admin scoping.** With the blanket owner-gate gone, gate global-mutating ops behind an `ADMIN_USER_IDS` allowlist checked per-command.

**Do**
- Keep secrets in env only; rotate immediately on any exposure; verify they were never committed.
- Run `scrub()` over every error string that can contain a proxy/DB URL, and back it with pino `redact` + a unit test.
- Validate host on any user-derived URL fetch (SSRF); cap and delimit untrusted profile text (prompt-injection).
- Rate-limit expensive command paths per user before opening to more than the owner.

**Don't**
- Don't interpolate user values into SQL — always parameterize (the codebase already does; don't regress).
- Don't log raw `execFile` errors that embed `--proxy user:pass@…` — that's the active leak at `ytdlp.ts:75,141,144`.
- Don't paste profile text into a prompt as if it were trusted instructions, or fetch a user-supplied URL without a host check.

---

## 8. Config Management

**Principle.** Configuration is validated data with sane defaults, parsed once at startup; an invalid environment should crash loudly and immediately, never half-boot into undefined behavior. Optional capabilities are gated by the *presence* of their credential, not by separate boolean flags that can drift out of sync.

**In this repo.** `config.ts` is the model to follow:

- **Zod-validated env, fail-fast.** `Env.safeParse(process.env)`; on failure it prints the field errors and `process.exit(1)` (`config.ts:43-50`). Types and coercions live in the schema (`z.coerce.number().int().positive()`, the `DATABASE_SSL` string→bool transform).
- **Feature flags via key presence.** Capability booleans are *derived*, not separately configured: `audioAsrEnabled = GROQ_API_KEY.length > 0`, `transcriptFallbackEnabled = OPENAI_API_KEY.length > 0`, `supadataEnabled = SUPADATA_API_KEY.length > 0`, `graderConfigured` = a real key that isn't the `__REPLACE_ME__` placeholder (`config.ts:54-65`). Setting the key turns the tier on; there's no second flag to forget.
- **Per-stage model knobs.** Today there's one `ANTHROPIC_MODEL`; the target (SPEC §6.4) splits it into `EXTRACT_MODEL` (Sonnet), `PERSONALIZE_MODEL` (Haiku), `GRADER_MODEL` (gpt-4o-mini) so each pipeline stage routes to its cost-appropriate model, each with a sane default.
- **Sane defaults.** Operationally tunable knobs (`POLL_CRON`, `WORKER_CRON`, `MIN_DURATION_MINUTES`, `YT_PLAYER_CLIENT`, `GROQ_MODEL`) all default so a minimal `.env` boots.

**Do**
- Parse and validate the whole environment once with Zod at startup; `process.exit(1)` on any invalid config.
- Derive capability flags from credential presence (`xEnabled = KEY.length > 0`) rather than separate on/off envs.
- Give every operational knob a default and a per-stage variant where stages have different cost/quality needs.

**Don't**
- Don't read `process.env.FOO` ad hoc deep in the code — everything goes through the validated `config` object.
- Don't gate a feature on a boolean env that can contradict whether its key is actually set — let presence be the switch.
- Don't ship a single global model knob when stages have a 5×–25× cost spread (Opus vs Haiku); split the knobs.

---

## 9. Code Structure for Testability

**Principle.** Separate I/O (Telegram, Postgres, subprocesses, HTTP) from domain logic so the decisions can be exercised with in-memory fakes. A repository/ports layer lets the same domain code run against real Postgres in integration and fakes in unit tests. Keep pure functions pure — don't thread `ctx` or a DB handle through logic that doesn't need it.

**In this repo.** Two structural blockers exist today (SPEC §7.5):

- **Telegram `ctx` is threaded into domain logic.** `runVideoNow` (`commands.ts:24-67`) *duplicates* the worker's `processOne` error ladder, welded to `ctx.reply`. The fix: a `src/app/` domain layer with zero Telegram imports, where `summarizeVideoNow(videoId, opts)` returns a discriminated union `{kind:'delivered'|'skipped'|'rate_limited'|'failed', detail}`; handlers shrink to ~3 lines that map the result via a pure, snapshot-tested `replyFor(r)`. The classification logic then exists **once**, shared by worker and command. (Note `processVideo` already returns a `ProcessResult` union — `process-video.ts:18` — extend that discipline outward.)
- **Services reach straight into `db/db.ts`.** Introduce `services/ports.ts` with interfaces derived from the *existing* function shapes (`VideoRepo`, `DigestRepo`, `ProfileRepo`, `Deliverer`); `services/*.ts` become the Postgres impls (SQL unchanged); domain functions take ports with production defaults. The seven-row worker test and the pipeline test then become pure unit tests with in-memory fakes, while the same code re-runs against real PG in integration.
- **Keep pure functions pure.** `extractJson`, `structured` (which already injects its `call` fn), `renderDigest`, `chunkHtml` take data in, return data out, touch no globals. Two globals that violate this and should move into injected/DB-backed state under a fleet: `groqCooldownUntil` (`ytdlp.ts:33`) and the tmpdir (SPEC R9).

**Do**
- Put domain logic in `src/app/` with no Telegram/`pg` imports; return discriminated unions; map to copy in thin handlers.
- Define ports (interfaces) from existing function signatures; pass them in with production defaults so tests inject fakes.
- Keep decision functions pure and dependency-injected (the `structured(schema, call)` shape is the model).

**Don't**
- Don't duplicate classification logic across a handler and the worker — extract it once (`summarizeVideoNow`/`replyFor`).
- Don't pass `ctx` or a live `Pool` into a function that only needs plain data.
- Don't hold per-process mutable state (`groqCooldownUntil`, tmpdir) that a worker fleet would each hammer independently — make it injectable, then DB-backed.

---

## 10. CI/CD & Deploy Hygiene

**Principle.** A change reaches production only after an automated gate proves it typechecks, lints, and passes tests; staging mirrors prod with its *own* credentials; schema work happens at deploy time, never on boot. The gate is the contract — if it's green, it's safe to ship.

**In this repo.** Note the trap: the repo has `eslint-disable` comments but **no eslint installed** — they're dead, suppressing nothing (`config.ts:45,47`). The target (SPEC §7.2):

- **Required gate.** Add ESLint first. GitHub Actions on every PR + `main`: a `check` job (typecheck + lint + unit) + an `integration` job (Docker is free on ubuntu runners → testcontainers work) + a `docker build .` job (catches a broken image — e.g. a yt-dlp download 404 — in CI, not at Railway build). Make `check` + `integration` **required status checks** on `main`; that *is* the deploy gate.
- **Staging with its own bot token (non-negotiable).** Two Railway environments: **staging** auto-deploys from `main` with a **separate `TELEGRAM_BOT_TOKEN`** — sharing the prod token is impossible because the 409 single-poller constraint means two pollers on one token crash-loop (SPEC §4.4, R4). **Production** deploys on a git tag (`v*`) or manual promote after a staging smoke-check.
- **Disciplined push-to-deploy + restart alerting.** Alert on Railway restart count: a crash-loop that exhausts `restartPolicyMaxRetries` must page you, because "crash and restart" otherwise silently masks a bad deploy.
- **No schema work on boot.** Migrations run as a release command, gated single-actor (§5); app instances `assertMigrated()` and refuse to start if behind — they never run DDL themselves.

**Do**
- Make typecheck + lint + unit + integration required checks on `main`; add a `docker build` job to catch broken images pre-deploy.
- Run a real staging env that auto-deploys `main` with its **own** bot token and DB; promote to prod on a tag.
- Alert on restart-count/crash-loops so a bad deploy pages instead of silently flapping.

**Don't**
- Don't trust `eslint-disable` comments without eslint actually installed and wired into CI — they're decorative today.
- Don't point staging at the production bot token (or DB) — the 409 constraint guarantees a crash-loop.
- Don't run migrations on app boot or let app instances apply DDL — deploy-time release command only, and never let a behind-schema instance start.

---

**Source files referenced:** `/Users/arunsharma/Documents/New project/podcast-digest-bot/SPEC.md` (§7), `src/util/retry.ts`, `src/youtube/ytdlp.ts`, `src/services/videos.ts`, `src/pipeline/process-video.ts`, `src/scheduler/worker.ts`, `src/config.ts`, `src/db/migrate.ts`, `src/db/schema.sql`, `src/db/db.ts`, `src/util/logger.ts`, `src/util/json.ts`, `src/util/structured.ts`.
