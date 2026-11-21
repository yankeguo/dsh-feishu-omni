/**
 * Local-file containment for outbound Feishu uploads.
 *
 * The bridge reads outbound files (`present` deliverables and inline card
 * images) with Node's fs directly, outside the DSH sandbox. A prompt-injected
 * assistant could therefore point the bridge at any local file and have its
 * bytes uploaded to every bound Feishu user. Every outbound path must pass
 * through {@link resolveLocalFile}, which:
 *
 * 1. resolves a relative path against the Session working directory;
 * 2. calls `fs.realpath` so every symlink is resolved and the on-disk case is
 *    normalized before any comparison;
 * 3. requires the real path to equal one allowed root or start with
 *    `root + path.sep` (never a bare `startsWith`, which would let
 *    `/work-escape` pass for root `/work`);
 * 4. confirms the target is a non-empty regular file.
 *
 * Symlinks are therefore allowed only when their target is inside an allowed
 * root; a symlink to the outside is refused exactly like the outside path.
 */

import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, normalize, resolve, sep } from 'node:path'

/** Why one outbound path may not be uploaded. */
export type LocalFileDenial =
  /** A relative path was supplied but the Session working directory is unknown. */
  | 'no-cwd'
  /** No allowed root could be resolved (unknown cwd and no usable attachment root). */
  | 'no-roots'
  /** The path cannot be resolved, does not exist, or is unreadable. */
  | 'missing'
  /** The real path is outside every allowed root. */
  | 'outside-roots'
  /** The target exists but is not a regular file (directory, socket, ...). */
  | 'not-file'
  /** The target is an empty regular file. */
  | 'empty'

/** One permitted upload: a real path proven to live inside an allowed root. */
export interface ResolvedLocalFile {
  readonly kind: 'ok'
  /** Real, symlink-resolved absolute path below an allowed root. */
  readonly path: string
  readonly size: number
}

/** One refused upload; never carries the absolute path. */
export interface DeniedLocalFile {
  readonly kind: 'denied'
  readonly reason: LocalFileDenial
  /** Best-effort byte size of a refused existing file, for the notice only. */
  readonly size?: number
}

export type LocalFileResolution = ResolvedLocalFile | DeniedLocalFile

/**
 * Strict root-boundary test: the target equals the root or is separated from it
 * by exactly one path separator. A sibling such as `/work-escape/x` must not
 * match root `/work`.
 */
export function isWithinRoot(root: string, target: string): boolean {
  if (root.length === 0) return false
  if (target === root) return true
  // A root that is itself the filesystem root (`/`) is a prefix for every
  // absolute path, which already includes the separator.
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  return target.startsWith(prefix)
}

/** Real path of one allowed root; unusable/non-absolute roots are dropped. */
async function realRoot(root: string | undefined): Promise<string | undefined> {
  if (root === undefined || root.trim().length === 0) return undefined
  const trimmed = root.trim()
  // A relative root would resolve against the Host process cwd, not the
  // Session: refuse it rather than silently allowing an unrelated directory.
  if (!isAbsolute(trimmed)) return undefined
  try {
    const real = await realpath(trimmed)
    return real.trim().length === 0 ? undefined : real
  } catch {
    return undefined
  }
}

/**
 * Resolve the effective allowed roots for one outbound operation: the Session
 * working directory (workspace root) plus the DSH attachment store. Both are
 * realpath'd so symlinked workspaces compare against resolved file paths.
 */
export async function localFileRoots(
  cwd: string | undefined,
  extraRoots: readonly string[],
): Promise<readonly string[]> {
  const roots: string[] = []
  for (const candidate of [cwd, ...extraRoots]) {
    const real = await realRoot(candidate)
    if (real !== undefined && !roots.includes(real)) roots.push(real)
  }
  return roots
}

/** Size of an existing refused regular file, used only for the notice text. */
async function bestEffortSize(path: string): Promise<number | undefined> {
  try {
    const info = await stat(path)
    return info.isFile() ? info.size : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve and authorize one outbound local path. `roots` must already be
 * realpath'd (see {@link localFileRoots}); the Session cwd is accepted as a
 * convenience and re-resolved internally.
 */
export async function resolveLocalFile(input: {
  readonly rawPath: string
  readonly cwd: string | undefined
  readonly roots: readonly string[]
}): Promise<LocalFileResolution> {
  const raw = input.rawPath.trim()
  if (raw.length === 0) return { kind: 'denied', reason: 'missing' }
  // Only an absolute cwd is a meaningful workspace root; anything else would be
  // resolved against the Host process cwd.
  const cwd = input.cwd !== undefined && input.cwd.trim().length > 0 && isAbsolute(input.cwd)
    ? input.cwd
    : undefined
  const relative = !isAbsolute(raw)
  if (relative && cwd === undefined) return { kind: 'denied', reason: 'no-cwd' }
  const candidate = relative ? resolve(cwd as string, raw) : normalize(raw)

  let real: string
  try {
    // realpath resolves symlinks and yields the on-disk case, so the containment
    // check compares canonical paths on both sides.
    real = await realpath(candidate)
  } catch {
    return { kind: 'denied', reason: 'missing' }
  }

  const roots = await localFileRoots(cwd, input.roots)
  if (roots.length === 0) return { kind: 'denied', reason: 'no-roots' }
  if (!roots.some(root => isWithinRoot(root, real))) {
    const size = await bestEffortSize(candidate)
    return { kind: 'denied', reason: 'outside-roots', ...(size === undefined ? {} : { size }) }
  }

  let info
  try {
    info = await stat(real)
  } catch {
    return { kind: 'denied', reason: 'missing' }
  }
  if (!info.isFile()) return { kind: 'denied', reason: 'not-file' }
  if (info.size === 0) return { kind: 'denied', reason: 'empty', size: 0 }
  return { kind: 'ok', path: real, size: info.size }
}
