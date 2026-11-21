import { OmniBridge } from './bridge.ts'
import { publicError, safeMessage, silentLogger, type Logger } from './errors.ts'
import type { ConfigureInput, ConnectionPhase, OmniStatus, PublicError, SessionOption, TestResult } from './public.ts'
import { SerialQueue } from './serial.ts'
import type {
  CredentialPort, FeishuGateway, GatewayFactory, SessionEventLike, SessionPort, StateStore,
} from './types.ts'

export interface OmniControllerOptions {
  readonly state: StateStore
  readonly sessions: SessionPort
  readonly credentials: CredentialPort
  readonly gatewayFactory: GatewayFactory
  readonly logger?: Logger
  readonly now?: () => Date
}

/** Owns configuration transitions and the single live bridge generation. */
export class OmniController {
  private readonly transition = new SerialQueue()
  private readonly logger: Logger
  private readonly now: () => Date
  private bridge: OmniBridge | undefined
  private generation = 0
  private phase: ConnectionPhase = 'unconfigured'
  private lastError: PublicError | null = null
  private lastConnectedAt: string | null = null
  private readonly secrets = new Set<string>()
  private closing = false
  private closed = false
  private closePromise: Promise<void> | undefined

  constructor(private readonly options: OmniControllerOptions) {
    this.logger = options.logger ?? silentLogger
    this.now = options.now ?? (() => new Date())
  }

  async initialize(): Promise<void> {
    const state = await this.options.state.load()
    this.phase = state.appId === null ? 'unconfigured' : 'disconnected'
    if (state.autoConnect) {
      void this.connect().catch(() => {
        // connect() records a redacted public error; initialization must not
        // prevent the Settings route from loading when the network is down.
      })
    }
  }

  async status(): Promise<OmniStatus> {
    const state = this.options.state.snapshot()
    return {
      appId: state.appId,
      secretConfigured: await this.options.credentials.configured(),
      sessionId: state.sessionId,
      autoConnect: state.autoConnect,
      phase: this.phase,
      lastError: this.lastError,
      lastConnectedAt: this.lastConnectedAt,
      bindings: state.bindings.map(binding => ({
        openId: binding.openId, chatId: binding.chatId, label: binding.label, updatedAt: binding.updatedAt,
      })),
    }
  }

  listSessions(signal?: AbortSignal): Promise<readonly SessionOption[]> {
    return this.options.sessions.list(signal)
  }

  configure(input: ConfigureInput): Promise<OmniStatus> {
    return this.run(() => this.configureValue(input).catch((error: unknown) => {
      throw new Error(safeMessage(error, [...this.secrets]))
    }))
  }

  private async configureValue(input: ConfigureInput): Promise<OmniStatus> {
    const appId = input.appId.trim()
    const sessionId = input.sessionId.trim()
    const suppliedSecret = input.appSecret?.trim()
    const appSecret = suppliedSecret ? suppliedSecret : undefined
    if (!/^cli_[0-9a-fA-F]{16}$/.test(appId)) {
      throw new Error('App ID must use the Feishu cli_ plus 16 hexadecimal characters format')
    }
    if (!sessionId) throw new Error('Select a DSH Session')
    if (appSecret !== undefined && appSecret.length > 512) {
      throw new Error('App Secret must be at most 512 characters')
    }
    const sessions = await this.options.sessions.list()
    if (!sessions.some(session => session.sessionId === sessionId)) throw new Error('The selected DSH Session no longer exists')
    if (appSecret === undefined && !await this.options.credentials.configured()) {
      throw new Error('App Secret is required for the initial configuration')
    }

    await this.stopBridge()
    if (appSecret !== undefined) {
      this.secrets.add(appSecret)
      await this.options.credentials.set(appSecret)
    }
    await this.options.state.update(current => ({ ...current, appId, sessionId }))
    this.phase = 'disconnected'
    this.lastError = null
    return this.status()
  }

  connect(): Promise<OmniStatus> {
    return this.run(async () => {
      await this.options.state.update(current => ({ ...current, autoConnect: true }))
      try {
        await this.startConfigured()
      } catch (error) {
        this.rememberError(error)
        throw new Error(safeMessage(error, [...this.secrets]))
      }
      return this.status()
    })
  }

  disconnect(): Promise<OmniStatus> {
    return this.run(async () => {
      await this.options.state.update(current => ({ ...current, autoConnect: false }))
      await this.stopBridge()
      this.lastError = null
      return this.status()
    })
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    // Set synchronously: operations already queued behind a running connect
    // must re-check this flag when they actually start, not only when enqueued.
    this.closing = true
    // Abort the active bridge immediately; merely queuing stop behind a stalled
    // prompt/send would make plugin disposal wait for the whole retry sequence.
    const activeStop = this.bridge?.stop()
    void activeStop?.catch(() => {})
    this.closePromise = this.transition.run(async () => {
      if (activeStop !== undefined) await activeStop
      await this.stopBridge()
      this.closed = true
      this.transition.close()
    })
    return this.closePromise
  }

  sessionEvent(sessionId: string, event: SessionEventLike): void {
    if (this.closing) return
    const bridge = this.bridge
    if (bridge === undefined) return
    void bridge.sessionEvent(sessionId, event)
  }

  sendTest(): Promise<TestResult> {
    return this.run(async () => {
      if (this.bridge === undefined || this.phase !== 'connected') throw new Error('Connect Feishu before sending a test message')
      return this.bridge.sendTest()
    })
  }

  async drain(): Promise<void> {
    await this.transition.drain()
    await this.bridge?.drain()
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing || this.closed) return Promise.reject(new Error('Feishu Omni controller is stopped'))
    return this.transition.run(async () => {
      if (this.closing || this.closed) throw new Error('Feishu Omni controller is stopped')
      return operation()
    })
  }

  private async startConfigured(): Promise<void> {
    if (this.closing) throw new Error('Feishu Omni controller is stopped')
    const state = this.options.state.snapshot()
    if (state.appId === null || state.sessionId === null) throw new Error('Configure App ID and a DSH Session first')
    const appSecret = await this.options.credentials.resolve()
    if (this.closing) throw new Error('Feishu Omni controller is stopped')
    if (appSecret === undefined) throw new Error('App Secret is missing; enter it again in Settings')
    this.secrets.add(appSecret)
    await this.stopBridge()
    this.phase = 'connecting'
    this.lastError = null
    const generation = ++this.generation
    let bridge: OmniBridge | undefined
    let gateway: FeishuGateway
    try {
      gateway = this.options.gatewayFactory(state.appId, appSecret, {
        onMessage: event => {
          if (bridge === undefined || generation !== this.generation) return Promise.resolve()
          return bridge.receive(event)
        },
        onPhase: (phase, error) => {
          if (generation !== this.generation) return
          this.phase = phase
          if (phase === 'connected') {
            this.lastConnectedAt = this.now().toISOString()
            this.lastError = null
          } else if (phase === 'error') this.rememberError(error ?? new Error('Feishu WebSocket connection failed'))
        },
      })
      bridge = new OmniBridge({
        state: this.options.state,
        sessions: this.options.sessions,
        gateway,
        logger: this.logger,
        now: this.now,
        onError: error => {
          if (generation === this.generation) this.rememberError(error)
        },
      })
      this.bridge = bridge
      await bridge.start()
      if (this.closing || generation !== this.generation) {
        throw new Error('Feishu Omni connection was cancelled')
      }
    } catch (error) {
      if (generation === this.generation) {
        this.bridge = undefined
        this.phase = 'error'
      }
      if (bridge !== undefined) await bridge.stop().catch(() => {})
      throw error
    }
  }

  private async stopBridge(): Promise<void> {
    const bridge = this.bridge
    this.bridge = undefined
    this.generation += 1
    if (bridge !== undefined) await bridge.stop()
    this.phase = this.options.state.snapshot().appId === null ? 'unconfigured' : 'disconnected'
  }

  private rememberError(error: unknown): void {
    this.lastError = publicError(error, this.now, [...this.secrets])
    this.logger.warn(`Feishu Omni: ${this.lastError.message}`)
  }
}
