import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { pool } from './db'
import { log } from '../util/logger'

/** Apply the idempotent schema on boot (so Railway needs no manual SQL step). */
export async function migrate(): Promise<void> {
  const sql = readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8')
  await pool.query(sql)
  log.info('Schema applied/verified')
}
