import type { SessionOption } from '../src/public.ts'
import type {
  CredentialPort, FeishuGateway, PromptInput, SessionPort,
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

export class FakeGateway implements FeishuGateway {
  readonly sent: { chatId: string; text: string; uuid: string }[] = []
  readonly attempts: { chatId: string; text: string; uuid: string }[] = []
  readonly failures = new Map<string, Error[]>()
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

export function assistantEvent(seq = 2, text = 'answer', turn = 1) {
  return {
    seq, type: 'assistant/message', surfaceOp: 'append',
    data: { turn, step: 1, message: { content: [{ type: 'text', text }] } },
  }
}

export function turnEnd(seq = 3, turn = 1) {
  return { seq, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }
}
