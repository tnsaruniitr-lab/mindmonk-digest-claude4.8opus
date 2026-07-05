// Pure journey formatting (no config/db imports — unit-testable in isolation).

export interface JourneyStep {
  tier: string
  outcome: string
  duration_ms: number | null
}

/** One line per journey: "supadata— → audio:groq⏳ → audio:openai✓ 42s". */
export function formatJourney(events: JourneyStep[]): string {
  const icon: Record<string, string> = { hit: '✓', miss: '—', rate_limited: '⏳', error: '✗' }
  return events
    .map((e) => {
      const secs = e.duration_ms != null && e.duration_ms >= 1000 ? ` ${Math.round(e.duration_ms / 1000)}s` : ''
      return `${e.tier}${icon[e.outcome] ?? '?'}${secs}`
    })
    .join(' → ')
}
