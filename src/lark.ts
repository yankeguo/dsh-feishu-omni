import { Buffer } from 'node:buffer'
import * as Lark from '@larksuiteoapi/node-sdk'
import axios from 'axios'
import { buildAssistantCard } from './card.ts'
import { AttachmentFailure } from './attachments.ts'
import type { FeishuMessageEvent } from './events.ts'
import type {
  DownloadedResource, FeishuGateway, GatewayCallbacks, GatewayFactory, SendMarkdownOptions,
} from './types.ts'

const REQUEST_TIMEOUT_MS = 15_000

/** Bytes buffered before returning a download handle, enough for format sniffing. */
const DOWNLOAD_HEAD_BYTES = 64

// Never let SDK request diagnostics serialize App Secret or tenant tokens into
// the Host log. Connection/API failures still reach our redacted status path.
const quietSdkLogger = {
  error() {}, warn() {}, info() {}, debug() {}, trace() {},
}

/** Match the SDK default response unwrapping while adding timeout/cancellation. */
export function createHttpInstance(signal?: AbortSignal) {
  const instance = axios.create({
    timeout: REQUEST_TIMEOUT_MS,
    ...(signal === undefined ? {} : { signal }),
  })
  instance.interceptors.response.use(response => {
    if ((response.config as unknown as Record<string, unknown>)['$return_headers']) {
      return { data: response.data, headers: response.headers }
    }
    return response.data
  })
  return instance
}

/** Narrow SDK face used by tests; production passes the official module. */
export interface LarkSdk {
  readonly Domain: typeof Lark.Domain
  readonly LoggerLevel: typeof Lark.LoggerLevel
  readonly Client: typeof Lark.Client
  readonly WSClient: typeof Lark.WSClient
  readonly EventDispatcher: typeof Lark.EventDispatcher
  readonly DefaultCache: typeof Lark.DefaultCache
}

type MessageType = 'text' | 'interactive' | 'image' | 'file'

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** Yield one buffer as an async iterable accepted by the DSH upload services. */
async function* singleChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes
}


class OfficialFeishuGateway implements FeishuGateway {
  private readonly wsClient: Lark.WSClient
  private readonly dispatcher: Lark.EventDispatcher
  private readonly cache: Lark.DefaultCache
  private started = false

  constructor(
    private readonly sdk: LarkSdk,
    private readonly appId: string,
    private readonly appSecret: string,
    callbacks: GatewayCallbacks,
  ) {
    this.cache = new sdk.DefaultCache()
    this.dispatcher = new sdk.EventDispatcher({}).register({
      'im.message.receive_v1': (event: FeishuMessageEvent) => callbacks.onMessage(event),
    })
    this.wsClient = new sdk.WSClient({
      appId, appSecret,
      domain: sdk.Domain.Feishu,
      logger: quietSdkLogger,
      loggerLevel: sdk.LoggerLevel.error,
      httpInstance: createHttpInstance(),
      handshakeTimeoutMs: REQUEST_TIMEOUT_MS,
      onReady: () => callbacks.onPhase('connected'),
      onReconnecting: () => callbacks.onPhase('connecting'),
      onReconnected: () => callbacks.onPhase('connected'),
      onError: (error: unknown) => callbacks.onPhase('error', error),
    })
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    // WSClient.start() only schedules work; onReady is the actual handshake.
    await this.wsClient.start({ eventDispatcher: this.dispatcher })
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false
    await this.wsClient.close({ force: true })
  }

  async sendText(chatId: string, text: string, uuid: string, signal?: AbortSignal): Promise<void> {
    await this.createMessage(chatId, 'text', JSON.stringify({ text }), uuid, signal)
  }

  /**
   * Assistant replies use Card JSON 2.0 with a single `markdown` element, so
   * headings, lists, fenced code blocks, links and tables render natively.
   * Non-assistant traffic keeps using {@link sendText}.
   */
  async sendMarkdown(
    chatId: string,
    markdown: string,
    uuid: string,
    signal?: AbortSignal,
    options?: SendMarkdownOptions,
  ): Promise<void> {
    const content = buildAssistantCard(markdown, options ?? {})
    await this.createMessage(chatId, 'interactive', content, uuid, signal)
  }

  /**
   * Add one emoji reaction to a user message as a best-effort admission ack.
   * The bot must be in the message's chat and the app needs
   * `im:message.reactions:write_only` (or the wider `im:message`) scope.
   */
  async addReaction(messageId: string, emojiType: string, signal?: AbortSignal): Promise<void> {
    const client = this.createClient(signal)
    const response = await client.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emojiType } },
    })
    if (response.code !== 0) {
      throw Object.assign(
        new Error(`Feishu message reaction create failed with code ${response.code}`),
        { code: response.code },
      )
    }
  }

  /**
   * Open one message resource download. The stream is pulled only far enough to
   * expose a sniffable head; the returned `data` replays the head and then the
   * remainder exactly once, so callers can inspect the format without losing
   * bytes. The request (including the stream) shares the caller's cancellation
   * signal.
   */
  async downloadResource(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
    signal?: AbortSignal,
  ): Promise<DownloadedResource> {
    const client = this.createClient(signal)
    const response = await client.im.v1.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type },
    })
    const stream = response.getReadableStream() as unknown as AsyncIterable<Uint8Array>
    const iterator = stream[Symbol.asyncIterator]()
    const buffered: Uint8Array[] = []
    let bufferedBytes = 0
    let finished = false
    let closed = false
    const close = async (): Promise<void> => {
      if (closed || finished) return
      closed = true
      try {
        await iterator.return?.()
      } catch {
        // Stream teardown is best effort; the HTTP request already failed or was aborted.
      }
    }
    try {
      while (bufferedBytes < DOWNLOAD_HEAD_BYTES) {
        const next = await iterator.next()
        if (next.done === true) {
          finished = true
          break
        }
        const chunk = next.value
        buffered.push(chunk)
        bufferedBytes += chunk.byteLength
      }
    } catch (error) {
      await close()
      throw new AttachmentFailure('Feishu resource download failed', 'download', { cause: error })
    }
    const head = concatChunks(buffered, bufferedBytes)
    if (finished) {
      return { head, data: singleChunk(head), cancel: async () => {} }
    }
    const remaining = async function* rest(): AsyncIterable<Uint8Array> {
      try {
        for (;;) {
          const next = await iterator.next()
          if (next.done === true) return
          yield next.value
        }
      } finally {
        // Cancellation (lifecycle stop, timeout) destroys the HTTP stream.
        await close()
      }
    }()
    // Replay the buffered head, then the still-streaming remainder: callers can
    // sniff the format without losing the bytes they forward to DSH.
    const data = async function* replay(): AsyncIterable<Uint8Array> {
      yield head
      yield* remaining
    }()
    return { head, data, cancel: close }
  }

  /** Upload one image for a `msg_type=image` message and return its `image_key`. */
  async uploadImage(bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
    const client = this.createClient(signal)
    const response = await client.im.v1.image.create({
      data: { image_type: 'message', image: Buffer.from(bytes) },
    })
    const record = response as { image_key?: unknown; code?: unknown } | null
    if (typeof record?.image_key !== 'string' || record.image_key.length === 0) {
      throw Object.assign(
        new AttachmentFailure('Feishu image upload did not return an image_key', 'upload'),
        { ...(typeof record?.code === 'number' ? { code: record.code } : {}) },
      )
    }
    return record.image_key
  }

  /** Upload one file for a `msg_type=file` message and return its `file_key`. */
  async uploadFile(bytes: Uint8Array, name: string, fileType: string, signal?: AbortSignal): Promise<string> {
    const client = this.createClient(signal)
    const response = await client.im.v1.file.create({
      data: {
        file_type: fileType as 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream',
        file_name: name,
        file: Buffer.from(bytes),
      },
    })
    const record = response as { file_key?: unknown; code?: unknown } | null
    if (typeof record?.file_key !== 'string' || record.file_key.length === 0) {
      throw Object.assign(
        new AttachmentFailure('Feishu file upload did not return a file_key', 'upload'),
        { ...(typeof record?.code === 'number' ? { code: record.code } : {}) },
      )
    }
    return record.file_key
  }

  /** Send an image message referencing an uploaded `image_key`. */
  async sendImage(chatId: string, imageKey: string, uuid: string, signal?: AbortSignal): Promise<void> {
    await this.createMessage(chatId, 'image', JSON.stringify({ image_key: imageKey }), uuid, signal)
  }

  /** Send a file message referencing an uploaded `file_key`. */
  async sendFile(chatId: string, fileKey: string, uuid: string, signal?: AbortSignal): Promise<void> {
    await this.createMessage(chatId, 'file', JSON.stringify({ file_key: fileKey }), uuid, signal)
  }

  private createClient(signal?: AbortSignal): Lark.Client {
    // A per-call Client lets Axios cancel both token and request calls with this
    // exact signal. The shared cache retains the SDK's tenant-token reuse.
    return new this.sdk.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: this.sdk.Domain.Feishu,
      logger: quietSdkLogger,
      cache: this.cache,
      httpInstance: createHttpInstance(signal),
    })
  }

  private async createMessage(
    chatId: string,
    messageType: MessageType,
    content: string,
    uuid: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const client = this.createClient(signal)
    const response = await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: messageType,
        content,
        uuid,
      },
    })
    if (response.code !== 0) {
      throw Object.assign(new Error(`Feishu message create failed with code ${response.code}`), { code: response.code })
    }
  }
}

export function createLarkGatewayFactory(sdk: LarkSdk = Lark): GatewayFactory {
  return (appId, appSecret, callbacks) => new OfficialFeishuGateway(sdk, appId, appSecret, callbacks)
}
