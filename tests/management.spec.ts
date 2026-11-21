import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { OmniController } from '../src/controller.ts'
import { dispatchManagement, registerManagementRoute } from '../src/management.ts'
import { emptyState, MemoryStateStore } from '../src/state.ts'
import { FakeCredentials, FakeGateway, FakeSessions, SESSION } from './helpers.ts'

function controller() {
  return new OmniController({
    state: new MemoryStateStore(emptyState()),
    sessions: new FakeSessions(),
    credentials: new FakeCredentials(),
    gatewayFactory: () => new FakeGateway(),
  })
}

describe('management dispatch', () => {
  it('returns a typed failure for unknown methods and invalid configure payloads', async () => {
    const unknown = await dispatchManagement(controller(), 'unknown', {})
    expect(unknown.ok).toBe(false)
    const invalid = await dispatchManagement(controller(), 'configure', { appId: 123 })
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error.details).toEqual({})
  })

  it('returns Session options and never adds secrets to status results', async () => {
    const sessions = await dispatchManagement(controller(), 'sessions.list', {})
    expect(sessions).toEqual({ ok: true, value: [SESSION] })
    const status = await dispatchManagement(controller(), 'status', {})
    expect(JSON.stringify(status)).not.toContain('appSecret')
  })
})

describe('management HTTP route', () => {
  async function request(body: unknown, contentType = 'application/json') {
    let route: { fetch(request: Request): Promise<Response> } | undefined
    const ctx = {
      connection: {
        fetch: {
          register(definition: { fetch(request: Request): Promise<Response> }) {
            route = definition
            return () => {}
          },
        },
      },
    } as unknown as Context
    registerManagementRoute(ctx, controller())
    const response = await route!.fetch(new Request('http://127.0.0.1/api/dsh-feishu-omni', {
      method: 'POST', headers: { 'content-type': contentType }, body: JSON.stringify(body),
    }))
    const responseBody = response.headers.get('content-type')?.includes('application/json')
      ? await response.json()
      : await response.text()
    return { status: response.status, body: responseBody }
  }

  it('dispatches a correlated native Connection envelope', async () => {
    const response = await request({
      type: 'client-request', rpcId: 'rpc-1', method: 'dsh-feishu-omni',
      payload: { method: 'status', payload: {} },
    })
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ type: 'server-response', rpcId: 'rpc-1', result: { ok: true } })
  })

  it('rejects malformed envelopes and wrong media types without invoking business logic', async () => {
    const malformed = await request({ type: 'client-request', rpcId: 'rpc-2' })
    expect(JSON.stringify(malformed.body)).toContain('"ok":false')
    const media = await request({}, 'text/plain')
    expect(media.status).toBe(415)
  })
})
