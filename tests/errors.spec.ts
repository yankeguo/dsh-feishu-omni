import { describe, expect, it } from 'vitest'
import { isRetryable, safeMessage } from '../src/errors.ts'

describe('error safety and retry policy', () => {
  it('redacts known secrets and token-shaped response fields', () => {
    const message = safeMessage(new Error('bad secret-fixture app_secret=secret-fixture tenant_access_token:token-fixture'), ['secret-fixture'])
    expect(message).not.toContain('secret-fixture')
    expect(message).not.toContain('token-fixture')
    expect(message).toContain('[redacted]')
  })

  it('does not retry ordinary client errors but retries rate limits and transient failures', () => {
    expect(isRetryable({ response: { status: 403 } })).toBe(false)
    expect(isRetryable({ response: { status: 429 } })).toBe(true)
    expect(isRetryable({ response: { status: 500 } })).toBe(true)
    expect(isRetryable({ code: 99991663 })).toBe(false)
    expect(isRetryable({ code: 230002 })).toBe(false)
    expect(isRetryable({ code: 230001 })).toBe(true)
    expect(isRetryable({ code: 'ERR_BAD_REQUEST', response: { data: { code: 230002 } } })).toBe(false)
    expect(isRetryable(new Error('socket reset'))).toBe(true)
  })
})
