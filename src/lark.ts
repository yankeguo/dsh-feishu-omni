import * as Lark from '@larksuiteoapi/node-sdk'
import axios from 'axios'
import { buildAssistantCard } from './card.ts'
import type { FeishuMessageEvent } from './events.ts'
import type { FeishuGateway, GatewayCallbacks, GatewayFactory, SendMarkdownOptions } from './types.ts'

const REQUEST_TIMEOUT_MS = 15_000

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
    messageType: 'text' | 'interactive',
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
