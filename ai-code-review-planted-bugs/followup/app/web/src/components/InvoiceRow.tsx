import type { Invoice } from '../api/invoices'

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

export function InvoiceRow({ invoice }: { invoice: Invoice }) {
  return (
    <tr>
      <td>#{invoice.id}</td>
      <td>{new Date(invoice.period_start).toLocaleDateString()}</td>
      <td>{money.format(invoice.amount / 100)}</td>
      <td>{invoice.status}</td>
    </tr>
  )
}
