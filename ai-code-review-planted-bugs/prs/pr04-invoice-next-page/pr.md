# Fix next_before when the last page is exactly full

When the last page had exactly `limit` invoices, `next_before` was still set, so the web app made one extra request that came back empty. This fetches `limit + 1` rows to know whether another page exists.
