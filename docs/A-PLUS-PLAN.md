# MindMonk → A+ Personal Digest System

**Date:** 2026-07-05 · **Method:** 16-agent review (5 code readers → adversarial verify → 4 web researchers → 3 competing designs → 3 judges). Winner: **Capture-first minimalist**, unanimous 3/3, with grafts from the two losing designs merged below.

**North star:** Arun marks anything — podcast episode, podcast *moment*, YouTube video, article, tweet, newsletter — with one muscle memory (share → Telegram → bot), and a digest in his format comes back **every single time**. Personal-first; scale explicitly out of scope.

---

## 1. Verdict on the current build

| Area | Grade | One-liner |
|---|---|---|
| Digest pipeline + LLM layer | **B+** | Clean 5-stage chain, Zod-validated everywhere, good prompts; format triple-hardcoded |
| Transcript acquisition | **B+** | Smart 3-tier waterfall + pay-once caching; but no free-captions tier, proxy cost invisible |
| Bot UX + delivery | **B** | Solid commands + careful Telegram rendering; **pasted/shared links are silently ignored** |
| Data model, config, cost | **A−** | Cost ledger + daily kill-switch are genuinely good; migrations are create-only |
| Docs + tests | **C+** | ~85% of docs design a 1000-user product that's now off-strategy; reliability core untested, no CI |

25 confirmed critical/major findings. The two **critical** ones:

1. **No plain-message capture** — the bot only has `bot.command()` handlers; a shared/pasted URL dead-ends silently. The product Arun wants literally has no front door.
2. **Create-only migrations** — `migrate.ts` replays `schema.sql` (`create table if not exists`); any `ALTER` is a silent no-op then a runtime crash. Nothing ships safely before this is fixed.

The majors, grouped:
- **Grader (③):** `GRADER_API_KEY` never set in prod → section ③ absent from every digest since launch (5-min fix; backfill at `process-video.ts:91` retro-heals cached digests). Worse: the grader only sees Claude's extraction, never the transcript — "unbiased grade" can't catch extraction bias.
- **Robustness:** `personalize()` unguarded → a ④ failure blocks the whole delivery; delivery not idempotent → duplicate digests on partial send; same-tick re-claim spin loop; no heartbeat/alerting → silent-death deploys.
- **Cost blindness:** residential-proxy bandwidth (the single largest real cost — $0.06–0.75/video for full audio) is invisible to the spend ledger; permanently-unavailable videos burn up to ~120 metered proxy attempts; yt-dlp metadata call taxes even cache/Supadata hits.
- **Content model:** everything keyed to YouTube `video_id`; format hardcoded across 3 Zod schemas + renderer + per-section DB columns.

What's already A-grade and must not be broken: pay-once transcript+digest caching, typed failure taxonomy (`NoTranscriptYet`/`TranscriptRateLimited`/`DailySpendCapExceeded` with separate retry budgets), daily spend cap pre-flight, structured-output discipline, honest degradation messages.

---

## 2. Capture UX — the Telegram chat becomes the universal inbox

One new catch-all `bot.on('text')` handler (registered after commands) + a pure URL classifier. Any extra text in the share message becomes the **capture note** ("why I marked this"), stored on the item and answered directly in section ④.

| Source | Motion | Mechanics |
|---|---|---|
| YouTube | share sheet → Telegram → bot | existing `parseVideoId` → existing pipeline |
| Podcast episode | share sheet → bot | Apple/Spotify link → iTunes Lookup + PodcastIndex (free key) → RSS enclosure MP3 |
| Podcast **moment** | pause → "Share from [time]" → bot (~4s) | Apple `?i=<ep>&r=<sec>` / Spotify `?t=` / Overcast `/+id/MM:SS` → ±4-min audio cut → moment card (~$0.003) + "reply *full*" |
| Article | share sheet / paste URL | defuddle (npm, $0) → r.jina.ai fallback (free tier) |
| Tweet/thread | share tweet → bot | fxtwitter JSON ($0, incl. self-reply threads) |
| Newsletter | subscribe with `digest@<domain>` | Cloudflare Email Routing → Worker → `/ingest` webhook ($0); doubles as "email anything to my digest" |
| Any Telegram forward | forward to bot | text passthrough, no transcript stage |
| Optional sugar | iOS Shortcut "Mark" | share sheet + Siri/Action button → POST `{url, note}` to `/ingest` |

Spotify true-exclusives: honest "metadata-only" reply (exclusivity is mostly dead since 2024; PodcastIndex resolves nearly everything).

---

## 3. The digest structure

Keep the 4-section skeleton (it's the signature — and the separate-LLM grader is the most differentiated feature in the whole market, cf. Shortform's "Clarifications & Counterpoints"). Add a verdict header, upgrade ③, vary by **depth per type** — not a format engine.

**[A] FULL** (YouTube / podcast ≥20 min):
```
🎙️ Title
Channel · 1h24m · listen — transcript: captions · $0.001 · 14s | grader: on
⓪ Verdict: 7/10 · SKIM · <≤25-word takeaway> · 1h24m → 90s read
① Key insights        (5–7, insight + detail)
② Patterns & antipatterns  (✅/⛔)
③ Second-opinion grade (by <non-Anthropic model>)
   overall/10 + DEEP-DIVE/SKIM/SKIP + 2–3 counterpoints
   + "what the extraction missed or overstated"     ← grader now gets a ~30k-char transcript slice
④ For you (relevance: high)
   "You marked this because: <note>" — answered first
   → Do now: …   → File: …
⑥ Quotes & references  (2–4 verbatim quotes with &t= deep links; needs segments jsonb)
```
**[B] COMPRESSED** (article/newsletter): TL;DR ≤25 words · ① capped at 5 · ③ one line · ④ as above.
**[C] MICRO** (tweet/raw text): 3–4 lines, no grader.
**[D] MOMENT CARD**: `🎯 Show — Episode @ 41:32` · ❝verbatim quote❞ · insight · context · for-you · "reply *full*".

**User-editable format, minimalist:** `/format <type> <free text>` → stored in the existing `settings` table as `format_notes:<type>`, appended verbatim to the extract+personalize prompts. **With dry-run preview**: bot re-renders your most recent item of that type with the new notes and asks confirm before activating. The full stored-format-spec engine (closed library of ~9 typed section kinds, each with fixed Zod schema + prompt fragment + renderer, seeded with the current format for zero-diff cutover) is **explicitly gated** behind 2 weeks of real use proving notes insufficient.

**Feedback-as-capture:** reply "pin" or react 👍/👎 on any digest → logged as taste signal, feeds resurfacing priority.

---

## 4. Transcript economics (the "smartest + cheapest at user level" answer)

Key insight from research: **the expensive anti-pattern is pulling full audio through a per-GB residential proxy** ($7–14 per 100 videos to feed $3 of Groq transcription). Captions are KB-scale; podcast MP3s need no proxy at all.

| Type | Waterfall | Cost |
|---|---|---|
| YouTube | cache → Supadata free tier (100 credits/mo ≈ his volume; guard the 2-credits/min AI-fallback trap) → **NEW tier 0.5: yt-dlp `--skip-download --write-auto-subs` via proxy (~$0.0005/video, $0 ASR)** → audio+Groq last resort | ~$1–3/mo after fix |
| Podcast | PodcastIndex → `<podcast:transcript>` RSS tag ($0, ~20–40% hit) → direct enclosure MP3 (no proxy, never bot-blocked) → ffmpeg → Groq whisper-large-v3-turbo $0.04/hr | 30×1h ≈ **$1.20/mo** |
| Moment | same + `ffmpeg -ss <t−240> -t 480` | ~$0.003/moment |
| Article | defuddle → r.jina.ai | $0 |
| Tweet | fxtwitter | $0 |
| Newsletter | Cloudflare Email Routing → Worker | $0 |

**Phase-3 endgame — home courier ($0/mo, kills the arms race):** a tiny worker on the Mac polls a `fetch_jobs` table in the same Railway Postgres (`FOR UPDATE SKIP LOCKED`, same pattern as `worker.ts`; no inbound networking). Runs yt-dlp captions/audio from the home IP — YouTube's 2026 blocking is overwhelmingly datacenter-IP-based; a home IP doing ~3 req/day is invisible. Job kinds `meta|captions|audio_asr|enclosure_asr`, 60s `courier_heartbeat` settings row, **auto-fallthrough to Supadata→cloud tiers when heartbeat stale >15 min** (a dead courier never blocks a digest), launchd plist, `yt-dlp -U` on start.

Sanity gate everywhere: reject transcript before caching if `text.length < durationSeconds * 3` (saveTranscript is first-writer-wins — never cache garbage forever). Store **segments as jsonb** (Whisper verbose_json / Supadata `text=false`) instead of flattening — enables quotes with `&t=` deep links and moment precision.

**All-in monthly (heavy month: 60 videos + 30 podcast-hrs + 15 moments + 100 articles + 100 tweets + 60 newsletters): ~$15–25 → ~$10–15 with courier.** LLM is the biggest line ($8–12 with routed models; ~3× that if extract stays on Opus).

---

## 5. Architecture changes (file-level)

- **Prereq:** versioned migrations — `schema_migrations` table + numbered `src/db/migrations/*.sql` applied in order; `schema.sql` stays as fresh-DB bootstrap. (Judges unanimously upgraded this from the single `schema-alter.sql` idea.)
- `src/bot/inbox.ts` (new, ~60 lines): catch-all text handler → URL extraction (text + url/text_link entities + forwards) → typed ack in <2s → enqueue. **This is the product.**
- `src/ingest/classify.ts` (new): pure URL router, unit-tested, no I/O.
- **`items` lane, not a `videos` migration:** `items` table mirroring videos' status ladder + `item_digests`. `transcripts` and `video_digests` are already text-keyed with no FK — reuse with namespaced ids (`pod:<sha1>`, `art:<sha1>`, `tw:<id>`). `videos` stays as-is; unify only if it hurts.
- `src/pipeline/process-item.ts` (new): `{kind, title, source, url, text, note}` → extract → grade → personalize → render. extract/grade/personalize already consume plain strings — `processVideo` becomes a thin transcript-resolving wrapper. Replace hardcoded "PODCAST" framing in `extract.ts:19-21` with a contentType param.
- `src/ingest/resolvers/{podcast,article,tweet}.ts`: each returns `{title, source, text}`; export `transcribeFile` from `ytdlp.ts` decoupled from YouTube-URL reconstruction.
- **Trust fixes:** personalize try/catch (copy the grade pattern around `process-video.ts:119`); delivery idempotency (delivery_log check + ON CONFLICT); `next_attempt_at` column to kill the same-tick spin; Telegram 429 `retry_after` honor; `/check` chains `runWorker()`.
- **Grader:** transcript slice in prompt, verdict + counterpoints + "extraction missed" fields, temperature 0.2 on both Claude and Anthropic-grader paths.
- `src/ingest/http.ts`: ~40-line `POST /ingest` with `x-ingest-secret` (email worker + iOS Shortcut target).
- **Ops (zero code, do first):** set `GRADER_API_KEY` (OpenRouter, cheap non-Anthropic mini model) — backfill retro-grades everything; `EXTRACT_MODEL`=Sonnet, `PERSONALIZE_MODEL`=Haiku; `TZ=Asia/Dubai` (spend-cap day = his day); persist `groqCooldownUntil` to settings (currently resets on deploy); `YT_PLAYER_CLIENT` as fallback list (`android_vr,tv,web_safari`).
- **Observability:** daily heartbeat cron (yesterday's spend, statusCounts, grader on/off — reuses dead `notify()`); per-digest footer `transcript: <tier> · $<cost> · <latency> | grader: on` — a tier/cost regression is visible within ONE digest, not at invoice time; proxy-GB metering into `usage_events` (`PROXY_USD_PER_GB`); `PermanentlyUnavailable` typed error from yt-dlp stderr patterns.
- **Hygiene:** CI (typecheck + vitest); the 3 designed high-risk tests (render escaping, chunkHtml 4096 boundary, worker status ladder) + classify router tests; `.dockerignore`; `npm ci --omit=dev`; CMD tsx so signals reach the process; SIGTERM handler closing pg pool + cron; STATUS header in ROADMAP.md parking the multi-tenant PHASES.md.

---

## 6. Phased plan

**Phase 1 — The magic inbox (5 days, usable Day 1):**
- Day 1 AM: env fixes (grader key + model routing + TZ), temperature 0.2, personalize try/catch, delivery idempotency, `/check` chains worker.
- Day 1 PM: catch-all inbox — **YouTube share-sheet works today**; other types get honest "coming this week" ack.
- Day 2: versioned migrations; items lane; classify router + tests; process-item generalization; article lane (COMPRESSED) + tweet lane (MICRO); capture-note → ④.
- Day 3–4: podcast lane (PodcastIndex, transcript-tag check, enclosure→Groq); Apple `&r=`/Spotify `?t=` → MOMENT CARD + "reply full"; segments jsonb from day one.
- Day 5: `/format` notes + dry-run preview; ⓪ Verdict header + grader upgrade; daily heartbeat; sanity gate.

**Phase 2 — Every source, zero residual friction (4–5 days):**
Cloudflare email → `/ingest`; iOS Shortcut "Mark"; YouTube waterfall patches (free-captions tier 0.5, cache-before-metadata, PermanentlyUnavailable, proxy metering, next_attempt_at, TG 429); per-digest footer; CI + tests; docs freeze; container hygiene.

**Phase 3 — Invisible cost + compounding memory (3–4 days, gated on 2 weeks of real daily use):**
Home courier (full spec above, $0/mo); weekly resurfacing cron (3–5 past insights at 7d/30d/6mo + "still true? acted on it?" + one serendipity gem, pin/👍 boosts priority); desktop bookmarklet (10 min).
**Decision gates, not builds:** format-notes limiting → the closed-library format engine; digests feel like islands → pgvector "⑤ Connections" with hard guardrails (strict similarity threshold, honest empty state, CONTRADICTS prioritized over CONFIRMS — nobody in the market ships contradiction detection; one noisy week kills the section's trust).

**Biggest risk:** the YouTube lane silently breaking mid-arms-race. A digest that arrives 90% of the time trains you to stop marking. Mitigation is layered by design: three independent acquisition paths + loud failures (heartbeat, footer) + the courier removing datacenter IPs from the equation entirely.
