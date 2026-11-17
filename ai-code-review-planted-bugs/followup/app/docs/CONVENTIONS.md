# Engineering conventions

## Access control

Every route under `/projects/:projectId` must call `assertProjectAccess(req.user, projectId)` from `src/auth/permissions.ts` before reading or writing project data. `authenticate` only proves who the caller is; it does not decide what they may see.

## Billing access

Invoices, payments, and coupons are visible to organization owners and admins only. Every billing route calls `assertBillingAccess(req.user)` in addition to filtering by `org_id`.

## Money

Amounts are stored in the currency's minor unit. Not every currency has cents: JPY and KRW have none, BHD and KWD have three decimals. Convert with `toMinorUnits` / `fromMinorUnits` from `src/lib/money.ts`; never multiply or divide by 100.

## Projects

Projects are soft-deleted: archiving sets `archived_at`. Archived projects are excluded from every list, count, and bill.

## Database migrations

- Releases are rolling: the previous and the new API version serve traffic side by side for up to 15 minutes. Every migration must work with the previous API version (expand, migrate, contract).
- `events` holds about 400 million rows and `invoices` about 30 million. Create indexes on these tables with `CREATE INDEX CONCURRENTLY`, in a migration file that starts with `-- migrate:no-transaction`.
- Never rename or drop a column in the same release that stops using it.

## External calls

- `withRetry` (`src/lib/retry.ts`) is only for idempotent operations: reads, and writes that send the full state. Do not wrap a call that charges a card, sends an email, or has any other side effect unless the request carries an idempotency key the provider honors.

## API compatibility

- Response fields are a contract with the web app (`web/`) and the iOS and Android apps (not in this repo). Rename or remove a field only behind a new API version.

## Logging

- Never log request bodies or headers on auth routes. `logger` redacts only `authorization` and `token` fields.

## Time

- Store and compute times in UTC. A billing period is one calendar month in UTC; a subscription that starts on the 31st renews on the last day of shorter months.
