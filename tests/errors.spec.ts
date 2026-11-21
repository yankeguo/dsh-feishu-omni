import { describe, expect, it } from 'vitest'
import { deliveryFailureKind, isRetryable, isRetryableDelivery, safeMessage } from '../src/errors.ts'

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

  it('treats legacy 400-wrapped rate limits as retryable', () => {
    expect(isRetryable({ code: 99991400, response: { status: 400 } })).toBe(true)
    expect(isRetryable({ code: 230020, response: { status: 400 } })).toBe(true)
    expect(isRetryableDelivery({ code: 99991400, response: { status: 400 } })).toBe(true)
  })

  it('classifies delivery failures for the card fallback ladder', () => {
    expect(deliveryFailureKind({ code: 230002 })).toBe('permanent')
    expect(deliveryFailureKind({ code: 230099 })).toBe('rejected')
    expect(deliveryFailureKind({ code: 230025 })).toBe('rejected')
    expect(deliveryFailureKind({ response: { status: 403 } })).toBe('rejected')
    expect(deliveryFailureKind({ response: { status: 500 } })).toBe('uncertain')
    expect(deliveryFailureKind({ response: { status: 429 } })).toBe('uncertain')
    expect(deliveryFailureKind(new Error('socket reset'))).toBe('uncertain')
    expect(deliveryFailureKind({ code: 'ERR_BAD_REQUEST', response: { data: { code: 230002 } } })).toBe('permanent')
  })

  it('never retries a card payload that Feishu rejected but retries transient codes', () => {
    expect(isRetryableDelivery({ code: 230099 })).toBe(false)
    expect(isRetryableDelivery({ code: 230025 })).toBe(false)
    expect(isRetryableDelivery({ code: 230020 })).toBe(true)
    expect(isRetryableDelivery(new Error('timeout'))).toBe(true)
    expect(isRetryableDelivery({ code: 230002 })).toBe(false)
  })
})
