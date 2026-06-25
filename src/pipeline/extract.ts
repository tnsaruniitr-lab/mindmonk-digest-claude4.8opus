import { z } from 'zod'
import { callClaude } from '../llm/claude'
import { structured } from '../util/structured'
import { config } from '../config'
import type { ExtractResult } from '../types'

const Schema = z.object({
  key_insights: z.array(z.object({ insight: z.string(), detail: z.string() })).default([]),
  patterns: z.array(z.object({ name: z.string(), why: z.string() })).default([]),
  antipatterns: z.array(z.object({ name: z.string(), why: z.string() })).default([]),
})

/** Sections ① and ② — key insights + patterns/antipatterns from the transcript. */
export async function extractInsights(input: {
  title: string | null
  channel: string | null
  transcript: string
}): Promise<ExtractResult> {
  const system = `You are an expert analyst who distils long-form podcast transcripts into structured intelligence. Write in ${config.SUMMARY_LANGUAGE}. Be specific and concrete — name names, cite the actual claims, avoid generic filler and table-of-contents summaries. Output ONLY valid minified JSON. No prose, no markdown fences.`

  const user = `PODCAST: ${input.title ?? 'Unknown'}${input.channel ? ` — ${input.channel}` : ''}

From the transcript below, produce JSON with EXACTLY this shape:
{
  "key_insights": [ { "insight": "<one-line non-obvious claim or idea>", "detail": "<1-2 sentences of the actual substance/evidence from the episode>" } ],
  "patterns": [ { "name": "<a repeatable approach/heuristic the episode argues WORKS>", "why": "<why it works>" } ],
  "antipatterns": [ { "name": "<a mistake/trap the episode says to AVOID>", "why": "<why it fails>" } ]
}

Rules:
- 5-8 key insights — the things a sharp listener would underline, not a summary of topics.
- 2-5 patterns and 2-5 antipatterns, each a concrete "do this / don't do this" lesson grounded in what was actually said.
- If the episode genuinely lacks a category, return an empty array for it. Do not invent.

TRANSCRIPT:
${input.transcript}`

  return structured(Schema, (strict) =>
    callClaude({
      system: strict ? `${system}\nReturn ONLY the JSON object — no prose, no fences.` : system,
      user,
      maxTokens: 6000,
    }),
  )
}
