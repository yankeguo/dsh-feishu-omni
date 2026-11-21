import { describe, expect, it, vi } from 'vitest'
import type { FeishuMessageEvent } from '../src/events.ts'
import { createLarkGatewayFactory, type LarkSdk } from '../src/lark.ts'
import type { GatewayCallbacks } from '../src/types.ts'

function fakeSdk(responseCode = 0, reactionCode = 0) {
  const create = vi.fn(async (_args: unknown) => ({ code: responseCode }))
  const reactionCreate = vi.fn(async (_args: unknown) => ({ code: reactionCode }))
  const start = vi.fn(async () => {})
  const close = vi.fn(async () => {})
  let handler: ((event: FeishuMessageEvent) => Promise<void>) | undefined
  const clientOptions: unknown[] = []
  class Client {
    constructor(options: unknown) { clientOptions.push(options) }
    readonly im = { v1: { message: { create }, messageReaction: { create: reactionCreate } } }
  }
  class DefaultCache {}
  class WSClient {
    constructor(_options: unknown) {}
    readonly start = start
    readonly close = close
  }
  class EventDispatcher {
    constructor(_options: unknown) {}
    register(definitions: { 'im.message.receive_v1': (event: FeishuMessageEvent) => Promise<void> }) {
      handler = definitions['im.message.receive_v1']
      return this
    }
  }
  const sdk = {
    Client, WSClient, EventDispatcher, DefaultCache,
    Domain: { Feishu: 'feishu' }, LoggerLevel: { error: 'error' },
  } as unknown as LarkSdk
  return { sdk, create, reactionCreate, start, close, clientOptions, receive: (event: FeishuMessageEvent) => handler?.(event) }
}

const callbacks: GatewayCallbacks = {
  onMessage: async () => {},
  onPhase: () => {},
}

describe('official Lark gateway', () => {
  it('registers the v1 message event and sends chat_id text with a stable uuid', async () => {
    const fake = fakeSdk()
    const gateway = createLarkGatewayFactory(fake.sdk)('cli_0123456789abcdef', 'secret-fixture', callbacks)
    await gateway.start()
    expect(fake.start).toHaveBeenCalledOnce()
    const signal = new AbortController().signal
    await gateway.sendText('oc_chat', 'hello', 'dshfo_uuid', signal)
    expect(fake.create).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: 'oc_chat', msg_type: 'text', content: '{"text":"hello"}', uuid: 'dshfo_uuid' },
    })
    const options = fake.clientOptions[0] as {
      httpInstance: { defaults: { timeout: number; signal?: AbortSignal } }
      cache: unknown
    }
    expect(options.httpInstance.defaults.timeout).toBe(15_000)
    expect(options.httpInstance.defaults.signal).toBe(signal)
    expect(options.cache).toBeDefined()
    await gateway.stop()
    expect(fake.close).toHaveBeenCalledWith({ force: true })
  })

  it('rejects non-zero Feishu API responses', async () => {
    const fake = fakeSdk(230002)
    const gateway = createLarkGatewayFactory(fake.sdk)('cli_0123456789abcdef', 'secret-fixture', callbacks)
    const result = gateway.sendText('oc_chat', 'hello', 'uuid')
    await expect(result).rejects.toThrow(/230002/)
    await expect(result).rejects.toMatchObject({ code: 230002 })
  })

  it('sends assistant replies as interactive Card JSON 2.0 markdown messages', async () => {
    const fake = fakeSdk()
    const gateway = createLarkGatewayFactory(fake.sdk)('cli_0123456789abcdef', 'secret-fixture', callbacks)
    const markdown = '# 标题\n\n- 一\n- 二\n\n```ts\nconst x = 1\n```\n\n[链接](https://example.test)'
    const signal = new AbortController().signal
    await gateway.sendMarkdown('oc_chat', markdown, 'dshfo_card', signal, { title: '[助手] (1/2)' })
    expect(fake.create).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_chat',
        msg_type: 'interactive',
        content: expect.any(String),
        uuid: 'dshfo_card',
      },
    })
    const call = fake.create.mock.calls[0]?.[0] as { data: { content: string } }
    const card = JSON.parse(call.data.content) as {
      schema: string
      header: { title: { tag: string; content: string } }
      body: { elements: { tag: string; content: string }[] }
    }
    expect(card.schema).toBe('2.0')
    expect(card.header.title).toEqual({ tag: 'plain_text', content: '[助手] (1/2)' })
    expect(card.body.elements).toEqual([{ tag: 'markdown', content: markdown }])
    const options = fake.clientOptions[0] as { httpInstance: { defaults: { signal?: AbortSignal } } }
    expect(options.httpInstance.defaults.signal).toBe(signal)
  })

  it('rejects interactive card responses with a non-zero business code', async () => {
    const fake = fakeSdk(230099)
    const gateway = createLarkGatewayFactory(fake.sdk)('cli_0123456789abcdef', 'secret-fixture', callbacks)
    await expect(gateway.sendMarkdown('oc_chat', 'answer', 'uuid')).rejects.toMatchObject({ code: 230099 })
  })

  it('adds an emoji reaction to the original message through the SDK reaction API', async () => {
    const fake = fakeSdk()
    const gateway = createLarkGatewayFactory(fake.sdk)('cli_0123456789abcdef', 'secret-fixture', callbacks)
    const signal = new AbortController().signal
    await gateway.addReaction('om_original', 'OK', signal)
    expect(fake.reactionCreate).toHaveBeenCalledWith({
      path: { message_id: 'om_original' },
      data: { reaction_type: { emoji_type: 'OK' } },
    })
    expect(fake.create).not.toHaveBeenCalled()
    const options = fake.clientOptions[0] as {
      httpInstance: { defaults: { timeout: number; signal?: AbortSignal } }
      cache: unknown
    }
    expect(options.httpInstance.defaults.signal).toBe(signal)
    expect(options.cache).toBeDefined()
  })

  it('rejects non-zero reaction responses so the bridge can classify them', async () => {
    const fake = fakeSdk(0, 99991672)
    const gateway = createLarkGatewayFactory(fake.sdk)('cli_0123456789abcdef', 'secret-fixture', callbacks)
    await expect(gateway.addReaction('om_original', 'OK')).rejects.toMatchObject({ code: 99991672 })
  })
})
