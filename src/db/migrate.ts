import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { pool } from './db'
import { log } from '../util/logger'

// Two-step migration on boot:
//   1. Replay the idempotent, CREATE-ONLY schema.sql (fresh-DB bootstrap; no-op on existing DBs).
//   2. Apply numbered src/db/migrations/NNNN_*.sql files in order, each in its own
//      transaction and recorded in schema_migrations — this is where ALTERs live.
// Never edit an applied migration; add a new numbered file instead.

export async function migrate(): Promise<void> {
  const sql = readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8')
  await pool.query(sql)

  await pool.query(
    `create table if not exists schema_migrations (
       version    text primary key,
       applied_at timestamptz not null default now()
     )`,
  )

  const dir = fileURLToPath(new URL('./migrations', import.meta.url))
  if (!existsSync(dir)) {
    log.info('Schema applied/verified (no migrations dir)')
    return
  }
  const files = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort()
  const applied = new Set(
    (await pool.query<{ version: string }>('select version from schema_migrations')).rows.map((r) => r.version),
  )
  let ran = 0
  for (const file of files) {
    if (applied.has(file)) continue
    const body = readFileSync(`${dir}/${file}`, 'utf8')
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query(body)
      await client.query('insert into schema_migrations(version) values($1)', [file])
      await client.query('commit')
      ran++
      log.info(`Migration applied: ${file}`)
    } catch (e) {
      await client.query('rollback').catch(() => {})
      throw new Error(`Migration ${file} failed: ${String(e)}`)
    } finally {
      client.release()
    }
  }
  log.info(`Schema applied/verified (${ran ? `${ran} new migration(s)` : 'migrations up to date'})`)
}
