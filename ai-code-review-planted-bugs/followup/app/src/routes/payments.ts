import { Router } from 'express'
import { z } from 'zod'
import { pool } from '../db.js'
import { createCharge } from '../lib/provider.js'
import { logger } from '../lib/logger.js'
import { assertBillingAccess } from '../auth/permissions.js'

export const paymentsRouter = Router()

const paySchema = z.object({ invoice_id: z.number().int().positive() })

paymentsRouter.post('/', async (req, res) => {
  assertBillingAccess(req.user)
  const { invoice_id } = paySchema.parse(req.body)
  const { rows } = await pool.query(
    `SELECT i.id, i.amount, i.currency, o.provider_customer_id
       FROM invoices i JOIN organizations o ON o.id = i.org_id
      WHERE i.id = $1 AND i.org_id = $2 AND i.status = 'open'`,
    [invoice_id, req.user.orgId],
  )
  const invoice = rows[0]
  if (!invoice) return res.status(404).json({ error: 'invoice_not_payable' })

  const charge = await createCharge({
    amount: Number(invoice.amount),
    currency: invoice.currency,
    customerId: invoice.provider_customer_id,
  })

  await pool.query(
    `INSERT INTO payments (org_id, invoice_id, provider_charge_id, amount, status) VALUES ($1, $2, $3, $4, $5)`,
    [req.user.orgId, invoice.id, charge.id, invoice.amount, charge.status],
  )
  if (charge.status === 'succeeded') await pool.query(`UPDATE invoices SET status = 'paid' WHERE id = $1`, [invoice.id])
  logger.info('invoice payment attempted', { invoice_id: invoice.id, charge_id: charge.id, status: charge.status })
  res.status(201).json({ charge_id: charge.id, status: charge.status })
})
