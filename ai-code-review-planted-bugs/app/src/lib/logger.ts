const REDACTED_KEYS = new Set(['authorization', 'token'])

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, REDACTED_KEYS.has(k.toLowerCase()) ? '[redacted]' : redact(v)]),
    )
  }
  return value
}

function write(level: string, message: string, fields: Record<string, unknown> = {}) {
  process.stdout.write(JSON.stringify({ level, message, ...(redact(fields) as object), at: new Date().toISOString() }) + '\n')
}

export const logger = {
  info: (message: string, fields?: Record<string, unknown>) => write('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => write('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => write('error', message, fields),
}
