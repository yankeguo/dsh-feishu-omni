import { describe, expect, it } from 'vitest'
import {
  attachmentErrorClass, attachmentErrorCode, deliveryFailureKind, isRetryable, isRetryableDelivery,
  reactionFailureDetail, reactionFailureKind, safeMessage,
} from '../src/errors.ts'
import { attachmentError } from './helpers.ts'

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

  it('retries message-service rate-limit codes even when wrapped in HTTP 400', () => {
    // 11232/11233/11247 are documented as message-send rate limits that point
    // back to the frequency-control guide, so they must survive a wrapping 400.
    for (const code of [11232, 11233, 11247]) {
      expect(isRetryable({ code })).toBe(true)
      expect(isRetryable({ code, response: { status: 400 } })).toBe(true)
      expect(isRetryable({ code: 'ERR_BAD_REQUEST', response: { status: 400, data: { code } } })).toBe(true)
      expect(isRetryableDelivery({ code, response: { status: 400 } })).toBe(true)
      // The provider answered and created nothing, so the exhausted-retry
      // fallback can reuse the same UUID for plain text without duplicating.
      expect(deliveryFailureKind({ code, response: { status: 400 } })).toBe('rejected')
    }
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

  it('classifies emoji-reaction failures for throttled best-effort logging', () => {
    expect(reactionFailureKind({ code: 99991672 })).toBe('permission')
    expect(reactionFailureKind({ code: 99991679 })).toBe('permission')
    expect(reactionFailureKind({ code: 'ERR_BAD_REQUEST', response: { data: { code: 99991672 } } })).toBe('permission')
    expect(reactionFailureKind({ code: 99991400 })).toBe('rate-limit')
    expect(reactionFailureKind({ code: 230020, response: { status: 400 } })).toBe('rate-limit')
    expect(reactionFailureKind({ response: { status: 429 } })).toBe('rate-limit')
    expect(reactionFailureKind({ response: { status: 500 } })).toBe('other')
    expect(reactionFailureKind({ code: 231003 })).toBe('other')
    expect(reactionFailureKind(new Error('message was recalled'))).toBe('other')
  })
})

describe('DSH AttachmentError classification', () => {
  it('identifies stable attachment codes structurally, across package copies', () => {
    expect(attachmentErrorCode(attachmentError('IMAGE_TOO_MANY_PIXELS'))).toBe('IMAGE_TOO_MANY_PIXELS')
    // A structural object is enough: no instanceof against a duplicate package.
    expect(attachmentErrorCode({ name: 'AttachmentError', code: 'UNSUPPORTED_IMAGE_TYPE' }))
      .toBe('UNSUPPORTED_IMAGE_TYPE')
    // Wrapped causes are followed, because callers may re-wrap the failure.
    expect(attachmentErrorCode(new Error('gateway/internal', { cause: attachmentError('ATTACHMENT_WRITE_FAILED') })))
      .toBe('ATTACHMENT_WRITE_FAILED')
    // Foreign codes, plain errors and DSH RemoteErrors are never misclassified.
    expect(attachmentErrorCode(new Error('plain'))).toBeUndefined()
    expect(attachmentErrorCode(Object.assign(new Error('fs'), { code: 'ENOENT' }))).toBeUndefined()
    expect(attachmentErrorCode({
      isDSHRemoteError: true, code: 'session/attachment-invalid', details: { reason: 'IMAGE_TOO_LARGE' },
    })).toBeUndefined()
  })

  it('maps image admission codes to the specific degradation classes', () => {
    expect(attachmentErrorClass('IMAGE_TOO_LARGE')).toBe('image-bytes')
    expect(attachmentErrorClass('IMAGES_TOO_LARGE')).toBe('image-bytes')
    expect(attachmentErrorClass('IMAGE_TOO_MANY_PIXELS')).toBe('image-pixels')
    expect(attachmentErrorClass('IMAGE_DIMENSION_TOO_LARGE')).toBe('image-pixels')
    expect(attachmentErrorClass('UNSUPPORTED_IMAGE_TYPE')).toBe('unsupported-image')
    // Corrupt/type-mismatched payloads are not a format-compatibility problem.
    expect(attachmentErrorClass('INVALID_IMAGE')).toBe('invalid-image')
    expect(attachmentErrorClass('INVALID_IMAGE_BASE64')).toBe('invalid-image')
    expect(attachmentErrorClass('IMAGE_TYPE_MISMATCH')).toBe('invalid-image')
    expect(attachmentErrorClass('TOO_MANY_IMAGES')).toBe('too-many-images')
    // Storage faults keep the generic "attachment service failed" notice.
    expect(attachmentErrorClass('ATTACHMENT_WRITE_FAILED')).toBeUndefined()
    expect(attachmentErrorClass('ATTACHMENT_FILES_UNSUPPORTED')).toBeUndefined()
  })
})

describe('reaction failure detail', () => {
  it('extracts the business code, HTTP status and provider msg from an axios-style error', () => {
    const error = Object.assign(new Error('Request failed with status code 400'), {
      code: 'ERR_BAD_REQUEST',
      config: {
        url: 'https://open.feishu.cn/open-apis/im/v1/messages/om_1/reactions?app_secret=secret-fixture',
        data: '{"reaction_type":{"emoji_type":"OK"}}',
        headers: { Authorization: 'Bearer token-fixture' },
      },
      response: {
        status: 400,
        data: {
          code: 231022,
          // The provider echoes credential-shaped text: it must be redacted too.
          msg: '用户不在应用机器人的可用范围 app_secret=secret-fixture',
          error: { permission_violations: [] },
        },
      },
    })
    const detail = reactionFailureDetail(error)
    expect(detail).toBe('code=231022 status=400 msg=用户不在应用机器人的可用范围 app_secret=[redacted]')
    // Request body, credentials, headers, URLs and the raw envelope never leak.
    expect(detail).not.toContain('secret-fixture')
    expect(detail).not.toContain('token-fixture')
    expect(detail).not.toContain('reaction_type')
    expect(detail).not.toContain('https://')
    expect(detail).not.toContain('permission_violations')
  })

  it('degrades to the error message for pure network failures without response metadata', () => {
    expect(reactionFailureDetail(new Error('socket reset'))).toBe('msg=socket reset')
    const timeout = Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED' })
    expect(reactionFailureDetail(timeout)).toBe('msg=timeout of 15000ms exceeded')
    expect(reactionFailureDetail(new Error('socket reset'))).not.toContain('code=')
    expect(reactionFailureDetail(new Error('socket reset'))).not.toContain('status=')
  })

  it('flattens and truncates long provider messages', () => {
    const detail = reactionFailureDetail({
      response: { status: 400, data: { code: 231002, msg: `第一行\n第二行\t${'很长的内容'.repeat(80)}` } },
    })
    expect(detail).toContain('code=231002 status=400 msg=第一行 第二行 ')
    expect(detail).not.toMatch(/[\r\n\t]/)
    // "code=231002 status=400 msg=" is 27 chars; the bounded msg adds at most 200.
    expect(detail.length).toBe(227)
    expect(detail.endsWith('…')).toBe(true)
  })

  it('ignores non-string provider messages instead of stringifying a payload', () => {
    const detail = reactionFailureDetail({
      code: 231003,
      response: { status: 400, data: { code: 231003, msg: { text: 'payload-secret' } } },
    })
    expect(detail).toBe('code=231003 status=400 msg=unknown error')
    expect(detail).not.toContain('payload-secret')
    expect(detail).not.toContain('[object')
  })
})
