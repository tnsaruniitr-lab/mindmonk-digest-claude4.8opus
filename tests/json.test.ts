import { describe, it, expect } from 'vitest'
import { extractJson } from '../src/util/json'

describe('extractJson', () => {
  it('parses a bare object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })
  it('strips ``` fences', () => {
    expect(extractJson('```json\n{"a":1,"b":[2,3]}\n```')).toEqual({ a: 1, b: [2, 3] })
  })
  it('trims prose around the object', () => {
    expect(extractJson('Sure! Here you go:\n{"ok":true}\nHope that helps.')).toEqual({ ok: true })
  })
  it('throws on non-JSON', () => {
    expect(() => extractJson('no json here')).toThrow()
  })
})
