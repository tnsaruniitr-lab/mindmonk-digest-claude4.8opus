import { describe, it, expect, vi, afterEach } from 'vitest'

// Mock config so the logger's SECRETS list is built from known values (no env needed).
vi.mock('../src/config', () => ({
  config: {
    YT_PROXY: 'http://user:pass@proxy.example.com:8080',
    DATABASE_URL: '',
    ANTHROPIC_API_KEY: 'sk-ant-secretvalue123',
    GRADER_API_KEY: '',
    GROQ_API_KEY: '',
    OPENAI_API_KEY: '',
    SUPADATA_API_KEY: '',
    TELEGRAM_BOT_TOKEN: '',
  },
}))

import { log, scrub } from '../src/util/logger'

afterEach(() => vi.restoreAllMocks())

describe('logger secret scrubbing (wired to config)', () => {
  it('redacts proxy URL credentials from a logged error line', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    log.warn('yt-dlp failed for http://user:pass@proxy.example.com:8080')
    const printed = spy.mock.calls[0].join(' ')
    expect(printed).not.toContain('pass')
    expect(printed).not.toContain('user:pass')
  })
  it('scrub() redacts a known API key (for user-facing / DB-persisted strings)', () => {
    expect(scrub('boom: sk-ant-secretvalue123')).not.toContain('sk-ant-secretvalue123')
  })
  it('scrub() leaves ordinary text intact', () => {
    expect(scrub('a normal message')).toBe('a normal message')
  })
})
