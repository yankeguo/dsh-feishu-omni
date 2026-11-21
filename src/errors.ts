import type { PublicError } from './public.ts'

export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} }

/** Keep only a bounded message and explicitly redact known credential material. */
export function safeMessage(error: unknown, secrets: readonly string[] = []): string {
  let message = error instanceof Error ? error.message : String(error)
  for (const secret of secrets) {
    if (secret) message = message.replaceAll(secret, '[redacted]')
  }
  message = message.replace(/(app_secret|appSecret|tenant_access_token)["'\s:=]+[^\s,"'}]+/gi, '$1=[redacted]')
  if (!message.trim()) return 'Unknown error'
  return message.length > 500 ? `${message.slice(0, 497)}…` : message
}

export function publicError(error: unknown, now: () => Date, secrets: readonly string[] = []): PublicError {
  const code = typeof error === 'object' && error !== null && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'feishu-omni/error'
  return { code, message: safeMessage(error, secrets), at: now().toISOString() }
}

export function providerCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const record = error as { code?: unknown; response?: { data?: { code?: unknown } } }
  const value = record.code ?? record.response?.data?.code
  const code = Number(value)
  return Number.isSafeInteger(code) && code !== 0 ? code : undefined
}

export function isRetryable(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    const status = (error as { response?: { status?: unknown }; status?: unknown }).response?.status
      ?? (error as { status?: unknown }).status
    if (typeof status === 'number') {
      if (status === 408 || status === 425 || status === 429) return true
      if (status >= 400 && status < 500) return false
    }
  }
  // SDK/API token errors are refreshed by the SDK itself. A surfaced auth error
  // is terminal for this attempt and must be fixed through Settings instead.
  const code = providerCode(error)
  if (code === 99991661 || code === 99991663 || code === 99991664) return false
  return true
}
