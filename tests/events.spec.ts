import { describe, expect, it } from 'vitest'
import { extractInboundMessage } from '../src/events.ts'
import { feishuEvent } from './helpers.ts'

describe('Feishu event extraction', () => {
  it('extracts a direct text message and both dedupe identities', () => {
    const result = extractInboundMessage(feishuEvent({ label: '张三', text: '  你好  ' }))
    expect(result).toEqual({
      kind: 'message',
      message: {
        eventId: 'event-1', messageId: 'om_1', openId: 'ou_alice', chatId: 'oc_alice',
        label: '张三', text: '你好',
      },
    })
  })

  it('accepts header event_id and redacts only mention placeholders', () => {
    const event = feishuEvent({ text: '@_user_1 请处理 @_user_2' })
    delete event.event_id
    Object.assign(event, { header: { event_id: 'event-header' } })
    Object.assign(event.message!, { mentions: [{ key: '@_user_1' }, { key: '@_user_2' }] })
    const result = extractInboundMessage(event)
    expect(result.kind).toBe('message')
    if (result.kind === 'message') {
      expect(result.message.eventId).toBe('event-header')
      expect(result.message.text).toBe('请处理')
    }
  })

  it('extracts text from the received post shape', () => {
    const event = feishuEvent()
    Object.assign(event.message!, {
      message_type: 'post',
      content: JSON.stringify({
        title: '标题',
        content: [[{ tag: 'text', text: '第一行' }, { tag: 'a', text: '链接' }], [{ tag: 'img', image_key: 'ignored' }]],
      }),
    })
    const result = extractInboundMessage(event)
    expect(result.kind).toBe('message')
    if (result.kind === 'message') expect(result.message.text).toBe('标题\n第一行链接')
  })

  it('ignores bots, groups, unsupported content and empty text', () => {
    expect(extractInboundMessage(feishuEvent({ senderType: 'bot' }))).toEqual({ kind: 'ignored', reason: 'bot' })
    expect(extractInboundMessage(feishuEvent({ chatType: 'group' }))).toEqual({ kind: 'ignored', reason: 'group' })
    expect(extractInboundMessage(feishuEvent({ text: '   ' }))).toEqual({ kind: 'ignored', reason: 'empty' })
    const image = feishuEvent()
    Object.assign(image.message!, { message_type: 'image', content: '{}' })
    expect(extractInboundMessage(image)).toEqual({ kind: 'ignored', reason: 'unsupported' })
  })

  it('rejects malformed events instead of admitting an undeduplicatable message', () => {
    const event = feishuEvent()
    delete event.event_id
    expect(() => extractInboundMessage(event)).toThrow(/event_id/)
    Object.assign(event, { event_id: 'event-1' })
    Object.assign(event.message!, { message_id: undefined })
    expect(() => extractInboundMessage(event)).toThrow(/message_id/)
  })
})
