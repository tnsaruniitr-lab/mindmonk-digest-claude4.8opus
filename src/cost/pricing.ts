// Pure cost-estimation helpers for the spend kill-switch (Phase 0).
// No config/db imports, so these stay trivially unit-testable.
//
// Rates are ESTIMATES for budgeting/guardrail purposes, not billing. They err
// slightly high so the daily cap trips a little early rather than too late.

// USD per 1,000,000 tokens: [substring match, input, output]. Most-specific first.
const LLM_RATES: ReadonlyArray<readonly [string, number, number]> = [
  ['gpt-4o-mini', 0.15, 0.6],
  ['gpt-4o', 2.5, 10],
  ['opus', 5, 25],
  ['sonnet', 3, 15],
  ['haiku', 0.8, 4],
]
const LLM_DEFAULT: readonly [number, number] = [5, 25] // conservative (opus-level) for unknowns

// USD per minute of audio: [substring match, perMin]. Most-specific first.
const ASR_RATES: ReadonlyArray<readonly [string, number]> = [
  ['turbo', 0.0007], // groq whisper-large-v3-turbo (~$0.04/hr); matched by MODEL name
  ['gpt-4o-mini-transcribe', 0.003],
  ['whisper-1', 0.006], // OpenAI (~$0.36/hr)
]
const ASR_DEFAULT_PER_MIN = 0.006 // conservative

function llmRate(model: string): readonly [number, number] {
  const m = model.toLowerCase()
  for (const [match, inPerM, outPerM] of LLM_RATES) if (m.includes(match)) return [inPerM, outPerM]
  return LLM_DEFAULT
}

/** Estimated USD for one LLM call. */
export function estimateLlmCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const [inPerM, outPerM] = llmRate(model)
  const cost = (Math.max(0, inputTokens) / 1e6) * inPerM + (Math.max(0, outputTokens) / 1e6) * outPerM
  return round6(cost)
}

/** Estimated USD for transcribing `seconds` of audio with `model`. */
export function estimateAsrCostUsd(model: string, seconds: number): number {
  const m = model.toLowerCase()
  let perMin = ASR_DEFAULT_PER_MIN
  for (const [match, r] of ASR_RATES) {
    if (m.includes(match)) {
      perMin = r
      break
    }
  }
  return round6((Math.max(0, seconds) / 60) * perMin)
}

/** True when spend should be BLOCKED. capUsd <= 0 disables the cap. */
export function decideCap(spentUsd: number, capUsd: number): boolean {
  if (!(capUsd > 0)) return false
  return spentUsd >= capUsd
}

/** Flat estimated USD for one Supadata managed-transcript request (per-call, not per-token). */
export const SUPADATA_PER_CALL_USD = 0.002

/** Rough audio-seconds estimate from transcript length, for cost when the true duration is
 *  unknown (~13 chars/sec of speech). Keeps a metadata-blocked transcription from being free. */
export function estimateSecondsFromText(text: string): number {
  return Math.round(Math.max(0, text.length) / 13)
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}
