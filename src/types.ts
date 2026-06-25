export interface ChannelRow {
  id: string
  youtube_channel_id: string
  title: string | null
  handle: string | null
  url: string | null
  active: boolean
  min_duration_minutes: number | null
  last_checked_at: string | null
  created_at: string
}

export type VideoStatus =
  | 'pending'
  | 'processing'
  | 'done'
  | 'skipped'
  | 'failed'
  | 'no_transcript'

export interface VideoRow {
  id: string
  video_id: string
  channel_id: string | null
  title: string | null
  url: string
  published_at: string | null
  duration_seconds: number | null
  is_long_form: boolean | null
  status: VideoStatus
  skip_reason: string | null
  attempts: number
  transcript_attempts: number
  created_at: string
  processed_at: string | null
  claimed_at: string | null
}

// ----- The four digest sections ------------------------------------------------

/** Section 1 + 2 — produced by the primary model from the transcript. */
export interface ExtractResult {
  key_insights: { insight: string; detail: string }[]
  patterns: { name: string; why: string }[]
  antipatterns: { name: string; why: string }[]
}

/** Section 3 — produced by the separate "specified" grader LLM. */
export interface GradeResult {
  overall_score: number
  verdict: string
  dimensions: { name: string; score: number; comment: string }[]
  caveats: string[]
}

/** Section 4 — produced by the primary model against the user's profile. */
export interface PersonalizeResult {
  relevance: 'high' | 'medium' | 'low'
  tailored: { point: string; why_it_matters_to_you: string; action: string }[]
  not_relevant?: string
}
