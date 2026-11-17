import { Router } from 'express'
import { z } from 'zod'
import { pool } from '../db.js'
import { serializeInvoice } from '../serializers/invoice.js'

export const invoicesRouter = Router()

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  before: z.coerce.number().int().positive().optional(),
})

// Newest first, keyset pagination on id.
invoicesRouter.get('/', async (req, res) => {
  const { limit, before } = listSchema.parse(req.query)
  const { rows } = await pool.query(
    `SELECT id, amount, currency, status, period_start, period_end, created_at
       FROM invoices
      WHERE org_id = $1 AND ($2::bigint IS NULL OR id < $2)
      ORDER BY id DESC
      LIMIT $3`,
    [req.user.orgId, before ?? null, limit],
  )
  res.json({
    invoices: rows.map(serializeInvoice),
    next_before: rows.length === limit ? rows[rows.length - 1].id : null,
  })
})

invoicesRouter.get('/:invoiceId', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, amount, currency, status, period_start, period_end, created_at
       FROM invoices WHERE id = $1 AND org_id = $2`,
    [Number(req.params.invoiceId), req.user.orgId],
  )
  if (!rows[0]) return res.status(404).json({ error: 'not_found' })
  res.json(serializeInvoice(rows[0]))
})
