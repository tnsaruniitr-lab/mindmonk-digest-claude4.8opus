import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config'
import { retry } from '../util/retry'

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })

/** Primary model call (insight extraction + personalization). Returns text. */
export async function callClaude(opts: {
  system: string
  user: string
  maxTokens?: number
}): Promise<string> {
  const res = await retry(
    () =>
      client.messages.create({
        model: config.ANTHROPIC_MODEL,
        max_tokens: opts.maxTokens ?? 8000,
        system: opts.system,
        messages: [{ role: 'user', content: opts.user }],
      }),
    { tries: 3, baseMs: 2000, label: 'claude' },
  )

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
  if (!text) throw new Error('Claude returned an empty response')
  return text
}
