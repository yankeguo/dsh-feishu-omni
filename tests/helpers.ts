import type { SessionOption } from '../src/public.ts'
import type {
  AttachmentPort, CredentialPort, DownloadedResource, FeishuGateway, FileUploadPort, PromptInput,
  SendMarkdownOptions, SessionPort, StagedUpload,
} from '../src/types.ts'

export interface MutableFeishuEvent {
  event_id?: unknown
  header?: { event_id?: unknown }
  sender?: {
    sender_id?: { open_id?: unknown }
    sender_type?: unknown
    name?: unknown
  }
  message?: {
    message_id?: unknown
    chat_id?: unknown
    chat_type?: unknown
    message_type?: unknown
    content?: unknown
    mentions?: { key?: unknown }[]
  }
}

export const SESSION: SessionOption = { sessionId: 'session-shared', title: 'Shared lead', cwd: '/work', running: false }

export function feishuEvent(overrides: {
  eventId?: string
  messageId?: string
  openId?: string
  chatId?: string
  label?: string
  text?: string
  senderType?: string
  chatType?: string
  messageType?: string
  /** Already-encoded `message.content`; overrides `text`. */
  content?: unknown
} = {}): MutableFeishuEvent {
  return {
    event_id: overrides.eventId ?? 'event-1',
    sender: {
      sender_type: overrides.senderType ?? 'user',
      sender_id: { open_id: overrides.openId ?? 'ou_alice' },
      ...(overrides.label === undefined ? {} : { name: overrides.label }),
    },
    message: {
      message_id: overrides.messageId ?? 'om_1',
      chat_id: overrides.chatId ?? 'oc_alice',
      chat_type: overrides.chatType ?? 'p2p',
      message_type: overrides.messageType ?? 'text',
      content: overrides.content !== undefined
        ? (typeof overrides.content === 'string' ? overrides.content : JSON.stringify(overrides.content))
        : JSON.stringify({ text: overrides.text ?? 'hello' }),
    },
  }
}

export interface FakeTextSend {
  readonly chatId: string
  readonly text: string
  readonly uuid: string
}

export interface FakeCardSend {
  readonly chatId: string
  readonly markdown: string
  readonly uuid: string
  readonly title?: string
}

export interface FakeReaction {
  readonly messageId: string
  readonly emojiType: string
}

export interface FakeDownloadRequest {
  readonly messageId: string
  readonly fileKey: string
  readonly type: 'image' | 'file'
  readonly signal?: AbortSignal
}

export interface FakeImageUpload {
  readonly bytes: Uint8Array
  readonly signal?: AbortSignal
}

export interface FakeFileUpload {
  readonly bytes: Uint8Array
  readonly name: string
  readonly fileType: string
  readonly signal?: AbortSignal
}

export interface FakeImageSend {
  readonly chatId: string
  readonly imageKey: string
  readonly uuid: string
}

export interface FakeFileSend {
  readonly chatId: string
  readonly fileKey: string
  readonly uuid: string
}

export class FakeGateway implements FeishuGateway {
  readonly sent: FakeTextSend[] = []
  readonly attempts: FakeTextSend[] = []
  readonly cards: FakeCardSend[] = []
  readonly cardAttempts: FakeCardSend[] = []
  readonly reactions: FakeReaction[] = []
  readonly reactionAttempts: FakeReaction[] = []
  readonly reactionSignals: (AbortSignal | undefined)[] = []
  readonly downloadRequests: FakeDownloadRequest[] = []
  readonly downloads = new Map<string, Uint8Array>()
  /** Custom download handles (e.g. synthetic large/streamed resources) keyed by file_key. */
  readonly downloadHandles = new Map<string, () => DownloadedResource | Promise<DownloadedResource>>()
  readonly downloadFailures = new Map<string, Error[]>()
  readonly downloadCancels: string[] = []
  readonly imageUploads: FakeImageUpload[] = []
  readonly imageUploadFailures: Error[] = []
  readonly uploadedFileRequests: FakeFileUpload[] = []
  readonly fileUploadFailures: Error[] = []
  readonly images: FakeImageSend[] = []
  readonly imageAttempts: FakeImageSend[] = []
  readonly imageSendFailures = new Map<string, Error[]>()
  readonly files: FakeFileSend[] = []
  readonly fileAttempts: FakeFileSend[] = []
  readonly fileSendFailures = new Map<string, Error[]>()
  /** Injected failures for `sendText`, consumed in order per chat. */
  readonly failures = new Map<string, Error[]>()
  /** Injected failures for `sendMarkdown`, consumed in order per chat. */
  readonly cardFailures = new Map<string, Error[]>()
  /** Injected failures for `addReaction`, consumed in call order. */
  readonly reactionFailures: Error[] = []
  starts = 0
  stops = 0
  private imageKeys = 0
  private fileKeys = 0

  async start(): Promise<void> { this.starts += 1 }
  async stop(): Promise<void> { this.stops += 1 }

  async sendText(chatId: string, text: string, uuid: string): Promise<void> {
    this.attempts.push({ chatId, text, uuid })
    const failure = this.failures.get(chatId)?.shift()
    if (failure !== undefined) throw failure
    this.sent.push({ chatId, text, uuid })
  }

  async sendMarkdown(chatId: string, markdown: string, uuid: string, _signal?: AbortSignal, options?: SendMarkdownOptions): Promise<void> {
    const record: FakeCardSend = {
      chatId, markdown, uuid,
      ...(options?.title === undefined ? {} : { title: options.title }),
    }
    this.cardAttempts.push(record)
    const failure = this.cardFailures.get(chatId)?.shift()
    if (failure !== undefined) throw failure
    this.cards.push(record)
  }

  async addReaction(messageId: string, emojiType: string, signal?: AbortSignal): Promise<void> {
    const record: FakeReaction = { messageId, emojiType }
    this.reactionAttempts.push(record)
    this.reactionSignals.push(signal)
    const failure = this.reactionFailures.shift()
    if (failure !== undefined) throw failure
    this.reactions.push(record)
  }

  async downloadResource(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
    signal?: AbortSignal,
  ): Promise<DownloadedResource> {
    this.downloadRequests.push({ messageId, fileKey, type, ...(signal === undefined ? {} : { signal }) })
    const failure = this.downloadFailures.get(fileKey)?.shift()
    if (failure !== undefined) throw failure
    const custom = this.downloadHandles.get(fileKey)
    if (custom !== undefined) return custom()
    const bytes = this.downloads.get(fileKey) ?? new Uint8Array()
    const head = bytes.slice(0, 64)
    const rest = bytes.slice(64)
    return {
      head,
      data: (async function* replay(): AsyncIterable<Uint8Array> {
        if (head.byteLength > 0) yield head
        if (rest.byteLength > 0) yield rest
      })(),
      cancel: async () => { this.downloadCancels.push(fileKey) },
    }
  }

  async uploadImage(bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
    this.imageUploads.push({ bytes, ...(signal === undefined ? {} : { signal }) })
    const failure = this.imageUploadFailures.shift()
    if (failure !== undefined) throw failure
    this.imageKeys += 1
    return `img_key_${this.imageKeys}`
  }

  async uploadFile(bytes: Uint8Array, name: string, fileType: string, signal?: AbortSignal): Promise<string> {
    this.uploadedFileRequests.push({ bytes, name, fileType, ...(signal === undefined ? {} : { signal }) })
    const failure = this.fileUploadFailures.shift()
    if (failure !== undefined) throw failure
    this.fileKeys += 1
    return `file_key_${this.fileKeys}`
  }

  async sendImage(chatId: string, imageKey: string, uuid: string, _signal?: AbortSignal): Promise<void> {
    const record: FakeImageSend = { chatId, imageKey, uuid }
    this.imageAttempts.push(record)
    const failure = this.imageSendFailures.get(chatId)?.shift()
    if (failure !== undefined) throw failure
    this.images.push(record)
  }

  async sendFile(chatId: string, fileKey: string, uuid: string, _signal?: AbortSignal): Promise<void> {
    const record: FakeFileSend = { chatId, fileKey, uuid }
    this.fileAttempts.push(record)
    const failure = this.fileSendFailures.get(chatId)?.shift()
    if (failure !== undefined) throw failure
    this.files.push(record)
  }
}

export class FakeSessions implements SessionPort {
  readonly prompts: PromptInput[] = []
  promptHook: ((input: PromptInput) => Promise<void>) | undefined

  constructor(readonly options: readonly SessionOption[] = [SESSION]) {}

  async list(): Promise<readonly SessionOption[]> { return this.options }

  async prompt(input: PromptInput): Promise<void> {
    if (this.promptHook !== undefined) return this.promptHook(input)
    this.prompts.push(input)
  }
}

export class FakeCredentials implements CredentialPort {
  secret: string | undefined
  configuredValue: boolean | undefined

  async set(secret: string): Promise<void> {
    this.secret = secret
    this.configuredValue = undefined
  }

  async resolve(): Promise<string | undefined> { return this.secret }

  async configured(): Promise<boolean> {
    return this.configuredValue ?? this.secret !== undefined
  }
}

export interface FakeStagedImageUpload {
  readonly sessionId: string
  readonly mediaType: string
  readonly name?: string
  readonly bytes: Uint8Array
  readonly signal?: AbortSignal
}

export interface FakeStagedFileUpload {
  readonly sessionId: string
  readonly name?: string
  readonly bytes: Uint8Array
  readonly signal?: AbortSignal
}

export class FakeFileUploads implements FileUploadPort {
  readonly imageUploads: FakeStagedImageUpload[] = []
  readonly fileUploads: FakeStagedFileUpload[] = []
  /** Injected failures consumed in call order across both upload kinds. */
  readonly failures: Error[] = []
  /** Normalized image reference returned for every image upload. */
  imageRefFactory: (bytes: Uint8Array, mediaType: string) => unknown = (_bytes, mediaType) => ({ ref: `normalized:${mediaType}` })

  async uploadImageStream(request: {
    readonly sessionId: string
    readonly data: AsyncIterable<Uint8Array>
    readonly mediaType: string
    readonly signal?: AbortSignal
    readonly name?: string
  }): Promise<StagedUpload> {
    const bytes = await collect(request.data)
    this.imageUploads.push({
      sessionId: request.sessionId,
      mediaType: request.mediaType,
      bytes,
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    const failure = this.failures.shift()
    if (failure !== undefined) throw failure
    return {
      receiptId: `receipt-image-${this.imageUploads.length}`,
      image: this.imageRefFactory(bytes, request.mediaType),
    }
  }

  async uploadStream(request: {
    readonly sessionId: string
    readonly data: AsyncIterable<Uint8Array>
    readonly signal?: AbortSignal
    readonly name?: string
  }): Promise<StagedUpload> {
    const bytes = await collect(request.data)
    this.fileUploads.push({
      sessionId: request.sessionId,
      bytes,
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    const failure = this.failures.shift()
    if (failure !== undefined) throw failure
    return { receiptId: `receipt-file-${this.fileUploads.length}` }
  }
}

export class FakeAttachments implements AttachmentPort {
  readonly saved: {
    readonly data: Uint8Array
    readonly mediaType: string
    readonly name?: string
  }[] = []
  readonly failures: Error[] = []
  /** Bytes returned by every `readImage` call. */
  readImageBytes: Uint8Array = new Uint8Array()
  readImageRefs: unknown[] = []
  readImageSignals: (AbortSignal | undefined)[] = []
  readImageFailures: Error[] = []

  async saveImage(input: {
    readonly data: Uint8Array
    readonly mediaType: string
    readonly name?: string
  }): Promise<unknown> {
    const failure = this.failures.shift()
    if (failure !== undefined) throw failure
    this.saved.push(input)
    return { ref: `saved:${this.saved.length}` }
  }

  async readImage(ref: unknown, signal?: AbortSignal): Promise<{ readonly data: Uint8Array }> {
    this.readImageRefs.push(ref)
    this.readImageSignals.push(signal)
    const failure = this.readImageFailures.shift()
    if (failure !== undefined) throw failure
    return { data: this.readImageBytes }
  }
}

export async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of source) {
    chunks.push(chunk)
    total += chunk.byteLength
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export function userEvent(seq = 1, text = 'hello', rpcId = 'feishu-omni:om_1:oc_alice') {
  return {
    seq, type: 'user/message', surfaceOp: 'append',
    data: { content: [{ type: 'text', text }], source: { kind: 'user', rpcId } },
  }
}

export function assistantEvent(seq = 2, text = 'answer', turn = 1, interrupted = false) {
  return {
    seq, type: 'assistant/message', surfaceOp: 'append',
    data: { turn, step: 1, interrupted, message: { content: [{ type: 'text', text }] } },
  }
}

export function turnEnd(seq = 3, turn = 1, reason: unknown = { kind: 'completed' }) {
  return { seq, type: 'turn/end', data: { turn, reason } }
}

/** Minimal valid 1x1 PNG used by image fixtures. */
export const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l5FpTQAAAABJRU5ErkJggg==',
  'base64',
)

/** Minimal GIF89a header; enough for format sniffing fixtures. */
export const GIF_BYTES = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'binary')

/** A JPEG magic header followed by padding; enough for format sniffing fixtures. */
export const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(60, 0),
])

/** HEIC-like `ftypheic` header; DSH cannot prompt this format. */
export const HEIC_BYTES = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypheic', 'ascii'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.alloc(40, 0),
])

/** `deliverables/presented` is a log-only event: it carries no surfaceOp. */
export function presentedEvent(
  seq: number,
  turn: number,
  files: readonly { path: string; description?: string }[],
) {
  return {
    seq, type: 'deliverables/presented',
    data: { turn, callId: `call-${seq}`, files },
  }
}

/** Effective working directory change, as emitted by the DSH session package. */
export function workingDirectoryChange(seq: number, cwd: string) {
  return { seq, type: 'working-directory/change', data: { cwd } }
}
