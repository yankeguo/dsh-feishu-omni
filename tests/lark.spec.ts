import { describe, expect, it, vi } from 'vitest'
import type { FeishuMessageEvent } from '../src/events.ts'
import { createLarkGatewayFactory, type LarkSdk } from '../src/lark.ts'
import type { GatewayCallbacks } from '../src/types.ts'

function fakeSdk(responseCode = 0) {
  const create = vi.fn(async () => ({ code: responseCode }))
  const start = vi.fn(async () => {})
  const close = vi.fn(async () => {})
  let handler: ((event: FeishuMessageEvent) => Promise<void>) | undefined
  const clientOptions: unknown[] = []
  class Client {
    constructor(options: unknown) { clientOptions.push(options) }
    readonly im = { v1: { message: { create } } }
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
  return { sdk, create, start, close, clientOptions, receive: (event: FeishuMessageEvent) => handler?.(event) }
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
})
