// Pure secret-scrubbing for logs (Phase 0). No config import so it's unit-testable;
// the logger supplies the concrete secret list from config at runtime.

const CREDS_IN_URL = /([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+:[^@\s/]+@/gi

/** Redact `user:pass@` credentials embedded in any URL (proxy, DB, etc.), keep the host. */
export function redactCredsInUrls(s: string): string {
  return s.replace(CREDS_IN_URL, '$1***:***@')
}

/** Replace any occurrence of a known secret value with [REDACTED]. Short secrets are
 *  ignored to avoid over-redacting ordinary text. */
export function redactSecrets(s: string, secrets: readonly string[]): string {
  let out = s
  for (const sec of secrets) {
    if (sec && sec.length >= 6) out = out.split(sec).join('[REDACTED]')
  }
  return out
}

/** Scrub a string for logging: known secret values first, then any URL-embedded creds. */
export function scrubWith(s: string, secrets: readonly string[] = []): string {
  return redactCredsInUrls(redactSecrets(s, secrets))
}
