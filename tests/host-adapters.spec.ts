import type { Context } from '@deepseek-ai/cordis'
import type { SessionPromptRequest } from '@deepseek-ai/dsh-api-session-controller'
import { describe, expect, it, vi } from 'vitest'
import { DshAttachmentPort, DshFileUploadPort, DshSessionPort } from '../src/host-adapters.ts'

describe('DshSessionPort', () => {
  it('lists ordinary Sessions with display titles and submits queue prompts with request identity', async () => {
    const prompt = vi.fn(async (_request: SessionPromptRequest, _signal: AbortSignal) => ({ accepted: true as const }))
    const ctx = {
      sessionController: {
        list: async () => ({
          items: [
            { sessionId: 'session-a', running: true, cwd: '/work/a', projections: { values: { title: 'Lead' } } },
            { sessionId: 'session-child', running: false, origin: 'subagent', projections: { values: {} } },
          ],
        }),
        prompt,
      },
    } as unknown as Context
    const port = new DshSessionPort(ctx)
    expect(await port.list()).toEqual([{ sessionId: 'session-a', title: 'Lead', cwd: '/work/a', running: true }])
    await port.prompt({ sessionId: 'session-a', requestId: 'feishu-omni:om_1', text: '[飞书 · Alice]\nhello' })
    expect(prompt).toHaveBeenCalledOnce()
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'session-a', requestId: 'feishu-omni:om_1', mode: 'queue',
      content: [{ type: 'text', text: '[飞书 · Alice]\nhello' }],
    })
  })

  it('appends staged receipts after the text part, making images and files native blocks', async () => {
    const prompt = vi.fn(async (_request: SessionPromptRequest, _signal: AbortSignal) => ({ accepted: true as const }))
    const ctx = {
      sessionController: { list: async () => ({ items: [] }), prompt },
    } as unknown as Context
    const port = new DshSessionPort(ctx)
    await port.prompt({
      sessionId: 'session-a',
      requestId: 'feishu-omni:om_1:oc_a',
      text: '[飞书 · Alice]\n（图片）',
      attachments: [{ receiptId: 'receipt-image-1' }, { receiptId: 'receipt-file-2' }],
    })
    const request = prompt.mock.calls[0]?.[0] as SessionPromptRequest
    expect(request.content).toEqual([
      { type: 'text', text: '[飞书 · Alice]\n（图片）' },
      { type: 'file', receiptId: 'receipt-image-1' },
      { type: 'file', receiptId: 'receipt-file-2' },
    ])
  })
})

function fakeCtx(services: Record<string, unknown>): Context {
  return {
    get: (name: string) => services[name],
    sessionController: {
      list: async () => ({ items: [] }),
      prompt: async () => ({ accepted: true as const }),
    },
  } as unknown as Context
}


describe('DshFileUploadPort', () => {
  it('forwards image staging requests and maps the receipt plus normalized image', async () => {
    const uploadImageStream = vi.fn(async (_request: unknown) => ({ receiptId: 'receipt-1', image: { ref: 'img' } }))
    const port = DshFileUploadPort.from(fakeCtx({ fileUploads: { uploadImageStream, uploadStream: vi.fn() } }))
    expect(port).toBeDefined()
    const signal = new AbortController().signal
    const staged = await port!.uploadImageStream({
      sessionId: 'session-a',
      data: (async function* (): AsyncIterable<Uint8Array> { yield new Uint8Array([1, 2]) })(),
      mediaType: 'image/png',
      name: 'image.png',
      signal,
    })
    expect(staged).toEqual({ receiptId: 'receipt-1', image: { ref: 'img' } })
    expect(uploadImageStream).toHaveBeenCalledWith({
      sessionId: 'session-a',
      data: expect.anything(),
      mediaType: 'image/png',
      name: 'image.png',
      signal,
    })
  })

  it('forwards file staging requests and maps the receipt only', async () => {
    const uploadStream = vi.fn(async (_request: unknown) => ({ receiptId: 'receipt-2' }))
    const port = DshFileUploadPort.from(fakeCtx({ fileUploads: { uploadImageStream: vi.fn(), uploadStream } }))
    const staged = await port!.uploadStream({
      sessionId: 'session-a',
      data: (async function* (): AsyncIterable<Uint8Array> { yield new Uint8Array([3]) })(),
      name: 'a.pdf',
    })
    expect(staged).toEqual({ receiptId: 'receipt-2' })
    expect(uploadStream).toHaveBeenCalledWith({
      sessionId: 'session-a', data: expect.anything(), name: 'a.pdf',
    })
  })

  it('stays absent when the composition has no service and fails cleanly if it disappears later', async () => {
    expect(DshFileUploadPort.from(fakeCtx({}))).toBeUndefined()
    const services: Record<string, unknown> = {
      fileUploads: { uploadImageStream: vi.fn(), uploadStream: vi.fn() },
    }
    const port = DshFileUploadPort.from(fakeCtx(services))
    delete services.fileUploads
    await expect(port!.uploadStream({
      sessionId: 'session-a',
      data: (async function* (): AsyncIterable<Uint8Array> { yield new Uint8Array() })(),
    })).rejects.toThrow(/unavailable/)
  })
})

describe('DshAttachmentPort', () => {
  it('forwards saveImage and readImage through ctx.get each call', async () => {
    const saveImage = vi.fn(async (_input: unknown) => ({ ref: 'saved' }))
    const readImage = vi.fn(async (_ref: unknown, _signal?: AbortSignal) => ({ data: new Uint8Array([7]) }))
    const services: Record<string, unknown> = { attachments: { saveImage, readImage } }
    const port = DshAttachmentPort.from(fakeCtx(services))
    expect(port).toBeDefined()
    await expect(port!.saveImage({ data: new Uint8Array([1]), mediaType: 'image/png' })).resolves.toEqual({ ref: 'saved' })
    await expect(port!.readImage({ ref: 'saved' })).resolves.toEqual({ data: new Uint8Array([7]) })
    expect(saveImage).toHaveBeenCalledWith({ data: new Uint8Array([1]), mediaType: 'image/png' })
    expect(readImage).toHaveBeenCalledWith({ ref: 'saved' }, undefined)
    expect(DshAttachmentPort.from(fakeCtx({}))).toBeUndefined()
  })
})
