// Pure rate-limit primitives (no imports) so they're trivially unit-testable.
// Used by services/telegram-rate.ts to pace delivery under Telegram's limits.

/** Token bucket: `capacity` tokens refilled at `refillPerSec`. `take(now)` returns the
 *  ms to wait for a token (0 if one was available and consumed). `now` is injected so
 *  the logic is deterministic. */
export class TokenBucket {
  private tokens: number
  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private last: number,
  ) {
    this.tokens = capacity
  }
  take(now: number): number {
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSec)
    this.last = now
    if (this.tokens >= 1) {
      this.tokens -= 1
      return 0
    }
    return Math.ceil(((1 - this.tokens) / this.refillPerSec) * 1000)
  }
}

/** Per-chat spacer: `reserve` returns the ms to wait so a chat's sends stay >= gapMs
 *  apart, and records the reservation. */
export class PerChatThrottle {
  private readonly next = new Map<string, number>()
  reserve(chatId: string, now: number, gapMs: number): number {
    const start = Math.max(now, this.next.get(chatId) ?? 0)
    this.next.set(chatId, start + gapMs)
    return start - now
  }
  /** Drop past reservations so the map can't grow unbounded across many chats. */
  prune(now: number): void {
    for (const [id, t] of this.next) if (t <= now) this.next.delete(id)
  }
}
