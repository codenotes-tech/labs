// Thin client for the card payment provider.
const BASE_URL = process.env.PAYMENT_PROVIDER_URL ?? 'https://api.payments.example'

export class ProviderError extends Error {
  constructor(message: string, public retryable: boolean) {
    super(message)
  }
}

export interface Charge {
  id: string
  status: 'succeeded' | 'failed'
}

export async function createCharge(input: { amount: number; currency: string; customerId: string }, idempotencyKey?: string): Promise<Charge> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(`${BASE_URL}/v1/charges`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.PAYMENT_PROVIDER_KEY}`,
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: JSON.stringify(input),
      signal: controller.signal,
    })
    if (response.status >= 500) throw new ProviderError(`provider ${response.status}`, true)
    if (!response.ok) throw new ProviderError(`provider ${response.status}`, false)
    return (await response.json()) as Charge
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw new ProviderError('provider timeout', true)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function getCustomer(customerId: string) {
  const response = await fetch(`${BASE_URL}/v1/customers/${customerId}`, {
    headers: { authorization: `Bearer ${process.env.PAYMENT_PROVIDER_KEY}` },
  })
  if (response.status >= 500) throw new ProviderError(`provider ${response.status}`, true)
  if (!response.ok) throw new ProviderError(`provider ${response.status}`, false)
  return response.json()
}
