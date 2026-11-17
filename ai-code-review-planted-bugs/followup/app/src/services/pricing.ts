import { toMinorUnits } from '../lib/money.js'

// List prices per seat per month, in each currency's major unit.
export const PLANS = {
  team: { monthly: { usd: 12, eur: 11, jpy: 1800, krw: 16000 } },
  business: { monthly: { usd: 29, eur: 27, jpy: 4300, krw: 39000 } },
} as const

export type Plan = keyof typeof PLANS
export type Currency = keyof (typeof PLANS)['team']['monthly']

export function monthlyPriceMinor(plan: Plan, currency: Currency, seats: number): number {
  return toMinorUnits(PLANS[plan].monthly[currency] * seats, currency)
}

export function planLabel(plan: Plan): string {
  return plan === 'team' ? 'Team' : 'Business'
}
