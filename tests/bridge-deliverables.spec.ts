import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OmniBridge } from '../src/bridge.ts'
import { emptyState, MemoryStateStore } from '../src/state.ts'
import type { AttachmentPort, Binding, FileUploadPort } from '../src/types.ts'
import {
  assistantEvent, FakeAttachments, FakeFileUploads, FakeGateway, FakeSessions, PNG_BYTES,
  presentedEvent, SESSION, turnEnd, userEvent,
} from './helpers.ts'

const alice: Binding = { openId: 'ou_alice', chatId: 'oc_alice', label: 'Alice', createdAt: '2026-01-01', updatedAt: '2026-01-01' }
const bob: Binding = { openId: 'ou_bob', chatId: 'oc_bob', label: 'Bob', createdAt: '2026-01-01', updatedAt: '2026-01-01' }

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dshfo-deliverables-'))
  tempDirs.push(dir)
  return dir
}

interface SetupOptions {
  readonly bindings?: readonly Binding[]
  readonly attachments?: FakeAttachments | null
  readonly fileUploads?: FakeFileUploads | null
  readonly sessionCwd?: (sessionId: string) => string | undefined
  readonly attachmentTimeoutMs?: number
  readonly sessions?: FakeSessions
}

function setup(options: SetupOptions = {}) {
  const state = new MemoryStateStore({
    ...emptyState(),
    sessionId: SESSION.sessionId,
    bindings: options.bindings ?? [alice],
  })
  const sessions = options.sessions ?? new FakeSessions()
  const gateway = new FakeGateway()
  const attachments = options.attachments === null ? undefined : options.attachments ?? new FakeAttachments()
  const fileUploads = options.fileUploads === null ? undefined : options.fileUploads ?? new FakeFileUploads()
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
    ...(options.attachmentTimeoutMs === undefined ? {} : { attachmentTimeoutMs: options.attachmentTimeoutMs }),
    ...(options.attachments === null ? {} : { attachments: attachments as AttachmentPort }),
    ...(options.fileUploads === null ? {} : { fileUploads: fileUploads as FileUploadPort }),
    ...(options.sessionCwd === undefined ? {} : { sessionCwd: options.sessionCwd }),
  })
  return { state, sessions, gateway, attachments, fileUploads, bridge, logs }
}

async function turnWithPresent(
  bridge: OmniBridge,
  markdown: string | undefined,
  files: readonly { path: string; description?: string }[],
  turn = 1,
): Promise<void> {
  if (markdown !== undefined) await bridge.sessionEvent(SESSION.sessionId, assistantEvent(1, markdown, turn))
  await bridge.sessionEvent(SESSION.sessionId, presentedEvent(2, turn, files))
  await bridge.sessionEvent(SESSION.sessionId, turnEnd(3, turn))
  await bridge.drain()
}

describe('OmniBridge present deliverables', () => {
  it('sends the final card first and then the presented file to every binding', async () => {
    const dir = await tempDir()
    const file = join(dir, 'report.pdf')
    await writeFile(file, '%PDF-1.7 fixture')
    const { bridge, gateway } = setup({ bindings: [alice, bob] })
    const order: string[] = []
    const markdown = gateway.sendMarkdown.bind(gateway)
    gateway.sendMarkdown = async (...args) => {
      order.push('card')
      return markdown(...args)
    }
    const sendFile = gateway.sendFile.bind(gateway)
    gateway.sendFile = async (...args) => {
      order.push('file')
      return sendFile(...args)
    }
    await turnWithPresent(bridge, '报告如下', [{ path: file, description: '报告' }])
    expect(order).toEqual(['card', 'card', 'file', 'file'])
    // Uploaded once, delivered to both chats with distinct UUIDs.
    expect(gateway.uploadedFileRequests).toHaveLength(1)
    expect(gateway.uploadedFileRequests[0]).toMatchObject({ name: 'report.pdf', fileType: 'pdf' })
    expect(gateway.files.map(row => row.chatId)).toEqual(['oc_alice', 'oc_bob'])
    expect(new Set(gateway.files.map(row => row.uuid)).size).toBe(2)
    for (const row of gateway.files) expect(row.uuid).toMatch(/^dshfo_[0-9a-f]{40}$/)
  })

  it('buffers a present event until the turn ends', async () => {
    const dir = await tempDir()
    const file = join(dir, 'a.pdf')
    await writeFile(file, '%PDF')
    const { bridge, gateway } = setup()
    await bridge.sessionEvent(SESSION.sessionId, presentedEvent(1, 1, [{ path: file }]))
    await bridge.drain()
    expect(gateway.uploadedFileRequests).toEqual([])
    expect(gateway.files).toEqual([])
    await bridge.sessionEvent(SESSION.sessionId, assistantEvent(2, 'done', 1))
    await bridge.sessionEvent(SESSION.sessionId, turnEnd(3, 1))
    await bridge.drain()
    expect(gateway.uploadedFileRequests).toHaveLength(1)
    expect(gateway.files).toHaveLength(1)
  })

  it('derives the same per-chat deliverable UUID across identical turns', async () => {
    const dir = await tempDir()
    const file = join(dir, 'a.pdf')
    await writeFile(file, '%PDF')
    const first = setup({ bindings: [alice, bob] })
    await turnWithPresent(first.bridge, 'done', [{ path: file }])
    const second = setup({ bindings: [alice, bob] })
    await turnWithPresent(second.bridge, 'done', [{ path: file }])
    expect(first.gateway.files.map(row => row.uuid)).toEqual(second.gateway.files.map(row => row.uuid))
    expect(first.gateway.cards.map(row => row.uuid)).toEqual(second.gateway.cards.map(row => row.uuid))
  })

  it('does not deliver presented files for a non-completed turn and clears the buffer', async () => {
    const dir = await tempDir()
    const file = join(dir, 'a.pdf')
    await writeFile(file, '%PDF')
    const { bridge, gateway } = setup()
    await bridge.sessionEvent(SESSION.sessionId, assistantEvent(1, 'partial', 1))
    await bridge.sessionEvent(SESSION.sessionId, presentedEvent(2, 1, [{ path: file }]))
    await bridge.sessionEvent(SESSION.sessionId, turnEnd(3, 1, { kind: 'aborted' }))
    // The next completed turn has no present event; the cleared buffer must not leak.
    await bridge.sessionEvent(SESSION.sessionId, assistantEvent(4, 'final', 2))
    await bridge.sessionEvent(SESSION.sessionId, turnEnd(5, 2))
    await bridge.drain()
    expect(gateway.cards.map(row => row.markdown)).toEqual(['final'])
    expect(gateway.files).toEqual([])
    expect(gateway.uploadedFileRequests).toEqual([])
  })

  it('delivers an image deliverable as a real image message', async () => {
    const dir = await tempDir()
    const file = join(dir, 'chart.png')
    await writeFile(file, PNG_BYTES)
    const { bridge, gateway, fileUploads } = setup()
    await turnWithPresent(bridge, undefined, [{ path: file }])
    expect(gateway.imageUploads).toHaveLength(1)
    expect(Buffer.from(gateway.imageUploads[0]?.bytes ?? [])).toEqual(PNG_BYTES)
    expect(gateway.images).toHaveLength(1)
    expect(gateway.images[0]?.chatId).toBe('oc_alice')
    // Present uploads bypass the inbound staging service entirely.
    expect(fileUploads?.imageUploads).toEqual([])
    expect(gateway.cards).toEqual([])
  })

  it('degrades a missing file to a text notice without blocking other files', async () => {
    const dir = await tempDir()
    const good = join(dir, 'good.txt')
    await writeFile(good, 'hello')
    const { bridge, gateway } = setup({ bindings: [alice, bob] })
    await turnWithPresent(bridge, 'done', [
      { path: join(dir, 'missing.pdf') },
      { path: good },
    ])
    const notices = gateway.sent.filter(row => row.text.includes('未发送'))
    expect(notices).toHaveLength(2)
    expect(notices.map(row => row.chatId)).toEqual(['oc_alice', 'oc_bob'])
    expect(notices[0]?.text).toContain('missing.pdf')
    expect(notices[0]?.text).toContain('文件不存在或不可读')
    // The local path never appears in the notice; only the base name does.
    expect(notices[0]?.text).not.toContain(dir)
    expect(gateway.files.map(row => row.chatId)).toEqual(['oc_alice', 'oc_bob'])
  })

  it('degrades a file above the Feishu 30 MiB upload limit before reading it', async () => {
    const dir = await tempDir()
    const big = join(dir, 'big.bin')
    await writeFile(big, '')
    await truncate(big, 30 * 1024 * 1024 + 1)
    const { bridge, gateway } = setup()
    await turnWithPresent(bridge, undefined, [{ path: big }])
    expect(gateway.uploadedFileRequests).toEqual([])
    expect(gateway.sent).toHaveLength(1)
    expect(gateway.sent[0]?.text).toContain('big.bin')
    expect(gateway.sent[0]?.text).toContain('30.0 MB')
  })

  it('normalizes an image over the 10 MiB Feishu image cap before uploading', async () => {
    const dir = await tempDir()
    const big = join(dir, 'huge.png')
    await writeFile(big, Buffer.concat([PNG_BYTES, Buffer.alloc(11 * 1024 * 1024)]))
    const attachments = new FakeAttachments()
    attachments.readImageBytes = PNG_BYTES
    const { bridge, gateway } = setup({ attachments })
    await turnWithPresent(bridge, undefined, [{ path: big }])
    expect(attachments.saved).toHaveLength(1)
    expect(attachments.saved[0]?.mediaType).toBe('image/png')
    expect(gateway.imageUploads).toHaveLength(1)
    expect(Buffer.from(gateway.imageUploads[0]?.bytes ?? [])).toEqual(PNG_BYTES)
    expect(gateway.images).toHaveLength(1)
  })

  it('retries an image through normalization when the direct Feishu upload is rejected', async () => {
    const dir = await tempDir()
    const file = join(dir, 'chart.png')
    await writeFile(file, PNG_BYTES)
    const attachments = new FakeAttachments()
    attachments.readImageBytes = PNG_BYTES
    const { bridge, gateway } = setup({ attachments })
    // The direct upload exhausts its retry ladder, then the normalized retry wins.
    const rejected = (): Error => Object.assign(new Error('image too large'), { code: 234006 })
    gateway.imageUploadFailures.push(rejected(), rejected(), rejected())
    await turnWithPresent(bridge, undefined, [{ path: file }])
    expect(attachments.saved).toHaveLength(1)
    expect(gateway.imageUploads).toHaveLength(4)
    expect(gateway.images).toHaveLength(1)
  })

  it('degrades an image that neither uploads nor normalizes', async () => {
    const dir = await tempDir()
    const file = join(dir, 'chart.png')
    await writeFile(file, PNG_BYTES)
    const attachments = new FakeAttachments()
    attachments.readImageFailures.push(new Error('store down'))
    const { bridge, gateway } = setup({ attachments })
    for (let attempt = 0; attempt < 6; attempt += 1) gateway.imageUploadFailures.push(new Error('rejected'))
    await turnWithPresent(bridge, undefined, [{ path: file }])
    expect(gateway.images).toEqual([])
    expect(gateway.sent).toHaveLength(1)
    expect(gateway.sent[0]?.text).toContain('无法规范化')
  })

  it('keeps other chats working when one recipient rejects the attachment', async () => {
    const dir = await tempDir()
    const file = join(dir, 'a.pdf')
    await writeFile(file, '%PDF')
    const { bridge, gateway } = setup({ bindings: [alice, bob] })
    gateway.fileSendFailures.set('oc_bob', [Object.assign(new Error('bot removed'), { code: 230002 })])
    await turnWithPresent(bridge, undefined, [{ path: file }])
    expect(gateway.files.map(row => row.chatId)).toEqual(['oc_alice'])
    // The failed attachment falls back to a text notice with the same UUID.
    const notices = gateway.sent.filter(row => row.chatId === 'oc_bob')
    expect(notices).toHaveLength(1)
    expect(notices[0]?.text).toContain('发送失败')
    expect(notices[0]?.uuid).toBe(gateway.fileAttempts.find(row => row.chatId === 'oc_bob')?.uuid)
  })

  it('resolves a relative present path against the Session working directory', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'notes.txt'), 'notes')
    const { bridge, gateway } = setup({ sessionCwd: () => dir })
    await turnWithPresent(bridge, undefined, [{ path: 'notes.txt' }])
    expect(gateway.files).toHaveLength(1)
    expect(gateway.uploadedFileRequests[0]?.name).toBe('notes.txt')
  })

  it('uploads a path presented twice in one turn only once', async () => {
    const dir = await tempDir()
    const file = join(dir, 'a.pdf')
    await writeFile(file, '%PDF')
    const { bridge, gateway } = setup()
    await turnWithPresent(bridge, undefined, [{ path: file }, { path: file }])
    expect(gateway.uploadedFileRequests).toHaveLength(1)
    expect(gateway.files).toHaveLength(1)
  })

  it('keeps the extension of an over-long basename and adds a suffix to extension-less names', async () => {
    const dir = await tempDir()
    const longStem = 'x'.repeat(130)
    const longPdf = join(dir, `${longStem}.pdf`)
    await writeFile(longPdf, '%PDF')
    const makefile = join(dir, 'Makefile')
    await writeFile(makefile, 'all:')
    const { bridge, gateway } = setup()
    await turnWithPresent(bridge, undefined, [{ path: longPdf }, { path: makefile }])
    const names = gateway.uploadedFileRequests.map(row => row.name)
    expect(names[0]?.endsWith('.pdf')).toBe(true)
    expect(names[0]?.length).toBeLessThanOrEqual(120)
    expect(names[1]).toBe('Makefile.bin')
    expect(gateway.uploadedFileRequests[0]?.fileType).toBe('pdf')
    expect(gateway.uploadedFileRequests[1]?.fileType).toBe('stream')
  })

  it('merges multiple present events of one turn and deduplicates repeated paths', async () => {
    const dir = await tempDir()
    const first = join(dir, 'a.pdf')
    const second = join(dir, 'b.pdf')
    await writeFile(first, '%PDF-a')
    await writeFile(second, '%PDF-b')
    const { bridge, gateway } = setup({ bindings: [alice, bob] })
    await bridge.sessionEvent(SESSION.sessionId, assistantEvent(1, 'done', 1))
    await bridge.sessionEvent(SESSION.sessionId, presentedEvent(2, 1, [{ path: first }]))
    await bridge.sessionEvent(SESSION.sessionId, presentedEvent(3, 1, [{ path: second }, { path: first }]))
    await bridge.sessionEvent(SESSION.sessionId, turnEnd(4, 1))
    await bridge.drain()
    expect(gateway.uploadedFileRequests.map(row => row.name)).toEqual(['a.pdf', 'b.pdf'])
    expect(gateway.files.map(row => row.chatId).sort()).toEqual(['oc_alice', 'oc_alice', 'oc_bob', 'oc_bob'])
  })

  it('retries a transient deliverable send before degrading and reuses the uuid', async () => {
    const dir = await tempDir()
    const file = join(dir, 'a.pdf')
    await writeFile(file, '%PDF')
    const { bridge, gateway } = setup()
    gateway.fileSendFailures.set('oc_alice', [Object.assign(new Error('rate limited'), { code: 230020 })])
    await turnWithPresent(bridge, undefined, [{ path: file }])
    expect(gateway.fileAttempts).toHaveLength(2)
    expect(new Set(gateway.fileAttempts.map(row => row.uuid)).size).toBe(1)
    expect(gateway.files).toHaveLength(1)
    expect(gateway.sent.filter(row => row.text.includes('未发送'))).toEqual([])
  })

  it('retries a transient deliverable upload before degrading', async () => {
    const dir = await tempDir()
    const file = join(dir, 'a.pdf')
    await writeFile(file, '%PDF')
    const { bridge, gateway } = setup()
    gateway.fileUploadFailures.push(Object.assign(new Error('rate limited'), { code: 230020 }))
    await turnWithPresent(bridge, undefined, [{ path: file }])
    expect(gateway.uploadedFileRequests).toHaveLength(2)
    expect(gateway.files).toHaveLength(1)
    expect(gateway.sent.filter(row => row.text.includes('未发送'))).toEqual([])
  })

  it('uploads an image deliverable once and sends it to every binding', async () => {
    const dir = await tempDir()
    const file = join(dir, 'chart.png')
    await writeFile(file, PNG_BYTES)
    const { bridge, gateway } = setup({ bindings: [alice, bob] })
    await turnWithPresent(bridge, undefined, [{ path: file }])
    expect(gateway.imageUploads).toHaveLength(1)
    expect(gateway.images.map(row => row.chatId)).toEqual(['oc_alice', 'oc_bob'])
    expect(new Set(gateway.images.map(row => row.uuid)).size).toBe(2)
  })

  it('degrades an empty file and a directory with distinct reasons', async () => {
    const dir = await tempDir()
    const empty = join(dir, 'empty.txt')
    await writeFile(empty, '')
    const { bridge, gateway } = setup()
    await turnWithPresent(bridge, undefined, [{ path: empty }, { path: dir }])
    const notices = gateway.sent.map(row => row.text)
    expect(notices.some(text => text.includes('empty.txt') && text.includes('文件为空'))).toBe(true)
    expect(notices.some(text => text.includes('不是普通文件'))).toBe(true)
  })

  it('warns when a turn presents more files than the buffer cap and still delivers the cap', async () => {
    const dir = await tempDir()
    const files: { path: string }[] = []
    for (let index = 0; index < 33; index += 1) {
      const file = join(dir, `f-${index}.txt`)
      await writeFile(file, `file-${index}`)
      files.push({ path: file })
    }
    const { bridge, gateway, logs } = setup()
    await turnWithPresent(bridge, undefined, files)
    expect(gateway.uploadedFileRequests).toHaveLength(32)
    expect(logs.some(log => log.level === 'warn' && log.message.includes('per-turn cap'))).toBe(true)
  })

  it('ignores a malformed present payload without delivering anything', async () => {
    const { bridge, gateway } = setup()
    await bridge.sessionEvent(SESSION.sessionId, assistantEvent(1, 'done', 1))
    await bridge.sessionEvent(SESSION.sessionId, {
      seq: 2, type: 'deliverables/presented', data: { turn: 1, files: [{ path: 42 }] },
    })
    await bridge.sessionEvent(SESSION.sessionId, turnEnd(3, 1))
    await bridge.drain()
    expect(gateway.uploadedFileRequests).toEqual([])
    expect(gateway.files).toEqual([])
    expect(gateway.cards).toHaveLength(1)
  })

  it('delivers cards before attachments even when the reply spans multiple chunks', async () => {
    const dir = await tempDir()
    const file = join(dir, 'a.pdf')
    await writeFile(file, '%PDF')
    const longMarkdown = Array.from({ length: 700 }, (_, index) => `段落 ${index}：` + 'x'.repeat(60)).join('\n\n')
    const { bridge, gateway } = setup()
    const order: string[] = []
    const markdown = gateway.sendMarkdown.bind(gateway)
    gateway.sendMarkdown = async (...args) => {
      order.push('card')
      return markdown(...args)
    }
    const sendFile = gateway.sendFile.bind(gateway)
    gateway.sendFile = async (...args) => {
      order.push('file')
      return sendFile(...args)
    }
    await turnWithPresent(bridge, longMarkdown, [{ path: file }])
    expect(order.filter(entry => entry === 'card').length).toBeGreaterThan(1)
    expect(order[order.length - 1]).toBe('file')
    expect(order.indexOf('file')).toBe(order.length - 1)
  })

  it('stops an in-flight deliverable send when the bridge stops', async () => {
    const dir = await tempDir()
    const file = join(dir, 'a.pdf')
    await writeFile(file, '%PDF')
    const { bridge, gateway } = setup()
    let calls = 0
    gateway.sendFile = () => {
      calls += 1
      return new Promise<void>(() => {})
    }
    await bridge.sessionEvent(SESSION.sessionId, presentedEvent(1, 1, [{ path: file }]))
    await bridge.sessionEvent(SESSION.sessionId, turnEnd(2, 1))
    await vi.waitFor(() => expect(calls).toBe(1))
    await bridge.stop()
    await bridge.drain()
    expect(gateway.stops).toBe(1)
    expect(gateway.sent.filter(row => row.text.includes('未发送'))).toEqual([])
  })

  it('keeps emitting mirrored user messages and test messages alongside deliverables', async () => {
    const dir = await tempDir()
    const file = join(dir, 'a.pdf')
    await writeFile(file, '%PDF')
    const { bridge, gateway } = setup({ bindings: [alice, bob] })
    await bridge.sessionEvent(SESSION.sessionId, userEvent(1, '[飞书 · Alice]\nhello', 'feishu-omni:om_1:oc_alice'))
    await turnWithPresent(bridge, 'done', [{ path: file }])
    expect(gateway.sent.map(row => row.chatId)).toEqual(['oc_bob'])
    expect(gateway.files.map(row => row.chatId)).toEqual(['oc_alice', 'oc_bob'])
  })
})

describe('OmniBridge inline card images', () => {
  it('uploads a local image reference and rewrites it to an image_key in the card', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'chart.png'), PNG_BYTES)
    const { bridge, gateway } = setup({ sessionCwd: () => dir })
    await turnWithPresent(bridge, '结果：\n\n![图](<chart.png>)\n\n完成。', [])
    expect(gateway.imageUploads).toHaveLength(1)
    expect(gateway.cards[0]?.markdown).toBe('结果：\n\n![图](img_key_1)\n\n完成。')
    expect(gateway.cards[0]?.markdown).not.toContain('chart.png')
  })

  it('rewrites an angle-bracket path containing spaces', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'my chart.png'), PNG_BYTES)
    const { bridge, gateway } = setup({ sessionCwd: () => dir })
    await turnWithPresent(bridge, '![图](<my chart.png>)', [])
    expect(gateway.cards[0]?.markdown).toBe('![图](img_key_1)')
  })

  it('rewrites relative and absolute image references without angle brackets', async () => {
    const dir = await tempDir()
    const absolute = join(dir, 'absolute.png')
    await writeFile(join(dir, 'relative.png'), PNG_BYTES)
    await writeFile(absolute, PNG_BYTES)
    const { bridge, gateway } = setup({ sessionCwd: () => dir })
    await turnWithPresent(bridge, 'A ![one](relative.png) B ![two](' + absolute + ')', [])
    expect(gateway.imageUploads).toHaveLength(2)
    expect(gateway.cards[0]?.markdown).toBe('A ![one](img_key_1) B ![two](img_key_2)')
  })

  it('does not rewrite image syntax inside four-backtick fences closed by shorter fences', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'chart.png'), PNG_BYTES)
    const { bridge, gateway } = setup({ sessionCwd: () => dir })
    const markdown = ['````md', '![in](chart.png)', '```', '![still-in](chart.png)', '````', '![after](chart.png)'].join('\n')
    await turnWithPresent(bridge, markdown, [])
    expect(gateway.cards[0]?.markdown).toBe(
      ['````md', '![in](chart.png)', '```', '![still-in](chart.png)', '````', '![after](img_key_1)'].join('\n'),
    )
    expect(gateway.imageUploads).toHaveLength(1)
  })

  it('does not close a fence on a line that carries an info string', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'chart.png'), PNG_BYTES)
    const { bridge, gateway } = setup({ sessionCwd: () => dir })
    const markdown = ['```js', 'code', '```json', '![in](chart.png)', '```', '![after](chart.png)'].join('\n')
    // The ```json line is not a closing fence (info text), so both image refs
    // stay inside the code block; only content after the real closer changes.
    await turnWithPresent(bridge, markdown, [])
    expect(gateway.cards[0]?.markdown).toBe(markdown.replace('![after](chart.png)', '![after](img_key_1)'))
    expect(gateway.imageUploads).toHaveLength(1)
  })

  it('preserves inline code inside the alt text while rewriting the target', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'chart.png'), PNG_BYTES)
    const { bridge, gateway } = setup({ sessionCwd: () => dir })
    await turnWithPresent(bridge, '![`x` 图](chart.png)', [])
    expect(gateway.cards[0]?.markdown).toBe('![`x` 图](img_key_1)')
  })

  it('does not rewrite image syntax shown inside inline code', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'chart.png'), PNG_BYTES)
    const { bridge, gateway } = setup({ sessionCwd: () => dir })
    await turnWithPresent(bridge, '示例 `![x](chart.png)` 与真图 ![y](chart.png)', [])
    expect(gateway.cards[0]?.markdown).toBe('示例 `![x](chart.png)` 与真图 ![y](img_key_1)')
    expect(gateway.imageUploads).toHaveLength(1)
  })

  it('keeps URLs, image keys, missing files, non-images and code fences untouched', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'notes.txt'), 'not an image')
    const { bridge, gateway } = setup({ sessionCwd: () => dir })
    const markdown = [
      '![remote](https://example.test/a.png)',
      '![key](img_v3_existing)',
      '![missing](missing.png)',
      '![text](notes.txt)',
      '```md',
      '![example](chart.png)',
      '```',
    ].join('\n')
    await turnWithPresent(bridge, markdown, [])
    expect(gateway.imageUploads).toEqual([])
    expect(gateway.cards[0]?.markdown).toBe(markdown)
  })

  it('does not rewrite an image that present already delivered as an image message', async () => {
    const dir = await tempDir()
    const file = join(dir, 'chart.png')
    await writeFile(file, PNG_BYTES)
    const { bridge, gateway } = setup({ sessionCwd: () => dir })
    await turnWithPresent(bridge, '见 ![图](<chart.png>)', [{ path: file }])
    expect(gateway.cards[0]?.markdown).toBe('见 ![图](<chart.png>)')
    // Only the deliverable path uploaded and sent the image, exactly once.
    expect(gateway.imageUploads).toHaveLength(1)
    expect(gateway.images).toHaveLength(1)
  })

  it('leaves the reference untouched when the upload fails and no normalization is available', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'chart.png'), PNG_BYTES)
    const { bridge, gateway } = setup({ sessionCwd: () => dir, attachments: null })
    gateway.imageUploadFailures.push(new Error('missing im:resource scope'))
    await turnWithPresent(bridge, '![图](chart.png)', [])
    expect(gateway.cards[0]?.markdown).toBe('![图](chart.png)')
  })

  it('normalizes an oversize inline image before rewriting it', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'huge.png'), Buffer.concat([PNG_BYTES, Buffer.alloc(11 * 1024 * 1024)]))
    const attachments = new FakeAttachments()
    attachments.readImageBytes = PNG_BYTES
    const { bridge, gateway } = setup({ sessionCwd: () => dir, attachments })
    await turnWithPresent(bridge, '![图](huge.png)', [])
    expect(attachments.saved).toHaveLength(1)
    expect(gateway.cards[0]?.markdown).toBe('![图](img_key_1)')
  })

  it('does not resolve relative references when the Session working directory is unknown', async () => {
    const unknownCwd = new FakeSessions([{ ...SESSION, cwd: null }])
    const { bridge, gateway } = setup({ sessions: unknownCwd })
    await turnWithPresent(bridge, '![图](chart.png)', [])
    expect(gateway.cards[0]?.markdown).toBe('![图](chart.png)')
    expect(gateway.imageUploads).toEqual([])
  })

  it('falls back to the Session list cwd when no event-fed cwd is available', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'chart.png'), PNG_BYTES)
    const listed = new FakeSessions([{ ...SESSION, cwd: dir }])
    const { bridge, gateway } = setup({ sessions: listed })
    await turnWithPresent(bridge, '![图](chart.png)', [])
    expect(gateway.cards[0]?.markdown).toBe('![图](img_key_1)')
  })

  it('uploads a repeated image reference once and reuses the same key', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'chart.png'), PNG_BYTES)
    const { bridge, gateway } = setup({ sessionCwd: () => dir })
    await turnWithPresent(bridge, '![a](chart.png) and ![b](<chart.png>)', [])
    expect(gateway.imageUploads).toHaveLength(1)
    expect(gateway.cards[0]?.markdown).toBe('![a](img_key_1) and ![b](img_key_1)')
  })
})
