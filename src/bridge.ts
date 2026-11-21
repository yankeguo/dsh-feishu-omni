import { createHash } from 'node:crypto'
import { assistantCardTitle, assistantFallbackText, splitAssistantMarkdown } from './card.ts'
import {
  AttachmentFailure, FEISHU_FILE_MAX_BYTES, FEISHU_IMAGE_MAX_BYTES, INBOUND_FILE_MAX_BYTES,
  INBOUND_IMAGE_MAX_BYTES, collectingStream, feishuFileType, formatBytes, imageMediaType,
  mediaTypeExtension, readAllBounded, unsupportedImageFormat, type FeishuFileType,
} from './attachments.ts'
import {
  attachmentRejectionReason, deliveryFailureKind, isRetryable, isRetryableDelivery, reactionFailureDetail,
  reactionFailureKind, safeMessage, silentLogger, type Logger, type ReactionFailureKind,
} from './errors.ts'
import { extractInboundMessage, type FeishuMessageEvent, type InboundAttachment, type InboundMessage } from './events.ts'
import type { TestResult } from './public.ts'
import { appendRecentKeys } from './state.ts'
import { SerialQueue } from './serial.ts'
import type {
  AttachmentPort, DownloadedResource, FeishuGateway, FileUploadPort, PromptAttachment, PromptInput,
  RetryOptions, SessionEventLike, SessionPort, StagedUpload, StateStore,
} from './types.ts'

const DEFAULT_RETRY: RetryOptions = { attempts: 3, baseDelayMs: 500, maxDelayMs: 5000 }
const MAX_SESSION_EVENT_KEYS = 2048
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000
const DEFAULT_ACK_TIMEOUT_MS = 5_000
/**
 * Per-attachment bound covering one download plus its DSH staging write. Large
 * files over a slow link are the reason this is larger than the plain send
 * bound; it still caps a hostile/stalled resource far below SDK defaults.
 */
const DEFAULT_ATTACHMENT_TIMEOUT_MS = 120_000
/** Longest display name kept for prompt placeholders and Feishu uploads. */
const MAX_DISPLAY_NAME_LENGTH = 120

/**
 * Feishu prompts carry their origin chat in the request id:
 * `feishu-omni:<message_id>:<chat_id>`. DSH records the request id verbatim as
 * `source.rpcId` on the committed user message, so the outbound side can decode
 * the originating chat from the durable Session event alone — no in-memory map
 * that a restart or delayed admission could lose.
 */
const REQUEST_PREFIX = 'feishu-omni:'

/** Fixed emoji reaction acknowledging that a user message reached the Session. */
export const ACK_EMOJI = 'OK'

interface TextContent {
  readonly content?: unknown
  readonly source?: { readonly kind?: unknown }
}

/** `feishu` mirrors the parsed rpcId; `chatId` is absent when it cannot be decoded. */
interface PromptOrigin {
  readonly feishu: boolean
  readonly chatId?: string
}

function parsePromptOrigin(rpcId: unknown): PromptOrigin {
  if (typeof rpcId !== 'string' || !rpcId.startsWith(REQUEST_PREFIX)) return { feishu: false }
  const rest = rpcId.slice(REQUEST_PREFIX.length)
  // Decode from the right: message ids are opaque and only the chat id tail is
  // consumed. A missing/empty tail (pre-upgrade request ids) keeps `feishu` and
  // falls back to a full broadcast instead of guessing a recipient.
  const separator = rest.lastIndexOf(':')
  if (separator <= 0) return { feishu: true }
  const chatId = rest.slice(separator + 1).trim()
  return chatId ? { feishu: true, chatId } : { feishu: true }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content.map(block => {
    if (typeof block !== 'object' || block === null) return ''
    const row = block as { type?: unknown; text?: unknown }
    return row.type === 'text' && typeof row.text === 'string' ? row.text : ''
  }).filter(Boolean).join('\n\n').trim()
}

function messageData(data: unknown): TextContent | undefined {
  return typeof data === 'object' && data !== null ? data as TextContent : undefined
}

function uuidFor(key: string): string {
  return `dshfo_${createHash('sha256').update(key).digest('hex').slice(0, 40)}`
}

/** Strip control characters and path separators from a display-only name. */
function displayName(name: string | undefined, fallback: string): string {
  const trimmed = name?.trim() ?? ''
  const cleaned = trimmed.replace(/[\p{Cc}/\\]+/gu, ' ').replace(/\s{2,}/g, ' ').trim()
  const chosen = cleaned.length > 0 ? cleaned : fallback
  return chosen.length > MAX_DISPLAY_NAME_LENGTH ? chosen.slice(0, MAX_DISPLAY_NAME_LENGTH) : chosen
}

/** Fallback display name per inbound attachment kind; never used as a path. */
function inboundFileName(attachment: InboundAttachment): string {
  switch (attachment.kind) {
    case 'file':
      return displayName(attachment.name, 'file.bin')
    case 'audio':
      return displayName(attachment.name, 'audio.opus')
    case 'media':
      return displayName(attachment.name, 'video.mp4')
    case 'image':
      return displayName(attachment.name, 'image.png')
  }
}

/** Prompt-body placeholder describing one attachment the agent receives natively. */
function promptPlaceholder(attachment: InboundAttachment): string {
  switch (attachment.kind) {
    case 'image':
      return '（图片）'
    case 'file':
      return attachment.name === undefined ? '（文件）' : `（文件：${displayName(attachment.name, 'file')}）`
    case 'audio':
      return '（音频）'
    case 'media':
      return attachment.name === undefined ? '（视频）' : `（视频：${displayName(attachment.name, 'video')}）`
  }
}

/** Text fallback sent to other bindings when an attachment cannot be re-uploaded. */
function mirrorPlaceholder(attachment: InboundAttachment): string {
  switch (attachment.kind) {
    case 'image':
      return '[图片]'
    case 'file':
      return `[文件: ${displayName(attachment.name, 'file')}]`
    case 'audio':
      return '[音频]'
    case 'media':
      return attachment.name === undefined ? '[视频]' : `[视频: ${displayName(attachment.name, 'video')}]`
  }
}

/** One stagged prompt part plus the metadata needed for the mirror broadcast. */
interface StagedMirror {
  readonly attachment: InboundAttachment
  readonly placeholder: string
  /** Raw bytes kept for a Feishu re-upload; absent when the resource was too large. */
  readonly bytes?: Uint8Array
  /** DSH-normalized image reference (images only); read back when raw bytes exceed the Feishu upload bound. */
  readonly imageRef?: unknown
  readonly fileName?: string
  readonly fileType?: FeishuFileType
}

interface StagedInbound {
  readonly prompt: readonly PromptAttachment[]
  readonly mirrors: readonly StagedMirror[]
}

/** One uploaded mirror resource, cached across recipient chats. */
type MirrorResource =
  | { readonly kind: 'image'; readonly key: string }
  | { readonly kind: 'file'; readonly key: string }
  | { readonly kind: 'placeholder' }

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes
}

/** Normalize any gateway/service failure into a classified attachment failure. */
function asAttachmentFailure(
  error: unknown,
  reason: 'download' | 'upload',
  message: string,
): AttachmentFailure {
  return error instanceof AttachmentFailure ? error : new AttachmentFailure(message, reason, { cause: error })
}

export interface OmniBridgeOptions {
  readonly state: StateStore
  readonly sessions: SessionPort
  readonly gateway: FeishuGateway
  readonly logger?: Logger
  readonly retry?: RetryOptions
  readonly now?: () => Date
  readonly sleep?: (milliseconds: number) => Promise<void>
  readonly onError?: (error: unknown) => void
  readonly operationTimeoutMs?: number
  readonly ackTimeoutMs?: number
  readonly attachmentTimeoutMs?: number
  /** DSH attachment staging service; absent means inbound files degrade to text. */
  readonly fileUploads?: FileUploadPort
  /** DSH attachment store used to normalize oversize outbound images. */
  readonly attachments?: AttachmentPort
}

/** One connected bot bound to one existing DSH Session and many direct chats. */
export class OmniBridge {
  private readonly queue = new SerialQueue()
  private readonly logger: Logger
  private readonly retry: RetryOptions
  private readonly now: () => Date
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly onError: (error: unknown) => void
  private readonly sessionEventKeys = new Set<string>()
  private readonly sessionEventOrder: string[] = []
  private readonly pendingAssistant = new Map<number, string>()
  private readonly lifecycle = new AbortController()
  private readonly operationTimeoutMs: number
  private readonly ackTimeoutMs: number
  private readonly attachmentTimeoutMs: number
  private readonly fileUploads: FileUploadPort | undefined
  private readonly attachments: AttachmentPort | undefined
  /** Last reaction failure kind (null = last attempt succeeded/never failed). */
  private reactionFailure: ReactionFailureKind | null = null
  private stopped = false
  private stopPromise: Promise<void> | undefined

  constructor(private readonly options: OmniBridgeOptions) {
    this.logger = options.logger ?? silentLogger
    this.retry = options.retry ?? DEFAULT_RETRY
    this.now = options.now ?? (() => new Date())
    this.sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
    this.onError = options.onError ?? (() => {})
    this.operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS
    this.ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS
    this.attachmentTimeoutMs = options.attachmentTimeoutMs ?? DEFAULT_ATTACHMENT_TIMEOUT_MS
    this.fileUploads = options.fileUploads
    this.attachments = options.attachments
  }

  async start(): Promise<void> {
    await this.bounded(() => this.options.gateway.start())
  }

  /** ACK immediately: Feishu requires its event callback to finish within 3s. */
  receive(event: FeishuMessageEvent): Promise<void> {
    if (this.stopped) return Promise.resolve()
    const task = this.queue.run(() => this.processInbound(event)).catch((error: unknown) => {
      this.onError(error)
      this.logger.warn('Inbound Feishu message failed')
    })
    void task.catch(() => {})
    return Promise.resolve()
  }

  /** Mirror committed human and assistant messages, never streams/tool progress. */
  sessionEvent(sessionId: string, event: SessionEventLike): Promise<void> {
    if (this.stopped) return Promise.resolve()
    const task = this.queue.run(() => this.processSessionEvent(sessionId, event)).catch((error: unknown) => {
      this.onError(error)
      this.logger.warn('Session event broadcast failed')
    })
    void task.catch(() => {})
    return Promise.resolve()
  }

  async drain(): Promise<void> {
    await this.queue.drain()
  }

  sendTest(): Promise<TestResult> {
    return this.queue.run(() => this.broadcast('[Feishu Omni] 测试消息：DSH 与飞书连接正常。', `test:${this.now().toISOString()}`))
  }

  stop(): Promise<void> {
    if (this.stopPromise !== undefined) return this.stopPromise
    this.stopped = true
    this.lifecycle.abort(new Error('Feishu Omni bridge stopped'))
    this.queue.close()
    this.stopPromise = (async () => {
      await this.queue.drain()
      await this.options.gateway.stop()
    })()
    return this.stopPromise
  }

  private async processInbound(event: FeishuMessageEvent): Promise<void> {
    const extracted = extractInboundMessage(event)
    if (extracted.kind === 'ignored') return
    const message = extracted.message
    const keys = [`message:${message.messageId}`, `event:${message.eventId}`]
    if (keys.some(key => this.options.state.snapshot().recentEventIds.includes(key))) return

    // Bind before prompting so a later configuration fix can reach this user.
    const at = this.now().toISOString()
    await this.options.state.update(current => ({
      ...current,
      bindings: [
        ...current.bindings.filter(binding => binding.openId !== message.openId),
        {
          openId: message.openId, chatId: message.chatId, label: message.label,
          createdAt: current.bindings.find(binding => binding.openId === message.openId)?.createdAt ?? at,
          updatedAt: at,
        },
      ],
    }))

    const sessionId = this.options.state.snapshot().sessionId
    if (sessionId === null) throw new Error('No DSH Session is bound')
    const requestId = `${REQUEST_PREFIX}${message.messageId}:${message.chatId}`

    let staged: StagedInbound = { prompt: [], mirrors: [] }
    if (message.attachments.length > 0) {
      try {
        staged = await this.stageInboundAttachments(message, sessionId)
      } catch (error) {
        // A format/size/download failure is terminal: do not prompt, do not ack,
        // tell the sender why in plain text, and persist the dedupe keys so a
        // Feishu redelivery cannot spam the same notice.
        await this.degradeInbound(message, error, keys)
        return
      }
    }

    try {
      await this.promptWithRetry({
        sessionId,
        requestId,
        text: this.promptText(message),
        ...(staged.prompt.length === 0 ? {} : { attachments: staged.prompt }),
      })
    } catch (error) {
      const reason = attachmentRejectionReason(error)
      if (reason !== undefined) {
        // DSH refused the attachment payload (e.g. the selected model has no
        // image input). Retrying the same receipts cannot succeed.
        await this.degradeInbound(message, error, keys)
        return
      }
      // The Feishu handler has already ACKed, so a terminal DSH admission
      // failure must be visible to the sender rather than only to Settings.
      try {
        await this.bounded(() => this.options.gateway.sendText(
          message.chatId,
          '[Feishu Omni] 消息暂时无法投递到绑定的 DSH Session，请稍后重试。',
          uuidFor(`prompt-error:${message.messageId}`),
          this.lifecycle.signal,
        ))
      } catch {
        // Preserve the Session admission error; notification delivery is best effort.
      }
      throw error
    }
    // Persist dedupe keys before the ack: a redelivery must never react twice,
    // and a slow/failed reaction must never look like an unprocessed message.
    await this.options.state.update(current => appendRecentKeys(current, keys))
    await this.acknowledge(message.messageId)
    if (staged.mirrors.length > 0) await this.mirrorInboundAttachments(message, staged.mirrors)
  }

  /** `[飞书 · label]` plus the text body and one placeholder per attachment. */
  private promptText(message: InboundMessage): string {
    const parts: string[] = []
    if (message.text) parts.push(message.text)
    for (const attachment of message.attachments) parts.push(promptPlaceholder(attachment))
    return `[飞书 · ${message.label}]\n${parts.join('\n')}`
  }

  /**
   * Download every attachment and stage it through DSH's own upload service so
   * prompt admission receives opaque receipts. Images must sniff to one of the
   * four DSH-accepted media types before staging; files stream straight into
   * the attachment store and keep a bounded copy for the Feishu mirror.
   */
  private async stageInboundAttachments(message: InboundMessage, sessionId: string): Promise<StagedInbound> {
    const uploads = this.fileUploads
    if (uploads === undefined) {
      throw new AttachmentFailure('DSH attachment upload service is unavailable', 'upload')
    }
    const prompt: PromptAttachment[] = []
    const mirrors: StagedMirror[] = []
    for (const attachment of message.attachments) {
      if (attachment.type === 'image') {
        const staged = await this.stageInboundImage(message, attachment, sessionId, uploads)
        prompt.push({ receiptId: staged.receiptId, kind: 'image' })
        mirrors.push(staged.mirror)
      } else {
        const staged = await this.stageInboundFile(message, attachment, sessionId, uploads)
        prompt.push({ receiptId: staged.receiptId, kind: 'file' })
        mirrors.push(staged.mirror)
      }
    }
    return { prompt, mirrors }
  }

  private async stageInboundImage(
    message: InboundMessage,
    attachment: InboundAttachment,
    sessionId: string,
    uploads: FileUploadPort,
  ): Promise<{ receiptId: string; mirror: StagedMirror }> {
    const signal = this.attachmentSignal()
    let download: DownloadedResource
    try {
      download = await this.bounded(
        () => this.options.gateway.downloadResource(message.messageId, attachment.key, 'image', signal),
        this.attachmentTimeoutMs,
      )
    } catch (error) {
      throw asAttachmentFailure(error, 'download', 'Feishu image resource download failed')
    }
    let bytes: Uint8Array
    try {
      bytes = await this.bounded(
        () => readAllBounded(download.data, INBOUND_IMAGE_MAX_BYTES, 'image'),
        this.attachmentTimeoutMs,
      )
    } catch (error) {
      throw asAttachmentFailure(error, 'download', 'Feishu image resource download failed')
    }
    if (bytes.byteLength === 0) throw new AttachmentFailure('Feishu image resource is empty', 'download')
    const mediaType = imageMediaType(bytes)
    if (mediaType === undefined) {
      const format = unsupportedImageFormat(bytes)
      throw new AttachmentFailure(
        'Feishu image uses a format DSH cannot prompt',
        'unsupported-image',
        { detail: format ?? 'unknown' },
      )
    }
    let staged: StagedUpload
    try {
      staged = await this.bounded(
        () => uploads.uploadImageStream({
          sessionId,
          data: oneChunk(bytes),
          mediaType,
          signal,
          name: `image.${mediaTypeExtension(mediaType)}`,
        }),
        this.attachmentTimeoutMs,
      )
    } catch (error) {
      throw asAttachmentFailure(error, 'upload', 'DSH attachment staging failed')
    }
    return {
      receiptId: staged.receiptId,
      mirror: {
        attachment,
        placeholder: mirrorPlaceholder(attachment),
        bytes,
        ...(staged.image === undefined ? {} : { imageRef: staged.image }),
      },
    }
  }

  private async stageInboundFile(
    message: InboundMessage,
    attachment: InboundAttachment,
    sessionId: string,
    uploads: FileUploadPort,
  ): Promise<{ receiptId: string; mirror: StagedMirror }> {
    const signal = this.attachmentSignal()
    let download: DownloadedResource
    try {
      download = await this.bounded(
        () => this.options.gateway.downloadResource(message.messageId, attachment.key, 'file', signal),
        this.attachmentTimeoutMs,
      )
    } catch (error) {
      throw asAttachmentFailure(error, 'download', 'Feishu file resource download failed')
    }
    const fileName = inboundFileName(attachment)
    const collector = collectingStream(
      download.data, INBOUND_FILE_MAX_BYTES, FEISHU_FILE_MAX_BYTES, 'file',
    )
    let receiptId: string
    try {
      const staged = await this.bounded(
        () => uploads.uploadStream({ sessionId, data: collector.data, signal, name: fileName }),
        this.attachmentTimeoutMs,
      )
      receiptId = staged.receiptId
    } catch (error) {
      // Staging failed before the stream was fully consumed; release the socket.
      await download.cancel()
      throw asAttachmentFailure(error, 'upload', 'DSH attachment staging failed')
    }
    const bytes = collector.collected()
    return {
      receiptId,
      mirror: {
        attachment,
        placeholder: mirrorPlaceholder(attachment),
        ...(bytes === undefined ? {} : { bytes }),
        fileName,
        fileType: feishuFileType(fileName),
      },
    }
  }

  /**
   * Tell the sender why an attachment could not be admitted, persist dedupe
   * keys, and never acknowledge (the message did not reach the Session).
   */
  private async degradeInbound(
    message: InboundMessage,
    error: unknown,
    keys: readonly string[],
  ): Promise<void> {
    const notice = this.degradationNotice(error)
    this.logger.warn(`Feishu inbound attachment degraded: ${safeMessage(error)}`)
    try {
      await this.sendWithRetry(message.chatId, `[Feishu Omni] ${notice}`, uuidFor(`degrade:${message.messageId}`))
    } catch {
      // sendWithRetry never throws; keep the guard for future changes.
    }
    await this.options.state.update(current => appendRecentKeys(current, keys))
  }

  /** User-facing reason for one refused inbound attachment. */
  private degradationNotice(error: unknown): string {
    if (error instanceof AttachmentFailure) {
      switch (error.reason) {
        case 'unsupported-image': {
          const format = error.detail === undefined || error.detail === 'unknown'
            ? ''
            : `${error.detail.toUpperCase()} `
          return `图片格式${format ? ` ${format.trim()}` : ''}暂不支持，支持 PNG/JPEG/WEBP/GIF；HEIC/BMP/TIFF 请先转成 PNG/JPEG 后重新发送。`
        }
        case 'too-large':
          return `附件超过大小限制（图片 ≤${formatBytes(INBOUND_IMAGE_MAX_BYTES)}，文件 ≤${formatBytes(INBOUND_FILE_MAX_BYTES)}），未投递到 Session。`
        case 'download':
          return '附件下载失败，未投递到 Session，请稍后重试。'
        case 'normalize':
        case 'upload':
          return '附件无法写入 DSH 附件服务，未投递到 Session，请稍后重试或改发文字。'
      }
    }
    const reason = attachmentRejectionReason(error)
    if (reason === 'MODEL_DOES_NOT_SUPPORT_IMAGES') {
      return '当前绑定的模型不支持图片输入，图片未投递到 Session；请改用支持视觉的模型或改发文字。'
    }
    if (error instanceof Error && error.message.includes('timed out')) {
      return '附件处理超时，未投递到 Session，请稍后重试。'
    }
    return '附件未能被 Session 接收，未投递到 Session，请稍后重试或改发文字。'
  }

  /**
   * Re-deliver the already downloaded resources to every other bound chat, the
   * same visibility rule used for mirrored text. The sender never sees their
   * own attachment echoed; each upload is shared across recipients and every
   * send uses a deterministic per-chat UUID. Failures only reach the log.
   */
  private async mirrorInboundAttachments(message: InboundMessage, mirrors: readonly StagedMirror[]): Promise<void> {
    const bindings = this.options.state.snapshot().bindings
    const recipients = bindings.filter(binding => binding.chatId !== message.chatId)
    if (recipients.length === 0) return
    for (const [index, mirror] of mirrors.entries()) {
      const resource = await this.uploadMirrorResource(mirror)
      for (const binding of recipients) {
        const uuid = uuidFor(`attach:${message.messageId}:${binding.chatId}:${index}`)
        try {
          if (resource.kind === 'image') {
            await this.bounded(
              () => this.options.gateway.sendImage(binding.chatId, resource.key, uuid, this.attachmentSignal()),
              this.attachmentTimeoutMs,
            )
          } else if (resource.kind === 'file') {
            await this.bounded(
              () => this.options.gateway.sendFile(binding.chatId, resource.key, uuid, this.attachmentSignal()),
              this.attachmentTimeoutMs,
            )
          } else {
            // Placeholder text is best-effort like every other mirror write: a
            // failure must not reach Settings' connection error or block peers.
            await this.bounded(() => this.options.gateway.sendText(
              binding.chatId, mirror.placeholder, uuid, this.attachmentSignal(),
            ), this.attachmentTimeoutMs)
          }
        } catch (error) {
          this.logger.warn(`Feishu attachment mirror delivery failed: ${safeMessage(error)}`)
        }
      }
    }
  }

  /** Upload one mirror resource once so every recipient chat can reuse the key. */
  private async uploadMirrorResource(mirror: StagedMirror): Promise<MirrorResource> {
    if (mirror.attachment.type === 'image') {
      if (mirror.bytes !== undefined && mirror.bytes.byteLength <= FEISHU_IMAGE_MAX_BYTES) {
        try {
          const key = await this.bounded(
            () => this.options.gateway.uploadImage(mirror.bytes as Uint8Array, this.attachmentSignal()),
            this.attachmentTimeoutMs,
          )
          return { kind: 'image', key }
        } catch (error) {
          this.logger.warn(`Feishu image mirror upload failed: ${safeMessage(error)}`)
        }
      }
      // Oversize raw images: DSH already normalized the prompt copy; re-upload
      // that bounded form instead of inventing another image pipeline.
      if (mirror.imageRef !== undefined && this.attachments !== undefined) {
        try {
          const stored = await this.bounded(
            () => (this.attachments as AttachmentPort).readImage(mirror.imageRef, this.attachmentSignal()),
            this.attachmentTimeoutMs,
          )
          if (stored.data.byteLength > 0 && stored.data.byteLength <= FEISHU_IMAGE_MAX_BYTES
            && imageMediaType(stored.data) !== undefined) {
            const key = await this.bounded(
              () => this.options.gateway.uploadImage(stored.data, this.attachmentSignal()),
              this.attachmentTimeoutMs,
            )
            return { kind: 'image', key }
          }
        } catch (error) {
          this.logger.warn(`Feishu normalized image mirror upload failed: ${safeMessage(error)}`)
        }
      }
      return { kind: 'placeholder' }
    }
    if (mirror.bytes === undefined || mirror.fileName === undefined) return { kind: 'placeholder' }
    try {
      const key = await this.bounded(
        () => this.options.gateway.uploadFile(
          mirror.bytes as Uint8Array,
          mirror.fileName as string,
          mirror.fileType ?? 'stream',
          this.attachmentSignal(),
        ),
        this.attachmentTimeoutMs,
      )
      return { kind: 'file', key }
    } catch (error) {
      this.logger.warn(`Feishu file mirror upload failed: ${safeMessage(error)}`)
      return { kind: 'placeholder' }
    }
  }

  /**
   * Best-effort `OK` reaction on the original Feishu message. It never retries,
   * never throws, and never reaches `onError`/connection status: ack failures
   * (missing scope, rate limit, recalled message, network) must not affect
   * prompt admission or broadcast. The warning is logged once per failure kind
   * state change so a missing permission cannot flood the Host log per message.
   * Each warning carries a sanitized `code=/status=/msg=` detail: the bare axios
   * message cannot tell a recalled message from an out-of-range user.
   */
  private async acknowledge(messageId: string): Promise<void> {
    try {
      // The signal also cancels the in-flight HTTP request at the same bound, so
      // a stalled reaction cannot linger until the SDK's own 15s HTTP timeout.
      const signal = AbortSignal.any([this.lifecycle.signal, AbortSignal.timeout(this.ackTimeoutMs)])
      await this.bounded(
        () => this.options.gateway.addReaction(messageId, ACK_EMOJI, signal),
        this.ackTimeoutMs,
      )
      if (this.reactionFailure !== null) {
        this.reactionFailure = null
        this.logger.info('Feishu reaction ack recovered')
      }
    } catch (error) {
      if (this.stopped) return
      const kind = reactionFailureKind(error)
      if (kind === this.reactionFailure) return
      this.reactionFailure = kind
      const detail = reactionFailureDetail(error)
      if (kind === 'permission') {
        this.logger.warn(
          'Feishu reaction ack failed: the app lacks the im:message.reactions:write_only '
          + '(or im:message) scope; grant it in the Feishu developer console and publish a new app version '
          + `(${detail})`,
        )
        return
      }
      if (kind === 'rate-limit') {
        this.logger.warn(
          'Feishu reaction ack failed (rate-limit; the API allows 1000 reactions/min and 50/s): '
          + detail,
        )
        return
      }
      this.logger.warn(`Feishu reaction ack failed (other): ${detail}`)
    }
  }

  private async processSessionEvent(sessionId: string, event: SessionEventLike): Promise<void> {
    if (sessionId !== this.options.state.snapshot().sessionId) return
    const supported = event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'turn/end'
    if (!supported || (event.type !== 'turn/end' && event.surfaceOp !== 'append')) return
    const key = `${sessionId}:${event.seq}:${event.type}`
    if (this.sessionEventKeys.has(key)) return
    this.sessionEventKeys.add(key)
    this.sessionEventOrder.push(key)
    if (this.sessionEventOrder.length > MAX_SESSION_EVENT_KEYS) {
      const oldest = this.sessionEventOrder.shift()
      if (oldest !== undefined) this.sessionEventKeys.delete(oldest)
    }

    if (event.type === 'assistant/message') {
      const data = event.data as {
        turn?: unknown
        interrupted?: unknown
        message?: { content?: unknown }
      } | undefined
      if (data?.interrupted === true) return
      if (typeof data?.turn !== 'number') return
      const rawText = textOf(data.message?.content)
      if (rawText) this.pendingAssistant.set(data.turn, rawText)
      return
    }
    if (event.type === 'turn/end') {
      const data = event.data as { turn?: unknown; reason?: unknown } | undefined
      const turn = data?.turn
      if (typeof turn !== 'number') return
      const rawText = this.pendingAssistant.get(turn)
      this.pendingAssistant.delete(turn)
      const reason = typeof data?.reason === 'object' && data.reason !== null
        ? (data.reason as { kind?: unknown }).kind
        : data?.reason
      // Aborted, failed, blocked and token-truncated turns are not final replies.
      if (reason === 'completed' && rawText !== undefined) await this.broadcastAssistant(rawText, key)
      return
    }

    const data = messageData(event.data)
    if (data?.source?.kind !== 'user') return
    const rawText = textOf(data.content)
    if (!rawText) return
    const source = (event.data as { source?: { rpcId?: unknown } }).source
    const origin = parsePromptOrigin(source?.rpcId)
    const text = origin.feishu ? rawText : `[DSH]\n${rawText}`
    // The sender already has this message in their own Feishu chat; mirror it to
    // everyone else. A prompt origin that cannot be decoded broadcasts to all
    // (a possible one-off echo) rather than hiding the message from other users.
    await this.broadcast(text, key, origin.chatId)
  }

  private async broadcast(text: string, key: string, exceptChatId?: string): Promise<TestResult> {
    const bindings = this.options.state.snapshot().bindings
    let sent = 0
    let failed = 0
    // One queue and recipient-at-a-time writes keep ordering deterministic.
    for (const binding of bindings) {
      if (exceptChatId !== undefined && binding.chatId === exceptChatId) continue
      const ok = await this.sendWithRetry(binding.chatId, text, uuidFor(`${key}:${binding.chatId}`))
      if (ok) sent += 1
      else failed += 1
    }
    return { sent, failed }
  }

  /**
   * Final assistant replies are rendered as Markdown cards. Chunking happens
   * once per turn so every recipient receives the same deterministic split and
   * the same per-part UUIDs.
   */
  private async broadcastAssistant(markdown: string, key: string): Promise<TestResult> {
    const bindings = this.options.state.snapshot().bindings
    const chunks = splitAssistantMarkdown(markdown)
    let sent = 0
    let failed = 0
    for (const binding of bindings) {
      const ok = await this.sendAssistantChunks(binding.chatId, chunks, key)
      if (ok) sent += 1
      else failed += 1
    }
    return { sent, failed }
  }

  private async sendAssistantChunks(chatId: string, chunks: readonly string[], key: string): Promise<boolean> {
    const total = chunks.length
    for (let index = 0; index < total; index += 1) {
      if (this.stopped) return false
      const markdown = chunks[index] ?? ''
      const uuid = uuidFor(`${key}:${chatId}:part:${index}`)
      const ok = await this.sendCardWithFallback(chatId, markdown, assistantCardTitle(index + 1, total), uuid)
      // Stop instead of posting a reply with a missing middle part.
      if (!ok) return false
    }
    return true
  }

  /**
   * Deliver one Markdown card part with the plain-text fallback ladder:
   * transient failures retry the same UUID, a rejected payload falls back to
   * text (the server proved nothing was created), permanent recipient errors
   * stop immediately, and an ambiguous outcome also falls back to text with
   * the *same* UUID — Feishu allows at most one successful message per UUID in
   * an hour, so the fallback can never duplicate a card that actually landed.
   */
  private async sendCardWithFallback(
    chatId: string,
    markdown: string,
    title: string,
    uuid: string,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < this.retry.attempts; attempt += 1) {
      if (this.stopped) return false
      try {
        await this.bounded(() => this.options.gateway.sendMarkdown(
          chatId, markdown, uuid, this.lifecycle.signal, { title },
        ))
        return true
      } catch (error) {
        if (this.stopped) return false
        const kind = deliveryFailureKind(error)
        if (isRetryableDelivery(error) && attempt < this.retry.attempts - 1) {
          await this.bounded(() => this.sleep(Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** attempt)))
          continue
        }
        // A permanent recipient failure (bot removed, revoked token, ...) is
        // not repaired by re-sending the same text.
        if (kind === 'permanent') {
          this.onError(error)
          this.logger.warn('Feishu assistant card delivery failed permanently')
          return false
        }
        this.logger.warn('Feishu assistant card delivery failed; falling back to plain text')
        return this.sendWithRetry(chatId, assistantFallbackText(markdown, title), uuid)
      }
    }
    return false
  }

  private async promptWithRetry(input: PromptInput): Promise<void> {
    for (let attempt = 0; attempt < this.retry.attempts; attempt += 1) {
      if (this.stopped) throw new Error('Feishu Omni bridge stopped before Session admission')
      try {
        await this.bounded(() => this.options.sessions.prompt(input, this.lifecycle.signal))
        return
      } catch (error) {
        if (this.stopped || attempt === this.retry.attempts - 1 || !isRetryable(error)) throw error
        // A terminal attachment rejection cannot become admissible by retrying.
        if (attachmentRejectionReason(error) !== undefined) throw error
        await this.bounded(() => this.sleep(Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** attempt)))
      }
    }
  }

  private async sendWithRetry(chatId: string, text: string, uuid: string): Promise<boolean> {
    for (let attempt = 0; attempt < this.retry.attempts; attempt += 1) {
      if (this.stopped) return false
      try {
        await this.bounded(() => this.options.gateway.sendText(chatId, text, uuid, this.lifecycle.signal))
        return true
      } catch (error) {
        if (this.stopped) return false
        const terminal = attempt === this.retry.attempts - 1 || !isRetryable(error)
        if (terminal) {
          this.onError(error)
          this.logger.warn('Feishu recipient delivery failed')
          return false
        }
        await this.bounded(() => this.sleep(Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** attempt)))
      }
    }
    return false
  }

  /** Bound every external wait and reject immediately when stop aborts it. */
  private bounded<T>(operation: () => Promise<T>, timeoutMs = this.operationTimeoutMs): Promise<T> {
    const signal = this.lifecycle.signal
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => finish(reject, new Error('Feishu Omni operation timed out')), timeoutMs)
      timer.unref()
      const finish = (callback: (value: T) => void, value: T | unknown): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        callback(value as T)
      }
      const onAbort = () => finish(reject, signal.reason ?? new Error('Feishu Omni bridge stopped'))
      signal.addEventListener('abort', onAbort, { once: true })
      Promise.resolve().then(operation).then(
        value => finish(resolve, value),
        error => finish(reject, error),
      )
      if (signal.aborted) onAbort()
    })
  }

  /** Bounded cancellation for one attachment download/upload round. */
  private attachmentSignal(): AbortSignal {
    return AbortSignal.any([this.lifecycle.signal, AbortSignal.timeout(this.attachmentTimeoutMs)])
  }
}
