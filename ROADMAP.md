# Roadmap — single-user → 1,000-user

Sequenced by **real risk**: cost runaway → tenancy correctness → transcript
reliability → safe-to-deploy. Throughput is *not* the binding constraint at 1,000
users; the live build already has a race-safe `SELECT … FOR UPDATE SKIP LOCKED`
queue. Each phase is **one PR, UAT'd before the next**. Stay single-instance as long
as possible (see the deferred list).

**Gating rule:** no broad user invite before Phase 0 (cost cap) **+** Phase 2
(tenancy) **+** Phase 4 (tests/CI) are all merged.

---

## Phase 0 — Stop the bleeding + cost kill-switch — ✅ this PR
The live single-user bot can't silently run up an unbounded bill, and secrets stop
leaking into logs.

- `usage_events` ledger table; every LLM + ASR call records an estimated cost.
- `GLOBAL_DAILY_SPEND_CAP_USD` (default 25, `0` = off): expensive calls pause when the
  day's tracked spend hits the cap; jobs re-queue (no attempt bump, no data loss).
- Central log scrub: proxy creds + known secret values redacted from every log line.
- Smoke-test floor: vitest + tests for cost math, the scrubber, and JSON extraction.

**UAT**
- [ ] `npm test` green; `npm run typecheck` clean.
- [ ] Set `GLOBAL_DAILY_SPEND_CAP_USD=0.01`, process one video → worker logs
      `Daily spend cap hit; re-queued …`; video stays `pending`, `attempts` NOT bumped.
- [ ] Reset to `25` → the same video processes and delivers normally.
- [ ] `select kind, model, cost_usd from usage_events order by created_at desc limit 5;`
      shows LLM + ASR rows.
- [ ] Force a yt-dlp/proxy error (bad `YT_PROXY`) → log shows `http://***:***@…`, not the password.

## Phase 1 — Per-video dedup + cost-aware pipeline
Compute the expensive per-video work once; cost scales with distinct videos, not
users. Still single-user — a pure refactor, no tenancy risk.

- Split `digests` → shared `video_digests` (transcript-derived ①②③, one row/video).
- `transcripts(video_id)` cache — never re-transcribe a video_id.
- Per-stage model knobs (EXTRACT / PERSONALIZE / GRADER); personalization on the
  cheapest model. Supadata stays Tier 0. Wire Supadata calls into the ledger too.

**UAT**
- [ ] Re-processing a cached video makes zero ASR/yt-dlp calls (verify via `usage_events`).
- [ ] `video_digests` has exactly one row per video_id.
- [ ] Digest output unchanged vs pre-refactor for a known video (snapshot).

## Phase 2 — Multi-tenancy (the spine)
Many users, each with their own channels/profile/delivery, correct on ONE process.

- `node-pg-migrate` (expand→backfill→deploy→soak→drop); retire boot-time auto-apply.
- `users`, `user_profiles`, `user_settings`, `subscriptions`, per-user `user_deliveries`
  (`UNIQUE(user_id, video_id)`); `profile_version` for targeted re-personalization.
- Owner-gate → upsert-on-first-contact middleware (`ctx.state.user`).
- ALL user-facing reads go through ONE user-scoped repository (the isolation boundary).
- Stage A writes the shared digest once → idempotent fan-out one `user_deliveries`
  row per active subscriber → Stage B personalizes + delivers per user.
- Backfill the existing owner; their global channel list becomes their subscriptions.

**UAT (heaviest — destructive migration on live data)**
- [ ] On a staging DB copy: migrate forward, confirm owner + channels backfilled, run
      the app, deliver a digest — then run the `down` and confirm a clean revert.
- [ ] Two test users on the same channel BOTH receive the digest; user A's profile/edits
      never appear in user B's output (automated isolation test).
- [ ] The single destructive drop is gated behind 3 verification queries (row counts match).
- [ ] Rollback rehearsed and documented before the prod drop.

## Phase 3 — Throughput + delivery limits (still single-instance)
Handle 1,000 users' volume and respect Telegram/provider limits, on one box.

- Replace `PER_TICK=4` serial drain with a continuous claim loop + bounded concurrency
  (p-limit, ~4–8 in flight).
- In-process delivery token bucket: ~25/s global, 1/s per chat, 429 `retry_after` →
  reschedule, 403 → pause user; pre-smooth fan-out.
- Shared cooldown for provider 429s.

**UAT**
- [ ] A seeded backlog drains at the configured concurrency (not one-at-a-time).
- [ ] Simulated Telegram 429 → send reschedules and eventually delivers; no crash.
- [ ] No chat receives > ~1 msg/s across a multi-chunk digest.

## Phase 4 — Tests + CI + observability → unlocks public beta
Safe to change code and open to real users.

- Vitest on the brittle units + Testcontainers on the SKIP-LOCKED claim, reaper,
  fan-out idempotency, migration idempotency, and the tenant-isolation assertion.
- GitHub Actions REQUIRED check (typecheck + test + docker build) = the deploy gate.
- Staging Railway env with its OWN bot token (the long-poll 409 forbids sharing prod's).
- pino structured logs (user_id/video_id/stage) + Sentry + a stall watchdog + `/healthz`.

**UAT**
- [ ] CI fails a PR with a deliberately broken test / type error.
- [ ] `/healthz` returns 200 only when DB + scheduler are alive.
- [ ] A staged exception reaches Sentry with no secrets in the payload.

## Phase 5 — Monetize + bound demand
Cost-bounded and monetized.

- Freemium quotas that cap the real drivers (channel caps, daily `/fetch` caps,
  Pro-gated grader + min-duration) — never gate personalization.
- Per-tier ceilings reading the Phase-0 ledger; per-user quotas.
- Telegram Stars `/upgrade`; nightly downgrade; retention prune; `/export` + `/delete-account`.

**UAT**
- [ ] A free user hitting the channel cap is refused BEFORE any expensive call.
- [ ] A low global cap pauses new expensive jobs and resumes next day.
- [ ] `/delete-account` removes all of a user's rows; shared caches untouched.

---

## Deferred — only when a measured ceiling forces it
3-service split (telegram-io / worker / poller) · poller leader-election · webhook
mode · DB-backed rate window · PgBouncer · Postgres RLS. None is on the 1,000-user
critical path; each has a clear trigger (worker CPU-bound → split; >1 instance →
webhook + leader election + DB rate window; conn count near ceiling → PgBouncer;
untrusted query path → RLS).
