# Retry payment provider calls on transient errors

We see a handful of provider timeouts and 502s a day, and customers have to press Pay again. This wraps the charge call in our existing `withRetry` helper, which already retries timeouts and 5xx responses with backoff.
