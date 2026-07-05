import 'dotenv/config'
import { z } from 'zod'

const Env = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHAT_ID: z.string().min(1),

  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_MODEL: z.string().default('claude-opus-4-8'),
  // Optional per-stage overrides (Phase 1 cost routing). Empty -> use ANTHROPIC_MODEL.
  EXTRACT_MODEL: z.string().default(''), // sections ①② (shared, once per video)
  PERSONALIZE_MODEL: z.string().default(''), // section ④ (per delivery; keep cheap)

  GRADER_PROVIDER: z.enum(['openai-compatible', 'anthropic']).default('openai-compatible'),
  GRADER_API_KEY: z.string().default('__REPLACE_ME__'),
  GRADER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  GRADER_MODEL: z.string().default('openai/gpt-4o'),

  MIN_DURATION_MINUTES: z.coerce.number().int().positive().default(20),
  POLL_CRON: z.string().default('*/15 * * * *'),
  WORKER_CRON: z.string().default('*/3 * * * *'),
  BACKFILL_ON_ADD: z.coerce.number().default(1),
  SUMMARY_LANGUAGE: z.string().default('English'),

  // --- Transcript engine: audio -> Groq Whisper (via yt-dlp + a residential proxy) ---
  GROQ_API_KEY: z.string().default(''),
  GROQ_MODEL: z.string().default('whisper-large-v3-turbo'),
  YT_PROXY: z.string().default(''), // residential/ISP proxy, e.g. http://user:pass@host:port
  YT_PLAYER_CLIENT: z.string().default('android_vr'), // PO-token-free client that dodges SABR

  // --- Transcript fallback: OpenAI Whisper, used only when Groq is rate-limited ---
  OPENAI_API_KEY: z.string().default(''), // platform.openai.com key (direct, not OpenRouter)
  OPENAI_TRANSCRIBE_MODEL: z.string().default('whisper-1'), // or gpt-4o-mini-transcribe (cheaper)

  // --- Transcript Tier 0: Supadata managed API (no proxy/yt-dlp/download) -------
  // When set, it's tried FIRST; the audio chain above stays intact as the fallback.
  SUPADATA_API_KEY: z.string().default(''),

  // --- Multi-user web app --------------------------------------------------------
  // When set, /api/signup requires this exact invite code (invite-only mode).
  // Leave blank for open signup (not recommended while the bot token is shared).
  INVITE_CODE: z.string().default(''),
  // The account (by email) allowed to become owner when it links TELEGRAM_CHAT_ID.
  // Without this, linking the owner chat does NOT auto-promote — closes the phishing
  // vector where a scanned attacker QR would otherwise transfer ownership.
  OWNER_EMAIL: z.string().default(''),

  // --- Waterfall dashboard (optional HTTP observability) ------------------------
  // When DASHBOARD_SECRET is set, a small HTTP server exposes /dashboard?key=<secret>
  // showing which transcript tier served/failed each video. Empty = no server at all.
  DASHBOARD_SECRET: z.string().default(''),
  // Tolerant parse: PORT= (blank) must not crash a bot that isn't even serving HTTP.
  PORT: z.preprocess((v) => (v == null || v === '' ? 8080 : v), z.coerce.number().int().positive()), // Railway injects PORT when networking is enabled

  // --- Cost guardrail (Phase 0 kill-switch) ------------------------------------
  // Hard daily ceiling on estimated LLM + transcription spend (USD). When today's
  // tracked spend reaches this, new expensive calls pause (jobs re-queue, no data
  // loss) until the next day. 0 disables the guard.
  GLOBAL_DAILY_SPEND_CAP_USD: z.coerce.number().nonnegative().default(25),
})

const parsed = Env.safeParse(process.env)
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('❌ Invalid environment configuration. Check your .env against .env.example:')
  // eslint-disable-next-line no-console
  console.error(parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const config = parsed.data

/** Per-stage model resolution (Phase 1 cost routing). Empty override -> primary model. */
export const extractModel = config.EXTRACT_MODEL || config.ANTHROPIC_MODEL
export const personalizeModel = config.PERSONALIZE_MODEL || config.ANTHROPIC_MODEL

/** True only when a real grader key has been supplied (not the placeholder). */
export const graderConfigured =
  config.GRADER_API_KEY.length > 0 && config.GRADER_API_KEY !== '__REPLACE_ME__'

/** True when audio→Groq transcription is configured. */
export const audioAsrEnabled = config.GROQ_API_KEY.length > 0

/** True when an OpenAI Whisper fallback is configured (used when Groq is throttled). */
export const transcriptFallbackEnabled = config.OPENAI_API_KEY.length > 0

/** True when Supadata (managed transcript, Tier 0) is configured. Tried before the audio chain. */
export const supadataEnabled = config.SUPADATA_API_KEY.length > 0
