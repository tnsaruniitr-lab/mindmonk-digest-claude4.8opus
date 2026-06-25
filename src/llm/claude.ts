import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config'
import { retry } from '../util/retry'
import { assertUnderDailyCap, recordLlmUsage } from '../cost/ledger'

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })

/** Primary model call (insight extraction + personalization). Returns text. */
export async function callClaude(opts: {
  system: string
  user: string
  maxTokens?: number
  model?: string
}): Promise<string> {
  const model = opts.model || config.ANTHROPIC_MODEL
  await assertUnderDailyCap()
  const res = await retry(
    () =>
      client.messages.create({
        model,
        max_tokens: opts.maxTokens ?? 8000,
        system: opts.system,
        messages: [{ role: 'user', content: opts.user }],
      }),
    { tries: 3, baseMs: 2000, label: 'claude' },
  )
  await recordLlmUsage({
    provider: 'anthropic',
    model,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
  })

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
  if (!text) throw new Error('Claude returned an empty response')
  return text
}
