// Web app client for the invoices API.
export interface Invoice {
  id: number
  amount: number // cents
  currency: string
  status: 'open' | 'paid' | 'void'
  period_start: string
  period_end: string
  created_at: string
}

export async function listInvoices(token: string, before?: number): Promise<{ invoices: Invoice[]; next_before: number | null }> {
  const params = new URLSearchParams({ limit: '25', ...(before ? { before: String(before) } : {}) })
  const response = await fetch(`/api/invoices?${params}`, { headers: { authorization: `Bearer ${token}` } })
  if (!response.ok) throw new Error(`invoices ${response.status}`)
  return response.json()
}
