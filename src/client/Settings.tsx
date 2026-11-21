/** Settings surface for the single Feishu Omni application and its bound Session. */

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type {
  ConfigureInput,
  ConnectionPhase,
  OmniStatus,
  SessionOption,
  TestResult,
} from '../public.ts'
import type { FeishuOmniKey } from './locales.ts'
import {
  parseOmniStatus,
  parseSessionOptions,
  parseTestResult,
  unwrapRpcResult,
  type ManagementRpc,
} from './rpc.ts'

export type Translate = (key: FeishuOmniKey, params?: Record<string, unknown>) => string

export interface FeishuOmniSettingsProps {
  readonly rpcCall: ManagementRpc
  readonly t: Translate
}

type Busy = 'save' | 'connect' | 'disconnect' | 'test' | null

type Notice =
  | { readonly kind: 'saved' | 'connected' | 'disconnected' }
  | { readonly kind: 'test'; readonly result: TestResult }

interface Failure {
  readonly message: string
}

const PHASE_LABELS: Record<ConnectionPhase, FeishuOmniKey> = {
  unconfigured: 'status.phase.unconfigured',
  disconnected: 'status.phase.disconnected',
  connecting: 'status.phase.connecting',
  connected: 'status.phase.connected',
  error: 'status.phase.error',
}

function failureOf(error: unknown, secret?: string): Failure {
  let message = error instanceof Error ? error.message.trim() : ''
  if (secret !== undefined && secret.length > 0) message = message.split(secret).join('[redacted]')
  return { message }
}

function timestamp(value: string): string {
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? value : new Date(parsed).toLocaleString()
}

/** The settings component receives its translator and RPC face from the slot. */
export function FeishuOmniSettings({ rpcCall, t }: FeishuOmniSettingsProps) {
  const [status, setStatus] = useState<OmniStatus | null>(null)
  const [sessions, setSessions] = useState<readonly SessionOption[]>([])
  const [appId, setAppId] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [loading, setLoading] = useState(true)
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [busy, setBusy] = useState<Busy>(null)
  const [operationError, setOperationError] = useState<Failure | null>(null)
  const [sessionsError, setSessionsError] = useState<Failure | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(false)
  const busyRef = useRef<Busy>(null)
  const operationVersionRef = useRef(0)

  const loadStatus = useCallback(async (signal: AbortSignal) => {
    setLoading(true)
    setOperationError(null)
    try {
      const result = await rpcCall('status', {}, signal)
      const next = parseOmniStatus(unwrapRpcResult(result))
      if (!mountedRef.current) return
      setStatus(next)
      setAppId(next.appId ?? '')
      setSessionId(next.sessionId ?? '')
      // Never initialize this field from status, even if a drifting Host sends
      // an extra property. The credential projection is boolean-only.
      setAppSecret('')
    } catch (error: unknown) {
      if (mountedRef.current) setOperationError(failureOf(error))
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [rpcCall])

  const refreshSessions = useCallback(async () => {
    const signal = controllerRef.current?.signal
    if (signal === undefined || !mountedRef.current) return
    setSessionsLoading(true)
    setSessionsError(null)
    try {
      const result = await rpcCall('sessions.list', {}, signal)
      const next = parseSessionOptions(unwrapRpcResult(result))
      if (mountedRef.current) setSessions(next)
    } catch (error: unknown) {
      if (mountedRef.current) setSessionsError(failureOf(error))
    } finally {
      if (mountedRef.current) setSessionsLoading(false)
    }
  }, [rpcCall])

  useEffect(() => {
    const timer = setInterval(() => {
      const controller = controllerRef.current
      if (!mountedRef.current || controller === null || busyRef.current !== null) return
      const version = operationVersionRef.current
      void (async () => {
        try {
          const result = await rpcCall('status', {}, controller.signal)
          const next = parseOmniStatus(unwrapRpcResult(result))
          // A slow pre-operation poll must never overwrite a newer action.
          if (mountedRef.current && busyRef.current === null && operationVersionRef.current === version) {
            setStatus(next)
          }
        } catch {
          // Keep the last good status and its visible error during a poll failure.
        }
      })()
    }, 3000)
    return () => clearInterval(timer)
  }, [rpcCall])

  useEffect(() => {
    const controller = new AbortController()
    controllerRef.current = controller
    mountedRef.current = true
    void loadStatus(controller.signal)
    void refreshSessions()
    return () => {
      mountedRef.current = false
      controller.abort()
      if (controllerRef.current === controller) controllerRef.current = null
      busyRef.current = null
    }
  }, [loadStatus, refreshSessions])

  const begin = (kind: Exclude<Busy, null>): AbortSignal | undefined => {
    const signal = controllerRef.current?.signal
    if (signal === undefined || busyRef.current !== null || !mountedRef.current) return undefined
    busyRef.current = kind
    operationVersionRef.current += 1
    setBusy(kind)
    setOperationError(null)
    setNotice(null)
    return signal
  }

  const end = () => {
    busyRef.current = null
    if (mountedRef.current) setBusy(null)
  }

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalizedAppId = appId.trim()
    if (normalizedAppId.length === 0 || sessionId.length === 0) return
    if (status?.secretConfigured !== true && appSecret.trim().length === 0) return
    const signal = begin('save')
    if (signal === undefined) return
    const payload: ConfigureInput = {
      appId: normalizedAppId,
      sessionId,
      ...(appSecret.trim().length > 0 ? { appSecret } : {}),
    }
    try {
      const result = await rpcCall('configure', payload, signal)
      const next = parseOmniStatus(unwrapRpcResult(result))
      if (!mountedRef.current) return
      setStatus(next)
      setAppId(next.appId ?? '')
      setSessionId(next.sessionId ?? '')
      setAppSecret('')
      setNotice({ kind: 'saved' })
    } catch (error: unknown) {
      if (mountedRef.current) setOperationError(failureOf(error, appSecret))
    } finally {
      end()
    }
  }

  const changeConnection = async (kind: 'connect' | 'disconnect') => {
    const signal = begin(kind)
    if (signal === undefined) return
    try {
      const result = await rpcCall(kind, {}, signal)
      const next = parseOmniStatus(unwrapRpcResult(result))
      if (!mountedRef.current) return
      setStatus(next)
      setNotice({ kind: kind === 'connect' ? 'connected' : 'disconnected' })
    } catch (error: unknown) {
      if (mountedRef.current) setOperationError(failureOf(error))
    } finally {
      end()
    }
  }

  const sendTest = async () => {
    const signal = begin('test')
    if (signal === undefined) return
    try {
      const result = await rpcCall('test', {}, signal)
      const next = parseTestResult(unwrapRpcResult(result))
      if (mountedRef.current) setNotice({ kind: 'test', result: next })
    } catch (error: unknown) {
      if (mountedRef.current) setOperationError(failureOf(error))
    } finally {
      end()
    }
  }

  const selectedSession = sessions.find(option => option.sessionId === sessionId)
  const selectedIsListed = selectedSession !== undefined
  const saveDisabled = busy !== null || loading || appId.trim().length === 0 || sessionId.length === 0
    || (status?.secretConfigured !== true && appSecret.trim().length === 0)
  const connectDisabled = busy !== null || status === null || status.phase === 'connected'
    || status.phase === 'connecting' || status.appId === null || !status.secretConfigured
    || status.sessionId === null
  const disconnectDisabled = busy !== null || status === null
    || (status.phase !== 'connected' && status.phase !== 'connecting' && status.phase !== 'error')
  const testDisabled = busy !== null || status?.phase !== 'connected' || status.bindings.length === 0
  const phaseLabel = status === null ? null : t(PHASE_LABELS[status.phase])

  let noticeText: string | null = null
  if (notice?.kind === 'saved') noticeText = t('action.saved')
  else if (notice?.kind === 'connected') noticeText = t('action.connected')
  else if (notice?.kind === 'disconnected') noticeText = t('action.disconnected')
  else if (notice?.kind === 'test') {
    noticeText = t('action.test.result', { sent: notice.result.sent, failed: notice.result.failed })
  }

  return (
    <section className="dfo-page" aria-labelledby="dfo-title">
      <header className="dfo-header">
        <h2 className="dfo-title" id="dfo-title">{t('title')}</h2>
        <p className="dfo-description">{t('description')}</p>
      </header>

      <section className="dfo-card" aria-labelledby="dfo-config-title">
        <div className="dfo-card-heading">
          <div>
            <h3 id="dfo-config-title">{t('config.title')}</h3>
            <p>{t('config.description')}</p>
          </div>
        </div>
        <form className="dfo-form" onSubmit={event => { void save(event) }}>
          <div className="dfo-fields">
            <label className="dfo-field">
              <span className="dfo-label">{t('field.appId')}</span>
              <input
                className="dfo-input"
                value={appId}
                onChange={event => setAppId(event.target.value)}
                placeholder={t('field.appId.placeholder')}
                autoComplete="off"
                spellCheck={false}
                disabled={busy !== null}
                required
              />
            </label>
            <label className="dfo-field">
              <span className="dfo-label">{t('field.appSecret')}</span>
              <input
                className="dfo-input"
                type="password"
                value={appSecret}
                onChange={event => setAppSecret(event.target.value)}
                placeholder={t('field.appSecret.placeholder')}
                autoComplete="new-password"
                spellCheck={false}
                disabled={busy !== null}
                required={status?.secretConfigured === false}
              />
              <p className="dfo-hint">
                {status === null
                  ? t('field.secret.unknown')
                  : status.secretConfigured
                    ? t('field.secret.configured')
                    : t('field.secret.unconfigured')}
              </p>
              <p className="dfo-hint">{t('field.appSecret.keep')}</p>
            </label>
            <label className="dfo-field dfo-field-wide">
              <span className="dfo-label">{t('field.session')}</span>
              <span className="dfo-session-row">
                <select
                  className="dfo-select"
                  value={sessionId}
                  onChange={event => setSessionId(event.target.value)}
                  disabled={busy !== null || sessionsLoading}
                  required
                >
                  <option value="">{t('field.session.placeholder')}</option>
                  {sessionId.length > 0 && !selectedIsListed && (
                    <option value={sessionId}>
                      {t('field.session.currentMissing')} · {sessionId}
                    </option>
                  )}
                  {sessions.map(option => (
                    <option key={option.sessionId} value={option.sessionId}>
                      {option.title} · {option.sessionId} · {t(option.running ? 'field.session.running' : 'field.session.stopped')}
                    </option>
                  ))}
                </select>
                <button
                  className="dfo-button dfo-refresh"
                  type="button"
                  onClick={() => { void refreshSessions() }}
                  disabled={sessionsLoading || busy !== null}
                  aria-busy={sessionsLoading}
                >
                  {sessionsLoading ? t('field.session.refreshing') : t('field.session.refresh')}
                </button>
              </span>
              {sessions.length === 0 && !sessionsLoading && <p className="dfo-hint">{t('field.session.empty')}</p>}
              {selectedSession?.cwd != null && (
                <p className="dfo-hint">{t('field.session.cwd', { cwd: selectedSession.cwd })}</p>
              )}
            </label>
          </div>
          <div className="dfo-actions">
            <button className="dfo-button dfo-button-primary" type="submit" disabled={saveDisabled} aria-busy={busy === 'save'}>
              {busy === 'save' ? t('action.saving') : t('action.save')}
            </button>
          </div>
        </form>
      </section>

      <section className="dfo-card" aria-labelledby="dfo-status-title">
        <div className="dfo-card-heading">
          <div>
            <h3 id="dfo-status-title">{t('status.title')}</h3>
          </div>
          {status !== null && <span className="dfo-phase" data-phase={status.phase}>{phaseLabel}</span>}
        </div>
        {loading ? (
          <p className="dfo-loading" role="status">{t('status.loading')}</p>
        ) : status === null ? (
          <p className="dfo-empty">{t('status.unavailable')}</p>
        ) : (
          <>
            <dl className="dfo-status-grid">
              <div className="dfo-status-item">
                <dt>{t('status.phase')}</dt>
                <dd>{phaseLabel}</dd>
              </div>
              <div className="dfo-status-item">
                <dt>{t('status.bindings')}</dt>
                <dd>{status.bindings.length}</dd>
              </div>
              <div className="dfo-status-item">
                <dt>{t('status.autoConnect')}</dt>
                <dd>{t(status.autoConnect ? 'status.enabled' : 'status.disabled')}</dd>
              </div>
              <div className="dfo-status-item">
                <dt>{t('status.lastConnectedAt')}</dt>
                <dd>{status.lastConnectedAt === null ? t('status.never') : timestamp(status.lastConnectedAt)}</dd>
              </div>
            </dl>
            {status.lastError !== null && (
              <div className="dfo-error" role="alert">
                <strong>{t('status.lastError')}</strong>
                <span>{status.lastError.message}</span>
                <code>{status.lastError.code}</code>
                <span className="dfo-error-time">
                  {t('status.errorAt', { at: timestamp(status.lastError.at) })}
                </span>
              </div>
            )}
            <div className="dfo-actions">
              <button
                className="dfo-button dfo-button-primary"
                type="button"
                onClick={() => { void changeConnection('connect') }}
                disabled={connectDisabled}
                aria-busy={busy === 'connect'}
              >
                {busy === 'connect' ? t('action.connecting') : t('action.connect')}
              </button>
              <button
                className="dfo-button dfo-button-danger"
                type="button"
                onClick={() => { void changeConnection('disconnect') }}
                disabled={disconnectDisabled}
                aria-busy={busy === 'disconnect'}
              >
                {busy === 'disconnect' ? t('action.disconnecting') : t('action.disconnect')}
              </button>
            </div>
          </>
        )}
      </section>

      <section className="dfo-card" aria-labelledby="dfo-test-title">
        <div className="dfo-card-heading">
          <div>
            <h3 id="dfo-test-title">{t('test.title')}</h3>
            <p>{t('test.description')}</p>
          </div>
        </div>
        {status !== null && status.bindings.length === 0 && <p className="dfo-hint">{t('status.noBindings')}</p>}
        <div className="dfo-actions">
          <button
            className="dfo-button"
            type="button"
            onClick={() => { void sendTest() }}
            disabled={testDisabled}
            aria-busy={busy === 'test'}
          >
            {busy === 'test' ? t('action.testing') : t('action.test')}
          </button>
        </div>
      </section>

      {sessionsError !== null && (
        <div className="dfo-error" role="alert">{sessionsError.message || t('error.unknown')}</div>
      )}
      {operationError !== null && (
        <div className="dfo-error" role="alert">{operationError.message || t('error.unknown')}</div>
      )}
      {noticeText !== null && <p className="dfo-notice" role="status" aria-live="polite">{noticeText}</p>}
    </section>
  )
}
