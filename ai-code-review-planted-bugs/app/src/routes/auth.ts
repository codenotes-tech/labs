import { Router } from 'express'
import { z } from 'zod'
import crypto from 'node:crypto'
import { pool } from '../db.js'
import { hashPassword, verifyPassword } from '../auth/passwords.js'
import { logger } from '../lib/logger.js'

export const authRouter = Router()

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12),
  organization: z.string().min(1).max(200),
})

authRouter.post('/signup', async (req, res) => {
  const { email, password, organization } = signupSchema.parse(req.body)
  const passwordHash = await hashPassword(password)
  const { rows } = await pool.query(
    `WITH org AS (INSERT INTO organizations (name) VALUES ($1) RETURNING id)
     INSERT INTO users (org_id, email, password_hash, role) SELECT id, $2, $3, 'owner' FROM org RETURNING id, org_id`,
    [organization, email.toLowerCase(), passwordHash],
  )
  logger.info('user signed up', { user_id: rows[0].id, org_id: rows[0].org_id })
  res.status(201).json({ user_id: rows[0].id })
})

const loginSchema = z.object({ email: z.string().email(), password: z.string() })

authRouter.post('/login', async (req, res) => {
  const { email, password } = loginSchema.parse(req.body)
  const { rows } = await pool.query('SELECT id, password_hash FROM users WHERE email = $1', [email.toLowerCase()])
  if (!rows[0] || !(await verifyPassword(password, rows[0].password_hash))) {
    return res.status(401).json({ error: 'invalid_credentials' })
  }
  const token = crypto.randomBytes(32).toString('base64url')
  const digest = crypto.createHash('sha256').update(token).digest('hex')
  await pool.query(`INSERT INTO sessions (user_id, token_sha256, expires_at) VALUES ($1, $2, now() + interval '30 days')`, [rows[0].id, digest])
  res.json({ token })
})
