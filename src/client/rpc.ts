/** Browser-safe management RPC helpers. No transport or React dependency lives here. */

import type {
  ConnectionPhase,
  ManagementMethod,
  ManagementPayloadMap,
  ManagementResult,
  OmniStatus,
  PublicBinding,
  PublicError,
  SessionOption,
  TestResult,
} from '../public.ts'

/** One correlated request sent through the public `/api` carrier. */
export interface ManagementRequest<M extends ManagementMethod> {
  readonly method: M
  readonly payload: ManagementPayloadMap[M]
}

/** Typed management call face injected into the settings section. */
export interface ManagementRpc {
  <M extends ManagementMethod>(
    method: M,
    payload: ManagementPayloadMap[M],
    signal: AbortSignal,
  ): Promise<ManagementResult>
}

/** Error returned by the Host, or a malformed management response. */
export class ManagementRpcError extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'ManagementRpcError'
    this.code = code
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidResponse(): never {
  throw new ManagementRpcError('Feishu Omni returned an unrecognized response.', 'feishu-omni/invalid-response')
}

/**
 * Unwrap DSH's settled Remote result without knowing a transport or UI.
 * Host-declared failures and malformed responses become typed exceptions.
 */
export function unwrapRpcResult(result: unknown): unknown {
  if (!isRecord(result) || typeof result.ok !== 'boolean') return invalidResponse()
  if (result.ok) return result.value
  const error = isRecord(result.error) ? result.error : {}
  const message = typeof error.message === 'string' && error.message.trim().length > 0
    ? error.message
    : 'Feishu Omni request failed.'
  const code = typeof error.code === 'string' && error.code.trim().length > 0
    ? error.code
    : 'feishu-omni/rpc-error'
  throw new ManagementRpcError(message, code)
}

function nullableString(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string') return invalidResponse()
  return value
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string') return invalidResponse()
  return value
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') return invalidResponse()
  return value
}

const PHASES: readonly ConnectionPhase[] = [
  'unconfigured', 'disconnected', 'connecting', 'connected', 'error',
]

function phase(value: unknown): ConnectionPhase {
  if (typeof value !== 'string' || !PHASES.includes(value as ConnectionPhase)) return invalidResponse()
  return value as ConnectionPhase
}

function publicError(value: unknown): PublicError | null {
  if (value === null) return null
  if (!isRecord(value)) return invalidResponse()
  return {
    code: requiredString(value.code),
    message: requiredString(value.message),
    at: requiredString(value.at),
  }
}

function binding(value: unknown): PublicBinding {
  if (!isRecord(value)) return invalidResponse()
  return {
    openId: requiredString(value.openId),
    chatId: requiredString(value.chatId),
    label: requiredString(value.label),
    updatedAt: requiredString(value.updatedAt),
  }
}

/** Validate the redacted Host status projection before it enters React state. */
export function parseOmniStatus(value: unknown): OmniStatus {
  if (!isRecord(value) || !Array.isArray(value.bindings)) return invalidResponse()
  return {
    appId: nullableString(value.appId),
    secretConfigured: requiredBoolean(value.secretConfigured),
    sessionId: nullableString(value.sessionId),
    autoConnect: requiredBoolean(value.autoConnect),
    phase: phase(value.phase),
    lastError: publicError(value.lastError),
    lastConnectedAt: nullableString(value.lastConnectedAt),
    bindings: value.bindings.map(binding),
  }
}

function sessionOption(value: unknown): SessionOption {
  if (!isRecord(value)) return invalidResponse()
  return {
    sessionId: requiredString(value.sessionId),
    title: requiredString(value.title),
    cwd: nullableString(value.cwd),
    running: requiredBoolean(value.running),
  }
}

/** Accept the canonical array and a wrapper useful to older Host adapters. */
export function parseSessionOptions(value: unknown): readonly SessionOption[] {
  const rows = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.sessions)
      ? value.sessions
      : invalidResponse()
  return rows.map(sessionOption)
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return invalidResponse()
  return value
}

/** Validate the aggregate delivery result of a test broadcast. */
export function parseTestResult(value: unknown): TestResult {
  if (!isRecord(value)) return invalidResponse()
  return {
    sent: nonNegativeInteger(value.sent),
    failed: nonNegativeInteger(value.failed),
  }
}
