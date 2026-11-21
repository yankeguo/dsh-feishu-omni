import type { AssistantCardOptions } from './card.ts'
import type { FeishuMessageEvent } from './events.ts'
import type { ConnectionPhase, SessionOption } from './public.ts'

export interface Binding {
  readonly openId: string
  readonly chatId: string
  readonly label: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface PersistedState {
  readonly version: 1
  readonly appId: string | null
  readonly sessionId: string | null
  readonly autoConnect: boolean
  readonly bindings: readonly Binding[]
  /** FIFO bounded set; persisted to survive SDK redelivery across restarts. */
  readonly recentEventIds: readonly string[]
}

export interface StateStore {
  load(): Promise<PersistedState>
  snapshot(): PersistedState
  update(mutator: (current: PersistedState) => PersistedState): Promise<PersistedState>
}

/** Host prompt content part mirrored from the DSH Session Controller face. */
export type PromptContentPart =
  | { readonly type: 'text'; readonly text: string }
  /** Opaque DSH upload receipt; the Host resolves it to an ImageBlock or FileBlock. */
  | { readonly type: 'file'; readonly receiptId: string }

/** One staged prompt attachment produced before prompt admission. */
export interface PromptAttachment {
  readonly receiptId: string
  /** Only used for the placeholder text and log lines; the Host decides the block type. */
  readonly kind: 'image' | 'file'
}

export interface PromptInput {
  readonly sessionId: string
  readonly requestId: string
  readonly text: string
  /** Staged attachments appended after the text block, in message order. */
  readonly attachments?: readonly PromptAttachment[]
}

/** Download namespace Feishu's resource API exposes for one message resource. */
export type FeishuResourceType = 'image' | 'file'

/**
 * One in-flight Feishu resource download. `head` is the buffered prefix used
 * for format sniffing; `data` replays those same bytes followed by the rest of
 * the resource exactly once.
 */
export interface DownloadedResource {
  readonly head: Uint8Array
  readonly data: AsyncIterable<Uint8Array>
  /** Release the underlying HTTP stream if `data` will not be consumed. */
  cancel(): Promise<void>
}

/** Result of one DSH attachment-service staging call. */
export interface StagedUpload {
  /** Opaque receipt accepted by `sessionController.prompt` content parts. */
  readonly receiptId: string
  /** Durable normalized image reference for image uploads; opaque to this plugin. */
  readonly image?: unknown
}

/** DSH `ctx.fileUploads` face used for inbound staging. */
export interface FileUploadPort {
  uploadImageStream(request: {
    readonly sessionId: string
    readonly data: AsyncIterable<Uint8Array>
    readonly mediaType: string
    readonly signal?: AbortSignal
    readonly name?: string
  }): Promise<StagedUpload>
  uploadStream(request: {
    readonly sessionId: string
    readonly data: AsyncIterable<Uint8Array>
    readonly signal?: AbortSignal
    readonly name?: string
  }): Promise<StagedUpload>
}

/** DSH `ctx.attachments` face used for outbound image normalization. */
export interface AttachmentPort {
  saveImage(input: {
    readonly data: Uint8Array
    readonly mediaType: string
    readonly name?: string
  }): Promise<unknown>
  readImage(ref: unknown, signal?: AbortSignal): Promise<{ readonly data: Uint8Array }>
}

export interface SessionPort {
  list(signal?: AbortSignal): Promise<readonly SessionOption[]>
  prompt(input: PromptInput, signal?: AbortSignal): Promise<void>
}

export interface SessionEventLike {
  readonly seq: number
  readonly type: string
  readonly surfaceOp?: string | { readonly op: string }
  readonly data?: unknown
}

export type SendMarkdownOptions = AssistantCardOptions

export interface FeishuGateway {
  start(): Promise<void>
  stop(): Promise<void>
  sendText(chatId: string, text: string, uuid: string, signal?: AbortSignal): Promise<void>
  /** Send one Markdown chunk as a Feishu Card JSON 2.0 `markdown` element. */
  sendMarkdown(
    chatId: string,
    markdown: string,
    uuid: string,
    signal?: AbortSignal,
    options?: SendMarkdownOptions,
  ): Promise<void>
  /** Add one emoji reaction to an existing message; a best-effort admission ack. */
  addReaction(messageId: string, emojiType: string, signal?: AbortSignal): Promise<void>
  /** Download one image/file resource of an existing inbound message. */
  downloadResource(
    messageId: string,
    fileKey: string,
    type: FeishuResourceType,
    signal?: AbortSignal,
  ): Promise<DownloadedResource>
  /** Upload image bytes for a `msg_type=image` message; resolves the `image_key`. */
  uploadImage(bytes: Uint8Array, signal?: AbortSignal): Promise<string>
  /** Upload file bytes for a `msg_type=file` message; resolves the `file_key`. */
  uploadFile(bytes: Uint8Array, name: string, fileType: string, signal?: AbortSignal): Promise<string>
  /** Send an `image_key` previously returned by {@link uploadImage}. */
  sendImage(chatId: string, imageKey: string, uuid: string, signal?: AbortSignal): Promise<void>
  /** Send a `file_key` previously returned by {@link uploadFile}. */
  sendFile(chatId: string, fileKey: string, uuid: string, signal?: AbortSignal): Promise<void>
}

export interface GatewayCallbacks {
  readonly onMessage: (event: FeishuMessageEvent) => Promise<void>
  readonly onPhase: (phase: ConnectionPhase, error?: unknown) => void
}

export type GatewayFactory = (appId: string, appSecret: string, callbacks: GatewayCallbacks) => FeishuGateway

export interface CredentialPort {
  set(secret: string): Promise<void>
  resolve(): Promise<string | undefined>
  configured(): Promise<boolean>
}

export interface RetryOptions {
  readonly attempts: number
  readonly baseDelayMs: number
  readonly maxDelayMs: number
}
