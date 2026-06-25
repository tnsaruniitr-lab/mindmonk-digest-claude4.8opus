/**
 * Tolerant JSON extraction from an LLM response: strips ``` fences and trims
 * to the outermost {...} so a stray sentence before/after the object doesn't
 * break parsing.
 */
export function extractJson<T = unknown>(text: string): T {
  let s = text.trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start !== -1 && end !== -1 && end > start) s = s.slice(start, end + 1)
  return JSON.parse(s) as T
}
