import { z } from 'zod'
import { callClaude } from '../llm/claude'
import { structured } from '../util/structured'
import { config, personalizeModel } from '../config'
import type { ExtractResult, PersonalizeResult } from '../types'

const Schema = z.object({
  relevance: z.enum(['high', 'medium', 'low']),
  tailored: z
    .array(z.object({ point: z.string(), why_it_matters_to_you: z.string(), action: z.string() }))
    .default([]),
  not_relevant: z.string().optional(),
})

/** Section ④ — map the episode's ideas onto the user's profile and goals. */
export async function personalize(input: {
  extract: ExtractResult
  profile: string
}): Promise<PersonalizeResult> {
  const ideas = [
    ...input.extract.key_insights.map((k) => `INSIGHT: ${k.insight} — ${k.detail}`),
    ...input.extract.patterns.map((p) => `PATTERN: ${p.name} — ${p.why}`),
    ...input.extract.antipatterns.map((a) => `ANTIPATTERN: ${a.name} — ${a.why}`),
  ].join('\n')

  const system = `You are the user's sharp chief-of-staff. You know their goals, projects, and constraints intimately and you tell them the truth. Connect this episode's ideas to THEIR specific situation — not generic advice. Be blunt: if the episode is low-relevance to them, say so plainly rather than stretching. Write in ${config.SUMMARY_LANGUAGE}. Output ONLY valid minified JSON. No prose, no markdown fences.`

  const user = `MY PROFILE:
${input.profile || '(no profile set)'}

EPISODE IDEAS:
${ideas}

Produce JSON with EXACTLY this shape:
{
  "relevance": "high" | "medium" | "low",
  "tailored": [ { "point": "<the idea, framed for me>", "why_it_matters_to_you": "<tie it to a specific goal/project of mine>", "action": "<one concrete thing I could do>" } ],
  "not_relevant": "<optional: 1 sentence on what here is NOT worth my time>"
}

Rules:
- Only include "tailored" items that genuinely connect to MY goals. 0-5 items.
- If relevance is low, return an empty "tailored" array and explain why in "not_relevant".`

  return structured(Schema, (strict) =>
    callClaude({
      system: strict ? `${system}\nReturn ONLY the JSON object — no prose, no fences.` : system,
      user,
      maxTokens: 3000,
      model: personalizeModel,
    }),
  )
}
