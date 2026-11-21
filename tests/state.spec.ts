import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyState, FileStateStore, MemoryStateStore, normalizeState } from '../src/state.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('state persistence', () => {
  it('round-trips non-secret configuration and bindings with a private file mode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dfo-state-'))
    directories.push(directory)
    const path = join(directory, 'nested', 'state.json')
    const store = new FileStateStore(path)
    await store.load()
    await store.update(current => ({
      ...current,
      appId: 'cli_0123456789abcdef',
      sessionId: 'session-shared',
      autoConnect: true,
      bindings: [{ openId: 'ou_a', chatId: 'oc_a', label: 'Alice', createdAt: '2026-01-01', updatedAt: '2026-01-01' }],
    }))

    const reopened = new FileStateStore(path)
    const loaded = await reopened.load()
    expect(loaded.appId).toBe('cli_0123456789abcdef')
    expect(loaded.sessionId).toBe('session-shared')
    expect(loaded.bindings).toHaveLength(1)
    expect(loaded.autoConnect).toBe(true)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readFile(path, 'utf8')).not.toContain('appSecret')
  })

  it('serializes concurrent updates without losing bindings', async () => {
    const store = new MemoryStateStore()
    await Promise.all([
      store.update(current => ({ ...current, appId: 'cli_0123456789abcdef' })),
      store.update(current => ({ ...current, sessionId: 'session-shared' })),
      store.update(current => ({ ...current, autoConnect: true })),
    ])
    expect(store.snapshot()).toMatchObject({ appId: 'cli_0123456789abcdef', sessionId: 'session-shared', autoConnect: true })
  })

  it('rejects corrupt or unsupported persisted data', async () => {
    expect(() => normalizeState({ version: 2 })).toThrow(/unsupported version/)
    expect(() => normalizeState({ version: 1, bindings: [{}] })).toThrow(/invalid binding/)
    const directory = await mkdtemp(join(tmpdir(), 'dfo-corrupt-'))
    directories.push(directory)
    const path = join(directory, 'state.json')
    await writeFile(path, '{bad json')
    await expect(new FileStateStore(path).load()).rejects.toThrow()
  })

  it('never requires or serializes a credential field', async () => {
    const store = new MemoryStateStore(emptyState())
    const secret = 'secret-fixture-do-not-use'
    await store.update(current => ({ ...current, appId: 'cli_0123456789abcdef' }))
    expect(JSON.stringify(store.snapshot())).not.toContain(secret)
    expect(Object.keys(store.snapshot())).not.toContain('appSecret')
  })
})
