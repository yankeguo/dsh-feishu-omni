import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OmniController } from '../src/controller.ts'
import { dispatchManagement } from '../src/management.ts'
import { emptyState, FileStateStore, MemoryStateStore } from '../src/state.ts'
import type { GatewayCallbacks } from '../src/types.ts'
import { FakeCredentials, FakeGateway, FakeSessions, SESSION } from './helpers.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

/** chmod does not block reads/renames as root and is ignored on Windows. */
const skipPermissionTests = process.getuid?.() === 0 || process.platform === 'win32'

function setup(initial = emptyState()) {
  const state = new MemoryStateStore(initial)
  const sessions = new FakeSessions()
  const credentials = new FakeCredentials()
  const gateways: FakeGateway[] = []
  const callbacks: GatewayCallbacks[] = []
  const secrets: string[] = []
  const logs: string[] = []
  const controller = new OmniController({
    state, sessions, credentials,
    gatewayFactory: (_appId, secret, callback) => {
      secrets.push(secret)
      callbacks.push(callback)
      const gateway = new FakeGateway()
      gateways.push(gateway)
      return gateway
    },
    logger: { info: message => logs.push(message), warn: message => logs.push(message), error: message => logs.push(message) },
  })
  return { state, sessions, credentials, gateways, callbacks, secrets, logs, controller }
}

describe('OmniController', () => {
  it('saves configuration without echoing or logging App Secret', async () => {
    const { controller, state, credentials, logs } = setup()
    const status = await controller.configure({ appId: 'cli_0123456789abcdef', sessionId: SESSION.sessionId, appSecret: 'secret-fixture' })
    expect(credentials.secret).toBe('secret-fixture')
    expect(state.snapshot()).toMatchObject({ appId: 'cli_0123456789abcdef', sessionId: SESSION.sessionId, autoConnect: false })
    expect(status).toMatchObject({ secretConfigured: true, phase: 'disconnected' })
    expect(JSON.stringify(status)).not.toContain('secret-fixture')
    expect(logs.join('\n')).not.toContain('secret-fixture')
  })

  it('keeps the existing secret when the replacement field is blank and rejects missing initial credentials', async () => {
    const first = setup()
    await expect(first.controller.configure({ appId: 'cli_0123456789abcdef', sessionId: SESSION.sessionId })).rejects.toThrow(/App Secret/)
    const { controller, credentials } = setup()
    await controller.configure({ appId: 'cli_0123456789abcdef', sessionId: SESSION.sessionId, appSecret: 'secret-fixture' })
    await controller.configure({ appId: 'cli_0123456789abcdef', sessionId: SESSION.sessionId, appSecret: '' })
    expect(credentials.secret).toBe('secret-fixture')
    await expect(controller.configure({ appId: 'cli_0123456789abcdef', sessionId: 'deleted', appSecret: '' })).rejects.toThrow(/no longer exists/)
  })

  it('rejects malformed App IDs before the SDK can remain silently connecting', async () => {
    const { controller, credentials } = setup()
    await expect(controller.configure({ appId: 'not-an-app-id', sessionId: SESSION.sessionId, appSecret: 'secret-fixture' }))
      .rejects.toThrow(/cli_/)
    expect(credentials.secret).toBeUndefined()
  })

  it('rejects cli_test because the SDK requires exactly 16 hexadecimal characters', async () => {
    const { controller, credentials } = setup()
    await expect(controller.configure({ appId: 'cli_test', sessionId: SESSION.sessionId, appSecret: 'secret-fixture' }))
      .rejects.toThrow(/16 hexadecimal/)
    expect(credentials.secret).toBeUndefined()
  })

  it('connects with the stored secret, persists auto-connect, and disconnects cleanly', async () => {
    const initial = { ...emptyState(), appId: 'cli_0123456789abcdef', sessionId: SESSION.sessionId }
    const { controller, state, credentials, gateways, callbacks, secrets } = setup(initial)
    credentials.secret = 'secret-fixture'
    await controller.initialize()
    const connecting = await controller.connect()
    expect(connecting.phase).toBe('connecting')
    callbacks[0]?.onPhase('connected')
    expect((await controller.status()).phase).toBe('connected')
    expect(secrets).toEqual(['secret-fixture'])
    expect(state.snapshot().autoConnect).toBe(true)
    expect(gateways[0]?.starts).toBe(1)
    expect(await controller.sendTest()).toEqual({ sent: 0, failed: 0 })
    await controller.disconnect()
    expect(gateways[0]?.stops).toBe(1)
    expect(state.snapshot().autoConnect).toBe(false)
    await expect(controller.sendTest()).rejects.toThrow(/Connect Feishu/)
  })

  it('redacts a credential provider failure that echoes the submitted Secret', async () => {
    const { controller, credentials } = setup()
    credentials.set = async secret => { throw new Error(`credential write failed: ${secret}`) }
    const result = await dispatchManagement(controller, 'configure', {
      appId: 'cli_0123456789abcdef', sessionId: SESSION.sessionId, appSecret: 'secret-fixture',
    })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('secret-fixture')
    expect(JSON.stringify(result)).toContain('[redacted]')
  })

  it('does not run queued connections or resurrect a gateway after close', async () => {
    const state = new MemoryStateStore({
      ...emptyState(), appId: 'cli_0123456789abcdef', sessionId: SESSION.sessionId,
    })
    const credentials = new FakeCredentials()
    credentials.secret = 'secret-fixture'
    const gateways: FakeGateway[] = []
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const controller = new OmniController({
      state,
      sessions: new FakeSessions(),
      credentials,
      gatewayFactory: () => {
        const gateway = new FakeGateway()
        gateway.start = () => gate
        gateways.push(gateway)
        return gateway
      },
    })
    const first = controller.connect()
    await vi.waitFor(() => expect(gateways).toHaveLength(1))
    const second = controller.connect()
    const firstOutcome = expect(first).rejects.toThrow()
    const secondOutcome = expect(second).rejects.toThrow(/stopped/)
    const closing = controller.close()
    release?.()
    await Promise.all([firstOutcome, secondOutcome, closing])
    expect(gateways).toHaveLength(1)
    expect(gateways[0]?.stops).toBe(1)
    await expect(controller.connect()).rejects.toThrow(/stopped/)
  })

  it('initializes with a corrupt state quarantined and remains configurable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dfo-controller-corrupt-'))
    directories.push(directory)
    const path = join(directory, 'state.json')
    await writeFile(path, '{bad json')
    const state = new FileStateStore(path)
    const credentials = new FakeCredentials()
    const controller = new OmniController({
      state,
      sessions: new FakeSessions(),
      credentials,
      gatewayFactory: () => new FakeGateway(),
    })
    await expect(controller.initialize()).resolves.toBeUndefined()
    const status = await controller.status()
    expect(status).toMatchObject({ appId: null, sessionId: null, phase: 'unconfigured', bindings: [] })
    expect(status.lastError?.message).toContain('state.json.corrupt-')
    const quarantined = (await readdir(directory)).filter(name => name.startsWith('state.json.corrupt-'))
    expect(quarantined).toHaveLength(1)
    expect(await readFile(join(directory, quarantined[0] ?? ''), 'utf8')).toBe('{bad json')

    await controller.configure({
      appId: 'cli_0123456789abcdef', sessionId: SESSION.sessionId, appSecret: 'secret-fixture',
    })
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      appId: 'cli_0123456789abcdef', sessionId: SESSION.sessionId,
    })
    expect((await controller.status()).lastError).toBeNull()
    await controller.close()
  })

  it.skipIf(skipPermissionTests)('fails initialization on state I/O errors instead of quarantining', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dfo-controller-io-'))
    directories.push(directory)
    const path = join(directory, 'state.json')
    await writeFile(path, JSON.stringify(emptyState()))
    await chmod(path, 0o000)
    try {
      const state = new FileStateStore(path)
      const controller = new OmniController({
        state,
        sessions: new FakeSessions(),
        credentials: new FakeCredentials(),
        gatewayFactory: () => new FakeGateway(),
      })
      // Only StateRecoveryError is absorbed; an unreadable file must surface.
      await expect(controller.initialize()).rejects.toMatchObject({ code: 'EACCES' })
      expect(await readdir(directory)).toEqual(['state.json'])
    } finally {
      await chmod(path, 0o600)
    }
  })

  it('restores auto-connect after initialization and exposes only redacted errors', async () => {
    const initial = { ...emptyState(), appId: 'cli_0123456789abcdef', sessionId: SESSION.sessionId, autoConnect: true }
    const { controller, callbacks, logs, credentials } = setup(initial)
    credentials.secret = 'secret-fixture'
    await controller.initialize()
    await controller.drain()
    callbacks[0]?.onPhase('error', new Error('authentication failed for secret-fixture'))
    const status = await controller.status()
    expect(status.phase).toBe('error')
    // Controller error messages are redacted by the management boundary; no raw
    // provider error object is ever logged by the controller itself.
    expect(JSON.stringify(status)).not.toHaveProperty('appSecret')
    expect(status.lastError?.message).not.toContain('secret-fixture')
    expect(logs.join('\n')).not.toContain('secret-fixture')
  })
})
