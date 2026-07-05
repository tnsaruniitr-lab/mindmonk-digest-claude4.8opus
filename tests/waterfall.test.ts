import { describe, expect, it } from 'vitest'
import { formatJourney } from '../src/util/journey'

describe('formatJourney', () => {
  it('renders an empty journey as an empty string', () => {
    expect(formatJourney([])).toBe('')
  })

  it('renders a single hit with icon', () => {
    expect(formatJourney([{ tier: 'supadata', outcome: 'hit', duration_ms: null }])).toBe('supadata✓')
  })

  it('chains tiers in order with arrows', () => {
    const j = formatJourney([
      { tier: 'supadata', outcome: 'miss', duration_ms: 800 },
      { tier: 'audio:groq', outcome: 'rate_limited', duration_ms: null },
      { tier: 'audio:openai', outcome: 'hit', duration_ms: 42_400 },
    ])
    expect(j).toBe('supadata— → audio:groq⏳ → audio:openai✓ 42s')
  })

  it('shows seconds only at >= 1s (sub-second attempts stay clean)', () => {
    expect(formatJourney([{ tier: 'supadata', outcome: 'hit', duration_ms: 999 }])).toBe('supadata✓')
    expect(formatJourney([{ tier: 'supadata', outcome: 'hit', duration_ms: 1000 }])).toBe('supadata✓ 1s')
  })

  it('renders errors and unknown outcomes defensively', () => {
    expect(formatJourney([{ tier: 'audio', outcome: 'error', duration_ms: 3000 }])).toBe('audio✗ 3s')
    expect(formatJourney([{ tier: 'audio', outcome: 'weird', duration_ms: null }])).toBe('audio?')
  })
})
