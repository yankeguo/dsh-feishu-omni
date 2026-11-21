import { describe, expect, it, vi } from 'vitest'
import { AttachmentFailure } from '../src/attachments.ts'
import { ACK_EMOJI, OmniBridge } from '../src/bridge.ts'
import { emptyState, MemoryStateStore } from '../src/state.ts'
import type { Binding, AttachmentPort, FileUploadPort } from '../src/types.ts'
import {
  FakeAttachments, FakeFileUploads, FakeGateway, FakeSessions, feishuEvent, GIF_BYTES, HEIC_BYTES,
  JPEG_BYTES, PNG_BYTES, SESSION,
} from './helpers.ts'

const alice: Binding = { openId: 'ou_alice', chatId: 'oc_alice', label: 'Alice', createdAt: '2026-01-01', updatedAt: '2026-01-01' }
const bob: Binding = { openId: 'ou_bob', chatId: 'oc_bob', label: 'Bob', createdAt: '2026-01-01', updatedAt: '2026-01-01' }

interface SetupOptions {
  readonly bindings?: readonly Binding[]
  readonly fileUploads?: FakeFileUploads | null
  readonly attachments?: FakeAttachments | null
  readonly attachmentTimeoutMs?: number
}

function setup(options: SetupOptions = {}) {
  const state = new MemoryStateStore({
    ...emptyState(),
    sessionId: SESSION.sessionId,
    bindings: options.bindings ?? [],
  })
  const sessions = new FakeSessions()
  const gateway = new FakeGateway()
  const fileUploads = options.fileUploads === null ? undefined : options.fileUploads ?? new FakeFileUploads()
  const attachments = options.attachments === null ? undefined : options.attachments ?? new FakeAttachments()
  const errors: unknown[] = []
  const logs: { level: 'info' | 'warn' | 'error'; message: string }[] = []
  const logger = {
    info: (message: string) => { logs.push({ level: 'info', message }) },
    warn: (message: string) => { logs.push({ level: 'warn', message }) },
    error: (message: string) => { logs.push({ level: 'error', message }) },
  }
  const bridge = new OmniBridge({
    state, sessions, gateway, logger,
    retry: { attempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
    sleep: async () => {},
    onError: error => errors.push(error),
    ...(options.attachmentTimeoutMs === undefined ? {} : { attachmentTimeoutMs: options.attachmentTimeoutMs }),
    ...(fileUploads === undefined ? {} : { fileUploads: fileUploads as FileUploadPort }),
    ...(attachments === undefined ? {} : { attachments: attachments as AttachmentPort }),
  })
  return { state, sessions, gateway, fileUploads, attachments, bridge, errors, logs }
}

function imageEvent(overrides: Parameters<typeof feishuEvent>[0] & { key?: string } = {}) {
  const { key = 'img_v3_1', ...rest } = overrides
  return feishuEvent({ ...rest, messageType: 'image', content: { image_key: key } })
}

describe('OmniBridge inbound images', () => {
  it('downloads, stages through DSH and prompts with a native image receipt', async () => {
    const { bridge, sessions, gateway, fileUploads, state } = setup()
    gateway.downloads.set('img_v3_1', PNG_BYTES)
    await bridge.receive(imageEvent({ label: '张三' }))
    await bridge.drain()

    expect(gateway.downloadRequests).toMatchObject([
      { messageId: 'om_1', fileKey: 'img_v3_1', type: 'image' },
    ])
    expect(fileUploads?.imageUploads).toHaveLength(1)
    expect(fileUploads?.imageUploads[0]).toMatchObject({ sessionId: SESSION.sessionId, mediaType: 'image/png', name: 'image.png' })
    expect(fileUploads?.imageUploads[0]?.bytes).toEqual(new Uint8Array(PNG_BYTES))
    expect(sessions.prompts).toEqual([{
      sessionId: SESSION.sessionId,
      requestId: 'feishu-omni:om_1:oc_alice',
      text: '[飞书 · 张三]\n（图片）',
      attachments: [{ receiptId: 'receipt-image-1' }],
    }])
    expect(gateway.reactionAttempts).toEqual([{ messageId: 'om_1', emojiType: ACK_EMOJI }])
    expect(state.snapshot().recentEventIds).toEqual(['message:om_1', 'event:event-1'])
  })

  it.each([
    ['JPEG', JPEG_BYTES, 'image/jpeg'],
    ['GIF', GIF_BYTES, 'image/gif'],
  ])('accepts %s image bytes and keeps the detected media type', async (_label, bytes, mediaType) => {
    const { bridge, fileUploads, gateway } = setup()
    gateway.downloads.set('img_v3_1', bytes)
    await bridge.receive(imageEvent())
    await bridge.drain()
    expect(fileUploads?.imageUploads[0]?.mediaType).toBe(mediaType)
  })

  it('stages every post rich-text image and keeps the caption as prompt text', async () => {
    const { bridge, sessions, gateway, fileUploads } = setup()
    gateway.downloads.set('img_v3_one', PNG_BYTES)
    gateway.downloads.set('img_v3_two', GIF_BYTES)
    await bridge.receive(feishuEvent({
      label: '张三',
      messageType: 'post',
      content: {
        title: '图文',
        content: [[{ tag: 'text', text: '看这个' }], [{ tag: 'img', image_key: 'img_v3_one' }, { tag: 'img', image_key: 'img_v3_two' }]],
      },
    }))
    await bridge.drain()
    expect(fileUploads?.imageUploads).toHaveLength(2)
    expect(sessions.prompts[0]?.text).toBe('[飞书 · 张三]\n图文\n看这个\n（图片）\n（图片）')
    expect(sessions.prompts[0]?.attachments).toEqual([
      { receiptId: 'receipt-image-1' },
      { receiptId: 'receipt-image-2' },
    ])
  })

  it('degrades an unsupported image format to a specific text notice without prompting or acking', async () => {
    const { bridge, sessions, gateway, logs } = setup()
    gateway.downloads.set('img_v3_1', HEIC_BYTES)
    await bridge.receive(imageEvent())
    await bridge.drain()
    expect(sessions.prompts).toEqual([])
    expect(gateway.reactionAttempts).toEqual([])
    expect(gateway.sent).toHaveLength(1)
    expect(gateway.sent[0]?.chatId).toBe('oc_alice')
    expect(gateway.sent[0]?.text).toContain('HEIC')
    expect(gateway.sent[0]?.text).toContain('PNG/JPEG')
    expect(logs.some(log => log.level === 'warn' && log.message.includes('degraded'))).toBe(true)
  })

  it('degrades an oversize inbound image before staging it', async () => {
    const { bridge, sessions, gateway, fileUploads } = setup()
    gateway.downloads.set('img_v3_1', Buffer.concat([PNG_BYTES, Buffer.alloc(20 * 1024 * 1024)]))
    await bridge.receive(imageEvent())
    await bridge.drain()
    expect(sessions.prompts).toEqual([])
    expect(fileUploads?.imageUploads).toEqual([])
    expect(gateway.reactionAttempts).toEqual([])
    expect(gateway.sent[0]?.text).toContain('超过大小限制')
  })

  it('degrades a failed download to a text notice', async () => {
    const { bridge, sessions, gateway } = setup()
    gateway.downloadFailures.set('img_v3_1', [new Error('network down')])
    await bridge.receive(imageEvent())
    await bridge.drain()
    expect(sessions.prompts).toEqual([])
    expect(gateway.reactionAttempts).toEqual([])
    expect(gateway.sent[0]?.text).toContain('下载失败')
  })

  it('degrades when the Host composition has no attachment service', async () => {
    const { bridge, sessions, gateway } = setup({ fileUploads: null })
    gateway.downloads.set('img_v3_1', PNG_BYTES)
    await bridge.receive(imageEvent())
    await bridge.drain()
    expect(sessions.prompts).toEqual([])
    expect(gateway.reactionAttempts).toEqual([])
    expect(gateway.sent[0]?.text).toContain('附件服务')
  })

  it('degrades a DSH attachment rejection (model without image input) without retrying', async () => {
    const { bridge, sessions, gateway, state, errors } = setup()
    let calls = 0
    sessions.promptHook = async () => {
      calls += 1
      throw Object.assign(new Error('Model "x" does not support image input.'), {
        isDSHRemoteError: true,
        code: 'session/attachment-invalid',
        details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
      })
    }
    gateway.downloads.set('img_v3_1', PNG_BYTES)
    await bridge.receive(imageEvent())
    await bridge.drain()
    // Terminal payload rejection: exactly one admission attempt, no ack.
    expect(calls).toBe(1)
    expect(gateway.reactionAttempts).toEqual([])
    expect(gateway.sent[0]?.text).toContain('模型不支持图片输入')
    expect(errors).toEqual([])
    // The notice path records the dedupe keys so a redelivery cannot spam.
    expect(state.snapshot().recentEventIds).toContain('message:om_1')
  })

  it('keeps the generic delivery notice for a transport-level prompt failure', async () => {
    const { bridge, sessions, gateway, errors } = setup()
    sessions.promptHook = async () => { throw new Error('Session is unavailable') }
    gateway.downloads.set('img_v3_1', PNG_BYTES)
    await bridge.receive(imageEvent())
    await bridge.drain()
    expect(gateway.sent[0]?.text).toContain('暂时无法投递')
    expect(errors).toHaveLength(1)
    expect(gateway.reactionAttempts).toEqual([])
  })

  it('deduplicates a redelivered image message across download, staging, prompt and ack', async () => {
    const { bridge, sessions, gateway, fileUploads } = setup()
    gateway.downloads.set('img_v3_1', PNG_BYTES)
    await bridge.receive(imageEvent())
    await bridge.receive(imageEvent({ eventId: 'event-2' }))
    await bridge.drain()
    expect(gateway.downloadRequests).toHaveLength(1)
    expect(fileUploads?.imageUploads).toHaveLength(1)
    expect(sessions.prompts).toHaveLength(1)
    expect(gateway.reactionAttempts).toHaveLength(1)
  })

  it('cancels a stalled download when the bridge stops without marking the message seen', async () => {
    const { bridge, gateway, state } = setup({ attachmentTimeoutMs: 60_000 })
    gateway.downloadHandles.set('img_v3_1', () => ({
      head: new Uint8Array(PNG_BYTES),
      data: (async function* stalled(): AsyncIterable<Uint8Array> {
        await new Promise<void>(() => {})
        yield new Uint8Array()
      })(),
      cancel: async () => {},
    }))
    await bridge.receive(imageEvent())
    await vi.waitFor(() => expect(gateway.downloadRequests).toHaveLength(1))
    const downloadSignal = gateway.downloadRequests[0]?.signal
    await bridge.stop()
    await bridge.drain()
    expect(gateway.stops).toBe(1)
    // The in-flight download is cancelled through the same lifecycle signal.
    expect(downloadSignal?.aborted).toBe(true)
    // Shutdown is not a terminal payload failure: a restart may retry this event.
    expect(state.snapshot().recentEventIds).toEqual([])
    expect(gateway.reactionAttempts).toEqual([])
  })

  it('degrades before buffering when Content-Length exceeds the image bound', async () => {
    const { bridge, gateway, sessions } = setup()
    let consumed = false
    let cancelled = false
    gateway.downloadHandles.set('img_v3_1', () => ({
      head: new Uint8Array(PNG_BYTES),
      size: 20 * 1024 * 1024 + 1,
      data: (async function* body(): AsyncIterable<Uint8Array> {
        consumed = true
        yield new Uint8Array()
      })(),
      cancel: async () => { cancelled = true },
    }))
    await bridge.receive(imageEvent())
    await bridge.drain()
    expect(consumed).toBe(false)
    expect(cancelled).toBe(true)
    expect(sessions.prompts).toEqual([])
    expect(gateway.sent[0]?.text).toContain('超过大小限制')
  })

  it('rejects an unsupported image from the sniffed head before reading the body', async () => {
    const { bridge, gateway, sessions } = setup()
    let consumed = false
    gateway.downloadHandles.set('img_v3_1', () => ({
      head: new Uint8Array(HEIC_BYTES),
      size: HEIC_BYTES.byteLength,
      data: (async function* body(): AsyncIterable<Uint8Array> {
        consumed = true
        yield HEIC_BYTES
      })(),
      cancel: async () => {},
    }))
    await bridge.receive(imageEvent())
    await bridge.drain()
    expect(consumed).toBe(false)
    expect(sessions.prompts).toEqual([])
    expect(gateway.sent[0]?.text).toContain('HEIC')
  })

  it('preserves a DSH size rejection wrapped by the upload service', async () => {
    const { bridge, fileUploads, gateway, sessions } = setup()
    gateway.downloads.set('file_v3_1', Buffer.from('x'))
    fileUploads?.failures.push(Object.assign(new Error('failed to store file upload'), {
      isDSHRemoteError: true,
      code: 'gateway/internal',
      cause: new AttachmentFailure('Feishu file download exceeded the limit', 'too-large'),
    }))
    await bridge.receive(feishuEvent({ messageType: 'file', content: { file_key: 'file_v3_1', file_name: 'a.bin' } }))
    await bridge.drain()
    expect(sessions.prompts).toEqual([])
    expect(gateway.sent[0]?.text).toContain('超过大小限制')
  })

  it('degrades a message carrying too many attachments', async () => {
    const { bridge, gateway, sessions } = setup()
    const images = Array.from({ length: 21 }, (_, index) => ({ tag: 'img', image_key: `img_v3_${index}` }))
    await bridge.receive(feishuEvent({
      messageType: 'post',
      content: { title: 't', content: [[{ tag: 'text', text: 'many' }], images] },
    }))
    await bridge.drain()
    expect(gateway.downloadRequests).toEqual([])
    expect(sessions.prompts).toEqual([])
    expect(gateway.sent[0]?.text).toContain('附件过多')
  })

  it('explains a download permission failure with the required scope', async () => {
    const { bridge, gateway, sessions } = setup()
    gateway.downloadFailures.set('img_v3_1', [Object.assign(new Error('no scope'), { code: 99991672 })])
    await bridge.receive(imageEvent())
    await bridge.drain()
    expect(sessions.prompts).toEqual([])
    expect(gateway.sent[0]?.text).toContain('im:message:readonly')
  })

  it('degrades an attachment whose download stalls past the attachment timeout', async () => {
    const { bridge, gateway, sessions } = setup({ attachmentTimeoutMs: 20 })
    gateway.downloadHandles.set('file_v3_1', () => ({
      head: new Uint8Array([1, 2, 3]),
      data: (async function* stalled(): AsyncIterable<Uint8Array> {
        await new Promise<void>(() => {})
        yield new Uint8Array()
      })(),
      cancel: async () => {},
    }))
    await bridge.receive(feishuEvent({ messageType: 'file', content: { file_key: 'file_v3_1', file_name: 'a.bin' } }))
    await bridge.drain()
    expect(sessions.prompts).toEqual([])
    expect(gateway.sent[0]?.text).toContain('超时')
  })
})

describe('OmniBridge inbound files', () => {
  it('streams a file into the attachment service and prompts with a file receipt', async () => {
    const { bridge, sessions, gateway, fileUploads } = setup()
    const bytes = Buffer.from('%PDF-1.7 fixture')
    gateway.downloads.set('file_v3_1', bytes)
    await bridge.receive(feishuEvent({
      label: '张三',
      messageType: 'file',
      content: { file_key: 'file_v3_1', file_name: '报告.pdf' },
    }))
    await bridge.drain()
    expect(gateway.downloadRequests).toMatchObject([
      { messageId: 'om_1', fileKey: 'file_v3_1', type: 'file' },
    ])
    expect(fileUploads?.fileUploads[0]).toMatchObject({ sessionId: SESSION.sessionId, name: '报告.pdf' })
    expect(fileUploads?.fileUploads[0]?.bytes).toEqual(new Uint8Array(bytes))
    expect(sessions.prompts[0]).toMatchObject({
      text: '[飞书 · 张三]\n（文件：报告.pdf）',
      attachments: [{ receiptId: 'receipt-file-1' }],
    })
    expect(gateway.reactionAttempts).toEqual([{ messageId: 'om_1', emojiType: ACK_EMOJI }])
  })

  it('accepts audio and media messages as file-like attachments', async () => {
    const { bridge, sessions, gateway, fileUploads } = setup()
    gateway.downloads.set('file_v3_audio', Buffer.from('audio-bytes'))
    gateway.downloads.set('file_v3_video', Buffer.from('video-bytes'))
    await bridge.receive(feishuEvent({ messageType: 'audio', content: { file_key: 'file_v3_audio', duration: 3000 } }))
    await bridge.receive(feishuEvent({
      eventId: 'event-2', messageId: 'om_2',
      messageType: 'media',
      content: { file_key: 'file_v3_video', file_name: 'clip.mp4', duration: 3000, image_key: 'img_cover' },
    }))
    await bridge.drain()
    expect(fileUploads?.fileUploads.map(upload => upload.name)).toEqual(['audio.opus', 'clip.mp4'])
    expect(sessions.prompts.map(input => input.text)).toEqual([
      '[飞书 · 用户 ou_alice]\n（音频）',
      '[飞书 · 用户 ou_alice]\n（视频：clip.mp4）',
    ])
  })

  it('degrades a failed file staging attempt and releases the download stream', async () => {
    const { bridge, sessions, gateway, fileUploads } = setup()
    gateway.downloads.set('file_v3_1', Buffer.from('data'))
    fileUploads?.failures.push(new Error('attachment store unavailable'))
    await bridge.receive(feishuEvent({ messageType: 'file', content: { file_key: 'file_v3_1', file_name: 'a.bin' } }))
    await bridge.drain()
    expect(sessions.prompts).toEqual([])
    expect(gateway.reactionAttempts).toEqual([])
    expect(gateway.sent[0]?.text).toContain('附件服务')
    // The failure path releases the download handle (best effort, idempotent)
    // and never re-prompts the Session.
    expect(gateway.downloadCancels).toEqual(['file_v3_1'])
  })
})

describe('OmniBridge inbound attachment mirror', () => {
  it('sends the image to other bindings but never echoes it to the sender', async () => {
    const { bridge, gateway } = setup({ bindings: [alice, bob] })
    gateway.downloads.set('img_v3_1', PNG_BYTES)
    await bridge.receive(imageEvent())
    await bridge.drain()
    // Prompt admission and ack happen exactly once.
    expect(gateway.reactionAttempts).toHaveLength(1)
    // One Feishu upload shared by every other binding.
    expect(gateway.imageUploads).toHaveLength(1)
    expect(Buffer.from(gateway.imageUploads[0]?.bytes ?? [])).toEqual(PNG_BYTES)
    expect(gateway.images).toHaveLength(1)
    expect(gateway.images[0]).toMatchObject({ chatId: 'oc_bob', imageKey: 'img_key_1' })
    expect(gateway.images[0]?.uuid).toMatch(/^dshfo_[0-9a-f]{40}$/)
    expect(gateway.sent).toEqual([])
  })

  it('mirrors a file with a Feishu file type derived from the name', async () => {
    const { bridge, gateway } = setup({ bindings: [alice, bob] })
    gateway.downloads.set('file_v3_1', Buffer.from('%PDF'))
    await bridge.receive(feishuEvent({ messageType: 'file', content: { file_key: 'file_v3_1', file_name: '报告.pdf' } }))
    await bridge.drain()
    expect(gateway.uploadedFileRequests).toMatchObject([
      { name: '报告.pdf', fileType: 'pdf' },
    ])
    expect(Buffer.from(gateway.uploadedFileRequests[0]?.bytes ?? [])).toEqual(Buffer.from('%PDF'))
    expect(gateway.files).toHaveLength(1)
    expect(gateway.files[0]).toMatchObject({ chatId: 'oc_bob', fileKey: 'file_key_1' })
  })

  it('falls back to a placeholder text when the mirror upload fails, without failing the prompt', async () => {
    const { bridge, gateway, sessions } = setup({ bindings: [alice, bob] })
    gateway.downloads.set('img_v3_1', PNG_BYTES)
    // Exhaust the upload retry ladder with a permanent-looking failure.
    gateway.imageUploadFailures.push(
      Object.assign(new Error('missing im:resource scope'), { code: 99991672 }),
      Object.assign(new Error('missing im:resource scope'), { code: 99991672 }),
      Object.assign(new Error('missing im:resource scope'), { code: 99991672 }),
    )
    await bridge.receive(imageEvent())
    await bridge.drain()
    expect(sessions.prompts).toHaveLength(1)
    expect(gateway.reactionAttempts).toHaveLength(1)
    expect(gateway.images).toEqual([])
    expect(gateway.sent).toEqual([{ chatId: 'oc_bob', text: '[图片]', uuid: expect.stringMatching(/^dshfo_/) }])
  })

  it('retries a transient mirror send failure before giving up', async () => {
    const { bridge, gateway } = setup({ bindings: [alice, bob] })
    gateway.downloads.set('img_v3_1', PNG_BYTES)
    gateway.imageSendFailures.set('oc_bob', [Object.assign(new Error('rate limited'), { code: 230020 })])
    await bridge.receive(imageEvent())
    await bridge.drain()
    expect(gateway.imageAttempts.filter(row => row.chatId === 'oc_bob')).toHaveLength(2)
    expect(gateway.images.map(row => row.chatId)).toEqual(['oc_bob'])
    expect(gateway.sent).toEqual([])
  })

  it('falls back to placeholder text with the same uuid when mirror delivery keeps failing', async () => {
    const { bridge, gateway } = setup({ bindings: [alice, bob] })
    gateway.downloads.set('img_v3_1', PNG_BYTES)
    gateway.imageSendFailures.set('oc_bob', [Object.assign(new Error('bot removed'), { code: 230002 })])
    await bridge.receive(imageEvent())
    await bridge.drain()
    expect(gateway.images).toEqual([])
    const attempt = gateway.imageAttempts.find(row => row.chatId === 'oc_bob')
    expect(gateway.sent).toEqual([{ chatId: 'oc_bob', text: '[图片]', uuid: attempt?.uuid }])
  })

  it('logs a mirror delivery failure without affecting the other binding', async () => {
    const carol: Binding = { openId: 'ou_carol', chatId: 'oc_carol', label: 'Carol', createdAt: '2026-01-01', updatedAt: '2026-01-01' }
    const { bridge, gateway, logs } = setup({ bindings: [alice, bob, carol] })
    gateway.downloads.set('img_v3_1', PNG_BYTES)
    gateway.imageSendFailures.set('oc_bob', [Object.assign(new Error('bot removed'), { code: 230002 })])
    await bridge.receive(imageEvent())
    await bridge.drain()
    expect(gateway.images.map(row => row.chatId)).toEqual(['oc_carol'])
    expect(logs.some(log => log.level === 'warn' && log.message.includes('mirror delivery failed'))).toBe(true)
  })

  it('uses the DSH-normalized image when the raw image exceeds the Feishu upload bound', async () => {
    const { bridge, gateway, attachments } = setup({ bindings: [alice, bob] })
    const raw = Buffer.concat([PNG_BYTES, Buffer.alloc(11 * 1024 * 1024)])
    gateway.downloads.set('img_v3_1', raw)
    if (attachments !== undefined) attachments.readImageBytes = PNG_BYTES
    await bridge.receive(imageEvent())
    await bridge.drain()
    // Raw bytes are too large for Feishu; the normalized prompt image is reused.
    expect(attachments?.readImageRefs).toEqual([{ ref: 'normalized:image/png' }])
    expect(Buffer.from(gateway.imageUploads[0]?.bytes ?? [])).toEqual(PNG_BYTES)
    expect(gateway.images).toHaveLength(1)
  })

  it('produces deterministic per-chat UUIDs across identical deliveries', async () => {
    const first = setup({ bindings: [alice, bob] })
    first.gateway.downloads.set('img_v3_1', PNG_BYTES)
    await first.bridge.receive(imageEvent())
    await first.bridge.drain()
    const second = setup({ bindings: [alice, bob] })
    second.gateway.downloads.set('img_v3_1', PNG_BYTES)
    await second.bridge.receive(imageEvent())
    await second.bridge.drain()
    expect(first.gateway.images[0]?.uuid).toBe(second.gateway.images[0]?.uuid)
  })

  it('gives each attachment of one message its own deterministic uuid', async () => {
    const { bridge, gateway } = setup({ bindings: [alice, bob] })
    gateway.downloads.set('img_v3_one', PNG_BYTES)
    gateway.downloads.set('img_v3_two', GIF_BYTES)
    await bridge.receive(feishuEvent({
      messageType: 'post',
      content: { content: [[{ tag: 'img', image_key: 'img_v3_one' }, { tag: 'img', image_key: 'img_v3_two' }]] },
    }))
    await bridge.drain()
    const uuids = gateway.imageAttempts.map(row => row.uuid)
    expect(uuids).toHaveLength(2)
    expect(new Set(uuids).size).toBe(2)
  })

  it('falls back to placeholder for a 10-20 MiB image when no normalization service exists', async () => {
    const { bridge, gateway } = setup({ bindings: [alice, bob], attachments: null })
    gateway.downloads.set('img_v3_1', Buffer.concat([PNG_BYTES, Buffer.alloc(11 * 1024 * 1024)]))
    await bridge.receive(imageEvent())
    await bridge.drain()
    expect(gateway.imageUploads).toEqual([])
    expect(gateway.sent).toEqual([{ chatId: 'oc_bob', text: '[图片]', uuid: expect.stringMatching(/^dshfo_/) }])
  })

  it('mirrors a message with no other binding without uploading anything', async () => {
    const { bridge, gateway } = setup({ bindings: [alice] })
    gateway.downloads.set('img_v3_1', PNG_BYTES)
    await bridge.receive(imageEvent())
    await bridge.drain()
    expect(gateway.imageUploads).toEqual([])
    expect(gateway.images).toEqual([])
    expect(gateway.sent).toEqual([])
  })
})
