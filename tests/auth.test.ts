import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword, normalizeEmail } from '../src/util/password'
import { parseCookies, sessionCookie, clearSessionCookie } from '../src/http/cookies'

describe('password hashing (scrypt)', () => {
  it('round-trips a correct password', () => {
    const stored = hashPassword('correct horse battery staple')
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true)
  })
  it('rejects a wrong password', () => {
    const stored = hashPassword('correct horse battery staple')
    expect(verifyPassword('correct horse battery stapl', stored)).toBe(false)
  })
  it('produces unique salts per hash', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'))
  })
  it('rejects malformed stored hashes without throwing', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false)
    expect(verifyPassword('x', 'bcrypt$something$else')).toBe(false)
    expect(verifyPassword('x', '')).toBe(false)
  })
  it('embeds the scrypt params for future upgrades', () => {
    expect(hashPassword('x')).toMatch(/^scrypt\$16384\$8\$1\$/)
  })
})

describe('email normalization', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Arun@Example.COM ')).toBe('arun@example.com')
  })
})

describe('cookies', () => {
  it('parses a cookie header', () => {
    expect(parseCookies('a=1; mm_session=tok%3D%3D; b=2')).toEqual({ a: '1', mm_session: 'tok==', b: '2' })
  })
  it('handles missing header and junk parts', () => {
    expect(parseCookies(undefined)).toEqual({})
    expect(parseCookies('junk; =nokey; k=v')).toEqual({ k: 'v' })
  })
  it('sets httpOnly strict session cookie and clears it', () => {
    const c = sessionCookie('raw-token', 3600)
    expect(c).toContain('mm_session=raw-token')
    expect(c).toContain('HttpOnly')
    expect(c).toContain('SameSite=Strict')
    expect(c).toContain('Max-Age=3600')
    expect(clearSessionCookie()).toContain('Max-Age=0')
  })
})
