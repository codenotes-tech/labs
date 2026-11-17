// The 12 pull requests: title and description as an author would write them,
// the exact edits applied to app/, and the answer key used for scoring.
//
// visibility: 'diff'    the bug can be seen in the diff by itself
//             'context' spotting it needs something outside the diff (other routes,
//                       the web client, docs/CONVENTIONS.md, table sizes, tests)
// answer.marker is a string on the line the bug lives on in the PR head; scoring
// accepts a finding on that file whose text contains any of answer.keywords.
// Clean PRs have no answer; any finding on them counts as a false alarm.

export const PRS = [
  {
    id: 'pr01-project-events-csv',
    title: 'Add CSV export for project events',
    description:
      "Customers asked to download a project's activity log. Adds `GET /projects/:projectId/events.csv`, which returns the latest 10,000 events as CSV. Same query as the JSON events endpoint, larger limit.",
    edits: [
      {
        file: 'src/routes/projects.ts',
        append: `
projectsRouter.get('/:projectId/events.csv', async (req, res) => {
  const projectId = Number(req.params.projectId)
  const { rows } = await pool.query(
    'SELECT id, kind, payload, created_at FROM events WHERE project_id = $1 ORDER BY id DESC LIMIT 10000',
    [projectId],
  )
  res.setHeader('content-type', 'text/csv')
  res.setHeader('content-disposition', \`attachment; filename="project-\${projectId}-events.csv"\`)
  res.write('id,kind,created_at,payload\\n')
  for (const row of rows) {
    res.write([row.id, row.kind, row.created_at.toISOString(), JSON.stringify(JSON.stringify(row.payload))].join(',') + '\\n')
  }
  res.end()
})
`,
      },
    ],
    answer: {
      category: 'missing authorization check',
      visibility: 'context',
      file: 'src/routes/projects.ts',
      marker: "projectsRouter.get('/:projectId/events.csv'",
      summary: 'The new route never calls assertProjectAccess, so any signed-in user of any organization can export any project by id.',
      keywords: ['authoriz', 'assertprojectaccess', 'access check', 'access control', 'permission', 'idor', 'any authenticated', 'any signed-in', 'any logged-in', 'any user', 'other organization', 'another organization', 'other org', 'another org', 'other tenant', 'ownership', 'cross-tenant', 'tenant'],
    },
  },
  {
    id: 'pr02-coupon-error-messages',
    title: "Return specific errors when a coupon can't be redeemed",
    description:
      "Support keeps asking why a coupon \"didn't work\". This splits the single UPDATE into a lookup plus explicit checks, so the API can say whether the code is unknown, expired, or used up. Still runs in one transaction.",
    edits: [
      {
        file: 'src/routes/coupons.ts',
        find: `  const result = await withTransaction(async (client) => {
    // One atomic statement: the row is only updated while redemptions remain.
    const updated = await client.query(
      \`UPDATE coupons SET redemptions = redemptions + 1
        WHERE code = $1 AND redemptions < max_redemptions
          AND (expires_at IS NULL OR expires_at > now())
        RETURNING percent_off\`,
      [code],
    )
    if (updated.rowCount === 0) return null
    await client.query('INSERT INTO coupon_redemptions (code, org_id) VALUES ($1, $2)', [code, req.user.orgId])
    return updated.rows[0]
  })
  if (!result) return res.status(409).json({ error: 'coupon_unavailable' })
  res.json({ percent_off: result.percent_off })`,
        replace: `  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT percent_off, max_redemptions, redemptions, expires_at FROM coupons WHERE code = $1',
      [code],
    )
    const coupon = rows[0]
    if (!coupon) return { error: 'coupon_not_found' as const }
    if (coupon.expires_at && coupon.expires_at <= new Date()) return { error: 'coupon_expired' as const }
    if (coupon.redemptions >= coupon.max_redemptions) return { error: 'coupon_used_up' as const }
    await client.query('UPDATE coupons SET redemptions = redemptions + 1 WHERE code = $1', [code])
    await client.query('INSERT INTO coupon_redemptions (code, org_id) VALUES ($1, $2)', [code, req.user.orgId])
    return { percent_off: coupon.percent_off as number }
  })
  if ('error' in result) return res.status(409).json({ error: result.error })
  res.json({ percent_off: result.percent_off })`,
      },
    ],
    answer: {
      category: 'race condition',
      visibility: 'diff',
      file: 'src/routes/coupons.ts',
      marker: "await client.query('UPDATE coupons SET redemptions = redemptions + 1 WHERE code = $1', [code])",
      summary: 'Read-check-write: two concurrent redemptions both read redemptions < max under READ COMMITTED and both increment, so a coupon can be redeemed more times than max_redemptions.',
      keywords: ['race', 'concurren', 'atomic', 'for update', 'row lock', 'lock the row', 'locking', 'simultaneous', 'parallel', 'exceed', 'oversubscri', 'toctou', 'check-then', 'same time', 'read committed', 'over-redeem', 'more than max'],
    },
  },
  {
    id: 'pr03-events-project-index',
    title: 'Speed up the project activity feed',
    description:
      'The project events endpoint does a sequential scan per project. Adds an index on `events (project_id, id DESC)` to match the query.',
    edits: [
      {
        file: 'migrations/005_events_project_idx.sql',
        create: `CREATE INDEX events_project_id_idx ON events (project_id, id DESC);
`,
      },
    ],
    answer: {
      category: 'unsafe migration',
      visibility: 'context',
      file: 'migrations/005_events_project_idx.sql',
      marker: 'CREATE INDEX events_project_id_idx',
      summary: 'A plain CREATE INDEX on the 400-million-row events table blocks writes for the whole build; the conventions require CREATE INDEX CONCURRENTLY in a no-transaction migration.',
      keywords: ['concurrently', 'lock', 'block write', 'blocks write', 'blocking write', 'downtime', 'large table', 'exclusive', 'share lock', 'no-transaction'],
    },
  },
  {
    id: 'pr04-invoice-next-page',
    title: 'Fix next_before when the last page is exactly full',
    description:
      'When the last page had exactly `limit` invoices, `next_before` was still set, so the web app made one extra request that came back empty. This fetches `limit + 1` rows to know whether another page exists.',
    edits: [
      {
        file: 'src/routes/invoices.ts',
        find: `    [req.user.orgId, before ?? null, limit],
  )
  res.json({
    invoices: rows.map(serializeInvoice),
    next_before: rows.length === limit ? rows[rows.length - 1].id : null,
  })`,
        replace: `    [req.user.orgId, before ?? null, limit + 1],
  )
  const hasMore = rows.length > limit
  const page = rows.slice(1, limit + 1)
  res.json({
    invoices: page.map(serializeInvoice),
    next_before: hasMore ? page[page.length - 1].id : null,
  })`,
      },
    ],
    answer: {
      category: 'off-by-one',
      visibility: 'diff',
      file: 'src/routes/invoices.ts',
      marker: 'const page = rows.slice(1, limit + 1)',
      summary: 'slice(1, limit + 1) drops the first (newest) row of every page; it should be slice(0, limit).',
      keywords: ['slice', 'off-by-one', 'off by one', 'skip', 'drop', 'first invoice', 'first row', 'first item', 'first element', 'first result', 'index 0', 'newest invoice', 'omit'],
    },
  },
  {
    id: 'pr05-retry-provider-calls',
    title: 'Retry payment provider calls on transient errors',
    description:
      'We see a handful of provider timeouts and 502s a day, and customers have to press Pay again. This wraps the charge call in our existing `withRetry` helper, which already retries timeouts and 5xx responses with backoff.',
    edits: [
      {
        file: 'src/routes/payments.ts',
        find: `import { createCharge } from '../lib/provider.js'`,
        replace: `import { createCharge } from '../lib/provider.js'
import { withRetry } from '../lib/retry.js'`,
      },
      {
        file: 'src/routes/payments.ts',
        find: `  const charge = await createCharge({
    amount: Number(invoice.amount),
    currency: invoice.currency,
    customerId: invoice.provider_customer_id,
  })`,
        replace: `  const charge = await withRetry(() =>
    createCharge({
      amount: Number(invoice.amount),
      currency: invoice.currency,
      customerId: invoice.provider_customer_id,
    }),
  )`,
      },
    ],
    answer: {
      category: 'retry of a non-idempotent side effect',
      visibility: 'context',
      file: 'src/routes/payments.ts',
      marker: 'const charge = await withRetry(() =>',
      summary: 'A timeout after the provider has already charged is retried without an idempotency key, so customers can be charged twice; the conventions forbid withRetry around charges without an idempotency key.',
      keywords: ['idempoten', 'double charge', 'double-charge', 'duplicate charge', 'charged twice', 'charge twice', 'charging twice', 'duplicate payment', 'multiple charges', 'charged multiple', 'charged more than once'],
    },
  },
  {
    id: 'pr06-amount-cents-field',
    title: 'Rename invoice amount to amount_cents',
    description:
      '`amount` is ambiguous: people reading the API assume dollars. This renames the response field to `amount_cents` so the unit is explicit.',
    edits: [
      {
        file: 'src/serializers/invoice.ts',
        find: `    amount: Number(row.amount),`,
        replace: `    amount_cents: Number(row.amount),`,
      },
    ],
    answer: {
      category: 'breaking API contract change',
      visibility: 'context',
      file: 'src/serializers/invoice.ts',
      marker: 'amount_cents: Number(row.amount),',
      summary: 'Removing `amount` from the response breaks the web client (web/src/api/invoices.ts, InvoiceRow) and the mobile apps; the conventions require a new API version for renames.',
      keywords: ['breaking', 'break', 'client', 'consumer', 'web/', 'invoicerow', 'backward', 'compatib', 'api version', 'versioning', 'mobile', 'contract', 'frontend', 'front-end'],
    },
  },
  {
    id: 'pr07-log-signup-payloads',
    title: 'Log signup payloads to debug failed signups',
    description:
      "Some signups fail validation and we can't tell what clients sent. This logs the incoming payload before validation. The logger already redacts sensitive fields.",
    edits: [
      {
        file: 'src/routes/auth.ts',
        find: `authRouter.post('/signup', async (req, res) => {
  const { email, password, organization } = signupSchema.parse(req.body)`,
        replace: `authRouter.post('/signup', async (req, res) => {
  logger.info('signup attempt', { body: req.body })
  const { email, password, organization } = signupSchema.parse(req.body)`,
      },
    ],
    answer: {
      category: 'sensitive data in logs',
      visibility: 'diff',
      file: 'src/routes/auth.ts',
      marker: "logger.info('signup attempt', { body: req.body })",
      summary: 'The signup body contains the plaintext password, and the logger redacts only `authorization` and `token`.',
      keywords: ['password', 'plaintext', 'plain text', 'sensitive', 'pii', 'credential', 'secret'],
    },
  },
  {
    id: 'pr08-billing-period-simplify',
    title: 'Simplify next billing period calculation',
    description:
      'Replaces the manual date math in `nextPeriod` with `setUTCMonth`, which already handles month and year rollover.',
    edits: [
      {
        file: 'src/services/billing.ts',
        find: `export function nextPeriod(periodStart: Date): { start: Date; end: Date } {
  const start = new Date(periodStart)
  const anchorDay = start.getUTCDate()
  const year = start.getUTCFullYear()
  const month = start.getUTCMonth() + 1
  // Clamp to the last day of the next month, so a period starting on Jan 31 renews on Feb 28/29.
  const lastDayOfNextMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const end = new Date(Date.UTC(year, month, Math.min(anchorDay, lastDayOfNextMonth)))
  return { start, end }
}`,
        replace: `export function nextPeriod(periodStart: Date): { start: Date; end: Date } {
  const start = new Date(periodStart)
  const end = new Date(periodStart)
  end.setUTCMonth(end.getUTCMonth() + 1)
  return { start, end }
}`,
      },
    ],
    answer: {
      category: 'date overflow at month end',
      visibility: 'diff',
      file: 'src/services/billing.ts',
      marker: 'end.setUTCMonth(end.getUTCMonth() + 1)',
      summary: 'setUTCMonth overflows: a period starting on Jan 31 ends on Mar 3 (Mar 2 in leap years) instead of Feb 28/29; the existing test "clamps to the end of a shorter month" fails.',
      keywords: ['overflow', '31', 'end of month', 'end-of-month', 'shorter month', 'february', 'feb ', 'march', 'mar ', 'rollover', 'roll over', 'clamp', 'skip', 'days in', 'last day', 'month boundar'],
    },
  },
  {
    id: 'pr09-invoice-sorting',
    title: 'Let the web app sort invoices',
    description: 'Adds an optional `sort` query parameter (for example `amount` or `created_at`) to `GET /invoices`.',
    edits: [
      {
        file: 'src/routes/invoices.ts',
        find: `  before: z.coerce.number().int().positive().optional(),
})`,
        replace: `  before: z.coerce.number().int().positive().optional(),
  sort: z.string().optional(),
})`,
      },
      {
        file: 'src/routes/invoices.ts',
        find: `  const { limit, before } = listSchema.parse(req.query)`,
        replace: `  const { limit, before, sort } = listSchema.parse(req.query)
  const orderBy = sort ? \`\${sort} DESC, id DESC\` : 'id DESC'`,
      },
      {
        file: 'src/routes/invoices.ts',
        find: `      ORDER BY id DESC
      LIMIT $3\`,`,
        replace: `      ORDER BY \${orderBy}
      LIMIT $3\`,`,
      },
    ],
    answer: {
      category: 'SQL injection',
      visibility: 'diff',
      file: 'src/routes/invoices.ts',
      marker: "const orderBy = sort ? `${sort} DESC, id DESC` : 'id DESC'",
      summary: 'The user-supplied sort value is interpolated into ORDER BY, which allows SQL injection.',
      keywords: ['injection', 'inject', 'interpolat', 'unsanitized', 'unsanitised', 'unvalidated', 'whitelist', 'allowlist', 'allow-list', 'allow list', 'arbitrary sql'],
    },
  },
  {
    id: 'pr10-shared-money-format',
    title: 'Share money formatting in the web app',
    description: 'Moves the currency formatter used by `InvoiceRow` into `web/src/format.ts` so other components can reuse it. No behavior change.',
    edits: [
      {
        file: 'web/src/format.ts',
        create: `const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

export function formatCents(cents: number): string {
  return usd.format(cents / 100)
}
`,
      },
      {
        file: 'web/src/components/InvoiceRow.tsx',
        find: `import type { Invoice } from '../api/invoices'

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
`,
        replace: `import type { Invoice } from '../api/invoices'
import { formatCents } from '../format'
`,
      },
      {
        file: 'web/src/components/InvoiceRow.tsx',
        find: `      <td>{money.format(invoice.amount / 100)}</td>`,
        replace: `      <td>{formatCents(invoice.amount)}</td>`,
      },
    ],
    answer: null,
  },
  {
    id: 'pr11-proration-tests',
    title: 'Add edge-case tests for proration',
    description: 'Covers cancellations at the start and end of a period, before it starts, after it ends, and a partial month.',
    edits: [
      {
        file: 'tests/billing.test.ts',
        find: `    expect(proratedAmount(3000, start, end, new Date('2026-04-16T00:00:00Z'))).toBe(1500)
  })
})`,
        replace: `    expect(proratedAmount(3000, start, end, new Date('2026-04-16T00:00:00Z'))).toBe(1500)
  })

  it('refunds everything when cancelled at or before the start', () => {
    const start = new Date('2026-04-01T00:00:00Z')
    const end = new Date('2026-05-01T00:00:00Z')
    expect(proratedAmount(3000, start, end, start)).toBe(3000)
    expect(proratedAmount(3000, start, end, new Date('2026-03-20T00:00:00Z'))).toBe(3000)
  })

  it('refunds nothing when cancelled at or after the end', () => {
    const start = new Date('2026-04-01T00:00:00Z')
    const end = new Date('2026-05-01T00:00:00Z')
    expect(proratedAmount(3000, start, end, end)).toBe(0)
    expect(proratedAmount(3000, start, end, new Date('2026-05-09T00:00:00Z'))).toBe(0)
  })

  it('refunds two thirds after ten days of a thirty-day period', () => {
    const start = new Date('2026-04-01T00:00:00Z')
    const end = new Date('2026-05-01T00:00:00Z')
    expect(proratedAmount(3000, start, end, new Date('2026-04-11T00:00:00Z'))).toBe(2000)
  })
})`,
      },
    ],
    answer: null,
  },
  {
    id: 'pr12-document-env-vars',
    title: 'Document environment variables',
    description: 'Lists the environment variables the API reads, with their defaults.',
    edits: [
      {
        file: 'README.md',
        find: `## Running locally`,
        replace: `## Configuration

| Variable | Required | Default | Used by |
| --- | --- | --- | --- |
| \`DATABASE_URL\` | yes | none | \`src/db.ts\` |
| \`PORT\` | no | \`3000\` | \`src/server.ts\` |
| \`PAYMENT_PROVIDER_URL\` | no | \`https://api.payments.example\` | \`src/lib/provider.ts\` |
| \`PAYMENT_PROVIDER_KEY\` | yes | none | \`src/lib/provider.ts\` |

## Running locally`,
      },
    ],
    answer: null,
  },
]
