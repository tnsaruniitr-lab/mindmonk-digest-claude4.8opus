import { z } from 'zod'
import { extractJson } from './json'

/**
 * Parse an LLM response into a validated object. If the first attempt fails
 * (prose, fences, truncation, schema drift), retry once with a stricter
 * "JSON only" instruction before giving up.
 */
export async function structured<S extends z.ZodTypeAny>(
  schema: S,
  call: (strict: boolean) => Promise<string>,
): Promise<z.infer<S>> {
  const raw = await call(false)
  try {
    return schema.parse(extractJson(raw))
  } catch {
    const repaired = await call(true)
    return schema.parse(extractJson(repaired))
  }
}
