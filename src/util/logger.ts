import { config } from '../config'
import { scrubWith } from './redact'

// Concrete secret values pulled from config; any occurrence is redacted from every
// log line (covers e.g. a yt-dlp error that echoes the proxy URL with credentials).
const SECRETS: readonly string[] = [
  config.YT_PROXY,
  config.DATABASE_URL,
  config.ANTHROPIC_API_KEY,
  config.GRADER_API_KEY,
  config.GROQ_API_KEY,
  config.OPENAI_API_KEY,
  config.SUPADATA_API_KEY,
  config.TELEGRAM_BOT_TOKEN,
  config.DASHBOARD_SECRET,
].filter((s): s is string => typeof s === 'string' && s.length >= 6)

function ts(): string {
  return new Date().toISOString()
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)
  } catch {
    return String(value)
  }
}

function clean(value: unknown): string {
  return scrubWith(typeof value === 'string' ? value : safeStringify(value), SECRETS)
}

/** Scrub a string of known secret values + URL creds — for error text sent to users or
 *  persisted to the DB (the logger already scrubs everything it prints). */
export function scrub(s: string): string {
  return scrubWith(s, SECRETS)
}

export const log = {
  info: (msg: string, meta?: unknown) =>
    console.log(`${ts()} INFO  ${clean(msg)}`, meta == null ? '' : clean(meta)),
  warn: (msg: string, meta?: unknown) =>
    console.warn(`${ts()} WARN  ${clean(msg)}`, meta == null ? '' : clean(meta)),
  error: (msg: string, meta?: unknown) =>
    console.error(`${ts()} ERROR ${clean(msg)}`, meta == null ? '' : clean(meta)),
}
