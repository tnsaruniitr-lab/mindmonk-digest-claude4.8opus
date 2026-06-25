import { log } from './logger'

export async function retry<T>(
  fn: () => Promise<T>,
  opts: { tries?: number; baseMs?: number; label?: string; shouldRetry?: (err: unknown) => boolean } = {},
): Promise<T> {
  const tries = opts.tries ?? 3
  const baseMs = opts.baseMs ?? 1000
  let lastErr: unknown
  for (let i = 0; i < tries; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      // Some failures (e.g. an hourly quota) won't clear within a few seconds —
      // don't burn the retry budget on them; surface them immediately.
      if (opts.shouldRetry && !opts.shouldRetry(err)) throw err
      if (i < tries - 1) {
        const delay = baseMs * 2 ** i + Math.floor(Math.random() * 250)
        if (opts.label) log.warn(`${opts.label} failed (attempt ${i + 1}/${tries}), retrying in ${delay}ms`, String(err))
        await new Promise((r) => setTimeout(r, delay))
      }
    }
  }
  throw lastErr
}
