import { describe, it, expect } from 'vitest'
import { scrubWith, redactCredsInUrls, redactSecrets } from '../src/util/redact'

describe('redactCredsInUrls', () => {
  it('masks user:pass in a proxy URL but keeps the host', () => {
    expect(redactCredsInUrls('using http://alice:s3cret@proxy.example.com:8080')).toBe(
      'using http://***:***@proxy.example.com:8080',
    )
  })
  it('masks credentials in a postgres URL', () => {
    expect(redactCredsInUrls('postgres://u:p@db.host:5432/app')).toBe('postgres://***:***@db.host:5432/app')
  })
  it('leaves a credential-free URL untouched', () => {
    expect(redactCredsInUrls('https://api.example.com/v1')).toBe('https://api.example.com/v1')
  })
})

describe('redactSecrets', () => {
  it('replaces a known secret value anywhere it appears', () => {
    expect(redactSecrets('key=sk-abc123def in error', ['sk-abc123def'])).toBe('key=[REDACTED] in error')
  })
  it('ignores short/empty secrets to avoid over-redaction', () => {
    expect(redactSecrets('a normal sentence', ['', 'abc'])).toBe('a normal sentence')
  })
})

describe('scrubWith', () => {
  it('redacts both a known secret and URL creds in one pass', () => {
    const s = 'yt-dlp failed for http://bob:hunter2@gw.proxy.net:1080 token=supersecretkey99'
    const out = scrubWith(s, ['supersecretkey99'])
    expect(out).toContain('http://***:***@gw.proxy.net:1080')
    expect(out).toContain('token=[REDACTED]')
    expect(out).not.toContain('hunter2')
    expect(out).not.toContain('supersecretkey99')
  })
  it('is a no-op on clean text', () => {
    expect(scrubWith('all good here', [])).toBe('all good here')
  })
})
