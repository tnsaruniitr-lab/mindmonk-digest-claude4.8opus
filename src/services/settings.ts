import { one, query } from '../db/db'
import { config } from '../config'

export async function getSetting(key: string): Promise<string | null> {
  const row = await one<{ value: string }>('select value from settings where key = $1', [key])
  return row?.value ?? null
}

export async function setSetting(key: string, value: string): Promise<void> {
  await query(
    'insert into settings(key, value) values($1, $2) on conflict(key) do update set value = excluded.value',
    [key, value],
  )
}

export async function getMinDurationMinutes(): Promise<number> {
  const v = await getSetting('min_duration_minutes')
  const n = v ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? n : config.MIN_DURATION_MINUTES
}
