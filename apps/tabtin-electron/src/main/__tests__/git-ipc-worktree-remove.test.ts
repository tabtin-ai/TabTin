import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  execFileAsync: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/home' },
  ipcMain: {
    handle: mocks.handle,
    removeHandler: vi.fn(),
  },
}))

vi.mock('child_process', () => {
  const execFile = vi.fn()
  return { execFile, default: { execFile } }
})

vi.mock('util', () => ({
  promisify: () => mocks.execFileAsync,
  default: { promisify: () => mocks.execFileAsync },
}))

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    default: { ...actual, statSync: () => ({ isDirectory: () => true }) },
    statSync: () => ({ isDirectory: () => true }),
  }
})

vi.mock('../security/path-access-checker', () => ({
  getDefaultPathAccessChecker: () => ({
    check: () => ({ allowed: true }),
  }),
}))

vi.mock('../auth', () => ({
  isTrustedSender: () => true,
}))

vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

import { registerGitIpcHandlers } from '../git-ipc'
import {
  registerWorktreeRemoveRuntimeProbe,
  unregisterWorktreeRemoveRuntimeProbe,
} from '../git/worktree-remove-runtime-probe'

const MAIN = '/tmp/home/project'
const CLEAN = '/tmp/home/project-clean'
const DIRTY = '/tmp/home/project-dirty'
const LOCKED = '/tmp/home/project-locked'
const BOUND = '/tmp/home/project-bound'
const CASE_UPPER = '/tmp/home/project-case'
const CASE_LOWER = '/tmp/home/Project-case'
const HEAD = 'abc123def456'

function getHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const call = mocks.handle.mock.calls.find((candidate: unknown[]) => candidate[0] === channel)
  if (!call) throw new Error(`${channel} handler not registered`)
  return call[1] as (...args: unknown[]) => Promise<unknown>
}

function porcelain(
  items: Array<{ path: string; branch: string; locked?: string }>,
): string {
  return `${items
    .map((item) => {
      const lines = [
        `worktree ${item.path}`,
        `HEAD ${HEAD}`,
        `branch refs/heads/${item.branch}`,
      ]
      if (item.locked) lines.push(`locked ${item.locked}`)
      return lines.join('\n')
    })
    .join('\n\n')}\n`
}

const defaultList = porcelain([
  { path: MAIN, branch: 'main' },
  { path: CLEAN, branch: 'wt-clean' },
  { path: DIRTY, branch: 'wt-dirty' },
  { path: LOCKED, branch: 'wt-locked', locked: 'manual-lock' },
  { path: BOUND, branch: 'wt-bound' },
  { path: CASE_UPPER, branch: 'wt-case-upper' },
  { path: CASE_LOWER, branch: 'wt-case-lower' },
])

describe('git worktree remove safety', () => {
  const dirtyPaths = new Set<string>([DIRTY])
  const dirtyStatusByPath = new Map<string, string>([[DIRTY, '?? leftover.txt\n']])
  const unknownPaths = new Set<string>()
  const removed: string[] = []
  let stageWriteGate: Promise<void> | null = null
  let releaseStageWrite: (() => void) | null = null
  let notifyStageWriteStarted: (() => void) | null = null
  const probe = {
    listBindingsForRoot: vi.fn(async () => []),
    clearBindingsForRoot: vi.fn(async () => [] as string[]),
    reserveRootForRemoval: vi.fn(async () => () => {}),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    dirtyPaths.clear()
    dirtyPaths.add(DIRTY)
    dirtyStatusByPath.clear()
    dirtyStatusByPath.set(DIRTY, '?? leftover.txt\n')
    unknownPaths.clear()
    removed.length = 0
    stageWriteGate = null
    releaseStageWrite = null
    notifyStageWriteStarted = null
    probe.listBindingsForRoot.mockResolvedValue([])
    probe.clearBindingsForRoot.mockResolvedValue([])
    probe.reserveRootForRemoval.mockResolvedValue(() => {})
    registerWorktreeRemoveRuntimeProbe(probe)
    registerGitIpcHandlers()
    mocks.execFileAsync.mockImplementation(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command !== 'git') throw new Error(`unexpected ${command}`)
      const cwd = options?.cwd || ''
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        return { stdout: `${cwd}\n`, stderr: '' }
      }
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
        const branch = cwd === CLEAN ? 'wt-clean' : 'main'
        return { stdout: `${branch}\n`, stderr: '' }
      }
      if (args[0] === 'rev-parse' && args[1] === '--short') {
        return { stdout: `${HEAD.slice(0, 7)}\n`, stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { stdout: defaultList, stderr: '' }
      }
      if (args[0] === 'status' && args.includes('--porcelain=v1')) {
        if (unknownPaths.has(cwd)) throw new Error('unable to read index')
        if (dirtyPaths.has(cwd)) {
          return { stdout: dirtyStatusByPath.get(cwd) ?? '?? leftover.txt\n', stderr: '' }
        }
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        const target = args[args.length - 1]
        removed.push(target)
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'merge') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'add') {
        notifyStageWriteStarted?.()
        if (stageWriteGate) await stageWriteGate
        return { stdout: '', stderr: '' }
      }
      throw new Error(`unexpected git ${args.join(' ')}`)
    })
  })

  afterEach(() => {
    unregisterWorktreeRemoveRuntimeProbe()
  })

  it('blocks the main worktree', async () => {
    const result = await getHandler('git:worktreeRemovePreflight')({}, MAIN, { path: MAIN })
    expect(result).toMatchObject({
      success: true,
      canRemove: false,
      reason: 'main_worktree',
      code: 'MAIN_WORKTREE',
    })
  })

  it('blocks the current linked worktree', async () => {
    const result = await getHandler('git:worktreeRemovePreflight')({}, CLEAN, { path: CLEAN })
    expect(result).toMatchObject({
      success: true,
      canRemove: false,
      reason: 'current_worktree',
      code: 'WORKTREE_IN_USE',
      isCurrentWorktree: true,
    })
  })

  it('blocks a locked worktree even with force', async () => {
    const preflight = await getHandler('git:worktreeRemovePreflight')({}, MAIN, { path: LOCKED })
    expect(preflight).toMatchObject({
      success: true,
      canRemove: false,
      reason: 'worktree_locked',
      code: 'WORKTREE_LOCKED',
    })
    const releaseReservation = vi.fn()
    probe.reserveRootForRemoval.mockResolvedValueOnce(releaseReservation)
    const removedResult = await getHandler('git:worktreeRemove')({}, MAIN, {
      path: LOCKED,
      force: true,
      assessmentToken: 'x',
    })
    expect(removedResult).toMatchObject({
      success: false,
      code: 'WORKTREE_LOCKED',
    })
    expect(releaseReservation).toHaveBeenCalledOnce()
    expect(removed).toEqual([])
  })

  it('allows a clean linked worktree and clears bindings', async () => {
    probe.clearBindingsForRoot.mockResolvedValue(['session-clean'])
    const preflight = await getHandler('git:worktreeRemovePreflight')({}, MAIN, { path: CLEAN })
    expect(preflight).toMatchObject({
      success: true,
      canRemove: true,
      dirty: false,
    })
    const result = await getHandler('git:worktreeRemove')({}, MAIN, { path: CLEAN })
    expect(result).toMatchObject({
      success: true,
      clearedSessionIds: ['session-clean'],
    })
    expect(removed).toEqual([CLEAN])
  })

  it.skipIf(process.platform === 'win32')(
    'matches case-distinct worktree paths without deleting the other entry',
    async () => {
      const result = await getHandler('git:worktreeRemove')({}, MAIN, { path: CASE_LOWER })

      expect(result).toMatchObject({ success: true })
      expect(removed).toEqual([CASE_LOWER])
    },
  )

  it('requires a matching token to force-remove a dirty worktree', async () => {
    const preflight = await getHandler('git:worktreeRemovePreflight')({}, MAIN, { path: DIRTY }) as {
      assessmentToken?: string
    }
    expect(preflight).toMatchObject({
      success: true,
      canRemove: false,
      canForce: true,
      reason: 'worktree_dirty',
      code: 'WORKTREE_REMOVE_BLOCKED',
    })

    await expect(
      getHandler('git:worktreeRemove')({}, MAIN, { path: DIRTY }),
    ).resolves.toMatchObject({
      success: false,
      code: 'WORKTREE_REMOVE_BLOCKED',
    })
    await expect(
      getHandler('git:worktreeRemove')({}, MAIN, {
        path: DIRTY,
        force: true,
        assessmentToken: 'wrong-token',
      }),
    ).resolves.toMatchObject({
      success: false,
      code: 'WORKTREE_REMOVE_BLOCKED',
    })

    const forced = await getHandler('git:worktreeRemove')({}, MAIN, {
      path: DIRTY,
      force: true,
      assessmentToken: preflight.assessmentToken,
    })
    expect(forced).toMatchObject({ success: true })
    expect(removed).toEqual([DIRTY])
  })

  it('rejects a stale token after the dirty fingerprint changes', async () => {
    const preflight = await getHandler('git:worktreeRemovePreflight')({}, MAIN, { path: DIRTY }) as {
      assessmentToken?: string
    }
    dirtyStatusByPath.set(DIRTY, '?? leftover-changed.txt\n')
    const result = await getHandler('git:worktreeRemove')({}, MAIN, {
      path: DIRTY,
      force: true,
      assessmentToken: preflight.assessmentToken,
    })
    expect(result).toMatchObject({
      success: false,
      code: 'WORKTREE_REMOVE_BLOCKED',
    })
    expect(removed).toEqual([])
  })

  it('rechecks a force token after waiting in the write queue', async () => {
    const preflight = await getHandler('git:worktreeRemovePreflight')({}, MAIN, { path: DIRTY }) as {
      assessmentToken?: string
    }
    let markStageStarted!: () => void
    const stageStarted = new Promise<void>((resolve) => {
      markStageStarted = resolve
    })
    notifyStageWriteStarted = markStageStarted
    stageWriteGate = new Promise<void>((resolve) => {
      releaseStageWrite = resolve
    })

    const stage = getHandler('git:stage')({}, DIRTY)
    await stageStarted
    const removal = getHandler('git:worktreeRemove')({}, MAIN, {
      path: DIRTY,
      force: true,
      assessmentToken: preflight.assessmentToken,
    })
    await Promise.resolve()
    await Promise.resolve()

    dirtyStatusByPath.set(DIRTY, '?? created-while-queued.txt\n')
    releaseStageWrite?.()
    await expect(stage).resolves.toMatchObject({ success: true })
    await expect(removal).resolves.toMatchObject({
      success: false,
      code: 'WORKTREE_REMOVE_BLOCKED',
    })
    expect(removed).toEqual([])
  })

  it('rechecks session bindings after waiting in the write queue', async () => {
    let markStageStarted!: () => void
    const stageStarted = new Promise<void>((resolve) => {
      markStageStarted = resolve
    })
    notifyStageWriteStarted = markStageStarted
    stageWriteGate = new Promise<void>((resolve) => {
      releaseStageWrite = resolve
    })

    const stage = getHandler('git:stage')({}, CLEAN)
    await stageStarted
    const removal = getHandler('git:worktreeRemove')({}, MAIN, { path: CLEAN })
    await Promise.resolve()
    await Promise.resolve()
    expect(probe.listBindingsForRoot).not.toHaveBeenCalled()

    probe.listBindingsForRoot.mockResolvedValue([
      { sessionId: 'bound-while-queued', revision: 1, busy: false },
    ])
    releaseStageWrite?.()
    await expect(stage).resolves.toMatchObject({ success: true })
    await expect(removal).resolves.toMatchObject({
      success: false,
      code: 'WORKTREE_IN_USE',
    })
    expect(removed).toEqual([])
  })

  it('fails closed when the working tree probe is unknown', async () => {
    unknownPaths.add(CLEAN)
    const result = await getHandler('git:worktreeRemovePreflight')({}, MAIN, { path: CLEAN })
    expect(result).toMatchObject({
      success: true,
      canRemove: false,
      reason: 'working_tree_unknown',
      code: 'WORKING_TREE_UNKNOWN',
    })
  })

  it('fails closed when session bindings are not restored yet', async () => {
    const unknown = Object.assign(new Error('session code-root bindings are not restored yet'), {
      name: 'SessionCodeRootBindingsUnknownError',
      code: 'BINDINGS_UNKNOWN',
    })
    probe.listBindingsForRoot.mockRejectedValue(unknown)

    await expect(
      getHandler('git:worktreeRemovePreflight')({}, MAIN, { path: CLEAN }),
    ).resolves.toMatchObject({
      success: true,
      canRemove: false,
      reason: 'bindings_unknown',
      code: 'RUNTIME_UNAVAILABLE',
    })
    await expect(
      getHandler('git:worktreeRemove')({}, MAIN, { path: CLEAN }),
    ).resolves.toMatchObject({
      success: false,
      code: 'RUNTIME_UNAVAILABLE',
    })
    expect(removed).toEqual([])
  })

  it('blocks session-bound and busy worktrees', async () => {
    probe.listBindingsForRoot.mockResolvedValue([
      { sessionId: 's-bound', revision: 1, busy: false },
    ])
    await expect(
      getHandler('git:worktreeRemovePreflight')({}, MAIN, { path: BOUND }),
    ).resolves.toMatchObject({
      success: true,
      canRemove: false,
      reason: 'session_bound',
      code: 'WORKTREE_IN_USE',
    })

    probe.listBindingsForRoot.mockResolvedValue([
      { sessionId: 's-busy', revision: 2, busy: true },
    ])
    await expect(
      getHandler('git:worktreeRemovePreflight')({}, MAIN, { path: BOUND }),
    ).resolves.toMatchObject({
      success: true,
      canRemove: false,
      reason: 'session_busy',
      code: 'WORKTREE_IN_USE',
    })
  })

  it('returns a binding-cleanup warning after a successful remove', async () => {
    probe.clearBindingsForRoot.mockRejectedValue(new Error('sidecar write failed'))
    const result = await getHandler('git:worktreeRemove')({}, MAIN, { path: CLEAN })
    expect(result).toMatchObject({
      success: true,
      warnings: [
        expect.objectContaining({
          code: 'BINDING_CLEANUP_FAILED',
        }),
      ],
    })
    expect(removed).toEqual([CLEAN])
  })

  it('uses the same guarded removal lifecycle after a worktree merge', async () => {
    const releaseReservation = vi.fn()
    probe.reserveRootForRemoval.mockResolvedValueOnce(releaseReservation)

    const result = await getHandler('git:worktreeMerge')({}, MAIN, {
      sourceWorktreePath: CLEAN,
      targetBranch: 'main',
      deleteAfterMerge: true,
    })

    expect(result).toMatchObject({
      success: true,
      warnings: [],
    })
    expect(probe.reserveRootForRemoval).toHaveBeenCalledWith(CLEAN)
    expect(releaseReservation).toHaveBeenCalledOnce()
    expect(removed).toEqual([CLEAN])
  })

  it('blocks removal when the runtime probe is unavailable', async () => {
    unregisterWorktreeRemoveRuntimeProbe()
    await expect(
      getHandler('git:worktreeRemove')({}, MAIN, { path: '' }),
    ).resolves.toMatchObject({
      success: false,
      code: 'WORKTREE_PATH_REQUIRED',
    })
    const result = await getHandler('git:worktreeRemovePreflight')({}, MAIN, { path: CLEAN })
    expect(result).toMatchObject({
      success: true,
      canRemove: false,
      reason: 'runtime_unavailable',
      code: 'RUNTIME_UNAVAILABLE',
    })
    await expect(
      getHandler('git:worktreeRemove')({}, MAIN, { path: CLEAN }),
    ).resolves.toMatchObject({
      success: false,
      code: 'RUNTIME_UNAVAILABLE',
    })
  })

  it('returns a structured failure when removal reservation cannot be acquired', async () => {
    probe.reserveRootForRemoval.mockRejectedValueOnce(new Error('binding store unavailable'))

    const result = await getHandler('git:worktreeRemove')({}, MAIN, { path: CLEAN })

    expect(result).toMatchObject({
      success: false,
      code: 'GENERIC',
      error: 'binding store unavailable',
    })
    expect(removed).toEqual([])
  })
})
