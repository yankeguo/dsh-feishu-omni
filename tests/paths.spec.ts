import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isWithinRoot, localFileRoots, resolveLocalFile } from '../src/paths.ts'

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dshfo-paths-'))
  tempDirs.push(dir)
  return dir
}

interface Workspace {
  readonly parent: string
  readonly workspace: string
  readonly outside: string
  /** Sibling whose name starts with the workspace basename (`work-escape`). */
  readonly sibling: string
}

async function workspaceFixture(): Promise<Workspace> {
  const parent = await tempDir()
  const workspace = join(parent, 'work')
  const outside = join(parent, 'outside')
  const sibling = join(parent, 'work-escape')
  await mkdir(workspace)
  await mkdir(outside)
  await mkdir(sibling)
  return { parent, workspace, outside, sibling }
}

describe('isWithinRoot', () => {
  it('accepts the root itself and strict descendants only', () => {
    expect(isWithinRoot('/work', '/work')).toBe(true)
    expect(isWithinRoot('/work', '/work/a.png')).toBe(true)
    // A bare startsWith would let this sibling through.
    expect(isWithinRoot('/work', '/work-escape/a.png')).toBe(false)
    expect(isWithinRoot('/work', '/work2')).toBe(false)
    expect(isWithinRoot('/work/a', '/work/ab/x')).toBe(false)
    // Filesystem root is a prefix for every absolute path, separator included.
    expect(isWithinRoot('/', '/etc/hosts')).toBe(true)
    // An empty root must never behave like the filesystem root.
    expect(isWithinRoot('', '/etc/hosts')).toBe(false)
  })
})

describe('localFileRoots', () => {
  it('realpaths and de-duplicates existing roots and drops unusable ones', async () => {
    const { workspace, outside } = await workspaceFixture()
    const roots = await localFileRoots(workspace, [outside, join(outside, 'missing'), workspace, ''])
    expect(roots).toEqual([await realpath(workspace), await realpath(outside)])
    expect(await localFileRoots(undefined, [])).toEqual([])
  })
})

describe('resolveLocalFile', () => {
  it('allows a regular non-empty file inside the Session workspace', async () => {
    const { workspace } = await workspaceFixture()
    await writeFile(join(workspace, 'a.png'), 'PNG!')
    const result = await resolveLocalFile({
      rawPath: 'a.png', cwd: workspace, roots: await localFileRoots(workspace, []),
    })
    expect(result).toEqual({ kind: 'ok', path: await realpath(join(workspace, 'a.png')), size: 4 })
  })

  it('allows a file inside an additional allowed root (the DSH attachment store)', async () => {
    const { workspace, outside } = await workspaceFixture()
    await writeFile(join(outside, 'stored.bin'), 'bytes')
    const result = await resolveLocalFile({
      rawPath: join(outside, 'stored.bin'), cwd: workspace, roots: await localFileRoots(undefined, [outside]),
    })
    expect(result).toMatchObject({ kind: 'ok', size: 5 })
  })

  it('refuses an absolute path outside every allowed root and reports only its size', async () => {
    const { workspace, outside } = await workspaceFixture()
    await writeFile(join(outside, 'secret.txt'), 'secret!')
    const result = await resolveLocalFile({
      rawPath: join(outside, 'secret.txt'), cwd: workspace, roots: await localFileRoots(workspace, []),
    })
    expect(result).toEqual({ kind: 'denied', reason: 'outside-roots', size: 7 })
    expect(result).not.toHaveProperty('path')
  })

  it('refuses a ../ escape out of the workspace', async () => {
    const { parent, workspace } = await workspaceFixture()
    await writeFile(join(parent, 'secret.txt'), 'secret!')
    const result = await resolveLocalFile({
      rawPath: '../secret.txt', cwd: workspace, roots: await localFileRoots(workspace, []),
    })
    expect(result).toMatchObject({ kind: 'denied', reason: 'outside-roots', size: 7 })
  })

  it('refuses a symlink that points outside the workspace', async () => {
    const { workspace, outside } = await workspaceFixture()
    await writeFile(join(outside, 'secret.png'), 'PNG!')
    await symlink(join(outside, 'secret.png'), join(workspace, 'link.png'))
    const result = await resolveLocalFile({
      rawPath: 'link.png', cwd: workspace, roots: await localFileRoots(workspace, []),
    })
    expect(result).toMatchObject({ kind: 'denied', reason: 'outside-roots' })
  })

  it('allows a symlink whose target is inside the workspace', async () => {
    const { workspace } = await workspaceFixture()
    await writeFile(join(workspace, 'real.png'), 'PNG!')
    await symlink(join(workspace, 'real.png'), join(workspace, 'link.png'))
    const result = await resolveLocalFile({
      rawPath: 'link.png', cwd: workspace, roots: await localFileRoots(workspace, []),
    })
    expect(result).toEqual({ kind: 'ok', path: await realpath(join(workspace, 'real.png')), size: 4 })
  })

  it('handles a symlinked Session cwd by comparing real paths', async () => {
    const { parent, workspace } = await workspaceFixture()
    const link = join(parent, 'workspace-link')
    await symlink(workspace, link)
    await writeFile(join(workspace, 'a.png'), 'PNG!')
    const result = await resolveLocalFile({
      rawPath: 'a.png', cwd: link, roots: await localFileRoots(link, []),
    })
    expect(result).toEqual({ kind: 'ok', path: await realpath(join(workspace, 'a.png')), size: 4 })
  })

  it('refuses the workspace root itself and directories as not-file', async () => {
    const { workspace } = await workspaceFixture()
    const roots = await localFileRoots(workspace, [])
    await mkdir(join(workspace, 'subdir'))
    expect(await resolveLocalFile({ rawPath: workspace, cwd: workspace, roots }))
      .toEqual({ kind: 'denied', reason: 'not-file' })
    expect(await resolveLocalFile({ rawPath: 'subdir', cwd: workspace, roots }))
      .toEqual({ kind: 'denied', reason: 'not-file' })
  })

  it('reports a missing file and an empty file distinctly', async () => {
    const { workspace } = await workspaceFixture()
    const roots = await localFileRoots(workspace, [])
    expect(await resolveLocalFile({ rawPath: 'missing.png', cwd: workspace, roots }))
      .toEqual({ kind: 'denied', reason: 'missing' })
    await writeFile(join(workspace, 'empty.png'), '')
    expect(await resolveLocalFile({ rawPath: 'empty.png', cwd: workspace, roots }))
      .toEqual({ kind: 'denied', reason: 'empty', size: 0 })
  })

  it('refuses a relative path when the Session cwd is unknown', async () => {
    expect(await resolveLocalFile({ rawPath: 'a.png', cwd: undefined, roots: [] }))
      .toEqual({ kind: 'denied', reason: 'no-cwd' })
  })

  it('reports no-roots when even an absolute path has no allowed root', async () => {
    expect(await resolveLocalFile({ rawPath: '/etc/hosts', cwd: undefined, roots: [] }))
      .toEqual({ kind: 'denied', reason: 'no-roots' })
  })

  it('refuses relative cwd and relative roots instead of resolving them against process.cwd', async () => {
    expect(await localFileRoots('relative-workdir', [])).toEqual([])
    expect(await resolveLocalFile({ rawPath: 'a.png', cwd: 'relative-workdir', roots: [] }))
      .toEqual({ kind: 'denied', reason: 'no-cwd' })
    // An absolute path is still checked against the attachment root only.
    const { workspace } = await workspaceFixture()
    await writeFile(join(workspace, 'a.png'), 'PNG!')
    expect(await resolveLocalFile({
      rawPath: join(workspace, 'a.png'), cwd: 'relative-workdir', roots: [join(workspace, '..')],
    })).toMatchObject({ kind: 'ok' })
  })

  it('does not accept a sibling directory that shares the root prefix', async () => {
    const { workspace, sibling } = await workspaceFixture()
    await writeFile(join(sibling, 'a.png'), 'PNG!')
    const result = await resolveLocalFile({
      rawPath: join(sibling, 'a.png'), cwd: workspace, roots: await localFileRoots(workspace, []),
    })
    expect(result).toMatchObject({ kind: 'denied', reason: 'outside-roots' })
  })
})
