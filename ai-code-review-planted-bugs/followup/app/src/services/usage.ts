import { pool } from '../db.js'

// Usage numbers shown on the billing page and used by the invoice generator.
export async function memberCount(orgId: number): Promise<number> {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM users WHERE org_id = $1', [orgId])
  return rows[0].n
}

export async function activeProjectNames(orgId: number): Promise<string[]> {
  const { rows } = await pool.query(
    'SELECT name FROM projects WHERE org_id = $1 AND archived_at IS NULL ORDER BY name',
    [orgId],
  )
  return rows.map((r) => r.name)
}
