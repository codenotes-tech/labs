// Amounts are stored in the currency's minor unit. Not every currency has cents:
// JPY and KRW have no minor unit, BHD and KWD have three decimals.
// Always convert with these helpers; never multiply or divide by 100.
const MINOR_UNIT_DIGITS: Record<string, number> = { jpy: 0, krw: 0, bhd: 3, kwd: 3 }

export function minorUnitDigits(currency: string): number {
  return MINOR_UNIT_DIGITS[currency.toLowerCase()] ?? 2
}

export function toMinorUnits(amount: number, currency: string): number {
  return Math.round(amount * 10 ** minorUnitDigits(currency))
}

export function fromMinorUnits(minor: number, currency: string): number {
  return minor / 10 ** minorUnitDigits(currency)
}
