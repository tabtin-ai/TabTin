import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitWorktreeInfo } from '@shared/git-types'
import { AgentCodeWorktreeController } from '../agent-code-worktree-controller'
import { AgentWorktreeTransitionQueue } from '../agent-worktree-transition'

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function tempDir(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tabtin-${name}-`))
  tempRoots.push(root)
  return root
}

function worktree(pathValue: string, branch = 'feat/test'): GitWorktreeInfo {
  return {
    path: pathValue,
    branch,
    commitHash: 'abc123',
    isCurrent: false,
    isMainWorktree: false,
    isDetached: false,
    isBare: false,
    isLocked: false,
  }
}

function trustedRun(rootPath: string) {
  return {
    sessionId: 'session-1',
    runId: 'run-1',
    toolUseId: 'tool-1',
    rootPath,
    spaceId: 'space-1',
    tabScopeKey: 'conversation:session-1',
    bindingRevision: 2,
  }
}

describe('AgentCodeWorktreeController', () => {
  it('普通 code 命令只能从可信当前 run 解析会话根', () => {
    const source = tempDir('resolve-root')
    const controller = new AgentCodeWorktreeController({
      resolveTrustedRun: (context) => (
        context.runId === 'run-1' ? trustedRun(source) : null
      ),
      authorizePath: vi.fn(),
      transitions: new AgentWorktreeTransitionQueue(),
    })

    expect(controller.resolveRoot({
      sessionId: 'session-1',
      runId: 'run-1',
      toolUseId: 'tool-1',
    })).toBe(source)
    expect(controller.resolveRoot({
      sessionId: 'session-1',
      runId: 'forged',
      toolUseId: 'tool-1',
    })).toBeNull()
  })

  it('不信任 body 身份：Host 无活跃 run 时直接拒绝', async () => {
    const listWorktrees = vi.fn()
    const controller = new AgentCodeWorktreeController({
      resolveTrustedRun: () => null,
      authorizePath: vi.fn(),
      transitions: new AgentWorktreeTransitionQueue(),
      listWorktrees,
    })

    const result = await controller.list({
      sessionId: 'forged-session',
      runId: 'forged-run',
      toolUseId: 'forged-tool',
    })

    expect(result).toMatchObject({ ok: false, status: 403, code: 'UNTRUSTED_AGENT_RUN' })
    expect(listWorktrees).not.toHaveBeenCalled()
  })

  it('switch 校验同仓库、精确授权并登记到当前 tool boundary', async () => {
    const source = tempDir('source')
    const target = tempDir('target')
    const transitions = new AgentWorktreeTransitionQueue(() => 99)
    const authorizePath = vi.fn()
    const controller = new AgentCodeWorktreeController({
      resolveTrustedRun: () => trustedRun(source),
      authorizePath,
      transitions,
      sameRepository: async () => true,
      listWorktrees: async () => [
        { ...worktree(source, 'release/260812'), isCurrent: true, isMainWorktree: true },
        worktree(target),
      ],
    })

    const result = await controller.switch(
      { sessionId: 'session-1', runId: 'run-1', toolUseId: 'tool-1' },
      { path: target },
    )

    expect(result).toMatchObject({ ok: true, data: { scheduled: true, target_root: target } })
    expect(authorizePath).toHaveBeenCalledWith(trustedRun(source), target)
    expect(transitions.peekRun('run-1')).toMatchObject({
      sessionId: 'session-1',
      toolUseId: 'tool-1',
      previousRootPath: source,
      targetRootPath: target,
      boundaryReached: false,
    })
  })

  it('切换到当前根是幂等 no-op，不授权也不触发续跑', async () => {
    const source = tempDir('same')
    const authorizePath = vi.fn()
    const transitions = new AgentWorktreeTransitionQueue()
    const controller = new AgentCodeWorktreeController({
      resolveTrustedRun: () => trustedRun(source),
      authorizePath,
      transitions,
    })

    const result = await controller.switch(
      { sessionId: 'session-1', runId: 'run-1', toolUseId: 'tool-1' },
      { path: source },
    )

    expect(result).toMatchObject({ ok: true, data: { changed: false, scheduled: false } })
    expect(authorizePath).not.toHaveBeenCalled()
    expect(transitions.peekRun('run-1')).toBeUndefined()
  })

  it('switch 拒绝已越过工具边界的后台 CLI 请求', async () => {
    const source = tempDir('late-switch-source')
    const target = tempDir('late-switch-target')
    const authorizePath = vi.fn()
    const sameRepository = vi.fn(async () => true)
    const transitions = new AgentWorktreeTransitionQueue()
    transitions.markToolBoundary('run-1', 'tool-1')
    const controller = new AgentCodeWorktreeController({
      resolveTrustedRun: () => trustedRun(source),
      authorizePath,
      transitions,
      sameRepository,
    })

    const result = await controller.switch(
      { sessionId: 'session-1', runId: 'run-1', toolUseId: 'tool-1' },
      { path: target },
    )

    expect(result).toMatchObject({ ok: false, code: 'tool_boundary_passed' })
    expect(sameRepository).not.toHaveBeenCalled()
    expect(authorizePath).not.toHaveBeenCalled()
  })

  it('switch 在异步校验期间越过边界时不授权', async () => {
    const source = tempDir('racing-switch-source')
    const target = tempDir('racing-switch-target')
    const authorizePath = vi.fn()
    let finishRepositoryCheck!: (same: boolean) => void
    const sameRepository = vi.fn(() => new Promise<boolean>((resolve) => {
      finishRepositoryCheck = resolve
    }))
    const transitions = new AgentWorktreeTransitionQueue()
    const controller = new AgentCodeWorktreeController({
      resolveTrustedRun: () => trustedRun(source),
      authorizePath,
      transitions,
      sameRepository,
      listWorktrees: async () => [worktree(target)],
    })

    const resultPromise = controller.switch(
      { sessionId: 'session-1', runId: 'run-1', toolUseId: 'tool-1' },
      { path: target },
    )
    await vi.waitFor(() => expect(sameRepository).toHaveBeenCalled())
    transitions.markToolBoundary('run-1', 'tool-1')
    finishRepositoryCheck(true)

    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      code: 'tool_boundary_passed',
    })
    expect(authorizePath).not.toHaveBeenCalled()
  })

  it('create 物理创建成功后自动登记切换', async () => {
    const source = tempDir('create-source')
    const target = path.join(path.dirname(source), `${path.basename(source)}-wt`)
    const createWorktree = vi.fn(async () => undefined)
    const transitions = new AgentWorktreeTransitionQueue()
    const controller = new AgentCodeWorktreeController({
      resolveTrustedRun: () => trustedRun(source),
      authorizePath: vi.fn(),
      transitions,
      createWorktree,
      listWorktrees: async () => [worktree(target, 'feat/10498')],
    })

    const result = await controller.create(
      { sessionId: 'session-1', runId: 'run-1', toolUseId: 'tool-1' },
      { path: target, new_branch: 'feat/10498', base: 'release/260812' },
    )

    expect(createWorktree).toHaveBeenCalledWith(source, {
      path: target,
      branch: 'feat/10498',
      createBranch: true,
      baseBranch: 'release/260812',
    })
    expect(result).toMatchObject({ ok: true, data: { created: true, scheduled: true } })
    expect(transitions.peekRun('run-1')).toMatchObject({
      targetRootPath: target,
      branch: 'feat/10498',
      created: true,
    })
  })

  it('create 物理创建失败时不授权目标路径', async () => {
    const source = tempDir('create-failure-source')
    const target = path.join(path.dirname(source), `${path.basename(source)}-wt`)
    const authorizePath = vi.fn()
    const controller = new AgentCodeWorktreeController({
      resolveTrustedRun: () => trustedRun(source),
      authorizePath,
      transitions: new AgentWorktreeTransitionQueue(),
      createWorktree: async () => {
        throw new Error('branch already checked out')
      },
    })

    const result = await controller.create(
      { sessionId: 'session-1', runId: 'run-1', toolUseId: 'tool-1' },
      { path: target, new_branch: 'feat/duplicate' },
    )

    expect(result).toMatchObject({ ok: false, code: 'WORKTREE_CREATE_FAILED' })
    expect(authorizePath).not.toHaveBeenCalled()
  })

  it('create 拒绝已越过工具边界的后台 CLI 请求', async () => {
    const source = tempDir('late-create-source')
    const target = path.join(path.dirname(source), `${path.basename(source)}-wt`)
    const createWorktree = vi.fn(async () => undefined)
    const authorizePath = vi.fn()
    const transitions = new AgentWorktreeTransitionQueue()
    transitions.markToolBoundary('run-1', 'tool-1')
    const controller = new AgentCodeWorktreeController({
      resolveTrustedRun: () => trustedRun(source),
      authorizePath,
      transitions,
      createWorktree,
    })

    const result = await controller.create(
      { sessionId: 'session-1', runId: 'run-1', toolUseId: 'tool-1' },
      { path: target, new_branch: 'feat/background' },
    )

    expect(result).toMatchObject({ ok: false, code: 'tool_boundary_passed' })
    expect(createWorktree).not.toHaveBeenCalled()
    expect(authorizePath).not.toHaveBeenCalled()
  })

  it('create 执行期间越过边界时等待操作完成后再提交', async () => {
    const source = tempDir('racing-create-source')
    const target = path.join(path.dirname(source), `${path.basename(source)}-wt`)
    let finishCreate!: () => void
    const createWorktree = vi.fn(() => new Promise<void>((resolve) => {
      finishCreate = resolve
    }))
    const transitions = new AgentWorktreeTransitionQueue()
    const controller = new AgentCodeWorktreeController({
      resolveTrustedRun: () => trustedRun(source),
      authorizePath: vi.fn(),
      transitions,
      createWorktree,
      listWorktrees: async () => [worktree(target, 'feat/racing-create')],
    })

    const resultPromise = controller.create(
      { sessionId: 'session-1', runId: 'run-1', toolUseId: 'tool-1' },
      { path: target, new_branch: 'feat/racing-create' },
    )
    await vi.waitFor(() => expect(createWorktree).toHaveBeenCalled())
    expect(transitions.peekRun('run-1')).toMatchObject({ operationCompleted: false })
    expect(transitions.markToolBoundary('run-1', 'tool-1')).not.toBeNull()
    finishCreate()

    await expect(resultPromise).resolves.toMatchObject({ ok: true })
    expect(transitions.peekRun('run-1')).toMatchObject({
      operationCompleted: true,
      boundaryReached: true,
      targetRootPath: target,
    })
  })

  it('create 未传 path 时使用 Agent 托管目录并避让已占用路径', async () => {
    const source = tempDir('default-path-source')
    const managedRoot = tempDir('managed-worktrees')
    const baseTarget = path.join(
      managedRoot,
      path.basename(source),
      'wt-feat-10498-Agent-Worktree',
    )
    fs.mkdirSync(baseTarget, { recursive: true })
    const expectedTarget = `${baseTarget}-2`
    const createWorktree = vi.fn(async () => undefined)
    const controller = new AgentCodeWorktreeController({
      resolveTrustedRun: () => trustedRun(source),
      authorizePath: vi.fn(),
      transitions: new AgentWorktreeTransitionQueue(),
      managedWorktreeRoot: managedRoot,
      createWorktree,
      listWorktrees: async () => [worktree(expectedTarget, 'feat/10498-Agent-Worktree')],
    })

    const result = await controller.create(
      { sessionId: 'session-1', runId: 'run-1', toolUseId: 'tool-1' },
      { new_branch: 'feat/10498-Agent-Worktree', base: 'release/260812' },
    )

    expect(createWorktree).toHaveBeenCalledWith(source, {
      path: expectedTarget,
      branch: 'feat/10498-Agent-Worktree',
      createBranch: true,
      baseBranch: 'release/260812',
    })
    expect(result).toMatchObject({
      ok: true,
      data: { created: true, scheduled: true, target_root: expectedTarget },
    })
  })

  it('create 显式 path 优先于 Agent 托管目录', async () => {
    const source = tempDir('explicit-path-source')
    const managedRoot = tempDir('unused-managed-worktrees')
    const explicitTarget = path.join(path.dirname(source), `${path.basename(source)}-explicit`)
    const createWorktree = vi.fn(async () => undefined)
    const controller = new AgentCodeWorktreeController({
      resolveTrustedRun: () => trustedRun(source),
      authorizePath: vi.fn(),
      transitions: new AgentWorktreeTransitionQueue(),
      managedWorktreeRoot: managedRoot,
      createWorktree,
      listWorktrees: async () => [worktree(explicitTarget, 'feat/explicit')],
    })

    await controller.create(
      { sessionId: 'session-1', runId: 'run-1', toolUseId: 'tool-1' },
      { path: explicitTarget, new_branch: 'feat/explicit' },
    )

    expect(createWorktree).toHaveBeenCalledWith(source, expect.objectContaining({
      path: explicitTarget,
    }))
  })

  it('create 默认路径时会创建缺失的托管父目录', async () => {
    const source = tempDir('managed-parent-source')
    const managedRoot = path.join(tempDir('managed-parent-root'), 'nested', 'worktrees')
    const expectedTarget = path.join(
      managedRoot,
      path.basename(source),
      'wt-feat-managed-parent',
    )
    const createWorktree = vi.fn(async () => undefined)
    const controller = new AgentCodeWorktreeController({
      resolveTrustedRun: () => trustedRun(source),
      authorizePath: vi.fn(),
      transitions: new AgentWorktreeTransitionQueue(),
      managedWorktreeRoot: managedRoot,
      createWorktree,
      listWorktrees: async () => [worktree(expectedTarget, 'feat/managed-parent')],
    })

    const result = await controller.create(
      { sessionId: 'session-1', runId: 'run-1', toolUseId: 'tool-1' },
      { new_branch: 'feat/managed-parent' },
    )

    expect(fs.statSync(path.dirname(expectedTarget)).isDirectory()).toBe(true)
    expect(createWorktree).toHaveBeenCalledWith(source, expect.objectContaining({
      path: expectedTarget,
    }))
    expect(result).toMatchObject({ ok: true })
  })

  it('拒绝不同 Git 仓库的 switch', async () => {
    const source = tempDir('repo-source')
    const target = tempDir('other-repo')
    const controller = new AgentCodeWorktreeController({
      resolveTrustedRun: () => trustedRun(source),
      authorizePath: vi.fn(),
      transitions: new AgentWorktreeTransitionQueue(),
      sameRepository: async () => false,
    })

    const result = await controller.switch(
      { sessionId: 'session-1', runId: 'run-1', toolUseId: 'tool-1' },
      { path: target },
    )

    expect(result).toMatchObject({ ok: false, code: 'DIFFERENT_REPOSITORY' })
  })

  it.each(['feature branch', 'topic@{1}', 'topic.lock', '.hidden/topic'])(
    'create 拒绝非法 Git ref：%s',
    async (newBranch) => {
      const source = tempDir('invalid-ref-source')
      const target = path.join(path.dirname(source), `${path.basename(source)}-wt`)
      const createWorktree = vi.fn()
      const controller = new AgentCodeWorktreeController({
        resolveTrustedRun: () => trustedRun(source),
        authorizePath: vi.fn(),
        transitions: new AgentWorktreeTransitionQueue(),
        createWorktree,
      })

      const result = await controller.create(
        { sessionId: 'session-1', runId: 'run-1', toolUseId: 'tool-1' },
        { path: target, new_branch: newBranch },
      )

      expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
      expect(createWorktree).not.toHaveBeenCalled()
    },
  )
})
