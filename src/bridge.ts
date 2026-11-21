import { createHash } from 'node:crypto'
import { extractInboundMessage, type FeishuMessageEvent } from './events.ts'
import { isRetryable, silentLogger, type Logger } from './errors.ts'
import type { TestResult } from './public.ts'
import { appendRecentKeys } from './state.ts'
import { SerialQueue } from './serial.ts'
import type {
  FeishuGateway, PromptInput, RetryOptions, SessionEventLike, SessionPort, StateStore,
} from './types.ts'

const DEFAULT_RETRY: RetryOptions = { attempts: 3, baseDelayMs: 500, maxDelayMs: 5000 }
const MAX_SESSION_EVENT_KEYS = 2048
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000

interface TextContent {
  readonly content?: unknown
  readonly source?: { readonly kind?: unknown }
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
  private stopped = false
  private stopPromise: Promise<void> | undefined

  constructor(private readonly options: OmniBridgeOptions) {
    this.logger = options.logger ?? silentLogger
    this.retry = options.retry ?? DEFAULT_RETRY
    this.now = options.now ?? (() => new Date())
    this.sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
    this.onError = options.onError ?? (() => {})
    this.operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS
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
    const requestId = `feishu-omni:${message.messageId}`
    try {
      await this.promptWithRetry({
        sessionId,
        requestId,
        text: `[飞书 · ${message.label}]\n${message.text}`,
      })
    } catch (error) {
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
    await this.options.state.update(current => appendRecentKeys(current, keys))
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
      const data = event.data as { turn?: unknown; message?: { content?: unknown } } | undefined
      if (typeof data?.turn !== 'number') return
      const rawText = textOf(data.message?.content)
      if (rawText) this.pendingAssistant.set(data.turn, rawText)
      return
    }
    if (event.type === 'turn/end') {
      const turn = (event.data as { turn?: unknown } | undefined)?.turn
      if (typeof turn !== 'number') return
      const rawText = this.pendingAssistant.get(turn)
      this.pendingAssistant.delete(turn)
      if (rawText !== undefined) await this.broadcast(`[助手]\n${rawText}`, key)
      return
    }

    const data = messageData(event.data)
    if (data?.source?.kind !== 'user') return
    const rawText = textOf(data.content)
    if (!rawText) return
    const source = (event.data as { source?: { rpcId?: unknown } }).source
    const text = typeof source?.rpcId === 'string' && source.rpcId.startsWith('feishu-omni:')
      ? rawText
      : `[DSH]\n${rawText}`
    await this.broadcast(text, key)
  }

  private async broadcast(text: string, key: string): Promise<TestResult> {
    const bindings = this.options.state.snapshot().bindings
    let sent = 0
    let failed = 0
    // One queue and recipient-at-a-time writes keep ordering deterministic.
    for (const binding of bindings) {
      const ok = await this.sendWithRetry(binding.chatId, text, uuidFor(`${key}:${binding.chatId}`))
      if (ok) sent += 1
      else failed += 1
    }
    return { sent, failed }
  }

  private async promptWithRetry(input: PromptInput): Promise<void> {
    for (let attempt = 0; attempt < this.retry.attempts; attempt += 1) {
      if (this.stopped) throw new Error('Feishu Omni bridge stopped before Session admission')
      try {
        await this.bounded(() => this.options.sessions.prompt(input, this.lifecycle.signal))
        return
      } catch (error) {
        if (this.stopped || attempt === this.retry.attempts - 1 || !isRetryable(error)) throw error
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
  private bounded<T>(operation: () => Promise<T>): Promise<T> {
    const signal = this.lifecycle.signal
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => finish(reject, new Error('Feishu Omni operation timed out')), this.operationTimeoutMs)
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
}
