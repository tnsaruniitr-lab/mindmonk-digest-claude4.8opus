import { one, query } from '../db/db'
import type { ExtractResult, GradeResult } from '../types'

// Shared per-video digest cache (Phase 1). Sections ①②③ are pure functions of the
// transcript, so they're computed once per video and reused — cost then scales with
// distinct videos, not deliveries. Section ④ (personalization) is NOT cached here.

export interface VideoDigestRow {
  key_insights: ExtractResult['key_insights'] | null
  patterns: ExtractResult['patterns'] | null
  antipatterns: ExtractResult['antipatterns'] | null
  grading: GradeResult | null
  extract_model: string | null
  grader_model: string | null
}

export interface CachedDigest {
  extract: ExtractResult
  grade: GradeResult | null
  extractModel: string | null
  graderModel: string | null
}

/** Pure: map a DB row (pg already parses jsonb) into typed digest objects. */
export function rowToDigest(row: VideoDigestRow): CachedDigest {
  return {
    extract: {
      key_insights: row.key_insights ?? [],
      patterns: row.patterns ?? [],
      antipatterns: row.antipatterns ?? [],
    },
    grade: row.grading ?? null,
    extractModel: row.extract_model ?? null,
    graderModel: row.grader_model ?? null,
  }
}

export async function getVideoDigest(videoId: string): Promise<CachedDigest | null> {
  const row = await one<VideoDigestRow>(
    `select key_insights, patterns, antipatterns, grading, extract_model, grader_model
       from video_digests where video_id = $1`,
    [videoId],
  )
  return row ? rowToDigest(row) : null
}

/** Store the shared ①②③ for a video. First writer wins (idempotent on video_id). */
export async function saveVideoDigest(
  videoId: string,
  d: { extract: ExtractResult; grade: GradeResult | null; extractModel: string; graderModel: string | null },
  opts: { overwrite?: boolean } = {},
): Promise<void> {
  // First writer wins by default; on-demand (force) recompute overwrites the stale row.
  const conflict = opts.overwrite
    ? `on conflict(video_id) do update set
         key_insights = excluded.key_insights,
         patterns = excluded.patterns,
         antipatterns = excluded.antipatterns,
         grading = excluded.grading,
         extract_model = excluded.extract_model,
         grader_model = excluded.grader_model`
    : 'on conflict(video_id) do nothing'
  await query(
    `insert into video_digests(video_id, key_insights, patterns, antipatterns, grading, extract_model, grader_model)
     values($1, $2, $3, $4, $5, $6, $7)
     ${conflict}`,
    [
      videoId,
      JSON.stringify(d.extract.key_insights),
      JSON.stringify(d.extract.patterns),
      JSON.stringify(d.extract.antipatterns),
      d.grade ? JSON.stringify(d.grade) : null,
      d.extractModel,
      d.graderModel,
    ],
  )
}

/** Backfill section ③ on a row cached WITHOUT a grade (grader off or failed earlier).
 *  Only fills when grading is still null — never clobbers a real grade. */
export async function updateVideoDigestGrade(
  videoId: string,
  grade: GradeResult,
  graderModel: string,
): Promise<void> {
  await query(
    `update video_digests set grading = $2, grader_model = $3
     where video_id = $1 and grading is null`,
    [videoId, JSON.stringify(grade), graderModel],
  )
}
