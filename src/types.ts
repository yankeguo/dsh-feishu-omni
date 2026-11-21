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

export interface PromptInput {
  readonly sessionId: string
  readonly requestId: string
  readonly text: string
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
