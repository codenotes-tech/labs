import { Router } from 'express'
import { z } from 'zod'
import { withTransaction } from '../db.js'

export const couponsRouter = Router()

const redeemSchema = z.object({ code: z.string().min(3).max(64) })

couponsRouter.post('/redeem', async (req, res) => {
  const { code } = redeemSchema.parse(req.body)
  const result = await withTransaction(async (client) => {
    // One atomic statement: the row is only updated while redemptions remain.
    const updated = await client.query(
      `UPDATE coupons SET redemptions = redemptions + 1
        WHERE code = $1 AND redemptions < max_redemptions
          AND (expires_at IS NULL OR expires_at > now())
        RETURNING percent_off`,
      [code],
    )
    if (updated.rowCount === 0) return null
    await client.query('INSERT INTO coupon_redemptions (code, org_id) VALUES ($1, $2)', [code, req.user.orgId])
    return updated.rows[0]
  })
  if (!result) return res.status(409).json({ error: 'coupon_unavailable' })
  res.json({ percent_off: result.percent_off })
})
