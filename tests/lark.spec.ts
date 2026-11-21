import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { FeishuMessageEvent } from '../src/events.ts'
import { createLarkGatewayFactory, type LarkSdk } from '../src/lark.ts'
import type { GatewayCallbacks } from '../src/types.ts'

const RESOURCE_BYTES = Buffer.concat([Buffer.from('x'.repeat(64)), Buffer.alloc(20, 7)])

function fakeSdk(responseCode = 0, reactionCode = 0) {
  const create = vi.fn(async (_args: unknown) => ({ code: responseCode }))
  const reactionCreate = vi.fn(async (_args: unknown) => ({ code: reactionCode }))
  const resourceGet = vi.fn(async (_args: unknown) => ({
    writeFile: vi.fn(async () => {}),
    getReadableStream: () => Readable.from([RESOURCE_BYTES.slice(0, 64), RESOURCE_BYTES.slice(64)]),
    headers: {},
  }))
  const imageCreate = vi.fn(async (_args: unknown) => ({ image_key: 'img_key_uploaded' }))
  const fileCreate = vi.fn(async (_args: unknown) => ({ file_key: 'file_key_uploaded' }))
  const start = vi.fn(async () => {})
  const close = vi.fn(async () => {})
  let handler: ((event: FeishuMessageEvent) => Promise<void>) | undefined
  const clientOptions: unknown[] = []
  class Client {
    constructor(options: unknown) { clientOptions.push(options) }
    readonly im = {
      v1: {
        message: { create },
        messageReaction: { create: reactionCreate },
        messageResource: { get: resourceGet },
        image: { create: imageCreate },
        file: { create: fileCreate },
      },
    }
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
  return {
    sdk, create, reactionCreate, resourceGet, imageCreate, fileCreate, start, close, clientOptions,
    receive: (event: FeishuMessageEvent) => handler?.(event),
  }
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

describe('official Lark gateway attachments', () => {
  it('downloads a message resource and replays a sniffable head plus the remainder', async () => {
    const fake = fakeSdk()
    const gateway = createLarkGatewayFactory(fake.sdk)('cli_0123456789abcdef', 'secret-fixture', callbacks)
    const signal = new AbortController().signal
    const download = await gateway.downloadResource('om_original', 'img_v3_key', 'image', signal)
    expect(fake.resourceGet).toHaveBeenCalledWith({
      path: { message_id: 'om_original', file_key: 'img_v3_key' },
      params: { type: 'image' },
    })
    expect(new Uint8Array(download.head)).toEqual(new Uint8Array(RESOURCE_BYTES.slice(0, 64)))
    const chunks: Uint8Array[] = []
    for await (const chunk of download.data) chunks.push(chunk)
    expect(Buffer.concat(chunks)).toEqual(RESOURCE_BYTES)
    const options = fake.clientOptions[0] as { httpInstance: { defaults: { signal?: AbortSignal } } }
    expect(options.httpInstance.defaults.signal).toBe(signal)
  })

  it('stops buffering at the head size and streams the rest exactly once', async () => {
    const fake = fakeSdk()
    const gateway = createLarkGatewayFactory(fake.sdk)('cli_0123456789abcdef', 'secret-fixture', callbacks)
    const download = await gateway.downloadResource('om_original', 'file_v3_key', 'file')
    expect(download.head.byteLength).toBe(64)
    const chunks: Uint8Array[] = []
    for await (const chunk of download.data) chunks.push(chunk)
    expect(Buffer.concat(chunks)).toEqual(RESOURCE_BYTES)
    // Cancelling after the stream is drained is an idempotent no-op.
    await download.cancel()
    await download.cancel()
  })

  it('uploads image bytes with image_type=message and returns the image_key', async () => {
    const fake = fakeSdk()
    const gateway = createLarkGatewayFactory(fake.sdk)('cli_0123456789abcdef', 'secret-fixture', callbacks)
    const bytes = new Uint8Array([1, 2, 3])
    await expect(gateway.uploadImage(bytes)).resolves.toBe('img_key_uploaded')
    expect(fake.imageCreate).toHaveBeenCalledWith({
      data: { image_type: 'message', image: expect.any(Buffer) },
    })
    const call = fake.imageCreate.mock.calls[0]?.[0] as { data: { image: Buffer } }
    expect([...call.data.image]).toEqual([1, 2, 3])
  })

  it('rejects image uploads that return no image_key, keeping the business code', async () => {
    const fake = fakeSdk()
    fake.imageCreate.mockResolvedValueOnce({ code: 234001 } as never)
    const gateway = createLarkGatewayFactory(fake.sdk)('cli_0123456789abcdef', 'secret-fixture', callbacks)
    await expect(gateway.uploadImage(new Uint8Array([1]))).rejects.toMatchObject({ code: 234001 })
  })

  it('uploads file bytes with the documented file_type and returns the file_key', async () => {
    const fake = fakeSdk()
    const gateway = createLarkGatewayFactory(fake.sdk)('cli_0123456789abcdef', 'secret-fixture', callbacks)
    await expect(gateway.uploadFile(new Uint8Array([4, 5]), '报告.pdf', 'pdf')).resolves.toBe('file_key_uploaded')
    expect(fake.fileCreate).toHaveBeenCalledWith({
      data: { file_type: 'pdf', file_name: '报告.pdf', file: expect.any(Buffer) },
    })
  })

  it('rejects file uploads that return no file_key', async () => {
    const fake = fakeSdk()
    fake.fileCreate.mockResolvedValueOnce(null as never)
    const gateway = createLarkGatewayFactory(fake.sdk)('cli_0123456789abcdef', 'secret-fixture', callbacks)
    await expect(gateway.uploadFile(new Uint8Array([1]), 'a.bin', 'stream'))
      .rejects.toMatchObject({ reason: 'upload' })
  })

  it('sends image and file messages with the documented content JSON', async () => {
    const fake = fakeSdk()
    const gateway = createLarkGatewayFactory(fake.sdk)('cli_0123456789abcdef', 'secret-fixture', callbacks)
    await gateway.sendImage('oc_chat', 'img_key_1', 'dshfo_image')
    await gateway.sendFile('oc_chat', 'file_key_1', 'dshfo_file')
    expect(fake.create.mock.calls[0]?.[0]).toEqual({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: 'oc_chat', msg_type: 'image', content: '{"image_key":"img_key_1"}', uuid: 'dshfo_image' },
    })
    expect(fake.create.mock.calls[1]?.[0]).toEqual({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: 'oc_chat', msg_type: 'file', content: '{"file_key":"file_key_1"}', uuid: 'dshfo_file' },
    })
  })
})
