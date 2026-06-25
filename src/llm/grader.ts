import Anthropic from '@anthropic-ai/sdk'
import { config, graderConfigured } from '../config'
import { retry } from '../util/retry'
import { assertUnderDailyCap, recordLlmUsage } from '../cost/ledger'

/**
 * The "specified LLM" that produces the unbiased grade (Section 3). Configurable
 * provider + model + key so it can be a different family than the primary model.
 */
export async function callGrader(opts: {
  system: string
  user: string
  maxTokens?: number
}): Promise<string> {
  if (!graderConfigured) throw new Error('GRADER_API_KEY is not set (placeholder still in .env)')
  await assertUnderDailyCap()
  if (config.GRADER_PROVIDER === 'anthropic') return anthropicGrader(opts)
  return openaiCompatible(opts)
}

async function openaiCompatible(opts: { system: string; user: string; maxTokens?: number }): Promise<string> {
  return retry(
    async () => {
      const res = await fetch(`${config.GRADER_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.GRADER_API_KEY}`,
          // OpenRouter attribution (ignored by other providers)
          'http-referer': 'https://github.com/podcast-digest-bot',
          'x-title': 'Podcast Digest Bot',
        },
        body: JSON.stringify({
          model: config.GRADER_MODEL,
          temperature: 0.2,
          max_tokens: opts.maxTokens ?? 2000,
          messages: [
            { role: 'system', content: opts.system },
            { role: 'user', content: opts.user },
          ],
        }),
      })
      if (!res.ok) {
        throw new Error(`Grader HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
      }
      const j = (await res.json()) as {
        choices?: { message?: { content?: string } }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      const text = j.choices?.[0]?.message?.content
      if (!text) throw new Error('Grader returned no content')
      await recordLlmUsage({
        provider: 'openai-compatible',
        model: config.GRADER_MODEL,
        inputTokens: j.usage?.prompt_tokens ?? 0,
        outputTokens: j.usage?.completion_tokens ?? 0,
      })
      return text
    },
    { tries: 3, baseMs: 2000, label: 'grader' },
  )
}

async function anthropicGrader(opts: { system: string; user: string; maxTokens?: number }): Promise<string> {
  const client = new Anthropic({ apiKey: config.GRADER_API_KEY })
  const res = await retry(
    () =>
      client.messages.create({
        model: config.GRADER_MODEL,
        max_tokens: opts.maxTokens ?? 2000,
        system: opts.system,
        messages: [{ role: 'user', content: opts.user }],
      }),
    { tries: 3, baseMs: 2000, label: 'grader-anthropic' },
  )
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
  if (!text) throw new Error('Grader returned an empty response')
  await recordLlmUsage({
    provider: 'anthropic',
    model: config.GRADER_MODEL,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
  })
  return text
}
