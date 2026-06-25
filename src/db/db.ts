import pg from 'pg'
import { config } from '../config'

const { Pool } = pg

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  // Railway's internal URL needs no SSL; set DATABASE_SSL=true for the public/proxied URL.
  ssl: config.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  max: 5,
})

export async function query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(text, params)
  return res.rows as T[]
}

export async function one<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(text, params)
  return rows[0] ?? null
}
