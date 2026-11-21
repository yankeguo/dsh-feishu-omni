import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Binding, PersistedState, StateStore } from './types.ts'

const MAX_STATE_BYTES = 1024 * 1024
const MAX_EVENT_IDS = 2000

export const emptyState = (): PersistedState => ({
  version: 1,
  appId: null,
  sessionId: null,
  autoConnect: false,
  bindings: [],
  recentEventIds: [],
})

/** The corrupt file was preserved and the store is ready with an empty state. */
export class StateRecoveryError extends Error {
  constructor(quarantinePath: string, cause: unknown) {
    super(`Feishu Omni state was corrupt; the original was moved to ${quarantinePath}; starting with empty state`, { cause })
    this.name = 'StateRecoveryError'
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function nullableString(value: unknown): string | null {
  return nonEmpty(value) ? value.trim() : null
}

function parseBinding(value: unknown): Binding | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if (!nonEmpty(row.openId) || !nonEmpty(row.chatId) || !nonEmpty(row.label)
    || !nonEmpty(row.createdAt) || !nonEmpty(row.updatedAt)) return undefined
  return {
    openId: row.openId.trim(), chatId: row.chatId.trim(), label: row.label.trim(),
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  }
}

/** Validate and normalize disk data instead of trusting a hand-edited state file. */
export function normalizeState(value: unknown): PersistedState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Feishu Omni state must be a JSON object')
  }
  const row = value as Record<string, unknown>
  if (row.version !== 1) throw new Error('Feishu Omni state has an unsupported version')
  if (row.bindings !== undefined && !Array.isArray(row.bindings)) throw new Error('Feishu Omni bindings must be an array')
  if (row.recentEventIds !== undefined && !Array.isArray(row.recentEventIds)) {
    throw new Error('Feishu Omni recentEventIds must be an array')
  }
  const bindings = (row.bindings ?? []).map(parseBinding)
  if (bindings.some(binding => binding === undefined)) throw new Error('Feishu Omni state contains an invalid binding')
  const uniqueBindings = new Map<string, Binding>()
  for (const binding of bindings as Binding[]) uniqueBindings.set(binding.openId, binding)
  const recentEventIds = [...new Set((row.recentEventIds ?? []).filter(nonEmpty))].slice(-MAX_EVENT_IDS)
  return {
    version: 1,
    appId: nullableString(row.appId),
    sessionId: nullableString(row.sessionId),
    autoConnect: row.autoConnect === true,
    bindings: [...uniqueBindings.values()],
    recentEventIds,
  }
}

export function appendRecentKeys(state: PersistedState, keys: readonly string[]): PersistedState {
  const seen = new Set(state.recentEventIds)
  const additions = keys.filter(key => !seen.has(key))
  if (additions.length === 0) return state
  return { ...state, recentEventIds: [...state.recentEventIds, ...additions].slice(-MAX_EVENT_IDS) }
}

export class MemoryStateStore implements StateStore {
  protected current: PersistedState
  private queue: Promise<void> = Promise.resolve()

  constructor(initial: PersistedState = emptyState()) {
    this.current = normalizeState(initial)
  }

  async load(): Promise<PersistedState> {
    await this.queue
    return this.current
  }

  snapshot(): PersistedState {
    return this.current
  }

  update(mutator: (current: PersistedState) => PersistedState): Promise<PersistedState> {
    const result = this.queue.then(async () => {
      const next = normalizeState(mutator(this.current))
      await this.commit(next)
      this.current = next
      return next
    })
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  protected async commit(_next: PersistedState): Promise<void> {}
}

/** Atomic 0600 JSON persistence; credentials never belong to this document. */
export class FileStateStore implements StateStore {
  private current: PersistedState = emptyState()
  private loaded = false
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  async load(): Promise<PersistedState> {
    if (this.loaded) return this.current
    const result = this.queue.then(async () => {
      if (this.loaded) return
      try {
        const info = await stat(this.path)
        if (!info.isFile() || info.size > MAX_STATE_BYTES) throw new Error('Feishu Omni state file is too large')
        this.current = normalizeState(JSON.parse(await readFile(this.path, 'utf8')))
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'ENOENT') {
          const quarantinePath = `${this.path}.corrupt-${randomUUID()}`
          await rename(this.path, quarantinePath)
          this.current = emptyState()
          this.loaded = true
          throw new StateRecoveryError(quarantinePath, error)
        }
      }
      this.loaded = true
    })
    this.queue = result.catch(() => {})
    await result
    return this.current
  }

  snapshot(): PersistedState {
    if (!this.loaded) throw new Error('Feishu Omni state has not been loaded')
    return this.current
  }

  update(mutator: (current: PersistedState) => PersistedState): Promise<PersistedState> {
    return (async () => {
      if (!this.loaded) await this.load()
      const result = this.queue.then(async () => {
        const next = normalizeState(mutator(this.current))
        const directory = dirname(this.path)
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const temporary = join(directory, `.state-${process.pid}-${randomUUID()}.tmp`)
        const handle = await open(temporary, 'wx', 0o600)
        try {
          await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
        try {
          await rename(temporary, this.path)
        } catch (error) {
          await rm(temporary, { force: true })
          throw error
        }
        this.current = next
        return next
      })
      this.queue = result.then(() => undefined, () => undefined)
      return result
    })()
  }
}
