export interface InvoiceRow {
  id: number
  amount: string // BIGINT comes back as a string from pg
  currency: string
  status: string
  period_start: Date
  period_end: Date
  created_at: Date
}

export function serializeInvoice(row: InvoiceRow) {
  return {
    id: row.id,
    amount: Number(row.amount),
    currency: row.currency,
    status: row.status,
    period_start: row.period_start.toISOString(),
    period_end: row.period_end.toISOString(),
    created_at: row.created_at.toISOString(),
  }
}
