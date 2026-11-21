import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyState, FileStateStore, StateFileError } from '../src/state.ts'

/**
 * Simulate a file that grows past the limit between stat() and readFile(), so
 * the post-read byte check is exercised deterministically.
 */
const control = vi.hoisted(() => ({ oversizeOnRead: false }))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof FsPromises>()
  const readFile = async (...args: unknown[]): Promise<unknown> => {
    if (control.oversizeOnRead) return Buffer.alloc(1024 * 1024 + 1, 0x20)
    return (actual.readFile as (...inner: unknown[]) => Promise<unknown>)(...args)
  }
  return { ...actual, readFile }
})

const directories: string[] = []
afterEach(async () => {
  control.oversizeOnRead = false
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('state read size re-check', () => {
  it('rejects a file that grows past the limit between stat and read without touching it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dfo-state-toctou-'))
    directories.push(directory)
    const path = join(directory, 'state.json')
    const document = `${JSON.stringify(emptyState())}\n`
    await writeFile(path, document)
    control.oversizeOnRead = true
    const store = new FileStateStore(path)
    const error = await store.load().catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(StateFileError)
    expect((error as Error).message).toMatch(/too large/)
    expect((error as Error).message).toContain('1048577 bytes')
    expect((error as Error).message).toContain('the limit is 1048576 bytes')
    expect((error as Error).message).toContain(path)
    expect((error as Error).message).toMatch(/left untouched/)
    expect(() => store.snapshot()).toThrow(/has not been loaded/)
    // Oversized data must not be parsed or quarantined: the file stays in place.
    expect(await readdir(directory)).toEqual(['state.json'])
    expect((await stat(path)).size).toBe(Buffer.byteLength(document))
  })
})
