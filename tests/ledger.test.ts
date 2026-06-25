import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock config + db so the ledger guard can be tested without env/Postgres.
const h = vi.hoisted(() => ({
  cfg: { GLOBAL_DAILY_SPEND_CAP_USD: 25 },
  one: vi.fn(),
}))
vi.mock('../src/config', () => ({ config: h.cfg, graderConfigured: false }))
vi.mock('../src/db/db', () => ({ one: h.one, query: vi.fn() }))

import { assertUnderDailyCap, DailySpendCapExceeded } from '../src/cost/ledger'

beforeEach(() => {
  h.cfg.GLOBAL_DAILY_SPEND_CAP_USD = 25
  h.one.mockReset()
})

describe('assertUnderDailyCap', () => {
  it('throws DailySpendCapExceeded when spend exceeds the cap', async () => {
    h.one.mockResolvedValue({ s: '30' })
    await expect(assertUnderDailyCap()).rejects.toBeInstanceOf(DailySpendCapExceeded)
  })
  it('throws at exactly the cap (>=)', async () => {
    h.one.mockResolvedValue({ s: '25' })
    await expect(assertUnderDailyCap()).rejects.toBeInstanceOf(DailySpendCapExceeded)
  })
  it('resolves when under the cap', async () => {
    h.one.mockResolvedValue({ s: '10' })
    await expect(assertUnderDailyCap()).resolves.toBeUndefined()
  })
  it('is a no-op when the cap is 0 (disabled) and never queries the ledger', async () => {
    h.cfg.GLOBAL_DAILY_SPEND_CAP_USD = 0
    await expect(assertUnderDailyCap()).resolves.toBeUndefined()
    expect(h.one).not.toHaveBeenCalled()
  })
  it('fails OPEN (allows the call) when the ledger read errors', async () => {
    h.one.mockRejectedValue(new Error('db down'))
    await expect(assertUnderDailyCap()).resolves.toBeUndefined()
  })
})
