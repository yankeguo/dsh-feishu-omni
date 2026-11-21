import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  emptyState, FileStateStore, MemoryStateStore, normalizeState, StateFileError, StateRecoveryError,
} from '../src/state.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

/** chmod does not block reads/renames as root and is ignored on Windows. */
const skipPermissionTests = process.getuid?.() === 0 || process.platform === 'win32'

/** Node synthesizes file modes on Windows, so only POSIX hosts report the real 0600 bits. */
const supportsPosixFileMode = process.platform !== 'win32'

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
    if (supportsPosixFileMode) expect((await stat(path)).mode & 0o777).toBe(0o600)
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

  it('rejects corrupt or unsupported normalized data', () => {
    expect(() => normalizeState({ version: 2 })).toThrow(/unsupported version/)
    expect(() => normalizeState({ version: 1, bindings: [{}] })).toThrow(/invalid binding/)
  })

  it('quarantines a corrupt state file and starts with an empty usable store', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dfo-corrupt-'))
    directories.push(directory)
    const path = join(directory, 'state.json')
    await writeFile(path, '{bad json')
    const store = new FileStateStore(path)
    await expect(store.load()).rejects.toThrow(/moved.*starting with empty state/)
    expect(store.snapshot()).toEqual(emptyState())
    const files = await readdir(directory)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^state\.json\.corrupt-/)
    expect(await readFile(join(directory, files[0] ?? ''), 'utf8')).toBe('{bad json')
    await store.update(current => ({ ...current, sessionId: 'session-shared' }))
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ sessionId: 'session-shared' })
  })

  it('quarantines a structurally invalid state document as corruption', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dfo-invalid-schema-'))
    directories.push(directory)
    const path = join(directory, 'state.json')
    const document = `${JSON.stringify({ version: 2, sessionId: 'session-shared' })}\n`
    await writeFile(path, document)
    const store = new FileStateStore(path)
    await expect(store.load()).rejects.toBeInstanceOf(StateRecoveryError)
    expect(store.snapshot()).toEqual(emptyState())
    const files = await readdir(directory)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^state\.json\.corrupt-/)
    expect(await readFile(join(directory, files[0] ?? ''), 'utf8')).toBe(document)
    await store.update(current => ({ ...current, sessionId: 'session-shared' }))
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ sessionId: 'session-shared' })
  })

  it('continues on the quarantined empty state when update runs before load', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dfo-update-recovery-'))
    directories.push(directory)
    const path = join(directory, 'state.json')
    await writeFile(path, '{bad json')
    const store = new FileStateStore(path)
    // The production path calls initialize() first, but a direct update() must
    // not fail once the corrupt file has been quarantined; only a genuinely
    // unreadable file (see the EACCES case above) keeps rejecting updates.
    await expect(store.update(current => ({ ...current, sessionId: 'session-shared' })))
      .resolves.toMatchObject({ sessionId: 'session-shared' })
    expect(store.snapshot()).toMatchObject({ sessionId: 'session-shared' })
    const quarantined = (await readdir(directory)).filter(name => name.startsWith('state.json.corrupt-'))
    expect(quarantined).toHaveLength(1)
    expect(await readFile(join(directory, quarantined[0] ?? ''), 'utf8')).toBe('{bad json')
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ sessionId: 'session-shared' })
  })

  it('rejects a recovery error when the store never became usable despite it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dfo-recovery-unready-'))
    directories.push(directory)
    const path = join(directory, 'state.json')
    // update() continues past StateRecoveryError only because FileStateStore has
    // already quarantined the file and left an empty state behind; a store that
    // reports recovery without becoming ready must not be written to.
    class UnreadyRecoveryStore extends FileStateStore {
      override async load(): Promise<never> {
        throw new StateRecoveryError(`${path}.corrupt-fixture`, new Error('corrupt'))
      }
    }
    const store = new UnreadyRecoveryStore(path)
    await expect(store.update(current => current)).rejects.toBeInstanceOf(StateRecoveryError)
    expect(await readdir(directory)).toEqual([])
  })

  it.skipIf(skipPermissionTests)('propagates read I/O errors without quarantining the state file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dfo-io-error-'))
    directories.push(directory)
    const path = join(directory, 'state.json')
    const document = `${JSON.stringify(emptyState(), null, 2)}\n`
    await writeFile(path, document)
    await chmod(path, 0o000)
    try {
      const store = new FileStateStore(path)
      // EACCES is an I/O problem, not corruption: the file must stay in place.
      await expect(store.load()).rejects.toMatchObject({ code: 'EACCES' })
      expect(() => store.snapshot()).toThrow(/has not been loaded/)
      expect(await readdir(directory)).toEqual(['state.json'])
      // A later update must retry the real read instead of continuing empty.
      await expect(store.update(current => current)).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      await chmod(path, 0o600)
    }
    expect(await readFile(path, 'utf8')).toBe(document)
  })

  it('rejects an oversized state file without quarantining it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dfo-oversized-'))
    directories.push(directory)
    const path = join(directory, 'state.json')
    const document = `${JSON.stringify({ version: 1, padding: 'x'.repeat(1024 * 1024) })}\n`
    await writeFile(path, document)
    const store = new FileStateStore(path)
    const error = await store.load().catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(StateFileError)
    expect((error as Error).message).toMatch(/too large/)
    expect(() => store.snapshot()).toThrow(/has not been loaded/)
    expect(await readdir(directory)).toEqual(['state.json'])
    expect(await readFile(path, 'utf8')).toBe(document)
  })

  it('rejects a non-regular state path without touching it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dfo-state-directory-'))
    directories.push(directory)
    const path = join(directory, 'state.json')
    await mkdir(path)
    const store = new FileStateStore(path)
    await expect(store.load()).rejects.toBeInstanceOf(StateFileError)
    expect(await readdir(directory)).toEqual(['state.json'])
    expect((await stat(path)).isDirectory()).toBe(true)
  })

  it.skipIf(skipPermissionTests)('propagates a quarantine rename failure instead of starting empty', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dfo-quarantine-failure-'))
    directories.push(directory)
    const path = join(directory, 'state.json')
    await writeFile(path, '{bad json')
    // Removing write permission on the directory makes the quarantine rename fail.
    await chmod(directory, 0o500)
    try {
      const store = new FileStateStore(path)
      const error = await store.load().catch((reason: unknown) => reason)
      expect(error).toBeInstanceOf(StateFileError)
      expect((error as Error).message).toMatch(/could not be moved/)
      expect((error as Error).cause).toMatchObject({ code: 'EACCES' })
      expect(() => store.snapshot()).toThrow(/has not been loaded/)
      expect(await readdir(directory)).toEqual(['state.json'])
    } finally {
      await chmod(directory, 0o700)
    }
    expect(await readFile(path, 'utf8')).toBe('{bad json')
  })

  it('never requires or serializes a credential field', async () => {
    const store = new MemoryStateStore(emptyState())
    const secret = 'secret-fixture-do-not-use'
    await store.update(current => ({ ...current, appId: 'cli_0123456789abcdef' }))
    expect(JSON.stringify(store.snapshot())).not.toContain(secret)
    expect(Object.keys(store.snapshot())).not.toContain('appSecret')
  })
})
