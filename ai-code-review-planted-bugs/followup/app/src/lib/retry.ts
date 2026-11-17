// Retries an operation on timeouts and 5xx responses with exponential backoff.
// Only for idempotent operations: see "External calls" in docs/CONVENTIONS.md.
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      const retryable = (error as { retryable?: boolean }).retryable === true
      if (!retryable || attempt === attempts) break
      await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** (attempt - 1)))
    }
  }
  throw lastError
}
