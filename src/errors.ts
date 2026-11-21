import type { PublicError } from './public.ts'

export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} }

/** Redact credential-shaped material such as `app_secret=...` or token fields. */
function redactCredentialMaterial(message: string): string {
  return message.replace(/(app_secret|appSecret|tenant_access_token)["'\s:=]+[^\s,"'}]+/gi, '$1=[redacted]')
}

/** Keep only a bounded message and explicitly redact known credential material. */
export function safeMessage(error: unknown, secrets: readonly string[] = []): string {
  let message = error instanceof Error ? error.message : String(error)
  for (const secret of secrets) {
    if (secret) message = message.replaceAll(secret, '[redacted]')
  }
  message = redactCredentialMaterial(message)
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

/**
 * Scope-class business codes. They mean the app is missing an OpenAPI scope
 * (here: `im:message.reactions:write_only` or the wider `im:message`), which is
 * fixed in the Feishu developer console plus a new app version — never by
 * retrying the same call.
 */
const PERMISSION_PROVIDER_CODES = new Set([
  99991672, // Access denied: one of the required permission scopes is not granted
  99991679, // Unauthorized: the app/tenant is not allowed to call this OpenAPI
])

/** How a failed emoji-reaction call should be reported. */
export type ReactionFailureKind =
  /** Missing app scope; the operator must grant it and publish a new version. */
  | 'permission'
  /** Frequency limit; transient by definition. */
  | 'rate-limit'
  /** Recalled message, network error, unknown business code, ... */
  | 'other'

/**
 * Classify a reaction ack failure so the bridge can log once per state change
 * and tell a missing permission apart from ordinary transient noise.
 */
export function reactionFailureKind(error: unknown): ReactionFailureKind {
  const code = providerCode(error)
  if (code !== undefined && PERMISSION_PROVIDER_CODES.has(code)) return 'permission'
  if (code !== undefined && RETRYABLE_PROVIDER_CODES.has(code)) return 'rate-limit'
  if (httpStatusOf(error) === 429) return 'rate-limit'
  return 'other'
}

/** Longest provider message kept in a failure detail; longer text is ellipsized. */
const FAILURE_DETAIL_MESSAGE_MAX = 200

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/**
 * First provider-supplied `msg` reachable from the usual error shapes. Axios
 * keeps the Feishu envelope at `response.data`, while a raw SDK response or a
 * hand-built `Object.assign` error may carry it at `data`/`msg` instead.
 * Non-string values are ignored rather than stringified: there the value would
 * be a structured payload, and payloads must never reach the Host log.
 */
function providerFailureMessage(error: unknown): string | undefined {
  const record = recordOf(error)
  if (record === undefined) return undefined
  const data = recordOf(recordOf(record.response)?.data)
  for (const value of [data?.msg, recordOf(record.data)?.msg, record.msg]) {
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

/** Scalar fallback message for errors that carry no Feishu envelope. */
function fallbackFailureMessage(error: unknown): string | undefined {
  if (error instanceof Error || typeof error === 'string') return safeMessage(error)
  const message = recordOf(error)?.message
  return typeof message === 'string' && message.trim() ? message : undefined
}

/** Flatten control characters, redact credential material, and bound the length. */
function sanitizeFailureDetailMessage(message: string): string {
  const flattened = redactCredentialMaterial(message)
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return flattened.length > FAILURE_DETAIL_MESSAGE_MAX
    ? `${flattened.slice(0, FAILURE_DETAIL_MESSAGE_MAX - 1)}…`
    : flattened
}

/**
 * Build a one-line, sanitized summary of a failed reaction call for logs:
 * `code=<business code> status=<HTTP status> msg=<provider msg>`, with absent
 * parts omitted. A bare axios `Request failed with status code 400` cannot tell
 * a recalled message (`231003`) from an out-of-range user (`231022`); the
 * business code and Feishu `msg` can.
 *
 * Only scalar fields of the error/response envelope are read. Request bodies,
 * message text, URLs with query strings, credentials and raw error objects never
 * appear: the provider `msg` is redacted and flattened, and the fallback message
 * is bounded and credential-redacted too.
 */
export function reactionFailureDetail(error: unknown): string {
  const parts: string[] = []
  const code = providerCode(error)
  if (code !== undefined) parts.push(`code=${code}`)
  const status = httpStatusOf(error)
  if (status !== undefined) parts.push(`status=${status}`)
  const rawMessage = providerFailureMessage(error) ?? fallbackFailureMessage(error)
  const message = rawMessage === undefined ? '' : sanitizeFailureDetailMessage(rawMessage)
  parts.push(`msg=${message || 'unknown error'}`)
  return parts.join(' ')
}
