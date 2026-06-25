import { z } from 'zod'
import { callGrader } from '../llm/grader'
import { structured } from '../util/structured'
import { config } from '../config'
import type { ExtractResult, GradeResult } from '../types'

const Schema = z.object({
  overall_score: z.number().min(0).max(10),
  verdict: z.string(),
  dimensions: z
    .array(z.object({ name: z.string(), score: z.number().min(0).max(10), comment: z.string() }))
    .default([]),
  caveats: z.array(z.string()).default([]),
})

/** Section ③ — an independent, skeptical grade by the separate "specified" LLM. */
export async function gradeIdeas(input: {
  title: string | null
  extract: ExtractResult
}): Promise<GradeResult> {
  const ideas = [
    ...input.extract.key_insights.map((k) => `INSIGHT: ${k.insight} — ${k.detail}`),
    ...input.extract.patterns.map((p) => `PATTERN: ${p.name} — ${p.why}`),
    ...input.extract.antipatterns.map((a) => `ANTIPATTERN: ${a.name} — ${a.why}`),
  ].join('\n')

  const system = `You are an independent, skeptical evaluator. You did NOT write these ideas and have no stake in them. Judge them strictly on their MERITS — evidence quality, logical soundness, novelty, and real-world applicability — independent of who said them or how confidently it was asserted. Reward substance; penalise hand-waving, survivorship bias, cherry-picking, and unfalsifiable claims. Write in ${config.SUMMARY_LANGUAGE}. Output ONLY valid minified JSON. No prose, no markdown fences.`

  const user = `Grade the ideas extracted from the podcast "${input.title ?? 'Unknown'}".

Produce JSON with EXACTLY this shape:
{
  "overall_score": <number 0-10>,
  "verdict": "<one blunt sentence: are these ideas worth internalising?>",
  "dimensions": [
    { "name": "Evidence", "score": <0-10>, "comment": "<short>" },
    { "name": "Novelty", "score": <0-10>, "comment": "<short>" },
    { "name": "Practicality", "score": <0-10>, "comment": "<short>" },
    { "name": "Risk / limits", "score": <0-10>, "comment": "<what could make this wrong or harmful>" }
  ],
  "caveats": [ "<0-3 specific caveats a listener should keep in mind>" ]
}

IDEAS:
${ideas}`

  return structured(Schema, (strict) =>
    callGrader({
      system: strict ? `${system}\nReturn ONLY the JSON object — no prose, no fences.` : system,
      user,
      maxTokens: 2000,
    }),
  )
}
