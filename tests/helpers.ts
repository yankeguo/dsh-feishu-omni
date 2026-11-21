import type { SessionOption } from '../src/public.ts'
import type {
  CredentialPort, FeishuGateway, PromptInput, SendMarkdownOptions, SessionPort,
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
      message_type: 'text',
      content: JSON.stringify({ text: overrides.text ?? 'hello' }),
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

export class FakeGateway implements FeishuGateway {
  readonly sent: FakeTextSend[] = []
  readonly attempts: FakeTextSend[] = []
  readonly cards: FakeCardSend[] = []
  readonly cardAttempts: FakeCardSend[] = []
  /** Injected failures for `sendText`, consumed in order per chat. */
  readonly failures = new Map<string, Error[]>()
  /** Injected failures for `sendMarkdown`, consumed in order per chat. */
  readonly cardFailures = new Map<string, Error[]>()
  starts = 0
  stops = 0

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

export function userEvent(seq = 1, text = 'hello', rpcId = 'feishu-omni:om_1') {
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
