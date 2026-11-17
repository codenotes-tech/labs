# acme-billing-api

Billing API for Acme's project management product: organizations, projects, invoices, coupons, and card payments.

- `src/` — Express API (TypeScript), PostgreSQL via `pg`
- `migrations/` — SQL migrations, applied in order at deploy time
- `web/` — the customer web app's API client and components that consume this API
- `docs/CONVENTIONS.md` — rules every change must follow

Deploys are rolling: old and new versions of the API serve traffic together during a release.

## Running locally

```bash
npm install
DATABASE_URL=postgres://localhost/acme npm run migrate
npm run dev
```
