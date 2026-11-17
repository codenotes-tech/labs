# Rename invoice amount to amount_cents

`amount` is ambiguous: people reading the API assume dollars. This renames the response field to `amount_cents` so the unit is explicit.
