import { describe, expect, it } from 'vitest'
import { nextPeriod, proratedAmount } from '../src/services/billing'

describe('nextPeriod', () => {
  it('renews on the same day next month', () => {
    const { end } = nextPeriod(new Date('2026-03-15T00:00:00Z'))
    expect(end.toISOString()).toBe('2026-04-15T00:00:00.000Z')
  })

  it('clamps to the end of a shorter month', () => {
    const { end } = nextPeriod(new Date('2026-01-31T00:00:00Z'))
    expect(end.toISOString()).toBe('2026-02-28T00:00:00.000Z')
  })
})

describe('proratedAmount', () => {
  it('refunds the unused share of the period', () => {
    const start = new Date('2026-04-01T00:00:00Z')
    const end = new Date('2026-05-01T00:00:00Z')
    expect(proratedAmount(3000, start, end, new Date('2026-04-16T00:00:00Z'))).toBe(1500)
  })
})
