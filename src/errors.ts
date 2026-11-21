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
  // Axios errors carry non-numeric `code`s (ERR_BAD_REQUEST, ECONNABORTED), so
  // prefer the first candidate that actually reads as a provider business code.
  for (const value of [record.code, record.response?.data?.code]) {
    const code = Number(value)
    if (Number.isSafeInteger(code) && code !== 0) return code
  }
  return undefined
}

const PERMANENT_PROVIDER_CODES = new Set([
  230002, // The bot is outside the target chat; retrying cannot restore membership.
  99991661,
  99991663,
  99991664,
])

/**
 * Rate-limit codes that must stay retryable even when the response also carries
 * an HTTP 400. Official docs: the send-message API lists HTTP 400 + `230020`
 * ("This operation triggers the frequency limit"); the generic frequency-control
 * guide uses HTTP 429 + `99991400` and notes that some legacy OpenAPIs answer
 * with HTTP 400 instead; the server error-code reference lists `11232`/`11233`/
 * `11247` as message-send rate limits and points back to the same frequency
 * guide. All of them are transient by definition, so wait-and-retry with
 * backoff is the documented remedy.
 */
const RETRYABLE_PROVIDER_CODES = new Set([
  230020, // send message: current operation triggers the frequency limit (HTTP 400)
  11232, // create message service trigger rate limit (message-service quota)
  11233, // create message chat trigger rate limit (per-chat quota)
  11247, // internal send message trigger rate limit (request frequency limit)
  99991400, // generic OpenAPI frequency limit (HTTP 429, legacy APIs HTTP 400)
])

/**
 * Business codes that reject the payload itself, so retrying the same body is
 * pointless. They still prove the server created nothing, which makes a
 * plain-text fallback safe. See the Feishu IM error-code reference.
 */
const REJECTED_PAYLOAD_PROVIDER_CODES = new Set([
  230001, // invalid request parameters
  230025, // message body exceeds the 30 KB limit
  230099, // card content creation failed (parent of table/parse/schema rejections)
])

function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const status = (error as { response?: { status?: unknown }; status?: unknown }).response?.status
    ?? (error as { status?: unknown }).status
  return typeof status === 'number' ? status : undefined
}

export function isRetryable(error: unknown): boolean {
  const code = providerCode(error)
  // Rate limiting must win over a wrapping HTTP 4xx: Feishu rate limits surface
  // as 429 + 99991400, 400 + 99991400/230020, or 400 + 11232/11233/11247, all
  // transient rather than payload rejections.
  if (code !== undefined && RETRYABLE_PROVIDER_CODES.has(code)) return true
  const status = httpStatusOf(error)
  if (status !== undefined) {
    if (status === 408 || status === 425 || status === 429) return true
    if (status >= 400 && status < 500) return false
  }
  // SDK/API token errors are refreshed by the SDK itself. A surfaced auth error
  // is terminal for this attempt and must be fixed through Settings instead.
  if (code !== undefined && PERMANENT_PROVIDER_CODES.has(code)) return false
  return true
}

/** How a failed delivery relates to the message that was already sent. */
export type DeliveryFailureKind =
  /** The provider answered with a permanent error; the message was not created. */
  | 'permanent'
  /**
   * The provider answered with a non-permanent error (payload rejection or rate
   * limit); the message was not created, so reusing its UUID is safe.
   */
  | 'rejected'
  /** No trustworthy answer (network, timeout, 5xx); the message may have landed. */
  | 'uncertain'

/**
 * Classify a send failure into the three outcomes the fallback ladder needs.
 * A Feishu business code means the server answered, so the message was not
 * created; only transport-level failures leave the outcome unknown.
 */
export function deliveryFailureKind(error: unknown): DeliveryFailureKind {
  const code = providerCode(error)
  if (code !== undefined) {
    // A business answer (including rate limits such as 230020/11232) proves the
    // server created nothing. Retryable rate-limit codes are retried first by
    // isRetryableDelivery; once those retries are exhausted the caller falls
    // back with the same UUID, which official idempotency makes duplicate-safe.
    return PERMANENT_PROVIDER_CODES.has(code) ? 'permanent' : 'rejected'
  }
  const status = httpStatusOf(error)
  if (status !== undefined) {
    if (status === 408 || status === 425 || status === 429 || status >= 500) return 'uncertain'
    if (status >= 400 && status < 500) return 'rejected'
  }
  return 'uncertain'
}

/**
 * Like {@link isRetryable}, but a rejected payload is never retried: the same
 * card JSON would fail again. The caller falls back to plain text instead.
 */
export function isRetryableDelivery(error: unknown): boolean {
  const code = providerCode(error)
  if (code !== undefined && REJECTED_PAYLOAD_PROVIDER_CODES.has(code)) return false
  return isRetryable(error)
}
