/** Browser-safe contracts shared by the Host management route and Client UI. */

export const RPC_ENDPOINT = 'dsh-feishu-omni'
export const CREDENTIAL_REF = 'DSH_FEISHU_OMNI_APP_SECRET'

export type ConnectionPhase = 'unconfigured' | 'disconnected' | 'connecting' | 'connected' | 'error'

export interface PublicError {
  readonly code: string
  readonly message: string
  readonly at: string
}

export interface PublicBinding {
  readonly openId: string
  readonly chatId: string
  readonly label: string
  readonly updatedAt: string
}

export interface OmniStatus {
  readonly appId: string | null
  readonly secretConfigured: boolean
  readonly sessionId: string | null
  readonly autoConnect: boolean
  readonly phase: ConnectionPhase
  readonly lastError: PublicError | null
  readonly lastConnectedAt: string | null
  readonly bindings: readonly PublicBinding[]
}

export interface SessionOption {
  readonly sessionId: string
  readonly title: string
  readonly cwd: string | null
  readonly running: boolean
}

export interface ConfigureInput {
  readonly appId: string
  readonly sessionId: string
  /** A blank/absent value keeps the existing credential and is never echoed back. */
  readonly appSecret?: string
}

export interface TestResult {
  readonly sent: number
  readonly failed: number
}

export interface ManagementPayloadMap {
  readonly status: Record<string, never>
  readonly 'sessions.list': Record<string, never>
  readonly configure: ConfigureInput
  readonly connect: Record<string, never>
  readonly disconnect: Record<string, never>
  readonly test: Record<string, never>
}

export type ManagementMethod = keyof ManagementPayloadMap

export type ManagementResult =
  | { readonly ok: true; readonly value: unknown }
  | {
    readonly ok: false
    readonly error: { readonly code: string; readonly message: string; readonly details: Record<string, never> }
  }
