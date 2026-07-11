import { describe, it, expect } from 'vitest'
import { TokenBucket, PerChatThrottle } from '../src/util/rate-limit'

describe('TokenBucket', () => {
  it('allows up to capacity immediately, then makes you wait', () => {
    const b = new TokenBucket(3, 3, 1000) // 3 tokens, refill 3/s, start at t=1000
    expect(b.take(1000)).toBe(0)
    expect(b.take(1000)).toBe(0)
    expect(b.take(1000)).toBe(0)
    expect(b.take(1000)).toBeGreaterThan(0) // 4th: empty → must wait
  })

  it('refills over time', () => {
    const b = new TokenBucket(1, 10, 0) // 1 token, 10/s
    expect(b.take(0)).toBe(0) // consume the 1
    expect(b.take(0)).toBeGreaterThan(0) // empty
    expect(b.take(100)).toBe(0) // 100ms @10/s = 1 token refilled
  })

  it('never exceeds capacity when idle', () => {
    const b = new TokenBucket(2, 100, 0)
    // long idle would over-refill without the cap; should still only allow `capacity`
    expect(b.take(10_000)).toBe(0)
    expect(b.take(10_000)).toBe(0)
    expect(b.take(10_000)).toBeGreaterThan(0)
  })
})

describe('PerChatThrottle', () => {
  it('spaces a single chat by the gap, independent of other chats', () => {
    const t = new PerChatThrottle()
    expect(t.reserve('a', 0, 1000)).toBe(0) // first send: now
    expect(t.reserve('a', 0, 1000)).toBe(1000) // second: wait a full gap
    expect(t.reserve('b', 0, 1000)).toBe(0) // a different chat is unaffected
    expect(t.reserve('a', 1500, 1000)).toBe(500) // at t=1500, next was 2000 → wait 500
    expect(t.reserve('a', 5000, 1000)).toBe(0) // well past the reservation → no wait
  })

  it('prune drops past reservations', () => {
    const t = new PerChatThrottle()
    t.reserve('a', 0, 1000) // reserved until 1000
    t.prune(2000) // past it → dropped
    expect(t.reserve('a', 2000, 1000)).toBe(0) // fresh, no wait
  })
})
