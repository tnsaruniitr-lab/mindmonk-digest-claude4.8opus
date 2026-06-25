import { one, query } from '../db/db'
import { SEED_PROFILE } from '../data/seed-profile'

export async function getProfile(): Promise<string> {
  const row = await one<{ profile_text: string }>('select profile_text from user_profile where id = 1')
  return row?.profile_text ?? ''
}

export async function setProfile(text: string): Promise<void> {
  await query(
    `insert into user_profile(id, profile_text, updated_at) values(1, $1, now())
     on conflict(id) do update set profile_text = excluded.profile_text, updated_at = now()`,
    [text],
  )
}

/** Insert the seed profile on first boot if none exists yet. */
export async function ensureProfileSeeded(): Promise<void> {
  const current = await getProfile()
  if (!current.trim()) await setProfile(SEED_PROFILE)
}
