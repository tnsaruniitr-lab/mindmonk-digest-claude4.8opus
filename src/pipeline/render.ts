import { config, graderConfigured } from '../config'
import type { ExtractResult, GradeResult, PersonalizeResult } from '../types'

/** Escape text for Telegram HTML parse mode. */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Clamp + escape: keeps any single rendered line well under the Telegram limit. */
function ec(s: string, max = 600): string {
  const clamped = s.length > max ? `${s.slice(0, max - 1)}…` : s
  return esc(clamped)
}

function fmtDuration(sec: number | null): string {
  if (!sec || sec <= 0) return ''
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec % 3600) / 60)
  return h > 0 ? `${h}h${m}m` : `${m}m`
}

/** Compose the 4-section digest as a Telegram HTML message. */
export function renderDigest(i: {
  title: string | null
  channel: string | null
  url: string
  durationSeconds: number | null
  extract: ExtractResult
  grade: GradeResult | null
  personalize: PersonalizeResult
}): string {
  const lines: string[] = []
  const metaBits = [i.channel ? ec(i.channel, 120) : null, fmtDuration(i.durationSeconds) || null]
    .filter(Boolean)
    .join(' · ')

  lines.push(`🎙️ <b>${ec(i.title ?? 'New episode', 200)}</b>`)
  lines.push(metaBits ? `<i>${metaBits}</i> · <a href="${esc(i.url)}">watch</a>` : `<a href="${esc(i.url)}">watch</a>`)
  lines.push('')

  // ① Key insights
  lines.push('<b>① Key insights</b>')
  if (i.extract.key_insights.length === 0) lines.push('• <i>none surfaced</i>')
  for (const k of i.extract.key_insights) lines.push(`• <b>${ec(k.insight, 220)}</b> — ${ec(k.detail)}`)
  lines.push('')

  // ② Patterns & antipatterns
  lines.push('<b>② Patterns &amp; antipatterns</b>')
  for (const p of i.extract.patterns) lines.push(`✅ <b>${ec(p.name, 220)}</b> — ${ec(p.why)}`)
  for (const a of i.extract.antipatterns) lines.push(`⛔ <b>${ec(a.name, 220)}</b> — ${ec(a.why)}`)
  if (i.extract.patterns.length === 0 && i.extract.antipatterns.length === 0) lines.push('• <i>none surfaced</i>')
  lines.push('')

  // ③ Unbiased grade (by the separate "specified" LLM)
  if (i.grade) {
    lines.push(`<b>③ Unbiased grade</b> <i>(by ${ec(config.GRADER_MODEL, 80)})</i>`)
    lines.push(`Overall: <b>${i.grade.overall_score}/10</b> — ${ec(i.grade.verdict)}`)
    for (const d of i.grade.dimensions) lines.push(`• ${ec(d.name, 60)}: <b>${d.score}/10</b> — ${ec(d.comment)}`)
    if (i.grade.caveats.length) lines.push(`Caveats: ${i.grade.caveats.map((c) => ec(c, 300)).join('; ')}`)
  } else {
    lines.push('<b>③ Unbiased grade</b>')
    lines.push(
      graderConfigured
        ? '• <i>grading failed this run</i>'
        : '• <i>grading skipped — set GRADER_API_KEY to enable an independent second-model grade</i>',
    )
  }
  lines.push('')

  // ④ For you
  lines.push(`<b>④ For you</b> <i>(relevance: ${esc(i.personalize.relevance)})</i>`)
  if (i.personalize.tailored.length === 0) {
    lines.push(`• <i>${ec(i.personalize.not_relevant ?? 'nothing specifically actionable for you here')}</i>`)
  } else {
    for (const t of i.personalize.tailored) {
      lines.push(`• <b>${ec(t.point, 220)}</b> — ${ec(t.why_it_matters_to_you)}`)
      lines.push(`  → ${ec(t.action)}`)
    }
    if (i.personalize.not_relevant) lines.push(`<i>Skip: ${ec(i.personalize.not_relevant)}</i>`)
  }

  return lines.join('\n')
}
