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
        label: '张三', text: '你好', attachments: [],
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

  it('collects post rich-text image nodes as image attachments', () => {
    const event = feishuEvent()
    Object.assign(event.message!, {
      message_type: 'post',
      content: JSON.stringify({
        title: '图文',
        content: [
          [{ tag: 'text', text: '看这个' }],
          [{ tag: 'img', image_key: 'img_v3_one' }, { tag: 'img', image_key: 'img_v3_two' }, { tag: 'img', image_key: 'img_v3_one' }],
        ],
      }),
    })
    const result = extractInboundMessage(event)
    expect(result.kind).toBe('message')
    if (result.kind === 'message') {
      expect(result.message.text).toBe('图文\n看这个')
      expect(result.message.attachments).toEqual([
        { type: 'image', kind: 'image', key: 'img_v3_one' },
        { type: 'image', kind: 'image', key: 'img_v3_two' },
      ])
    }
  })

  it('extracts image message content as one image attachment', () => {
    const result = extractInboundMessage(feishuEvent({
      messageType: 'image',
      content: { image_key: 'img_v3_abc' },
    }))
    expect(result).toEqual({
      kind: 'message',
      message: {
        eventId: 'event-1', messageId: 'om_1', openId: 'ou_alice', chatId: 'oc_alice',
        label: '用户 ou_alice', text: '', attachments: [{ type: 'image', kind: 'image', key: 'img_v3_abc' }],
      },
    })
  })

  it('extracts file, audio and media content as file-like attachments', () => {
    const file = extractInboundMessage(feishuEvent({
      messageType: 'file',
      content: { file_key: 'file_v3_pdf', file_name: '报告.pdf' },
    }))
    expect(file.kind).toBe('message')
    if (file.kind === 'message') {
      expect(file.message.attachments).toEqual([
        { type: 'file', kind: 'file', key: 'file_v3_pdf', name: '报告.pdf' },
      ])
    }
    const audio = extractInboundMessage(feishuEvent({
      messageType: 'audio',
      content: { file_key: 'file_v3_audio', duration: 3000 },
    }))
    expect(audio.kind).toBe('message')
    if (audio.kind === 'message') {
      expect(audio.message.attachments).toEqual([{ type: 'file', kind: 'audio', key: 'file_v3_audio' }])
    }
    const media = extractInboundMessage(feishuEvent({
      messageType: 'media',
      content: { file_key: 'file_v3_video', file_name: 'clip.mp4', duration: 3000, image_key: 'img_cover' },
    }))
    expect(media.kind).toBe('message')
    if (media.kind === 'message') {
      expect(media.message.attachments).toEqual([
        { type: 'file', kind: 'media', key: 'file_v3_video', name: 'clip.mp4' },
      ])
    }
  })

  it('ignores messages whose resource key is missing instead of admitting an empty prompt', () => {
    expect(extractInboundMessage(feishuEvent({ messageType: 'image', content: '{}' })))
      .toEqual({ kind: 'ignored', reason: 'unsupported' })
    expect(extractInboundMessage(feishuEvent({ messageType: 'file', content: { file_name: 'x.pdf' } })))
      .toEqual({ kind: 'ignored', reason: 'unsupported' })
  })

  it('ignores bots, groups, unsupported content and empty text', () => {
    expect(extractInboundMessage(feishuEvent({ senderType: 'bot' }))).toEqual({ kind: 'ignored', reason: 'bot' })
    expect(extractInboundMessage(feishuEvent({ chatType: 'group' }))).toEqual({ kind: 'ignored', reason: 'group' })
    expect(extractInboundMessage(feishuEvent({ text: '   ' }))).toEqual({ kind: 'ignored', reason: 'empty' })
    const sticker = feishuEvent({ messageType: 'sticker', content: { file_key: 'sticker_key' } })
    expect(extractInboundMessage(sticker)).toEqual({ kind: 'ignored', reason: 'unsupported' })
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
