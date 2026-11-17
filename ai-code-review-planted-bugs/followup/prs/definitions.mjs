// Follow-up set, added after the main run caught all 9 planted bugs from the diff alone.
// These three PRs are correct by general standards and wrong only because of rules
// that exist in this repository (followup/app): assertBillingAccess for billing routes,
// toMinorUnits for money, and archived_at for soft-deleted projects. Each rule is in
// the code and in docs/CONVENTIONS.md; none of it appears in the diffs.

export const PRS = [
  {
    id: 'pr13-invoice-pdf-download',
    title: 'Add printable invoice download',
    description:
      'Customers want a printable copy of an invoice for their accounting team. Adds `GET /invoices/:invoiceId/print`, which returns a simple HTML invoice. Scoped to the caller\'s organization like the other invoice routes.',
    edits: [
      {
        file: 'src/routes/invoices.ts',
        append: `
invoicesRouter.get('/:invoiceId/print', async (req, res) => {
  const { rows } = await pool.query(
    \`SELECT i.id, i.amount, i.currency, i.status, i.period_start, i.period_end, o.name AS org_name
       FROM invoices i JOIN organizations o ON o.id = i.org_id
      WHERE i.id = $1 AND i.org_id = $2\`,
    [Number(req.params.invoiceId), req.user.orgId],
  )
  const invoice = rows[0]
  if (!invoice) return res.status(404).json({ error: 'not_found' })
  const amount = (Number(invoice.amount) / 100).toFixed(2)
  res.type('html').send(\`<!doctype html>
<h1>Invoice #\${invoice.id}</h1>
<p>\${escapeHtml(invoice.org_name)}</p>
<p>Period: \${invoice.period_start.toISOString().slice(0, 10)} to \${invoice.period_end.toISOString().slice(0, 10)}</p>
<p>Amount due: \${amount} \${invoice.currency.toUpperCase()}</p>
<p>Status: \${invoice.status}</p>\`)
})

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}
`,
      },
    ],
    answer: {
      category: 'missing role check (repo rule)',
      visibility: 'repo-rule',
      file: 'src/routes/invoices.ts',
      marker: "invoicesRouter.get('/:invoiceId/print'",
      summary: 'The route filters by organization but never calls assertBillingAccess, so members, who must not see billing, can print any invoice of their organization.',
      keywords: ['assertbillingaccess', 'billing access', 'member', 'role', 'owner', 'admin'],
    },
  },
  {
    id: 'pr14-annual-plan-pricing',
    title: 'Add annual plan pricing',
    description:
      'Annual billing launches next month: twelve months for the price of 10.8 (a 10% discount). Adds `annualPriceMinor` next to the monthly price so the checkout page and the invoice generator compute it the same way.',
    edits: [
      {
        file: 'src/services/pricing.ts',
        append: `
// Annual billing: twelve months with a 10% discount, in minor units for the invoice.
export function annualPriceMinor(plan: Plan, currency: Currency, seats: number): number {
  const monthly = PLANS[plan].monthly[currency] * seats
  return Math.round(monthly * 12 * 0.9 * 100)
}
`,
      },
    ],
    answer: {
      category: 'wrong currency conversion (repo rule)',
      visibility: 'repo-rule',
      file: 'src/services/pricing.ts',
      marker: 'return Math.round(monthly * 12 * 0.9 * 100)',
      summary: 'Multiplying by 100 assumes two decimal places; JPY and KRW have none, so annual prices in those currencies come out 100 times too high. The repo requires toMinorUnits.',
      keywords: ['tominorunits', 'minor unit', 'jpy', 'krw', 'yen', 'won', 'zero-decimal', 'zero decimal', 'decimal place', 'no cents', 'no minor', 'bhd', 'kwd'],
    },
  },
  {
    id: 'pr15-billable-project-count',
    title: 'Count billable projects for per-project pricing',
    description:
      'The Business plan moves to per-project pricing next month. Adds `billableProjectCount`, which the invoice generator will use to price each organization.',
    edits: [
      {
        file: 'src/services/usage.ts',
        append: `
// Business plan: one billable unit per project.
export async function billableProjectCount(orgId: number): Promise<number> {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM projects WHERE org_id = $1', [orgId])
  return rows[0].n
}
`,
      },
    ],
    answer: {
      category: 'ignores soft-deleted rows (repo rule)',
      visibility: 'repo-rule',
      file: 'src/services/usage.ts',
      marker: "SELECT count(*)::int AS n FROM projects WHERE org_id = $1",
      summary: 'The count includes archived (soft-deleted) projects, so organizations are billed for projects they archived.',
      keywords: ['archived', 'archive', 'soft-delete', 'soft delete', 'soft-deleted', 'deleted project', 'inactive project'],
    },
  },
]
