/**
 * WorkspaceBoundary · 单根契约行为钉死
 *
 * 验证 `WorkspaceBoundary.apply(paths-changed)` 在单根模型下的核心契约
 * （见 docs/single-root-space-prd.md §2.1 / §2.2）：
 *   1. payload schema 校验（缺 spaceId / 非 object → fail-closed + warning）
 *   2. spaceId 路由（只 mutate 匹配的 session，不污染其他 Space）
 *   3. 单根替换语义（workingDir 单字段直接替换；deprecated 数组永远清空）
 *   4. 过宽路径过滤（M3.1 硬化深度防御）
 *   5. fail-closed warn（找不到匹配 session 不静默成功）
 *   6. sandbox 不动（sources.sandbox 是 createRuntimeForSession 初值）
 *   7. allowedPaths 重新 derive 后正确去重 + 包含 sandbox + workingDir
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  createWorkspaceBoundary,
  type WorkspaceBoundary,
  type WorkspaceBoundarySession,
  type WorkspacePathsChangedPayload,
  type AppendSessionApprovedPathPayload,
} from '../workspace-boundary'
import type { WorkspaceSnapshot, WorkspaceSources } from '@tabtin/security-policy'
import { tabtinAgentTasksDir } from '@tabtin/terminal-core'

// dogfood 314d7f23 修复：deriveAllowedPaths 自动追加 internal
// agent-tasks 目录（让 `run_terminal_command` 写的 output_file 子 Agent 也能
// 读）。测试期望同步加这条；不动该常量来源以保证测试与实现走同源 helper。
const INTERNAL_AGENT_TASKS = tabtinAgentTasksDir()

let boundary: WorkspaceBoundary

beforeEach(() => {
  boundary = createWorkspaceBoundary()
})

function makeSnapshot(args: {
  sandbox?: string
  workingDir?: string
  sessionApprovedPaths?: string[]
  allowedPaths?: string[]
}): WorkspaceSnapshot {
  const sandbox = args.sandbox ?? '/tmp/sandbox'
  const workingDir = args.workingDir ?? ''
  const sessionApprovedPaths = args.sessionApprovedPaths ?? []
  return {
    sources: {
      sandbox,
      workingDir,
      sessionApprovedPaths,
      attachedFiles: [],
    },
    allowedPaths: args.allowedPaths ?? (workingDir ? [sandbox, workingDir, ...sessionApprovedPaths] : [sandbox, ...sessionApprovedPaths]),
    allowedFiles: [],
    spaceSessionId: 'sess-1',
  }
}

function makeSession(
  spaceId: string | undefined,
  snapshot: WorkspaceSnapshot | null,
  sessionId?: string,
): WorkspaceBoundarySession {
  return { sessionId, spaceId, workspaceSnapshot: snapshot }
}

function applyPathsChanged(
  sessions: Iterable<WorkspaceBoundarySession>,
  payload: WorkspacePathsChangedPayload,
) {
  return boundary.apply(sessions, { type: 'paths-changed', payload })
}

function approveSessionPath(
  sessions: Iterable<WorkspaceBoundarySession>,
  payload: AppendSessionApprovedPathPayload,
) {
  return boundary.apply(sessions, { type: 'session-path-approved', payload })
}

function peekPending(spaceId: string) {
  const snapshot = boundary.getSnapshot([], spaceId)
  if (!snapshot) return null
  return {
    workingDir: snapshot.sources.workingDir ?? '',
    sessionApprovedPaths: snapshot.sources.sessionApprovedPaths ?? [],
  }
}

function consumePending(spaceId: string) {
  const snapshot = makeSnapshot({ sandbox: '' })
  if (!boundary.reconcileSnapshot(snapshot, { type: 'consume-pending', spaceId })) return null
  return {
    workingDir: snapshot.sources.workingDir ?? '',
    sessionApprovedPaths: snapshot.sources.sessionApprovedPaths ?? [],
  }
}

function deriveAllowedPaths(sources: WorkspaceSources): string[] {
  const snapshot: WorkspaceSnapshot = {
    sources: {
      ...sources,
      sessionApprovedPaths: [...(sources.sessionApprovedPaths ?? [])],
      attachedFiles: [...sources.attachedFiles],
    },
    allowedPaths: [],
    allowedFiles: [],
  }
  boundary.reconcileSnapshot(snapshot, { type: 'refresh' })
  return snapshot.allowedPaths
}

function derivePendingAllowedPaths(pending: {
  workingDir: string
  sessionApprovedPaths: string[]
}): string[] {
  return deriveAllowedPaths({
    sandbox: '',
    workingDir: pending.workingDir,
    sessionApprovedPaths: pending.sessionApprovedPaths,
    attachedFiles: [],
  })
}

describe('applyPathsChanged · payload schema 校验（fail-closed）', () => {
  it('payload 不是对象 → 不动 + warning', () => {
    const sess = makeSession('A', makeSnapshot({}))
    const result = applyPathsChanged([sess], null as never)
    expect(result.mutated).toBe(false)
    expect(result.warning).toContain('not an object')
  })

  it('payload 缺 spaceId → 不动 + warning', () => {
    const sess = makeSession('A', makeSnapshot({}))
    const result = applyPathsChanged([sess], { workingDir: '/tmp/p' } as never)
    expect(result.mutated).toBe(false)
    expect(result.warning).toContain('missing spaceId')
    expect(sess.workspaceSnapshot?.sources.workingDir).toBe('')
  })

  it('spaceId 非 string 或空 → 不动', () => {
    const sess = makeSession('A', makeSnapshot({}))
    const r1 = applyPathsChanged([sess], { spaceId: '', workingDir: '/tmp/p' })
    expect(r1.mutated).toBe(false)
    const r2 = applyPathsChanged([sess], { spaceId: 123, workingDir: '/tmp/p' } as never)
    expect(r2.mutated).toBe(false)
  })
})

describe('applyPathsChanged · spaceId 路由', () => {
  it('找不到匹配 session → fail-closed warning（payload 进 pending buffer 但不动 sess）', () => {
    const sess = makeSession('A', makeSnapshot({}))
    const result = applyPathsChanged([sess], {
      spaceId: 'B',
      workingDir: '/tmp/p',
    })
    expect(result.mutated).toBe(false)
    expect(result.warning).toContain('no session for spaceId=B')
    expect(sess.workspaceSnapshot?.sources.workingDir).toBe('')
  })

  it('多 session：只 mutate 匹配 spaceId 的 session（修 L14 多 Space 污染）', () => {
    const sessA = makeSession('A', makeSnapshot({ workingDir: '/tmp/A-old' }))
    const sessB = makeSession('B', makeSnapshot({ workingDir: '/tmp/B-old' }))
    const sessC = makeSession('C', makeSnapshot({ workingDir: '/tmp/C-old' }))

    applyPathsChanged([sessA, sessB, sessC], {
      spaceId: 'B',
      workingDir: '/tmp/B-new',
    })

    expect(sessA.workspaceSnapshot?.sources.workingDir).toBe('/tmp/A-old')
    expect(sessC.workspaceSnapshot?.sources.workingDir).toBe('/tmp/C-old')
    expect(sessB.workspaceSnapshot?.sources.workingDir).toBe('/tmp/B-new')
  })

  it('session.workspaceSnapshot 为 null → 跳过（不抛错）', () => {
    const sess = makeSession('A', null)
    const result = applyPathsChanged([sess], {
      spaceId: 'A',
      workingDir: '/tmp/p',
    })
    expect(result.mutated).toBe(false)
    expect(result.warning).toContain('no session for spaceId')
  })
})

describe('applyPathsChanged · 单根替换语义', () => {
  it('替换 workingDir 整段（旧 working_dir 丢光）', () => {
    const sess = makeSession('A', makeSnapshot({ workingDir: '/tmp/old' }))
    applyPathsChanged([sess], {
      spaceId: 'A',
      workingDir: '/tmp/new',
    })
    expect(sess.workspaceSnapshot?.sources.workingDir).toBe('/tmp/new')
  })

  it('payload workingDir 为空字符串 = "Agent 没设置工作目录" → 真清光', () => {
    const sess = makeSession('A', makeSnapshot({
      sandbox: '/tmp/sandbox',
      workingDir: '/tmp/old',
    }))
    applyPathsChanged([sess], {
      spaceId: 'A',
      workingDir: '',
    })
    expect(sess.workspaceSnapshot?.sources.workingDir).toBe('')
    // allowedPaths 重新 derive 后只剩 sandbox + internal tool-output 白名单
    expect(sess.workspaceSnapshot?.allowedPaths).toEqual(['/tmp/sandbox', INTERNAL_AGENT_TASKS])
  })

  // 历史 deprecated 数组字段（tabcodeProjects/tabfolderDirs）已从 WorkspaceSources 类型彻底移除，
  // 不再需要"mutate 时清空"的保护语义。本用例已退役。

  it('payload 的额外字段被忽略（即使 caller 误传也不会进 sources）', () => {
    const sess = makeSession('A', makeSnapshot({}))
    applyPathsChanged([sess], {
      spaceId: 'A',
      workingDir: '/tmp/correct',
      // 类型不匹配（已废弃字段）—— main 端 schema 不接受，但用 `as never`
      // 模拟 wire 形态错乱时 applier 仍稳健
      tabcodeProjects: ['/tmp/wrong1', '/tmp/wrong2'],
    } as never)
    // workingDir 是真相
    expect(sess.workspaceSnapshot?.sources.workingDir).toBe('/tmp/correct')
  })
})

describe('applyPathsChanged · 过宽路径过滤（M3.1 硬化）', () => {
  it('payload workingDir 是 `/` / `/Users` 等过宽路径 → 过滤掉（深度防御 dirty 数据）', () => {
    const sess = makeSession('A', makeSnapshot({}))
    applyPathsChanged([sess], {
      spaceId: 'A',
      workingDir: '/',
    })
    expect(sess.workspaceSnapshot?.sources.workingDir).toBe('')
    applyPathsChanged([sess], {
      spaceId: 'A',
      workingDir: '/Users',
    })
    expect(sess.workspaceSnapshot?.sources.workingDir).toBe('')
  })

  it('payload workingDir 非字符串 → 视为空', () => {
    const sess = makeSession('A', makeSnapshot({}))
    applyPathsChanged([sess], {
      spaceId: 'A',
      workingDir: 123 as unknown as string,
    })
    expect(sess.workspaceSnapshot?.sources.workingDir).toBe('')
  })
})

describe('applyPathsChanged · sandbox 不动 + allowedPaths derive', () => {
  it('sources.sandbox 不被替换（renderer 无权改 sandbox）', () => {
    const sess = makeSession('A', makeSnapshot({ sandbox: '/tmp/original-sandbox' }))
    applyPathsChanged([sess], {
      spaceId: 'A',
      workingDir: '/tmp/proj',
    })
    expect(sess.workspaceSnapshot?.sources.sandbox).toBe('/tmp/original-sandbox')
  })

  it('allowedPaths derive 后 = sandbox + workingDir（单根契约）', () => {
    const sess = makeSession('A', makeSnapshot({ sandbox: '/tmp/sandbox' }))
    applyPathsChanged([sess], {
      spaceId: 'A',
      workingDir: '/tmp/proj',
    })
    expect(sess.workspaceSnapshot?.allowedPaths).toEqual([
      '/tmp/sandbox',
      '/tmp/proj',
      INTERNAL_AGENT_TASKS,
    ])
  })

  it('allowedPaths derive 自动去重（sandbox 与 workingDir 重合时不重复）', () => {
    const sess = makeSession('A', makeSnapshot({ sandbox: '/tmp/shared' }))
    applyPathsChanged([sess], {
      spaceId: 'A',
      workingDir: '/tmp/shared',
    })
    expect(sess.workspaceSnapshot?.allowedPaths).toEqual(['/tmp/shared', INTERNAL_AGENT_TASKS])
  })
})

describe('applyPathsChanged · pending hydrate buffer（Wave 3 P0-1 修复）', () => {
  it('找不到 session → 把 payload stash 进 pending buffer（不 drop）', () => {
    const result = applyPathsChanged([], {
      spaceId: 'space-fresh',
      workingDir: '/tmp/proj',
    })
    expect(result.mutated).toBe(false)
    expect(result.warning).toContain('stashed to pending buffer')
    expect(peekPending('space-fresh')).toEqual({
      workingDir: '/tmp/proj',
      sessionApprovedPaths: [],
    })
  })

  it('consumePending 拿到 buffer 后 buffer 自动清空（同 spaceId 不会被消费两次）', () => {
    applyPathsChanged([], {
      spaceId: 'space-X',
      workingDir: '/tmp/x',
    })
    expect(peekPending('space-X')).not.toBeNull()

    const consumed = consumePending('space-X')
    expect(consumed).toEqual({ workingDir: '/tmp/x', sessionApprovedPaths: [] })

    expect(peekPending('space-X')).toBeNull()
    expect(consumePending('space-X')).toBeNull()
  })

  it('没有 pending 时 hydrate 保留 session 创建期初始 allowedPaths', () => {
    const snapshot = makeSnapshot({
      sandbox: '/tmp/session-sandbox',
      allowedPaths: ['/tmp/session-sandbox'],
    })

    expect(boundary.reconcileSnapshot(snapshot, {
      type: 'consume-pending',
      spaceId: 'space-no-pending',
    })).toBe(false)
    expect(snapshot.allowedPaths).toEqual(['/tmp/session-sandbox'])
  })

  it('多次 hydrate 同 spaceId → buffer 保留最新 payload（覆盖式）', () => {
    applyPathsChanged([], {
      spaceId: 'space-A',
      workingDir: '/tmp/old',
    })
    applyPathsChanged([], {
      spaceId: 'space-A',
      workingDir: '/tmp/new',
    })
    expect(peekPending('space-A')).toEqual({
      workingDir: '/tmp/new',
      sessionApprovedPaths: [],
    })
  })

  it('mutate 成功后 buffer 自动清空（防止 createRuntimeForSession 重新读老 buffer）', () => {
    applyPathsChanged([], {
      spaceId: 'space-A',
      workingDir: '/tmp/p1',
    })
    expect(peekPending('space-A')).not.toBeNull()

    const sess = makeSession('space-A', makeSnapshot({}))
    applyPathsChanged([sess], {
      spaceId: 'space-A',
      workingDir: '/tmp/p2',
    })
    expect(peekPending('space-A')).toBeNull()
  })

  it('找不到 session 但 spaceId 校验失败 → 不进 buffer', () => {
    applyPathsChanged([], {
      spaceId: '',
      workingDir: '/tmp/p',
    })
    expect(peekPending('')).toBeNull()
  })

  it('cold-start 场景端到端（Review P0-1 闭环）', () => {
    // 1. renderer 启动 / 切 Space → setActiveSpace bridge hydrate
    applyPathsChanged([], {
      spaceId: 'space-S',
      workingDir: '/Volumes/外接盘/项目',
    })
    // 2. main 端 session 还没建：buffer 存了
    expect(peekPending('space-S')?.workingDir).toBe('/Volumes/外接盘/项目')

    // 3. 用户发第一条消息 → handleQuery → createRuntimeForSession
    const consumed = consumePending('space-S')
    expect(consumed).toEqual({ workingDir: '/Volumes/外接盘/项目', sessionApprovedPaths: [] })

    // 4. host 把 consumed 应用到 session sources，重新 derive allowedPaths
    const newSnapshot: WorkspaceSnapshot = {
      sources: {
        sandbox: '/tmp/sandbox',
        workingDir: consumed!.workingDir,
        sessionApprovedPaths: [],
        attachedFiles: [],
      },
      allowedPaths: deriveAllowedPaths({
        sandbox: '/tmp/sandbox',
        workingDir: consumed!.workingDir,
        sessionApprovedPaths: [],
        attachedFiles: [],
      }),
      allowedFiles: [],
      spaceSessionId: 'sess-1',
    }
    expect(newSnapshot.allowedPaths).toContain('/Volumes/外接盘/项目')
    // 5. 后续 LLM edit_file 该路径 → judge 拿到 allowedPaths 含外接盘 → workspace_in
  })
})

describe('deriveAllowedPaths · 纯函数', () => {
  it('sandbox 是过宽路径（譬如 `/`）→ 过滤掉，单 workingDir 留下', () => {
    const result = deriveAllowedPaths({
      sandbox: '/',
      workingDir: '/tmp/p',
      sessionApprovedPaths: [],
      attachedFiles: [],
    })
    expect(result).toEqual(['/tmp/p', INTERNAL_AGENT_TASKS])
  })

  it('空 sources → 仅 internal agent-tasks 白名单（仍要让子 Agent 能读工具自创文件）', () => {
    const result = deriveAllowedPaths({
      sandbox: '',
      workingDir: '',
      sessionApprovedPaths: [],
      attachedFiles: [],
    })
    expect(result).toEqual([INTERNAL_AGENT_TASKS])
  })

  it('workingDir 是过宽路径 → 过滤掉', () => {
    const result = deriveAllowedPaths({
      sandbox: '/tmp/sandbox',
      workingDir: '/Users',
      sessionApprovedPaths: [],
      attachedFiles: [],
    })
    expect(result).toEqual(['/tmp/sandbox', INTERNAL_AGENT_TASKS])
  })

  it('sessionApprovedPaths 进 allowedPaths（去重）', () => {
    const result = deriveAllowedPaths({
      sandbox: '/tmp/sandbox',
      workingDir: '/tmp/proj',
      sessionApprovedPaths: ['/tmp/extra-1', '/tmp/extra-2', '/tmp/proj' /* 与 workingDir 重复 */],
      attachedFiles: [],
    })
    expect(result).toEqual(['/tmp/sandbox', '/tmp/proj', '/tmp/extra-1', '/tmp/extra-2', INTERNAL_AGENT_TASKS])
  })

  it('sessionApprovedPaths 含过宽路径 → 过滤掉', () => {
    const result = deriveAllowedPaths({
      sandbox: '/tmp/sandbox',
      workingDir: '/tmp/proj',
      sessionApprovedPaths: ['/Users', '/tmp/legit', '/'],
      attachedFiles: [],
    })
    expect(result).toEqual(['/tmp/sandbox', '/tmp/proj', '/tmp/legit', INTERNAL_AGENT_TASKS])
  })

  it('internal agent-tasks 白名单永远在列表里（dogfood 314d7f23 子 Agent read_file 兜底）', () => {
    const result = deriveAllowedPaths({
      sandbox: '/tmp/sandbox',
      workingDir: '/tmp/proj',
      sessionApprovedPaths: [],
      attachedFiles: [],
    })
    expect(result).toContain(INTERNAL_AGENT_TASKS)
  })
})

describe('approveSessionPath · ApprovalPanel 审批通过路径推到 session', () => {
  it('正常路径 → 加进 sessionApprovedPaths 并 re-derive allowedPaths', () => {
    const sess = makeSession('A', makeSnapshot({ workingDir: '/tmp/proj' }))
    const result = approveSessionPath([sess], { spaceId: 'A', path: '/tmp/extra' })
    expect(result.mutated).toBe(true)
    expect(sess.workspaceSnapshot?.sources.sessionApprovedPaths).toEqual(['/tmp/extra'])
    expect(sess.workspaceSnapshot?.allowedPaths).toEqual(['/tmp/sandbox', '/tmp/proj', '/tmp/extra', INTERNAL_AGENT_TASKS])
  })

  it('已存在的路径 → 去重，不重复 push', () => {
    const sess = makeSession('A', makeSnapshot({
      workingDir: '/tmp/proj',
      sessionApprovedPaths: ['/tmp/extra'],
    }))
    const result = approveSessionPath([sess], { spaceId: 'A', path: '/tmp/extra' })
    expect(result).toEqual({ mutated: false, warning: null })
    expect(sess.workspaceSnapshot?.sources.sessionApprovedPaths).toEqual(['/tmp/extra'])
    expect(peekPending('A')).toBeNull()
  })

  it('过宽路径（/Users）→ 拒绝写入', () => {
    const sess = makeSession('A', makeSnapshot({ workingDir: '/tmp/proj' }))
    const result = approveSessionPath([sess], { spaceId: 'A', path: '/Users' })
    expect(result.mutated).toBe(false)
    expect(result.warning).toContain('too broad')
    expect(sess.workspaceSnapshot?.sources.sessionApprovedPaths).toEqual([])
  })

  it('找不到 spaceId session → 写入 pending buffer（Desktop 本地目录 ）', () => {
    const sess = makeSession('A', makeSnapshot({}))
    const result = approveSessionPath([sess], { spaceId: 'B', path: '/tmp/extra' })
    expect(result.mutated).toBe(false)
    expect(result.warning).toContain('stashed to pending buffer')
    expect(sess.workspaceSnapshot?.sources.sessionApprovedPaths).toEqual([])
    expect(peekPending('B')).toEqual({
      workingDir: '',
      sessionApprovedPaths: ['/tmp/extra'],
    })
  })

  it('pending buffer 保留已有 workingDir，追加 sessionApprovedPaths', () => {
    applyPathsChanged([], {
      spaceId: 'space-S',
      workingDir: '/Volumes/外接盘/项目',
    })
    approveSessionPath([], { spaceId: 'space-S', path: 'D:\\local-folder' })
    expect(peekPending('space-S')).toEqual({
      workingDir: '/Volumes/外接盘/项目',
      sessionApprovedPaths: ['D:\\local-folder'],
    })
    expect(derivePendingAllowedPaths(peekPending('space-S')!)).toContain('D:\\local-folder')
  })

  it('多 Space：只 mutate 匹配 spaceId 的 session', () => {
    const sessA = makeSession('A', makeSnapshot({}))
    const sessB = makeSession('B', makeSnapshot({}))
    approveSessionPath([sessA, sessB], { spaceId: 'A', path: '/tmp/A-only' })
    expect(sessA.workspaceSnapshot?.sources.sessionApprovedPaths).toEqual(['/tmp/A-only'])
    expect(sessB.workspaceSnapshot?.sources.sessionApprovedPaths).toEqual([])
  })

  it('提供 sessionId 时，同一 Space 只授权目标会话', () => {
    const sessA = makeSession('A', makeSnapshot({}), 'session-A')
    const sessB = makeSession('A', makeSnapshot({}), 'session-B')

    const result = approveSessionPath([sessA, sessB], {
      spaceId: 'A',
      sessionId: 'session-B',
      path: '/tmp/B-only',
    })

    expect(result).toEqual({ mutated: true, warning: null })
    expect(sessA.workspaceSnapshot?.sources.sessionApprovedPaths).toEqual([])
    expect(sessB.workspaceSnapshot?.sources.sessionApprovedPaths).toEqual(['/tmp/B-only'])
  })

  it('精确 sessionId 不存在时不降级写入 Space pending buffer', () => {
    const sess = makeSession('A', makeSnapshot({}), 'session-A')
    const result = approveSessionPath([sess], {
      spaceId: 'A',
      sessionId: 'session-missing',
      path: '/tmp/missing-only',
    })

    expect(result.mutated).toBe(false)
    expect(result.warning).toContain('sessionId=session-missing')
    expect(peekPending('A')).toBeNull()
    expect(sess.workspaceSnapshot?.sources.sessionApprovedPaths).toEqual([])
  })
})
