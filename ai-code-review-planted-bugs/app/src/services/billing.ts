// Billing periods are calendar months in UTC (see docs/CONVENTIONS.md).

export function nextPeriod(periodStart: Date): { start: Date; end: Date } {
  const start = new Date(periodStart)
  const anchorDay = start.getUTCDate()
  const year = start.getUTCFullYear()
  const month = start.getUTCMonth() + 1
  // Clamp to the last day of the next month, so a period starting on Jan 31 renews on Feb 28/29.
  const lastDayOfNextMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const end = new Date(Date.UTC(year, month, Math.min(anchorDay, lastDayOfNextMonth)))
  return { start, end }
}

export function proratedAmount(amountCents: number, periodStart: Date, periodEnd: Date, cancelledAt: Date): number {
  const total = periodEnd.getTime() - periodStart.getTime()
  const used = Math.min(Math.max(cancelledAt.getTime() - periodStart.getTime(), 0), total)
  return Math.round((amountCents * (total - used)) / total)
}
