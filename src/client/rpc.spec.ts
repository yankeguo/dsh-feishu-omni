import { describe, expect, it } from 'vitest'
import {
  ManagementRpcError,
  parseOmniStatus,
  parseSessionOptions,
  parseTestResult,
  unwrapRpcResult,
} from './rpc.ts'

describe('unwrapRpcResult', () => {
  it('returns the value of a settled success', () => {
    const value = { phase: 'connected' }
    expect(unwrapRpcResult({ ok: true, value })).toBe(value)
  })

  it('preserves a Host failure code and message', () => {
    let caught: unknown
    try {
      unwrapRpcResult({ ok: false, error: { code: 'host/denied', message: 'Denied', details: {} } })
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ManagementRpcError)
    expect((caught as ManagementRpcError).code).toBe('host/denied')
    expect((caught as ManagementRpcError).message).toBe('Denied')
  })

  it('rejects malformed transport data', () => {
    expect(() => unwrapRpcResult(null)).toThrow(ManagementRpcError)
    expect(() => unwrapRpcResult({ value: {} })).toThrow('unrecognized response')
  })
})

describe('management projections', () => {
  it('validates redacted status and never adopts an unexpected secret property', () => {
    const status = parseOmniStatus({
      appId: 'cli_0123456789abcdef',
      appSecret: 'must-not-cross-the-projection',
      secretConfigured: true,
      sessionId: 'session-1',
      autoConnect: true,
      phase: 'connected',
      lastError: null,
      lastConnectedAt: '2026-01-01T00:00:00.000Z',
      bindings: [],
    })
    expect(status.secretConfigured).toBe(true)
    expect(status).not.toHaveProperty('appSecret')
  })

  it('accepts both Session list envelope shapes and validates test counts', () => {
    const session = { sessionId: 's1', title: 'One', cwd: null, running: false }
    expect(parseSessionOptions([session])).toEqual([session])
    expect(parseSessionOptions({ sessions: [session] })).toEqual([session])
    expect(parseTestResult({ sent: 2, failed: 1 })).toEqual({ sent: 2, failed: 1 })
    expect(() => parseTestResult({ sent: -1, failed: 0 })).toThrow(ManagementRpcError)
  })
})
