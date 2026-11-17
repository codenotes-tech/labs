import crypto from 'node:crypto'
import { pool } from '../db.js'
import type { AuthUser } from '../middleware/authenticate.js'

export async function verifySessionToken(token: string): Promise<AuthUser | null> {
  const digest = crypto.createHash('sha256').update(token).digest('hex')
  const { rows } = await pool.query(
    `SELECT u.id, u.org_id, u.role FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_sha256 = $1 AND s.expires_at > now()`,
    [digest],
  )
  return rows[0] ? { id: rows[0].id, orgId: rows[0].org_id, role: rows[0].role } : null
}
