/**
 * Mode Alignment E2E integration tests（Phase 3 + Phase 4）
 *
 * Phase 3 已覆盖 E2E-5（switch_mode 完整流程）+ E2E-6（HITL × mode 切换 session 隔离）。
 * Phase 4 收尾补 E2E-1/2/3/4/7/9（剩 E2E-8 in-flight race 留 Phase 4+ 与 policyEpoch 一起做，TD-21）。
 *
 * Electron 当前没有专门 e2e harness，本测试用 vitest 在主进程模块层直接组装
 * ModeSwitchHandler + ProposalRegistry + switch_mode 工具 + 模拟 HITL map +
 * evaluateAgentModeToolAccess + mode-reminder-injector hook，
 * 走完工具拦截、提案、reminder 注入、session reload 等链路，不起 Electron BrowserWindow。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

import { ModeSwitchHandler } from '../mode-switch-handler.js'
import {
  createSwitchModeTool,
  REQUIRES_CLIENT_APPROVAL,
  ALREADY_PENDING,
} from '@tabtin/agent-runtime/tools'
import type { PendingHitlMap } from '@tabtin/agent-runtime'
import type {
  ToolContext,
  StreamEvent,
  EngineState,
  Message,
  Tool,
} from '@tabtin/agent-runtime/engine'
import { StreamEvents } from '@tabtin/agent-wire'
import {
  evaluateAgentModeToolAccess,
} from '@tabtin/agent-modes'
import type {
  AgentModeName,
} from '@tabtin/agent-modes'

import { buildModeReminderHook } from '@tabtin/agent-host/hooks'


type ModeTransitionSetter = (
  sessionId: string,
  transition: { fromMode: AgentModeName; toMode: AgentModeName },
) => void
type ModeTransitionSetterMock = ReturnType<typeof vi.fn> & ModeTransitionSetter

function makeModeTransitionSetterMock(): ModeTransitionSetterMock {
  return vi.fn() as ModeTransitionSetterMock
}

function makeHitlMap(): PendingHitlMap {
  return new Map()
}

function makeCtx(opts: {
  threadId: string
  emit?: (e: StreamEvent) => void
  waiter?: (requestId: string) => Promise<unknown>
}): ToolContext {
  return {
    threadId: opts.threadId,
    runtimeId: 'rt-1',
    abortSignal: new AbortController().signal,
    messages: [],
    emitStreamEvent: opts.emit,
    // ：switch_mode 现为阻塞式 HITL 工具，需 waitForUserInput。
    waitForUserInput: opts.waiter,
  }
}

/** 立即 resolve 指定 outcome 的 waiter（tool 会完成、清 timeout timer，无泄漏）。 */
function immediateWaiter(
  outcome: 'approved' | 'cancelled',
  toMode?: string,
): (requestId: string) => Promise<unknown> {
  return async () => ({ outcome, to_mode: toMode })
}

// ────────────────────────────────────────────────────────────────────
// E2E-5：switch_mode 完整流程（plan → 工具调用 → 卡片 → 用户批准 → cancel HITL + plan exit）
// ────────────────────────────────────────────────────────────────────

describe('E2E-5: switch_mode full flow (plan→agent)', () => {
  let hitlMap: PendingHitlMap
  let setPendingTransition: ModeTransitionSetterMock
  let handler: ModeSwitchHandler

  beforeEach(() => {
    hitlMap = makeHitlMap()
    setPendingTransition = makeModeTransitionSetterMock()
    handler = new ModeSwitchHandler({
      hitlMap,
      setPendingModeTransition: setPendingTransition,
    })
  })

  // ：switch_mode 现为阻塞式 HITL 工具。handleExecute 只做校验 + 返回
  // transition（无副作用——不 cancel HITL、不 setPendingModeTransition）；真正的
  // reconfigure + resolve waiter 由 host handleModeSwitchExecute 编排（此隔离 harness
  // 不含 host，故分别验证 handler 校验 + 工具阻塞/回流两段）。
  it('plan 模式 model 调 switch_mode → emit event → registry 注册 → handleExecute 校验返回 transition（无副作用）', async () => {
    // 模拟 session 内已有一条 pending HITL：本路径不应再 cancel 它。
    const askUserResolved = vi.fn()
    hitlMap.set('batch-pending-1', {
      sessionId: 'sess-1',
      resolver: askUserResolved,
    })

    const events: StreamEvent[] = []
    const tool = createSwitchModeTool({
      proposalRegistry: handler.asProposalRegistry(),
    })
    // 生产路径：卡片 IPC handleExecute 发生在 waiter 仍挂起时。
    let resolveWaiter: (value: unknown) => void = () => {}
    const pending = tool.execute(
      { target_mode_id: 'agent', reason: '需要改代码' },
      makeCtx({
        threadId: 'sess-1',
        emit: (e) => events.push(e),
        waiter: () => new Promise((resolve) => { resolveWaiter = resolve }),
      }),
    )
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe(StreamEvents.MODE_SWITCH_PROPOSAL)
    const proposalId = (events[0]!.payload as Record<string, unknown>).proposal_id as string
    expect(handler.hasPendingProposal('sess-1', proposalId)).toBe(true)

    // handleExecute（host IPC 校验层）：approve → 返回 transition，**不** cancel HITL /
    // **不** setPendingModeTransition（切换由 host reconfigureSessionModeInPlace 承担）。
    const execResult = handler.handleExecute({
      sessionId: 'sess-1',
      proposalId,
      outcome: 'approved',
    })
    expect(execResult.success).toBe(true)
    expect(execResult.outcome).toBe('approved')
    expect(execResult.transition).toEqual({ fromMode: 'plan', toMode: 'agent' })
    // 无副作用断言
    expect(askUserResolved).not.toHaveBeenCalled()
    expect(hitlMap.has('batch-pending-1')).toBe(true)
    expect(setPendingTransition).not.toHaveBeenCalled()
    // proposal 已从注册表移除，防 double-approve
    expect(handler.hasPendingProposal('sess-1', proposalId)).toBe(false)
    const duplicate = handler.handleExecute({
      sessionId: 'sess-1',
      proposalId,
      outcome: 'approved',
    })
    expect(duplicate.success).toBe(false)
    expect(duplicate.error).toMatch(/unknown.*expired/i)

    resolveWaiter({ outcome: 'approved', to_mode: 'agent' })
    const result = await pending
    expect(result.isError).toBeFalsy()
    const body = JSON.parse(result.content as string) as { status: string; mode?: string }
    expect(body.status).toBe('approved')
    expect(result.contextModifier?.modeOverride).toBe('agent')
  })

  it('用户「取消」→ handleExecute 返回 cancelled + 无 transition + 无副作用', async () => {
    const askUserResolved = vi.fn()
    hitlMap.set('batch-pending-1', {
      sessionId: 'sess-1',
      resolver: askUserResolved,
    })

    const events: StreamEvent[] = []
    const tool = createSwitchModeTool({
      proposalRegistry: handler.asProposalRegistry(),
    })
    let resolveWaiter: (value: unknown) => void = () => {}
    const pending = tool.execute(
      { target_mode_id: 'agent', reason: 'r' },
      makeCtx({
        threadId: 'sess-1',
        emit: (e) => events.push(e),
        waiter: () => new Promise((resolve) => { resolveWaiter = resolve }),
      }),
    )
    const proposalId = (events[0]!.payload as Record<string, unknown>).proposal_id as string
    expect(handler.hasPendingProposal('sess-1', proposalId)).toBe(true)

    const execResult = handler.handleExecute({
      sessionId: 'sess-1',
      proposalId,
      outcome: 'cancelled',
    })
    expect(execResult.success).toBe(true)
    expect(execResult.outcome).toBe('cancelled')
    expect(execResult.transition).toBeUndefined()
    // HITL 保留、不设 transition
    expect(askUserResolved).not.toHaveBeenCalled()
    expect(hitlMap.has('batch-pending-1')).toBe(true)
    expect(setPendingTransition).not.toHaveBeenCalled()
    expect(handler.hasPendingProposal('sess-1', proposalId)).toBe(false)

    resolveWaiter({ outcome: 'cancelled' })
    const result = await pending
    const declined = JSON.parse(result.content as string) as { status: string }
    expect(declined.status).toBe('declined')
    expect(result.contextModifier?.modeOverride).toBeUndefined()
  })

  it('waiter 被中断（无 handleExecute）必须释放 pending，下一轮可再 switch_mode', async () => {
    const tool = createSwitchModeTool({
      proposalRegistry: handler.asProposalRegistry(),
    })
    await tool.execute(
      { target_mode_id: 'agent', reason: 'interrupted' },
      makeCtx({
        threadId: 'sess-1',
        emit: () => {},
        waiter: immediateWaiter('cancelled'),
      }),
    )
    expect(handler.countPendingProposalsForSession('sess-1')).toBe(0)

    const events: StreamEvent[] = []
    const retry = await tool.execute(
      { target_mode_id: 'agent', reason: 'retry' },
      makeCtx({
        threadId: 'sess-1',
        emit: (e) => events.push(e),
        waiter: immediateWaiter('approved', 'agent'),
      }),
    )
    expect(retry.isError).toBeFalsy()
    expect(events).toHaveLength(1)
    expect(handler.countPendingProposalsForSession('sess-1')).toBe(0)
  })

  it('F5：伪造 proposal_id 一律拒', () => {
    const result = handler.handleExecute({
      sessionId: 'sess-1',
      proposalId: 'fake-proposal-id-from-attacker',
      outcome: 'approved',
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/unknown.*expired/i)
    expect(setPendingTransition).not.toHaveBeenCalled()
  })

  it('F7：同 session 重复调 switch_mode 返回 already_pending', async () => {
    const tool = createSwitchModeTool({
      proposalRegistry: handler.asProposalRegistry(),
    })
    // 第一次挂起（deferred waiter），模拟卡片仍在等审批。
    let resolveFirst: (v: unknown) => void = () => {}
    const events: StreamEvent[] = []
    const ctx = makeCtx({
      threadId: 'sess-1',
      emit: (e) => events.push(e),
      waiter: () => new Promise((res) => { resolveFirst = res }),
    })
    const firstPromise = tool.execute({ target_mode_id: 'agent', reason: '1st' }, ctx)
    const firstProposalId = (events[0]!.payload as Record<string, unknown>).proposal_id as string

    const second = await tool.execute(
      { target_mode_id: 'agent', reason: '2nd' },
      ctx,
    )
    expect(second.isError).toBe(true)
    const meta = JSON.parse(second.content as string) as {
      error_kind?: string
      existing_proposal_id?: string
    }
    expect(meta.error_kind).toBe(ALREADY_PENDING)
    expect(meta.existing_proposal_id).toBe(firstProposalId)

    resolveFirst({ outcome: 'approved', to_mode: 'agent' })
    await firstPromise
  })

  it('F4：没有 emitStreamEvent → fail-closed requires_client_approval', async () => {
    const tool = createSwitchModeTool({
      proposalRegistry: handler.asProposalRegistry(),
    })
    const result = await tool.execute(
      { target_mode_id: 'agent', reason: 'no-emit' },
      makeCtx({ threadId: 'sess-1' /* 没有 emit */ }),
    )
    expect(result.isError).toBe(true)
    const meta = JSON.parse(result.content as string) as { error_kind?: string }
    expect(meta.error_kind).toBe(REQUIRES_CLIENT_APPROVAL)
  })
})

// ────────────────────────────────────────────────────────────────────
// E2E-6：HITL × mode 切换 — session 隔离 + UI 手动切（notifyManualSwitch）
// ────────────────────────────────────────────────────────────────────

describe('E2E-6: HITL × mode switch (session isolation + manual UI switch)', () => {
  let hitlMap: PendingHitlMap
  let setPendingTransition: ModeTransitionSetterMock
  let handler: ModeSwitchHandler

  beforeEach(() => {
    hitlMap = makeHitlMap()
    setPendingTransition = makeModeTransitionSetterMock()
    handler = new ModeSwitchHandler({
      hitlMap,
      setPendingModeTransition: setPendingTransition,
    })
  })

  it('F1 + F8：用户切 mode 仅 cancel 当前 session 的 pending HITL，其他 session 不受影响', () => {
    const resolveA = vi.fn()
    const resolveB = vi.fn()
    hitlMap.set('batch-A1', { sessionId: 'sess-A', resolver: resolveA })
    hitlMap.set('batch-A2', { sessionId: 'sess-A', resolver: resolveA })
    hitlMap.set('batch-B1', { sessionId: 'sess-B', resolver: resolveB })

    // sess-A 用户切了 mode（ask→agent）→ renderer IPC notifyModeSwitched
    const result = handler.notifyManualSwitch('sess-A', 'ask', 'agent')

    expect(result.cancelledHitlBatchIds.sort()).toEqual(['batch-A1', 'batch-A2'])
    // sess-B 的 batch 必须保留——这是 F1+F8 联合修复的核心断言
    expect(hitlMap.has('batch-B1')).toBe(true)
    expect(resolveA).toHaveBeenCalledTimes(2)
    expect(resolveB).not.toHaveBeenCalled()
  })

  it('F9：任意合法 mode 切换都设置一次 mode transition reminder', () => {
    handler.notifyManualSwitch('sess-1', 'plan', 'agent')
    expect(setPendingTransition).toHaveBeenCalledWith('sess-1', { fromMode: 'plan', toMode: 'agent' })

    setPendingTransition.mockClear()
    handler.notifyManualSwitch('sess-2', 'study', 'agent')
    expect(setPendingTransition).toHaveBeenCalledWith('sess-2', { fromMode: 'study', toMode: 'agent' })

    setPendingTransition.mockClear()
    handler.notifyManualSwitch('sess-3', 'ask', 'agent')
    expect(setPendingTransition).toHaveBeenCalledWith('sess-3', { fromMode: 'ask', toMode: 'agent' })

    setPendingTransition.mockClear()
    handler.notifyManualSwitch('sess-4', 'agent', 'ask')
    expect(setPendingTransition).toHaveBeenCalledWith('sess-4', { fromMode: 'agent', toMode: 'ask' })

    setPendingTransition.mockClear()
    handler.notifyManualSwitch('sess-5', 'plan', 'study')
    expect(setPendingTransition).toHaveBeenCalledWith('sess-5', { fromMode: 'plan', toMode: 'study' })
  })

  it('F9：同 mode 或非法 mode 不注入 transition reminder', () => {
    handler.notifyManualSwitch('sess-same', 'agent', 'agent')
    expect(setPendingTransition).not.toHaveBeenCalled()

    handler.notifyManualSwitch('sess-invalid-from', 'broken', 'agent')
    expect(setPendingTransition).not.toHaveBeenCalled()

    handler.notifyManualSwitch('sess-invalid-to', 'ask', 'broken')
    expect(setPendingTransition).not.toHaveBeenCalled()
  })

  it('#7636：notifyManualSwitch 同步 modeAuthoritySticky（含切回 plan）', () => {
    const sticky = new Map<string, string>()
    handler = new ModeSwitchHandler({
      hitlMap,
      setPendingModeTransition: setPendingTransition,
      setModeAuthoritySticky: (sessionId, mode) => {
        sticky.set(sessionId, mode)
      },
    })

    handler.notifyManualSwitch('sess-1', 'plan', 'agent')
    expect(sticky.get('sess-1')).toBe('agent')

    handler.notifyManualSwitch('sess-1', 'agent', 'plan')
    expect(sticky.get('sess-1')).toBe('plan')
  })

  it('UI 切 mode 后挂起的 mode-switch proposal 被清掉（避免 stale 卡片）', async () => {
    const tool = createSwitchModeTool({
      proposalRegistry: handler.asProposalRegistry(),
    })
    let resolveWaiter: (value: unknown) => void = () => {}
    const hanging = tool.execute(
      { target_mode_id: 'agent', reason: 'pending' },
      makeCtx({
        threadId: 'sess-1',
        emit: () => {},
        waiter: () => new Promise((resolve) => { resolveWaiter = resolve }),
      }),
    )
    expect(handler.countPendingProposalsForSession('sess-1')).toBe(1)

    // 用户直接 UI 切了 mode（不点卡片）→ proposal 应清掉
    handler.notifyManualSwitch('sess-1', 'plan', 'agent')
    expect(handler.countPendingProposalsForSession('sess-1')).toBe(0)
    resolveWaiter({ outcome: 'cancelled' })
    await hanging
  })

  it('mode-switch handler 全局 cleanup：clearAll / clearSession 干净', async () => {
    const tool = createSwitchModeTool({
      proposalRegistry: handler.asProposalRegistry(),
    })
    let resolveA: (value: unknown) => void = () => {}
    let resolveB: (value: unknown) => void = () => {}
    const hangingA = tool.execute(
      { target_mode_id: 'agent', reason: 'a' },
      makeCtx({
        threadId: 'sess-A',
        emit: () => {},
        waiter: () => new Promise((resolve) => { resolveA = resolve }),
      }),
    )
    const hangingB = tool.execute(
      { target_mode_id: 'agent', reason: 'b' },
      makeCtx({
        threadId: 'sess-B',
        emit: () => {},
        waiter: () => new Promise((resolve) => { resolveB = resolve }),
      }),
    )
    expect(handler.countPendingProposalsForSession('sess-A')).toBe(1)
    expect(handler.countPendingProposalsForSession('sess-B')).toBe(1)

    handler.clearSession('sess-A')
    expect(handler.countPendingProposalsForSession('sess-A')).toBe(0)
    expect(handler.countPendingProposalsForSession('sess-B')).toBe(1)

    handler.clearAll()
    expect(handler.countPendingProposalsForSession('sess-B')).toBe(0)
    resolveA({ outcome: 'cancelled' })
    resolveB({ outcome: 'cancelled' })
    await Promise.all([hangingA, hangingB])
  })

  it('payload 校验：缺 sessionId / proposalId 返回 error', () => {
    const r1 = handler.handleExecute({
      sessionId: '',
      proposalId: 'p1',
      outcome: 'approved',
    })
    expect(r1.success).toBe(false)
    expect(r1.error).toMatch(/required/i)

    const r2 = handler.handleExecute({
      sessionId: 's1',
      proposalId: '',
      outcome: 'approved',
    })
    expect(r2.success).toBe(false)
    expect(r2.error).toMatch(/required/i)
  })
})

// ────────────────────────────────────────────────────────────────────
// Phase 4 / 收尾 — 直接调 SSoT 的 guard 行为矩阵 + reminder hook 行为
// ────────────────────────────────────────────────────────────────────

const writeFileTool: Tool = {
  name: 'write_file',
  description: 'Write a file',
  isReadOnly: false,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  } as Tool['inputSchema'],
  execute: async () => ({ content: 'ok', isError: false }),
}

const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read a file',
  isReadOnly: true,
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  } as Tool['inputSchema'],
  execute: async () => ({ content: 'ok', isError: false }),
}

// 用 os.tmpdir() 作为 workspaceRoot：跨平台真实存在，绝对路径形式避免
// macOS 上 /tmp → /private/tmp symlink 导致 isPathResolvedWithinWorkspace
// 比较失败的边界 case。path-aware 解析需要 workspaceRoot 真实存在才能走
// realpath 成功路径；测试不依赖真文件存在（write_file 还没执行）。
import { tmpdir } from 'node:os'
import path from 'node:path'

const TEST_WS = tmpdir()

function abs(p: string): string {
  return path.join(TEST_WS, p)
}

function checkAccess(
  mode: AgentModeName,
  tool: Tool,
  input: unknown,
  workspaceRoot: string = TEST_WS,
) {
  return evaluateAgentModeToolAccess({
    tool,
    toolInput: input,
    agentMode: mode,
    workspaceRoot,
  })
}

// ────────────────────────────────────────────────────────────────────
// E2E-1: Ask 模式 → write_file → mode_restricted → 切 agent → write_file 成功
// ────────────────────────────────────────────────────────────────────
describe('E2E-1: Ask write_file rejected → switch to agent → allowed', () => {
  it('ask 模式 write_file 被软拒，结构化 mode_restricted 错误带 remediation', () => {
    const result = checkAccess('ask', writeFileTool, {
      path: 'foo.ts',
      content: 'x',
    })
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.error.error_kind).toBe('mode_restricted')
      expect(result.error.deny_code).toBe('mode_disallowed_tool')
      expect(result.error.agent_mode).toBe('ask')
      expect(result.error.tool_name).toBe('write_file')
      // P1-5 / F11：ask 模式不应建议模型自调 switch_mode，应该让用户手动切
      expect(result.error.remediation.action).toBe('request_user_switch')
      expect(result.error.remediation.hint).toMatch(/manually|user/i)
    }
  })

  it('agent 模式 write_file 放行（mode 切换后无拦截）', () => {
    const result = checkAccess('agent', writeFileTool, {
      path: 'foo.ts',
      content: 'x',
    })
    expect(result.allowed).toBe(true)
  })

  it('ask 模式只读工具不被拦', () => {
    const result = checkAccess('ask', readFileTool, { path: 'foo.ts' })
    expect(result.allowed).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────────
// E2E-2: Plan 模式 → write_file('a.ts') → 错误 → 切 agent → 成功
// ────────────────────────────────────────────────────────────────────
describe('E2E-2: Plan write_file(.ts) rejected → switch to agent → allowed', () => {
  it('plan 模式 .ts 路径被 path-aware 软拒（mode_disallowed_path）', () => {
    const result = checkAccess('plan', writeFileTool, {
      path: 'src/foo.ts',
      content: 'x',
    })
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.error.deny_code).toBe('mode_disallowed_path')
      // P1-5：plan 模式拒 .ts 写入时应引导走 plan_create 或写 .md 草稿
      expect(['use_plan_create', 'change_path']).toContain(
        result.error.remediation.action,
      )
      expect(result.error.details).toMatchObject({
        agent_mode: 'plan',
        path: 'src/foo.ts',
      })
    }
  })

  it('agent 模式同一调用放行', () => {
    const result = checkAccess('agent', writeFileTool, {
      path: 'src/foo.ts',
      content: 'x',
    })
    expect(result.allowed).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────────
// E2E-3: Plan 模式 → write_file('draft.md') 成功 / write_file('a.ts') 失败
// ────────────────────────────────────────────────────────────────────
describe('E2E-3: Plan path-aware (.md allowed, .ts denied)', () => {
  it('plan 模式 .md 草稿放行', () => {
    const result = checkAccess('plan', writeFileTool, {
      path: abs('draft.md'),
      content: '# Plan',
    })
    expect(result.allowed).toBe(true)
  })

  it('plan 模式 .canvas.tsx 放行（D2 双轨）', () => {
    const result = checkAccess('plan', writeFileTool, {
      path: abs('sketch.canvas.tsx'),
      content: 'export default ...',
    })
    expect(result.allowed).toBe(true)
  })

  it('plan 模式 .ts 被拒', () => {
    const result = checkAccess('plan', writeFileTool, {
      path: abs('a.ts'),
      content: 'x',
    })
    expect(result.allowed).toBe(false)
  })

  it('study 模式 .md 草稿放行（D9 跟随 plan）', () => {
    const result = checkAccess('study', writeFileTool, {
      path: abs('lesson.md'),
      content: 'x',
    })
    expect(result.allowed).toBe(true)
  })

  it('study 模式 .py 被拒', () => {
    const result = checkAccess('study', writeFileTool, {
      path: abs('lesson.py'),
      content: 'x',
    })
    expect(result.allowed).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────
// E2E-4: Ask 模式 10 轮交互 → 每轮 messages 含 mode-reminder；DB history 不含
// ────────────────────────────────────────────────────────────────────

function makeUserMsg(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] }
}

function makeAssistantMsg(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

// 匹配 sparse reminder 内容。当前 sparse 模板是中文「Ask（问答）模式」
// 「Plan（规划）模式」「Study（学习）模式」（permission/agent-modes/src/prompts/*.md），
// 同时 wrapper 在外层包了 <context type="mode-reminder">；任一命中即视为一条 reminder。
function countReminders(messages: readonly Message[]): number {
  let n = 0
  for (const m of messages) {
    if (m.role !== 'user') continue
    const txt = Array.isArray(m.content)
      ? m.content
          .map((b) => (b && typeof b === 'object' && 'text' in b ? b.text : ''))
          .join('\n')
      : String(m.content ?? '')
    if (
      txt.includes('mode-reminder') ||
      txt.includes('问答）模式') ||
      txt.includes('规划）模式') ||
      txt.includes('学习）模式')
    ) {
      n++
    }
  }
  return n
}

describe('E2E-4: per-turn mode reminder injection (ask 10 轮，DB 不含)', () => {
  it('每轮 iteration 0 注入一条 reminder，旧 reminder 被清理（净增 1）', async () => {
    const currentMode: AgentModeName = 'ask'
    const hook = buildModeReminderHook({
      getAgentMode: () => currentMode,
    })
    // 模拟 10 轮 user message
    const state: EngineState = {
      messages: [],
    } as unknown as EngineState

    for (let turn = 1; turn <= 10; turn++) {
      // 用户发一句
      state.messages = [...state.messages, makeUserMsg(`Q ${turn}`)]
      // 调 hook beforeIteration(0)
      await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} })
      // 至少有 1 条 reminder（mode 是 ask）
      expect(countReminders(state.messages)).toBeGreaterThanOrEqual(1)
      // 模拟 assistant 回复
      state.messages = [...state.messages, makeAssistantMsg(`A ${turn}`)]
    }

    // 任意时刻最多只有 1 条 reminder（旧 marker 在新轮被清掉）
    expect(countReminders(state.messages)).toBe(1)
  })

  it('mode 切到 agent 后下一轮 reminder 自动消失', async () => {
    let currentMode: AgentModeName = 'ask'
    const hook = buildModeReminderHook({
      getAgentMode: () => currentMode,
    })
    const state: EngineState = {
      messages: [makeUserMsg('hello')],
    } as unknown as EngineState

    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} })
    expect(countReminders(state.messages)).toBeGreaterThanOrEqual(1)

    // 用户切到 agent
    currentMode = 'agent'
    state.messages = [
      ...state.messages,
      makeAssistantMsg('answer'),
      makeUserMsg('next q'),
    ]
    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} })
    // agent 模式 PER_TURN_MODES 不包含 → 旧 reminder 应被清掉
    expect(countReminders(state.messages)).toBe(0)
  })

  it('iteration > 0 不注入 reminder（仅 iteration 0 触发）', async () => {
    const hook = buildModeReminderHook({
      getAgentMode: () => 'ask',
    })
    const state: EngineState = {
      messages: [makeUserMsg('hello')],
    } as unknown as EngineState

    await hook.beforeIteration!({ state: state, iteration: 1, emitEvent: () => {}, emitNotice: () => {} })
    await hook.beforeIteration!({ state: state, iteration: 5, emitEvent: () => {}, emitNotice: () => {} })
    expect(countReminders(state.messages)).toBe(0)
  })
})

// ────────────────────────────────────────────────────────────────────
// E2E-7: 会话 reload → mode 恢复 + sparse reminder 重注入
// ────────────────────────────────────────────────────────────────────
describe('E2E-7: session reload → mode 恢复 + reminder 重注入', () => {
  it('从 DB 拉回 10 轮无 reminder 的历史 → 重启后第一轮 reminder 重新注入', async () => {
    // 模拟从 DB 拉回的历史（runtime 写 history 时 mode-reminder 不持久化，
    // 所以拉回时这些 marker 不存在）
    const historyFromDb: Message[] = []
    for (let i = 1; i <= 10; i++) {
      historyFromDb.push(makeUserMsg(`Q ${i}`))
      historyFromDb.push(makeAssistantMsg(`A ${i}`))
    }
    historyFromDb.push(makeUserMsg('new question after reload'))

    expect(countReminders(historyFromDb)).toBe(0)

    const hook = buildModeReminderHook({
      getAgentMode: () => 'plan',
    })
    const state: EngineState = {
      messages: historyFromDb.slice(),
    } as unknown as EngineState

    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} })
    // 恢复后第一轮注入一条 reminder
    expect(countReminders(state.messages)).toBeGreaterThanOrEqual(1)
  })

  it('reload 后 mode 切换被正确反映（plan→agent 后下一轮无 reminder）', async () => {
    let mode: AgentModeName = 'plan'
    const hook = buildModeReminderHook({
      getAgentMode: () => mode,
    })
    const state: EngineState = {
      messages: [makeUserMsg('after reload')],
    } as unknown as EngineState
    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} })
    expect(countReminders(state.messages)).toBeGreaterThanOrEqual(1)

    // session 中用户切到 agent，再发一句
    mode = 'agent'
    state.messages = [
      ...state.messages,
      makeAssistantMsg('ok'),
      makeUserMsg('q2'),
    ]
    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} })
    expect(countReminders(state.messages)).toBe(0)
  })
})

// ────────────────────────────────────────────────────────────────────
// E2E-9: Group space 隔离 + agent/group/yolo guard 行为
// ────────────────────────────────────────────────────────────────────

/** 与 renderer `resolveEffectiveAgentMode` 同构（group ⊥ yolo） */
function resolveEffectiveForGroupTest(
  requested: AgentModeName,
  ctx?: { isGroupSpace?: boolean; allowYolo?: boolean },
): AgentModeName {
  if (requested === 'yolo') {
    if (ctx?.isGroupSpace) return 'agent'
    if (!ctx?.allowYolo) return 'agent'
  }
  return requested
}

describe('E2E-9: Group space + ask/plan 隔离', () => {
  it('isGroupSpace=true 时 yolo 请求降级为 agent（PRD DR-8）', () => {
    expect(
      resolveEffectiveForGroupTest('yolo', { isGroupSpace: true, allowYolo: true }),
    ).toBe('agent')
  })

  it('isGroupSpace=true 时 ask/plan 选择不变；guard 仍软拒 write_file', () => {
    for (const mode of ['ask', 'plan'] as const) {
      expect(
        resolveEffectiveForGroupTest(mode, { isGroupSpace: true }),
      ).toBe(mode)
      const result = checkAccess(mode, writeFileTool, {
        path: mode === 'plan' ? abs('draft.md') : 'foo.ts',
        content: 'x',
      })
      if (mode === 'ask') {
        expect(result.allowed).toBe(false)
      } else {
        // plan + .md 草稿仍允许
        expect(result.allowed).toBe(true)
      }
    }
  })

  it('group 模式（Space type=group）write_file 不被 ask/plan guard 误拦', () => {
    const result = checkAccess('group', writeFileTool, {
      path: 'a.ts',
      content: 'x',
    })
    expect(result.allowed).toBe(true)
  })
})

describe('E2E-9b: agent / yolo modes 不被 mode guard 拦截', () => {
  const allModesAgentLike: AgentModeName[] = ['agent', 'group', 'yolo']

  for (const mode of allModesAgentLike) {
    it(`${mode} 模式 write_file('.ts') 放行`, () => {
      const result = checkAccess(mode, writeFileTool, {
        path: 'a.ts',
        content: 'x',
      })
      expect(result.allowed).toBe(true)
    })

    it(`${mode} 模式 write_file('.md') 放行`, () => {
      const result = checkAccess(mode, writeFileTool, {
        path: 'draft.md',
        content: 'x',
      })
      expect(result.allowed).toBe(true)
    })

    it(`${mode} 模式 reminder hook 不注入（PER_TURN_MODES 之外）`, async () => {
      const hook = buildModeReminderHook({
        getAgentMode: () => mode,
      })
      const state: EngineState = {
        messages: [makeUserMsg('hi')],
      } as unknown as EngineState
      await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} })
      expect(countReminders(state.messages)).toBe(0)
    })
  }
})
