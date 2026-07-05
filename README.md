# Podcast Digest Bot

Watches your favourite YouTube channels and, whenever they publish a **new long-form episode**, fetches the transcript and sends you a **4-section digest on Telegram**:

1. **① Key insights** — the substantive, non-obvious ideas (Claude)
2. **② Patterns & antipatterns** — what works / what to avoid (Claude)
3. **③ Unbiased grade** — an *independent* score by a **separate, configurable LLM** (its own API key) so it's a real second opinion, not the same model marking its own homework
4. **④ For you** — each idea mapped to **your profile and goals**, with concrete actions

Single-user: it only ever talks to your Telegram chat id.

## How it works

```
RSS poll (every 15m) ──> new video ──> queue
queue worker (every 3m) ──> yt-dlp (duration + transcript)
   ├─ skip Shorts / live / < MIN_DURATION
   ├─ ① + ② extract        (ANTHROPIC_MODEL)
   ├─ ③ grade              (GRADER_MODEL, separate key)
   ├─ ④ personalize        (ANTHROPIC_MODEL + your profile)
   └─ render + deliver to Telegram (chunked to 4096 chars)
```

- **Detection:** YouTube Atom RSS per channel (no API key). Only uploads published *after* you add a channel count as "new".
- **Transcript + duration:** `yt-dlp` (one call gives both). Auto-captions that lag are retried for ~1h before giving up.
- **No YouTube API key needed.**

## Stack

TypeScript · Node 20 · Telegraf · Postgres via `pg` (Railway) · `@anthropic-ai/sdk` · OpenAI-compatible grader (default: OpenRouter) · `yt-dlp` · `rss-parser` · `node-cron`.

## Setup

### 1. Database
Provision a Postgres database (Railway: **New → Database → PostgreSQL**) and copy its `DATABASE_URL`. The schema is applied **automatically on first boot** (`src/db/migrate.ts`) — no manual SQL step.

### 2. Environment
```bash
cp .env.example .env
```
Fill in:
- `TELEGRAM_BOT_TOKEN` — from @BotFather
- `TELEGRAM_CHAT_ID` — message @userinfobot to get your numeric id
- `DATABASE_URL` — your Postgres connection string (`DATABASE_SSL=true` only for an external/proxied URL)
- `ANTHROPIC_API_KEY` (`ANTHROPIC_MODEL` defaults to `claude-opus-4-8`; set `claude-sonnet-4-6` to cut cost)
- `GRADER_API_KEY` — **placeholder until you set it.** Get an [OpenRouter](https://openrouter.ai) key and the default `GRADER_MODEL=openai/gpt-4o` works (or any model OpenRouter exposes, e.g. `google/gemini-2.0-flash`). Section ③ is skipped gracefully until this is set.

### 3. yt-dlp (local dev only — the Docker image installs it for you)
```bash
brew install yt-dlp        # macOS
# or: pipx install yt-dlp
```

### 4. Run
```bash
npm install
npm run typecheck   # optional
npm run dev         # or: npm start
```

In Telegram: `/add https://www.youtube.com/@lexfridman`, then `/help`.

## Deploy (Railway, always-on)

This is a long-running worker (Telegram long-polling — no inbound port/domain needed).

1. Push this folder to a Git repo.
2. Railway → **New Project → Deploy from GitHub repo**. It uses the included `Dockerfile` (installs `yt-dlp`).
3. Add a **PostgreSQL** database to the project (**New → Database → PostgreSQL**).
4. In the app service → **Variables**, add all the `.env` values. For the DB, set `DATABASE_URL` to `${{Postgres.DATABASE_URL}}` (Railway's private URL — keep `DATABASE_SSL=false`).
5. Deploy. Logs should show `Schema applied/verified` then `Bot launched.`

The included `railway.json` sets the Dockerfile build + restart-on-failure. The schema auto-applies on boot.

### Optional: the waterfall dashboard

By default the service opens no inbound port. To enable the observability dashboard (per-video transcript journeys, tier hit/miss/rate-limit/error stats, spend):

1. Set `DASHBOARD_SECRET` on the service (≥16 chars, e.g. `openssl rand -hex 16`; shorter values are refused).
2. Railway → service → **Settings → Networking → Generate Domain** (Railway injects `PORT` automatically).
3. Open `https://<domain>/dashboard?key=<DASHBOARD_SECRET>`. In Telegram, `/waterfall` shows the same journeys inline.

Leave `DASHBOARD_SECRET` unset to run exactly as before (long-polling only, no HTTP server).

## Commands

| Command | What it does |
|---|---|
| `/add <url \| @handle \| UC…id>` | Track a channel |
| `/channels` | List tracked channels |
| `/remove <handle \| id \| title>` | Stop tracking |
| `/profile` | Show the profile used for section ④ |
| `/setprofile <text>` | Update your profile |
| `/minduration <minutes>` | Long-form threshold (default 20) |
| `/test <video url>` | Run the full pipeline on one video now |
| `/check` | Check all channels for new episodes now |
| `/status` | Counts + config |
| `/waterfall` | Which transcript tier served (or failed) each recent video |
| `/grader` | Grader configuration |

Your **profile** is seeded from a sensible default on first boot — edit it with `/setprofile` so section ④ is tailored to you.

## Notes / limitations

- Transcripts depend on YouTube captions (manual or auto). Caption-less videos are marked `no_transcript` after the retry window.
- Channel-id resolution scrapes the channel page HTML (no API key); paste the `UC…` id directly if a custom URL won't resolve.
- The grader defaults to an OpenAI-compatible endpoint; set `GRADER_PROVIDER=anthropic` to use a Claude model as the grader instead (less "independent").
