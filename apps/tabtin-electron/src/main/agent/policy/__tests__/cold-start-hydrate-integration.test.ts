/**
 * Cold-start hydrate 集成测试 · 单根契约下重启场景端到端
 *
 * 模拟完整的 cold-start 数据流（见 docs/single-root-space-prd.md §2.2）：
 *
 *   T0: 重启 Electron，main 端 sessions Map 空，cli-context.currentSpaceId
 *       已被 setActive IPC 设到 spaceId='S'
 *   T1: renderer setActiveSpace bridge .then() 触发
 *       `notifyWorkspacePathsForSpace('S')` → main applier 找不到 session →
 *       buffer stash workingDir
 *   T2: 用户在 TabFolder pane 点开 Agent 目录子文件 → `fs:readDir(working_dir)`
 *       IPC → main path-access-checker
 *       → setRendererWorkspaceProviders.getAllowedPaths 闭包：session miss →
 *       WorkspaceBoundary.getSnapshot 拿 pending workingDir → checker.allowedPaths 含 working_dir
 *       → **放行**（未修前是 deny）
 *   T3: 用户发第一句话 → handleQuery → createRuntimeForSession →
 *       WorkspaceBoundary.reconcileSnapshot 把 pending 应用到刚创建的 session.snapshot →
 *       后续 LLM 调 edit_file 该路径 judge workspace_in
 *   T4: 用户继续切 Space S→T，重复 T1-T3
 *
 * 这条测试钉死单根 cold-start race 的端到端语义：用户重启后第一秒
 * 在 TabFolder 看 Agent 目录就能用，不必等 sendMessage 之后才生效。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  createWorkspaceBoundary,
  type WorkspaceBoundary,
} from '../workspace-boundary'
import { createPathAccessChecker } from '../../../security/path-access-checker'
import type { WorkspaceSnapshot } from '@tabtin/security-policy'

interface FakeSession {
  spaceId: string | undefined
  workspaceSnapshot: WorkspaceSnapshot | null
}

function makeSnapshot(args: {
  sandbox?: string
  workingDir?: string
}): WorkspaceSnapshot {
  const sandbox = args.sandbox ?? '/tmp/sandbox-S'
  const workingDir = args.workingDir ?? ''
  return {
    sources: {
      sandbox,
      workingDir,
      sessionApprovedPaths: [],
      attachedFiles: [],
    },
    allowedPaths: workingDir ? [sandbox, workingDir] : [sandbox],
    allowedFiles: [],
    spaceSessionId: 'sess-1',
  }
}

describe('Cold-start hydrate 集成 · 单根契约下重启场景端到端', () => {
  let boundary: WorkspaceBoundary
  let activeSpaceId: string | null = null
  let sessions: FakeSession[] = []

  beforeEach(() => {
    boundary = createWorkspaceBoundary()
    activeSpaceId = null
    sessions = []
  })

  // 模拟 ElectronAgentHost.setRendererWorkspaceProviders 装配的 getAllowedPaths
  // 闭包行为——**与生产代码 1:1 对齐**。
  function getAllowedPaths(): string[] {
    if (!activeSpaceId) return []
    for (const sess of sessions) {
      if (sess.spaceId === activeSpaceId && sess.workspaceSnapshot) {
        return [...sess.workspaceSnapshot.allowedPaths]
      }
    }
    // session miss → peek buffer（workingDir + sessionApprovedPaths）
    const pendingSnapshot = boundary.getSnapshot(sessions, activeSpaceId)
    return pendingSnapshot ? [...pendingSnapshot.allowedPaths] : []
  }

  // 模拟 ElectronAgentHost.createRuntimeForSession 创建 session 时
  // WorkspaceBoundary.reconcileSnapshot 应用 pending state 到 sources。
  function createRuntimeForSession(spaceId: string): FakeSession {
    const snap = makeSnapshot({ sandbox: '/tmp/sandbox-' + spaceId })
    boundary.reconcileSnapshot(snap, { type: 'consume-pending', spaceId })
    const sess: FakeSession = { spaceId, workspaceSnapshot: snap }
    sessions.push(sess)
    return sess
  }

  it('T0-T2 cold-start 第一秒：重启 + setActiveSpace hydrate 后 fs:readDir 立即可用（peek buffer 接通）', () => {
    activeSpaceId = 'S'
    boundary.apply(sessions, {
      type: 'paths-changed',
      payload: { spaceId: 'S', workingDir: '/Volumes/外接盘/项目' },
    })
    expect(boundary.getSnapshot(sessions, 'S')?.sources.workingDir).toBe('/Volumes/外接盘/项目')

    const allowedPaths = getAllowedPaths()
    expect(allowedPaths).toContain('/Volumes/外接盘/项目')

    const checker = createPathAccessChecker({
      getAllowedPaths: () => allowedPaths,
      getPlatformAllowedDirs: () => ['/tmp/sandbox-S', '/tmp/home'],
      homeDir: '/tmp/home',
    })
    const result = checker.check('/Volumes/外接盘/项目/README.md', 'read')
    expect(result.allowed).toBe(true)
  })

  it('T3 cold-start 第一句话：createRuntimeForSession 消费 buffer 后 session.snapshot 含 working_dir', () => {
    activeSpaceId = 'S'
    boundary.apply(sessions, {
      type: 'paths-changed',
      payload: { spaceId: 'S', workingDir: '/Volumes/外接盘/项目' },
    })

    const sess = createRuntimeForSession('S')

    expect(sess.workspaceSnapshot?.allowedPaths).toContain('/Volumes/外接盘/项目')
    expect(sess.workspaceSnapshot?.allowedPaths).toContain('/tmp/sandbox-S')
    expect(sess.workspaceSnapshot?.sources.workingDir).toBe('/Volumes/外接盘/项目')

    expect(boundary.getSnapshot([], 'S')).toBeNull()

    const allowedPaths = getAllowedPaths()
    expect(allowedPaths).toContain('/Volumes/外接盘/项目')
  })

  it('T4 切 Space 接力：S→T 切换后 T 的 hydrate 不污染 S', () => {
    activeSpaceId = 'S'
    boundary.apply(sessions, {
      type: 'paths-changed',
      payload: { spaceId: 'S', workingDir: '/Volumes/外接盘/S-项目' },
    })
    createRuntimeForSession('S')

    activeSpaceId = 'T'
    boundary.apply(sessions, {
      type: 'paths-changed',
      payload: { spaceId: 'T', workingDir: '/Volumes/外接盘/T-项目' },
    })
    expect(boundary.getSnapshot(sessions, 'T')?.sources.workingDir).toBe('/Volumes/外接盘/T-项目')
    expect(boundary.getSnapshot([], 'S')).toBeNull()

    expect(getAllowedPaths()).toContain('/Volumes/外接盘/T-项目')
    expect(getAllowedPaths()).not.toContain('/Volumes/外接盘/S-项目')

    activeSpaceId = 'S'
    expect(getAllowedPaths()).toContain('/Volumes/外接盘/S-项目')
    expect(getAllowedPaths()).not.toContain('/Volumes/外接盘/T-项目')
  })

  it('peek 不消费——createRuntimeForSession 之前多次 fs IPC 都能拿到 buffer paths', () => {
    activeSpaceId = 'S'
    boundary.apply(sessions, {
      type: 'paths-changed',
      payload: { spaceId: 'S', workingDir: '/Volumes/外接盘/项目' },
    })

    expect(getAllowedPaths()).toContain('/Volumes/外接盘/项目')
    expect(getAllowedPaths()).toContain('/Volumes/外接盘/项目')
    expect(getAllowedPaths()).toContain('/Volumes/外接盘/项目')

    expect(boundary.getSnapshot([], 'S')).not.toBeNull()

    createRuntimeForSession('S')
    expect(boundary.getSnapshot([], 'S')).toBeNull()
    expect(getAllowedPaths()).toContain('/Volumes/外接盘/项目')
  })

  it('Desktop 本地目录：session miss 时批准路径进入 pending state → fs:readDir 放行', () => {
    activeSpaceId = 'S'
    boundary.apply([], {
      type: 'paths-changed',
      payload: { spaceId: 'S', workingDir: '' },
    })
    boundary.apply([], {
      type: 'session-path-approved',
      payload: { spaceId: 'S', path: 'D:\\external-folder' },
    })

    const allowedPaths = getAllowedPaths()
    expect(allowedPaths).toContain('D:\\external-folder')

    const checker = createPathAccessChecker({
      getAllowedPaths: () => allowedPaths,
      getPlatformAllowedDirs: () => ['/tmp/sandbox-S', '/tmp/home'],
      homeDir: '/tmp/home',
    })
    expect(checker.check('D:\\external-folder\\README.md', 'read').allowed).toBe(true)
  })
})
