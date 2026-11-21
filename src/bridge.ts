import { createHash } from 'node:crypto'
import { open, readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  assistantCardTitle, assistantFallbackText, closesFence, openingFence, splitAssistantMarkdown,
  type FenceInfo,
} from './card.ts'
import {
  AttachmentFailure, FEISHU_FILE_MAX_BYTES, FEISHU_IMAGE_MAX_BYTES, INBOUND_FILE_MAX_BYTES,
  INBOUND_IMAGE_MAX_BYTES, collectingStream, feishuFileType, formatBytes, imageMediaType,
  mediaTypeExtension, readAllBounded, unsupportedImageFormat, type SupportedImageMediaType,
} from './attachments.ts'
import {
  attachmentErrorClass, attachmentErrorCode, attachmentRejectionReason, deliveryFailureKind, httpStatusOf,
  isRetryable, isRetryableDelivery, providerFailureDetail, reactionFailureDetail, reactionFailureKind,
  safeMessage, silentLogger, type AttachmentRejectionClass, type Logger, type ReactionFailureKind,
} from './errors.ts'
import { extractInboundMessage, type FeishuMessageEvent, type InboundAttachment, type InboundMessage } from './events.ts'
import { localFileRoots, resolveLocalFile, type DeniedLocalFile } from './paths.ts'
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
/** One inbound message may carry at most this many attachments (matches DSH's 20-image prompt cap). */
const MAX_INBOUND_ATTACHMENTS = 20
/**
 * Per-message budget for the raw mirror copies kept after staging. The copies
 * exist only to re-upload to other bound chats; past this budget the mirror
 * falls back to DSH-normalized images or placeholder text instead of retaining
 * tens of megabytes of raw bytes.
 */
const MAX_INBOUND_MIRROR_BYTES = 60 * 1024 * 1024

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
  // Truncate by code point so a display name can never end in a lone surrogate.
  return chosen.length > MAX_DISPLAY_NAME_LENGTH
    ? [...chosen].slice(0, MAX_DISPLAY_NAME_LENGTH).join('')
    : chosen
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

/**
 * Find an AttachmentFailure inside a wrapped provider/DSH error chain. The DSH
 * file-upload service wraps non-Remote errors as `gateway/internal` with a
 * `cause`, and a stream abort inside the generator can arrive nested.
 */
function unwrapAttachmentFailure(error: unknown): AttachmentFailure | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 4; depth += 1) {
    if (current instanceof AttachmentFailure) return current
    if (typeof current !== 'object' || current === null || !('cause' in current)) return undefined
    current = (current as { readonly cause?: unknown }).cause
  }
  return undefined
}

/** Normalize any gateway/service failure into a classified attachment failure. */
function asAttachmentFailure(
  error: unknown,
  reason: 'download' | 'upload',
  message: string,
): AttachmentFailure {
  const nested = unwrapAttachmentFailure(error)
  if (nested !== undefined) return nested
  const rejection = attachmentRejectionReason(error)
  const classified = attachmentFailureOf(rejection ?? attachmentErrorCode(error), error)
  if (classified !== undefined) return classified
  if (rejection === 'FILE_TOO_LARGE') {
    return new AttachmentFailure('Feishu file exceeds the DSH admission limit', 'too-large', { cause: error })
  }
  return new AttachmentFailure(message, reason, { cause: error })
}

/**
 * Classify one stable DSH attachment code into a specific degradation.
 *
 * DSH 0.2.2-rc.5 `ctx.fileUploads` wraps every `AttachmentError` into
 * `RemoteError('session/attachment-invalid', { reason: code })` before it
 * crosses the upload call, and prompt admission reports the same shape; both
 * therefore reach {@link attachmentRejectionReason}. A raw `AttachmentError`
 * is matched structurally as a fallback for other/older compositions. Neither
 * form can be recognized by `instanceof` across package copies, and without
 * this mapping an image rejected for pixels/dimensions would fall back to the
 * generic "attachment service failed" notice.
 */
function attachmentFailureOf(code: string | undefined, error: unknown): AttachmentFailure | undefined {
  switch (code === undefined ? undefined : attachmentErrorClass(code)) {
    case 'image-bytes':
      return new AttachmentFailure('Image exceeds the DSH attachment byte limit', 'image-bytes', { cause: error })
    case 'image-pixels':
      return new AttachmentFailure('Image exceeds the DSH attachment pixel/dimension limit', 'image-pixels', { cause: error })
    case 'unsupported-image':
      return new AttachmentFailure('Image type is not accepted by DSH', 'unsupported-image', { cause: error })
    case 'invalid-image':
      return new AttachmentFailure('Image bytes are corrupt or type-mismatched', 'invalid-image', { cause: error })
    case 'too-many-images':
      return new AttachmentFailure('Message carries more images than DSH accepts', 'too-many-images', { cause: error })
    default:
      return undefined
  }
}

/** Sender-facing notice for one DSH image admission rejection class. */
function imageRejectionNotice(kind: AttachmentRejectionClass): string {
  switch (kind) {
    case 'image-bytes':
      return '图片超过 DSH 附件服务的字节上限，未投递到 Session，请压缩后重试。'
    case 'image-pixels':
      return '图片像素或尺寸超过 DSH 附件服务上限，未投递到 Session，请缩小后重试。'
    case 'unsupported-image':
      return '图片格式暂不支持，支持 PNG/JPEG/WEBP/GIF，请转换后重新发送。'
    case 'invalid-image':
      return '图片数据无效或已损坏，未投递到 Session，请重新发送。'
    case 'too-many-images':
      return '单条消息图片数量超过 DSH 附件服务上限，未投递到 Session。'
  }
}

/**
 * Sender-facing reason for one refused outbound file. Only the file name and
 * (best-effort) size are ever forwarded; the local path never is.
 */
function deliverableDenialReason(reason: DeniedLocalFile['reason']): string {
  switch (reason) {
    case 'no-cwd':
      return '无法解析相对路径（Session 工作目录未知）'
    case 'no-roots':
      return '无法确定会话工作区或 DSH 附件目录'
    case 'outside-roots':
      return '文件不在会话工作区或 DSH 附件目录内'
    case 'missing':
      return '文件不存在或不可读'
    case 'not-file':
      return '不是普通文件'
    case 'empty':
      return '文件为空'
  }
}

/** Upper bound for the presented-file buffer of one turn; present itself caps a call at 8. */
const MAX_PRESENTED_FILES = 32
/** Bounded memory of ended turns, so a late `deliverables/presented` is never buffered. */
const MAX_ENDED_TURNS = 256
/** Never read a deliverable larger than this while preparing an outbound message. */
const MAX_DELIVERABLE_READ_BYTES = 50 * 1024 * 1024
/** Image reference inside assistant Markdown: `![alt](<path with spaces>)`. */
const MARKDOWN_IMAGE_REF = /!\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^)\n]+?)\s*\)/g
/** Paths that are never local attachment files. */
const NON_PATH_TARGET = /^(?:[a-z][a-z0-9+.-]*:|#)/i
/** An image handled by Feishu itself (already-uploaded image_key). */
const IMAGE_KEY_TARGET = /^img_[A-Za-z0-9_-]+$/
/** Inline code span: one or more backticks, content, the same backtick run. */
const INLINE_CODE = /(`+)[\s\S]*?\1/g

/** One file declared by the `present` tool. */
interface PresentedFile {
  readonly path: string
  readonly description?: string
}

interface PresentedBatch {
  readonly turn: number
  readonly files: readonly PresentedFile[]
}

function presentedFileOf(value: unknown): PresentedFile | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const row = value as { readonly path?: unknown; readonly description?: unknown }
  if (typeof row.path !== 'string' || row.path.trim().length === 0) return undefined
  return {
    path: row.path,
    ...(typeof row.description === 'string' ? { description: row.description } : {}),
  }
}

/** Validate one `deliverables/presented` event payload. */
function presentedBatchOf(data: unknown): PresentedBatch | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const row = data as { readonly turn?: unknown; readonly files?: unknown }
  if (typeof row.turn !== 'number' || !Number.isSafeInteger(row.turn) || row.turn < 0) return undefined
  if (!Array.isArray(row.files)) return undefined
  const files: PresentedFile[] = []
  for (const value of row.files) {
    const file = presentedFileOf(value)
    if (file !== undefined) files.push(file)
  }
  if (files.length === 0) return undefined
  return { turn: row.turn, files }
}

/**
 * Display name for one deliverable: basename only, never a local path. Long
 * names are truncated in the stem so the extension survives; Feishu documents
 * that `file_name` must carry a suffix.
 */
function deliverableName(path: string): string {
  const cleaned = basename(path).replace(/[\p{Cc}]+/gu, ' ').trim()
  const chosen = cleaned.length > 0 ? cleaned : 'file.bin'
  if (chosen.length <= MAX_DISPLAY_NAME_LENGTH) return chosen
  const dot = chosen.lastIndexOf('.')
  const extension = dot > 0 && chosen.length - dot <= 16 ? chosen.slice(dot) : ''
  const stem = extension === '' ? chosen : chosen.slice(0, dot)
  const budget = Math.max(1, MAX_DISPLAY_NAME_LENGTH - extension.length)
  return `${[...stem].slice(0, budget).join('')}${extension}`
}

/** Ensure a Feishu upload name carries an extension (a documented requirement). */
function uploadFileName(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name : `${name}.bin`
}

/** Log-safe fs failure marker: the error code only, never the absolute path. */
function fileErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code
  }
  return 'unknown error'
}

/** Blank out inline code spans while preserving string length and offsets. */
function maskInlineCode(line: string): string {
  if (!line.includes('`')) return line
  return line.replace(INLINE_CODE, match => ' '.repeat(match.length))
}

/**
 * Column width of the leading whitespace of one line, with CommonMark tab stops
 * of four columns (a tab advances to the next multiple of four).
 */
function leadingColumns(line: string): number {
  let column = 0
  for (const char of line) {
    if (char === ' ') column += 1
    else if (char === '\t') column += 4 - (column % 4)
    else break
  }
  return column
}

/** Columns contributed by a run of spaces/tabs that starts at `startColumn`. */
function whitespaceColumns(text: string, startColumn: number): number {
  let column = 0
  for (const char of text) {
    if (char === ' ') column += 1
    else if (char === '\t') column += 4 - ((startColumn + column) % 4)
  }
  return column
}

/** Optional blockquote container marker (0-3 leading spaces, `>`, optional space). */
const BLOCKQUOTE_PREFIX = /^ {0,3}> ?/
/** List item marker plus the whitespace run that follows it. */
const LIST_MARKER = /^ {0,3}(?:[-+*]|\d{1,9}[.)])([ \t]+)/

/**
 * True when one line starts a CommonMark indented code block: content indented
 * by at least four columns after any blockquote/list container markers.
 *
 * Deliberately conservative — content indented four columns inside a nested
 * list is treated as code too. The only cost of a false positive is that an
 * image reference there stays Markdown text instead of becoming an inline
 * image, never a wrong upload.
 */
function isIndentedCodeLine(line: string): boolean {
  let content = line
  // Containers can interleave (`- >     code`, `- -     code`), so consume
  // blockquote/list markers until neither matches. Each step removes at least
  // one marker character, so the loop always terminates.
  for (let depth = 0; depth < 16; depth += 1) {
    const quote = BLOCKQUOTE_PREFIX.exec(content)
    if (quote !== null) {
      content = content.slice(quote[0].length)
      continue
    }
    const item = LIST_MARKER.exec(content)
    if (item === null) break
    const whitespace = item[1] ?? ''
    const markerEnd = item[0].length - whitespace.length
    // CommonMark consumes one to four columns after a list marker as the item's
    // content indentation; a larger run leaves the content indented 4+ columns,
    // which is an indented code block.
    if (whitespaceColumns(whitespace, markerEnd) > 4) return true
    content = content.slice(item[0].length)
  }
  return leadingColumns(content) >= 4
}

/** CommonMark backslash escape: an odd run of backslashes directly before `index`. */
function isEscaped(line: string, index: number): boolean {
  let backslashes = 0
  for (let cursor = index - 1; cursor >= 0 && line[cursor] === '\\'; cursor -= 1) backslashes += 1
  return backslashes % 2 === 1
}

/** Strip Markdown `<...>` destination brackets. */
function stripAngle(target: string): string {
  const trimmed = target.trim()
  return trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1).trim() : trimmed
}

/** Read only the leading bytes of a file, for format sniffing before a full read. */
async function readFileHead(path: string, bytes: number): Promise<Uint8Array> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const result = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, result.bytesRead)
  } finally {
    await handle.close()
  }
}

/** One prepared outbound deliverable, uploaded once and shared by every recipient. */
type PreparedDeliverable =
  | { readonly kind: 'image'; readonly key: string; readonly name: string; readonly size: number }
  | { readonly kind: 'file'; readonly key: string; readonly name: string; readonly size: number }
  | {
    readonly kind: 'degraded'
    readonly name: string
    readonly size?: number
    readonly reason: string
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
  /** Latest known working directory for one Session, used to resolve relative paths. */
  readonly sessionCwd?: (sessionId: string) => string | undefined
  /**
   * Additional upload roots besides the Session cwd. The Host supplies the DSH
   * attachment store (`$DSH_HOME/attachments/v1`), so an agent can present a
   * file it received as an inbound attachment. Resolved lazily so a provider
   * reload cannot leave a stale path.
   */
  readonly attachmentRoots?: () => readonly string[]
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
  /** Presented files buffered per turn until that turn ends. */
  private readonly pendingPresented = new Map<number, PresentedFile[]>()
  /** Bounded set of turns whose `turn/end` already ran; late present events are dropped. */
  private readonly endedTurns = new Set<number>()
  private readonly endedTurnOrder: number[] = []
  /** Last cwd resolved by fallback `SessionPort.list`, keyed by Session. */
  private readonly cwdCache = new Map<string, string>()
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

  /** Record one ended turn; bounded so a long-lived bridge cannot grow forever. */
  private markTurnEnded(turn: number): void {
    if (this.endedTurns.has(turn)) return
    this.endedTurns.add(turn)
    this.endedTurnOrder.push(turn)
    if (this.endedTurnOrder.length > MAX_ENDED_TURNS) {
      const oldest = this.endedTurnOrder.shift()
      if (oldest !== undefined) this.endedTurns.delete(oldest)
    }
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
    if (message.attachments.length > MAX_INBOUND_ATTACHMENTS) {
      throw new AttachmentFailure(
        `Feishu message carried ${message.attachments.length} attachments (limit ${MAX_INBOUND_ATTACHMENTS})`,
        'too-many',
      )
    }
    const prompt: PromptAttachment[] = []
    const mirrors: StagedMirror[] = []
    // One shared budget bounds the raw bytes retained for the mirror fan-out.
    const mirrorBudget = { remaining: MAX_INBOUND_MIRROR_BYTES }
    for (const attachment of message.attachments) {
      if (attachment.type === 'image') {
        const staged = await this.stageInboundImage(message, attachment, sessionId, uploads, mirrorBudget)
        prompt.push({ receiptId: staged.receiptId })
        mirrors.push(staged.mirror)
      } else {
        const staged = await this.stageInboundFile(message, attachment, sessionId, uploads, mirrorBudget)
        prompt.push({ receiptId: staged.receiptId })
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
    mirrorBudget: { remaining: number },
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
    // Content-Length and the sniffable head let an unsupported/oversize image
    // fail before any body byte is buffered.
    if (download.size !== undefined && download.size > INBOUND_IMAGE_MAX_BYTES) {
      await download.cancel()
      throw new AttachmentFailure('Feishu image exceeds the inbound byte bound', 'too-large')
    }
    if (download.head.byteLength === 0) {
      await download.cancel()
      throw new AttachmentFailure('Feishu image resource is empty', 'download')
    }
    const headMediaType = imageMediaType(download.head)
    if (headMediaType === undefined) {
      await download.cancel()
      const format = unsupportedImageFormat(download.head)
      throw new AttachmentFailure(
        'Feishu image uses a format DSH cannot prompt',
        'unsupported-image',
        { detail: format ?? 'unknown' },
      )
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
    const mediaType = imageMediaType(bytes) ?? headMediaType
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
    // Only a copy that Feishu can accept as-is is worth retaining for the
    // mirror; larger images fall back to the DSH-normalized prompt copy.
    const keepBytes = bytes.byteLength <= FEISHU_IMAGE_MAX_BYTES && bytes.byteLength <= mirrorBudget.remaining
    if (keepBytes) mirrorBudget.remaining -= bytes.byteLength
    return {
      receiptId: staged.receiptId,
      mirror: {
        attachment,
        placeholder: mirrorPlaceholder(attachment),
        ...(keepBytes ? { bytes } : {}),
        ...(staged.image === undefined ? {} : { imageRef: staged.image }),
      },
    }
  }

  private async stageInboundFile(
    message: InboundMessage,
    attachment: InboundAttachment,
    sessionId: string,
    uploads: FileUploadPort,
    mirrorBudget: { remaining: number },
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
    if (download.size !== undefined && download.size > INBOUND_FILE_MAX_BYTES) {
      await download.cancel()
      throw new AttachmentFailure('Feishu file exceeds the inbound byte bound', 'too-large')
    }
    const fileName = inboundFileName(attachment)
    // Retain a mirror copy only while the per-message budget allows it.
    const collectBytes = Math.max(0, Math.min(FEISHU_FILE_MAX_BYTES, mirrorBudget.remaining))
    const collector = collectingStream(
      download.data, INBOUND_FILE_MAX_BYTES, collectBytes, 'file',
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
    if (bytes !== undefined) mirrorBudget.remaining -= bytes.byteLength
    return {
      receiptId,
      mirror: {
        attachment,
        placeholder: mirrorPlaceholder(attachment),
        ...(bytes === undefined ? {} : { bytes }),
        fileName,
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
    // An abort caused by shutdown/stop is not a terminal payload failure: keep
    // the dedupe keys unwritten so a redelivery after restart can retry.
    if (this.stopped) return
    const notice = this.degradationNotice(error)
    const cause = error instanceof AttachmentFailure && error.cause !== undefined ? error.cause : error
    this.logger.warn(
      `Feishu inbound attachment degraded: ${safeMessage(error)} (${providerFailureDetail(cause)})`,
    )
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
      // The 120s staging bound surfaces as the wrapper's timeout, whichever
      // phase (download or DSH write) hit it.
      if (error.cause instanceof Error && error.cause.message.includes('timed out')) {
        return '附件处理超时，未投递到 Session，请稍后重试。'
      }
      switch (error.reason) {
        case 'unsupported-image': {
          const format = error.detail === undefined || error.detail === 'unknown'
            ? ''
            : ` ${error.detail.toUpperCase()} `
          return `图片格式${format}暂不支持，支持 PNG/JPEG/WEBP/GIF${format.trim() ? `；${format.trim()} 请先转成 PNG/JPEG` : ''}后重新发送。`
        }
        case 'too-large':
          return `附件超过大小限制（图片 ≤${formatBytes(INBOUND_IMAGE_MAX_BYTES)}，文件 ≤${formatBytes(INBOUND_FILE_MAX_BYTES)}），未投递到 Session。`
        case 'download': {
          // A missing download scope is fixed in the Feishu console, not by retrying.
          const kind = reactionFailureKind(error.cause)
          if (kind === 'permission') {
            return '机器人缺少读取消息附件的权限（im:message:readonly / im:message.history:readonly 等），'
              + '请管理员在飞书开放平台授权并发布新应用版本后重试。'
          }
          if (kind === 'rate-limit') {
            return '附件下载触发了飞书限频，未投递到 Session，请稍后重试。'
          }
          const status = httpStatusOf(error.cause)
          if (status !== undefined && status >= 400 && status < 500) {
            return '附件下载失败（资源可能超过 100 MB，或该消息类型不支持下载），未投递到 Session。'
          }
          return '附件下载失败，未投递到 Session，请稍后重试。'
        }
        case 'too-many':
          return `单条消息附件过多（上限 ${MAX_INBOUND_ATTACHMENTS} 个），未投递到 Session。`
        case 'image-bytes':
          return imageRejectionNotice('image-bytes')
        case 'image-pixels':
          return imageRejectionNotice('image-pixels')
        case 'invalid-image':
          return imageRejectionNotice('invalid-image')
        case 'too-many-images':
          return imageRejectionNotice('too-many-images')
        case 'upload':
          return '附件无法写入 DSH 附件服务，未投递到 Session，请稍后重试或改发文字。'
      }
    }
    const reason = attachmentRejectionReason(error)
    if (reason === 'MODEL_DOES_NOT_SUPPORT_IMAGES') {
      return '当前绑定的模型不支持图片输入，图片未投递到 Session；请改用支持视觉的模型或改发文字。'
    }
    // Prompt admission reports the same stable image codes through
    // `session/attachment-invalid` details; keep the notice specific there too.
    const rejectionClass = reason === undefined ? undefined : attachmentErrorClass(reason)
    if (rejectionClass !== undefined) return imageRejectionNotice(rejectionClass)
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
        await this.sendMirrorAttachment(binding.chatId, resource, mirror.placeholder, uuid)
      }
    }
  }

  /**
   * Send one mirrored attachment to one chat. Transient failures retry like the
   * text path; after that the recipient gets the placeholder text with the same
   * UUID (idempotent if the attachment actually landed). Mirror failures stay
   * out of Settings' connection error and never block other recipients.
   */
  private async sendMirrorAttachment(
    chatId: string,
    resource: MirrorResource,
    placeholder: string,
    uuid: string,
  ): Promise<void> {
    try {
      if (resource.kind === 'image') {
        await this.retryOperation(
          () => this.options.gateway.sendImage(chatId, resource.key, uuid, this.attachmentSignal()),
        )
      } else if (resource.kind === 'file') {
        await this.retryOperation(
          () => this.options.gateway.sendFile(chatId, resource.key, uuid, this.attachmentSignal()),
        )
      } else {
        await this.retryOperation(
          () => this.options.gateway.sendText(chatId, placeholder, uuid, this.attachmentSignal()),
        )
      }
      return
    } catch (error) {
      if (this.stopped) return
      this.logger.warn(`Feishu attachment mirror delivery failed: ${safeMessage(error)}`)
      if (resource.kind === 'placeholder') return
      // Same UUID: Feishu's idempotency suppresses a duplicate text when the
      // attachment actually landed but its response was lost.
      try {
        await this.retryOperation(
          () => this.options.gateway.sendText(chatId, placeholder, uuid, this.attachmentSignal()),
        )
      } catch (fallbackError) {
        this.logger.warn(`Feishu attachment mirror placeholder failed: ${safeMessage(fallbackError)}`)
      }
    }
  }

  /** Retry transient Feishu mirror uploads, returning undefined when they fail. */
  private async uploadMirrorWithRetry(operation: () => Promise<string>): Promise<string | undefined> {
    try {
      return await this.retryOperation(operation)
    } catch (error) {
      if (!this.stopped) this.logger.warn(`Feishu attachment mirror upload failed: ${safeMessage(error)}`)
      return undefined
    }
  }

  /** Upload one mirror resource once so every recipient chat can reuse the key. */
  private async uploadMirrorResource(mirror: StagedMirror): Promise<MirrorResource> {
    if (mirror.attachment.type === 'image') {
      if (mirror.bytes !== undefined && mirror.bytes.byteLength <= FEISHU_IMAGE_MAX_BYTES) {
        const kept = mirror.bytes as Uint8Array
        const key = await this.uploadMirrorWithRetry(
          () => this.options.gateway.uploadImage(kept, this.attachmentSignal()),
        )
        if (key !== undefined) return { kind: 'image', key }
      }
      // Oversize raw images: DSH already normalized the prompt copy; re-upload
      // that bounded form instead of inventing another image pipeline.
      if (mirror.imageRef !== undefined && this.attachments !== undefined) {
        try {
          const stored = await this.bounded(
            () => (this.attachments as AttachmentPort).readImage(mirror.imageRef, this.attachmentSignal()),
            this.attachmentTimeoutMs,
          )
          const normalized = stored.data
          if (normalized.byteLength > 0 && normalized.byteLength <= FEISHU_IMAGE_MAX_BYTES
            && imageMediaType(normalized) !== undefined) {
            const key = await this.uploadMirrorWithRetry(
              () => this.options.gateway.uploadImage(normalized, this.attachmentSignal()),
            )
            if (key !== undefined) return { kind: 'image', key }
          }
        } catch (error) {
          this.logger.warn(`Feishu normalized image mirror upload failed: ${safeMessage(error)}`)
        }
      }
      return { kind: 'placeholder' }
    }
    if (mirror.bytes === undefined || mirror.fileName === undefined) return { kind: 'placeholder' }
    const bytes = mirror.bytes as Uint8Array
    const fileName = mirror.fileName as string
    // Reuse the present-path fallback: Feishu documents that `file_name` must
    // carry a suffix, and an inbound file named e.g. `README` has none.
    const uploadName = uploadFileName(fileName)
    // Derive the upload type from the final name: a dotfile like `.env` becomes
    // `.env.bin` and must not keep a misleading document type.
    const key = await this.uploadMirrorWithRetry(
      () => this.options.gateway.uploadFile(bytes, uploadName, feishuFileType(uploadName), this.attachmentSignal()),
    )
    return key === undefined ? { kind: 'placeholder' } : { kind: 'file', key }
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
    const supported = event.type === 'user/message' || event.type === 'assistant/message'
      || event.type === 'turn/end' || event.type === 'deliverables/presented'
    // Present deliveries are log-only events without a surface operation.
    const surfaceOptional = event.type === 'turn/end' || event.type === 'deliverables/presented'
    if (!supported || (!surfaceOptional && event.surfaceOp !== 'append')) return
    const key = `${sessionId}:${event.seq}:${event.type}`
    if (this.sessionEventKeys.has(key)) return
    this.sessionEventKeys.add(key)
    this.sessionEventOrder.push(key)
    if (this.sessionEventOrder.length > MAX_SESSION_EVENT_KEYS) {
      const oldest = this.sessionEventOrder.shift()
      if (oldest !== undefined) this.sessionEventKeys.delete(oldest)
    }

    if (event.type === 'deliverables/presented') {
      const batch = presentedBatchOf(event.data)
      if (batch === undefined) {
        this.logger.warn('Ignoring malformed deliverables/presented session event')
        return
      }
      // A present event that arrives after its turn ended (replay, reordering)
      // can never be delivered; buffering it would leak one map entry per turn.
      if (this.endedTurns.has(batch.turn)) {
        this.logger.warn('Ignoring a deliverables/presented event that arrived after its turn ended')
        return
      }
      const merged = this.pendingPresented.get(batch.turn) ?? []
      let truncated = false
      for (const file of batch.files) {
        if (merged.length >= MAX_PRESENTED_FILES) {
          truncated = true
          break
        }
        if (!merged.some(entry => entry.path === file.path)) merged.push(file)
      }
      if (truncated) {
        this.logger.warn(
          `Feishu deliverable buffer reached its per-turn cap (${MAX_PRESENTED_FILES}); extra files were not delivered`,
        )
      }
      this.pendingPresented.set(batch.turn, merged)
      return
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
      this.markTurnEnded(turn)
      const rawText = this.pendingAssistant.get(turn)
      this.pendingAssistant.delete(turn)
      const presented = this.pendingPresented.get(turn)
      this.pendingPresented.delete(turn)
      const reason = typeof data?.reason === 'object' && data.reason !== null
        ? (data.reason as { kind?: unknown }).kind
        : data?.reason
      // Aborted, failed, blocked and token-truncated turns are not final replies
      // and must not deliver a partial turn's files either.
      if (reason !== 'completed') return
      // Nobody is bound: skip card/inline-image API traffic entirely.
      if (this.options.state.snapshot().bindings.length === 0) return
      // One deterministic rewrite per final reply: inline local images are
      // uploaded once, then every recipient gets the same chunk/UUID sequence.
      const markdown = rawText === undefined
        ? undefined
        : await this.rewriteInlineImages(rawText, presented, sessionId)
      if (markdown !== undefined) await this.broadcastAssistant(markdown, key)
      if (presented !== undefined && presented.length > 0) {
        // Cards first, then the deliverable attachments, preserving turn order.
        await this.sendDeliverables(sessionId, presented, key)
      }
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

  /** Resolve one Session working directory, preferring the event-fed value. */
  private async sessionWorkingDirectory(sessionId: string): Promise<string | undefined> {
    const provided = this.options.sessionCwd?.(sessionId)
    if (provided !== undefined && provided.trim()) return provided
    const cached = this.cwdCache.get(sessionId)
    if (cached !== undefined) return cached
    try {
      // Fallback for a bridge that missed the Session's first events (e.g. after
      // a reconnect): the controller still lists attached and persisted Sessions.
      const sessions = await this.bounded(() => this.options.sessions.list(this.lifecycle.signal))
      const cwd = sessions.find(session => session.sessionId === sessionId)?.cwd ?? undefined
      if (cwd !== undefined && cwd.trim()) this.cwdCache.set(sessionId, cwd)
      return cwd
    } catch {
      return undefined
    }
  }

  /**
   * Real allowed upload roots for one operation: the Session workspace plus the
   * DSH attachment store (so an agent can present/embed a file it received as an
   * inbound attachment). No root is guessed here; the Host supplies the store.
   */
  private async fileRoots(cwd: string | undefined): Promise<readonly string[]> {
    let extra: readonly string[] = []
    try {
      extra = this.options.attachmentRoots?.() ?? []
    } catch {
      // A Host adapter failure must degrade to "not allowed", never to "allow".
      this.logger.warn('Feishu attachment root lookup failed; only the Session workspace is allowed')
    }
    return localFileRoots(cwd, extra)
  }

  /** Upload one contained local image for inline display inside the assistant card. */
  private async inlineImageKey(path: string, size: number): Promise<string | undefined> {
    try {
      if (size > MAX_DELIVERABLE_READ_BYTES) return undefined
      const head = await readFileHead(path, 64)
      const mediaType = imageMediaType(head)
      if (mediaType === undefined) return undefined
      const bytes = await readFile(path)
      if (bytes.byteLength <= FEISHU_IMAGE_MAX_BYTES) {
        try {
          return await this.bounded(
            () => this.options.gateway.uploadImage(bytes, this.attachmentSignal()),
            this.attachmentTimeoutMs,
          )
        } catch (error) {
          // Over-limit or unsupported-dimension images still get one normalized retry.
          this.logger.warn(`Feishu inline image upload failed, retrying after normalization: ${safeMessage(error)}`)
        }
      }
      const normalized = await this.normalizeOutboundImage(bytes, mediaType)
      if (normalized === undefined) return undefined
      return await this.bounded(
        () => this.options.gateway.uploadImage(normalized, this.attachmentSignal()),
        this.attachmentTimeoutMs,
      )
    } catch (error) {
      // fs errors embed the absolute path; log only the error code.
      this.logger.warn(`Feishu inline image rewrite skipped (${fileErrorCode(error)})`)
      return undefined
    }
  }

  /** Resize/normalize one image through DSH's own attachment service. */
  private async normalizeOutboundImage(bytes: Uint8Array, mediaType: string): Promise<Uint8Array | undefined> {
    const attachments = this.attachments
    if (attachments === undefined) return undefined
    try {
      const ref = await this.bounded(
        () => attachments.saveImage({ data: bytes, mediaType }),
        this.attachmentTimeoutMs,
      )
      const stored = await this.bounded(
        () => attachments.readImage(ref, this.attachmentSignal()),
        this.attachmentTimeoutMs,
      )
      if (stored.data.byteLength === 0 || stored.data.byteLength > FEISHU_IMAGE_MAX_BYTES) return undefined
      return stored.data
    } catch (error) {
      this.logger.warn(`Feishu image normalization failed: ${safeMessage(error)}`)
      return undefined
    }
  }

  /**
   * Rewrite local Markdown image references in one final assistant reply into
   * Feishu `image_key`s that the card's markdown element renders inline.
   *
   * A reference is only touched when it points at a real image inside an
   * allowed root (Session workspace or DSH attachment store). Paths already
   * delivered by `present` keep their original text (that path sends a real
   * image message), as do URLs, `image_key`s, fenced/indented code examples,
   * inline code spans, escaped `\![x](path)`, missing files, files outside the
   * allowed roots, non-images and every upload failure. The original Markdown
   * then stays untouched, so it can only render as text, never as local bytes.
   */
  private async rewriteInlineImages(
    markdown: string,
    presented: readonly PresentedFile[] | undefined,
    sessionId: string,
  ): Promise<string> {
    if (!markdown.includes('![')) return markdown
    const lines = markdown.split('\n')
    const candidates: { readonly line: number; readonly match: RegExpExecArray }[] = []
    let fence: FenceInfo | undefined
    for (const [index, line] of lines.entries()) {
      // Use the card splitter's CommonMark fence rules so code examples are
      // never rewritten and the two pipelines agree on block boundaries.
      if (fence !== undefined) {
        if (closesFence(line, fence)) fence = undefined
        continue
      }
      const opened = openingFence(line)
      if (opened !== undefined) {
        fence = opened
        continue
      }
      // CommonMark indented code block (4 columns after blockquote/list
      // containers). Conservative on purpose: a 4-column-indented line inside
      // a nested list is skipped too, which at worst leaves such an image as
      // Markdown text.
      if (isIndentedCodeLine(line)) continue
      // Mask inline code spans so `` `![alt](path)` `` examples are not rewritten;
      // masking keeps offsets aligned with the original line.
      const masked = maskInlineCode(line)
      MARKDOWN_IMAGE_REF.lastIndex = 0
      for (;;) {
        const match = MARKDOWN_IMAGE_REF.exec(masked)
        if (match === null) break
        // `\![alt](path)` is escaped literal text, not an image reference.
        if (isEscaped(masked, match.index)) continue
        candidates.push({ line: index, match })
      }
    }
    if (candidates.length === 0) return markdown
    // Drop URL/image_key references before touching the filesystem: they can
    // never be local files and must not trigger a Session-list cwd fallback.
    const localCandidates = candidates.filter(candidate => {
      const target = stripAngle(candidate.match[2] ?? '')
      return !IMAGE_KEY_TARGET.test(target) && !NON_PATH_TARGET.test(target)
    })
    if (localCandidates.length === 0) return markdown

    const cwd = await this.sessionWorkingDirectory(sessionId)
    const roots = await this.fileRoots(cwd)

    // `present` already delivered its own paths as real image messages; compare
    // real paths so a symlinked present entry still suppresses the duplicate.
    const excluded = new Set<string>()
    for (const file of presented ?? []) {
      const resolution = await resolveLocalFile({ rawPath: file.path, cwd, roots })
      if (resolution.kind === 'ok') excluded.add(resolution.path)
    }

    const keys = new Map<string, string | undefined>()
    const replacements: { readonly line: number; readonly match: RegExpExecArray; key: string }[] = []
    for (const candidate of localCandidates) {
      const rawTarget = stripAngle(candidate.match[2] ?? '')
      const resolution = await resolveLocalFile({ rawPath: rawTarget, cwd, roots })
      if (resolution.kind !== 'ok' || excluded.has(resolution.path)) continue
      const path = resolution.path
      let key = keys.get(path)
      if (key === undefined && !keys.has(path)) {
        key = await this.inlineImageKey(path, resolution.size)
        keys.set(path, key)
      }
      if (key === undefined) continue
      replacements.push({ ...candidate, key })
    }
    if (replacements.length === 0) return markdown

    const byLine = new Map<number, { readonly match: RegExpExecArray; key: string }[]>()
    for (const replacement of replacements) {
      const bucket = byLine.get(replacement.line) ?? []
      bucket.push(replacement)
      byLine.set(replacement.line, bucket)
    }
    const rebuilt = [...lines]
    for (const [lineIndex, bucket] of byLine) {
      let line = rebuilt[lineIndex] ?? ''
      // Replace from the end so earlier match offsets stay valid.
      for (const replacement of bucket.reverse()) {
        const start = replacement.match.index
        const end = start + replacement.match[0].length
        // Take the alt text from the original line: the match was computed on a
        // masked copy where inline code spans were blanked.
        const alt = /^!\[([^\]\n]*)\]/.exec(line.slice(start))?.[1] ?? replacement.match[1] ?? ''
        line = `${line.slice(0, start)}![${alt}](${replacement.key})${line.slice(end)}`
      }
      rebuilt[lineIndex] = line
    }
    return rebuilt.join('\n')
  }

  /**
   * Deliver the files declared by `present` for one completed turn: each file is
   * prepared and uploaded once, then sent to every bound chat with a
   * deterministic per-chat UUID. Per-chat failures degrade to a text notice and
   * never block the other chats or files.
   */
  private async sendDeliverables(sessionId: string, files: readonly PresentedFile[], key: string): Promise<void> {
    const bindings = this.options.state.snapshot().bindings
    if (bindings.length === 0) return
    let cwd: string | undefined
    let roots: readonly string[] | undefined
    for (const [index, file] of files.entries()) {
      if (this.stopped) return
      if (roots === undefined) {
        cwd = await this.sessionWorkingDirectory(sessionId)
        roots = await this.fileRoots(cwd)
      }
      const prepared = await this.prepareDeliverable(file, cwd, roots)
      for (const binding of bindings) {
        if (this.stopped) return
        const uuid = uuidFor(`${key}:${binding.chatId}:deliverable:${index}`)
        await this.deliverPrepared(binding.chatId, prepared, uuid)
      }
    }
  }

  /** Classify, contain, bound and upload one presented file once for all recipients. */
  private async prepareDeliverable(
    file: PresentedFile,
    cwd: string | undefined,
    roots: readonly string[],
  ): Promise<PreparedDeliverable> {
    const name = deliverableName(file.path)
    const resolution = await resolveLocalFile({ rawPath: file.path, cwd, roots })
    if (resolution.kind === 'denied') {
      return {
        kind: 'degraded',
        name,
        ...(resolution.size === undefined ? {} : { size: resolution.size }),
        reason: deliverableDenialReason(resolution.reason),
      }
    }
    const path = resolution.path
    const size = resolution.size
    if (size > MAX_DELIVERABLE_READ_BYTES) {
      return { kind: 'degraded', name, size, reason: `附件超过处理上限（图片单文件需 ≤${formatBytes(MAX_DELIVERABLE_READ_BYTES)}，其他文件需 ≤${formatBytes(FEISHU_FILE_MAX_BYTES)}）` }
    }
    let head: Uint8Array
    try {
      head = await readFileHead(path, 64)
    } catch (error) {
      this.logger.warn(`Feishu deliverable read failed (${fileErrorCode(error)})`)
      return { kind: 'degraded', name, size, reason: '文件读取失败' }
    }
    const mediaType = imageMediaType(head)
    if (mediaType === undefined && size > FEISHU_FILE_MAX_BYTES) {
      // Sniff first: a large non-image must never be read into memory.
      return { kind: 'degraded', name, size, reason: `文件超过 ${formatBytes(FEISHU_FILE_MAX_BYTES)} 上限` }
    }
    let data: Uint8Array
    try {
      data = await readFile(path)
    } catch (error) {
      this.logger.warn(`Feishu deliverable read failed (${fileErrorCode(error)})`)
      return { kind: 'degraded', name, size, reason: '文件读取失败' }
    }
    if (mediaType !== undefined) {
      const imageKey = await this.uploadDeliverableImage(data, mediaType)
      if (imageKey !== undefined) return { kind: 'image', key: imageKey, name, size }
      return { kind: 'degraded', name, size, reason: '图片超过飞书限制且无法规范化' }
    }
    const uploadName = uploadFileName(name)
    try {
      const fileKey = await this.retryOperation(
        () => this.options.gateway.uploadFile(data, uploadName, feishuFileType(uploadName), this.attachmentSignal()),
      )
      return { kind: 'file', key: fileKey, name, size }
    } catch (error) {
      this.logger.warn(`Feishu deliverable file upload failed: ${safeMessage(error)}`)
      return { kind: 'degraded', name, size, reason: '飞书文件上传失败' }
    }
  }

  /** Upload one deliverable image, normalizing first when it exceeds the image cap. */
  private async uploadDeliverableImage(
    data: Uint8Array,
    mediaType: SupportedImageMediaType,
  ): Promise<string | undefined> {
    if (data.byteLength <= FEISHU_IMAGE_MAX_BYTES) {
      try {
        return await this.retryOperation(
          () => this.options.gateway.uploadImage(data, this.attachmentSignal()),
        )
      } catch (error) {
        this.logger.warn(`Feishu deliverable image upload failed, retrying after normalization: ${safeMessage(error)}`)
      }
    }
    const normalized = await this.normalizeOutboundImage(data, mediaType)
    if (normalized === undefined) return undefined
    try {
      return await this.retryOperation(
        () => this.options.gateway.uploadImage(normalized, this.attachmentSignal()),
      )
    } catch (error) {
      this.logger.warn(`Feishu normalized deliverable image upload failed: ${safeMessage(error)}`)
      return undefined
    }
  }

  /** Send one prepared deliverable, degrading to text only when it cannot land. */
  private async deliverPrepared(chatId: string, prepared: PreparedDeliverable, uuid: string): Promise<void> {
    try {
      if (prepared.kind === 'image') {
        await this.retryOperation(
          () => this.options.gateway.sendImage(chatId, prepared.key, uuid, this.attachmentSignal()),
        )
        return
      }
      if (prepared.kind === 'file') {
        await this.retryOperation(
          () => this.options.gateway.sendFile(chatId, prepared.key, uuid, this.attachmentSignal()),
        )
        return
      }
      await this.sendDeliverableNotice(chatId, prepared, uuid)
    } catch (error) {
      this.logger.warn(`Feishu deliverable delivery failed: ${safeMessage(error)}`)
      if (prepared.kind === 'degraded') return
      // Same UUID as the failed attachment: Feishu's idempotency prevents a
      // duplicate text when the attachment actually landed.
      await this.sendDeliverableNotice(chatId, {
        name: prepared.name, size: prepared.size, reason: '发送失败',
      }, uuid)
    }
  }

  /** Tell one chat why a deliverable was not attached, without leaking local paths. */
  private async sendDeliverableNotice(
    chatId: string,
    prepared: { readonly name: string; readonly size?: number; readonly reason: string },
    uuid: string,
  ): Promise<void> {
    const size = prepared.size === undefined ? '' : `（${formatBytes(prepared.size)}）`
    const text = `[Feishu Omni] 交付物「${prepared.name}」${size}未发送：${prepared.reason}`
    try {
      await this.retryOperation(
        () => this.options.gateway.sendText(chatId, text, uuid, this.attachmentSignal()),
      )
    } catch (error) {
      this.logger.warn(`Feishu deliverable notice failed: ${safeMessage(error)}`)
    }
  }

  /**
   * Retry one bounded external operation on retryable provider failures with the
   * same deterministic UUID. Used by deliverable upload/send and mirror paths so
   * a transient rate limit does not turn an attachment into a text notice.
   */
  private async retryOperation<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown
    for (let attempt = 0; attempt < this.retry.attempts; attempt += 1) {
      if (this.stopped) throw new Error('Feishu Omni bridge stopped')
      try {
        return await this.bounded(operation, this.attachmentTimeoutMs)
      } catch (error) {
        lastError = error
        if (this.stopped || attempt === this.retry.attempts - 1 || !isRetryable(error)) throw error
        await this.bounded(() => this.sleep(Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** attempt)))
      }
    }
    throw lastError ?? new Error('Feishu Omni operation failed')
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
