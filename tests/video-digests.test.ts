import { describe, it, expect, vi } from 'vitest'

// rowToDigest is pure, but the module imports the db layer at the top — mock it so the
// test doesn't pull in config/Postgres.
vi.mock('../src/db/db', () => ({ one: vi.fn(), query: vi.fn() }))

import { rowToDigest } from '../src/services/video-digests'

describe('rowToDigest', () => {
  it('maps a full row into typed objects', () => {
    const out = rowToDigest({
      key_insights: [{ insight: 'a', detail: 'b' }],
      patterns: [{ name: 'p', why: 'w' }],
      antipatterns: [],
      grading: { overall_score: 7, verdict: 'ok', dimensions: [], caveats: [] },
      extract_model: 'claude-sonnet-4-6',
      grader_model: 'openai/gpt-4o',
    })
    expect(out.extract.key_insights).toHaveLength(1)
    expect(out.extract.patterns[0].name).toBe('p')
    expect(out.grade?.overall_score).toBe(7)
    expect(out.extractModel).toBe('claude-sonnet-4-6')
    expect(out.graderModel).toBe('openai/gpt-4o')
  })

  it('defaults null jsonb columns to empty arrays / null grade', () => {
    const out = rowToDigest({
      key_insights: null,
      patterns: null,
      antipatterns: null,
      grading: null,
      extract_model: null,
      grader_model: null,
    })
    expect(out.extract.key_insights).toEqual([])
    expect(out.extract.patterns).toEqual([])
    expect(out.extract.antipatterns).toEqual([])
    expect(out.grade).toBeNull()
    expect(out.extractModel).toBeNull()
  })
})
