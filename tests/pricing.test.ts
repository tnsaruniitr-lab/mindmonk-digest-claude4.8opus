import { describe, it, expect } from 'vitest'
import {
  estimateLlmCostUsd,
  estimateAsrCostUsd,
  decideCap,
  estimateSecondsFromText,
  SUPADATA_PER_CALL_USD,
} from '../src/cost/pricing'

describe('estimateLlmCostUsd', () => {
  it('prices opus at $5/$25 per MTok', () => {
    expect(estimateLlmCostUsd('claude-opus-4-8', 1_000_000, 1_000_000)).toBeCloseTo(30, 6)
  })
  it('prices sonnet input at $3/MTok', () => {
    expect(estimateLlmCostUsd('claude-sonnet-4-6', 1_000_000, 0)).toBeCloseTo(3, 6)
  })
  it('matches gpt-4o-mini before gpt-4o', () => {
    expect(estimateLlmCostUsd('openai/gpt-4o-mini', 1_000_000, 0)).toBeCloseTo(0.15, 6)
    expect(estimateLlmCostUsd('openai/gpt-4o', 1_000_000, 0)).toBeCloseTo(2.5, 6)
  })
  it('falls back to a conservative rate for unknown models', () => {
    expect(estimateLlmCostUsd('some-future-model', 1_000_000, 0)).toBeCloseTo(5, 6)
  })
  it('clamps negative/junk input to zero', () => {
    expect(estimateLlmCostUsd('opus', -10, -10)).toBe(0)
  })
})

describe('estimateAsrCostUsd', () => {
  it('prices groq turbo ~$0.0007/min', () => {
    expect(estimateAsrCostUsd('whisper-large-v3-turbo', 600)).toBeCloseTo(0.007, 5) // 10 min
  })
  it('prices openai whisper-1 at $0.006/min', () => {
    expect(estimateAsrCostUsd('whisper-1', 600)).toBeCloseTo(0.06, 6) // 10 min
  })
})

describe('decideCap', () => {
  it('is disabled when cap <= 0', () => {
    expect(decideCap(9999, 0)).toBe(false)
    expect(decideCap(9999, -1)).toBe(false)
  })
  it('blocks at or over the cap', () => {
    expect(decideCap(25, 25)).toBe(true)
    expect(decideCap(26, 25)).toBe(true)
  })
  it('allows under the cap', () => {
    expect(decideCap(24.99, 25)).toBe(false)
  })
})

describe('estimateLlmCostUsd — more models', () => {
  it('prices haiku cheapest of the Claude family', () => {
    expect(estimateLlmCostUsd('claude-haiku-4-5', 1_000_000, 0)).toBeCloseTo(0.8, 6)
  })
})

describe('estimateAsrCostUsd — fallbacks', () => {
  it('uses the conservative default for an unknown/non-turbo whisper model', () => {
    expect(estimateAsrCostUsd('whisper-large-v3', 600)).toBeCloseTo(0.06, 6) // default 0.006/min
  })
  it('prices gpt-4o-mini-transcribe', () => {
    expect(estimateAsrCostUsd('gpt-4o-mini-transcribe', 600)).toBeCloseTo(0.03, 6) // 0.003/min
  })
})

describe('estimateSecondsFromText', () => {
  it('estimates ~13 chars/sec', () => {
    expect(estimateSecondsFromText('x'.repeat(1300))).toBe(100)
  })
  it('is zero for empty text', () => {
    expect(estimateSecondsFromText('')).toBe(0)
  })
})

describe('SUPADATA_PER_CALL_USD', () => {
  it('is a small positive flat per-call cost', () => {
    expect(SUPADATA_PER_CALL_USD).toBeGreaterThan(0)
    expect(SUPADATA_PER_CALL_USD).toBeLessThan(0.05)
  })
})
