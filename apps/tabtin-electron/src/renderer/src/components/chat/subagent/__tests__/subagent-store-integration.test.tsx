/**
 * subagent-store-integration.test.tsx — W1 三视角 review · P1 修复 8
 *
 * **锁住 P0 修复 1（ID 接线 bug）**：useSubagentRun 必须**双向匹配**——既支持
 * 按 `subagentRunId`（子 runtime UUID）精确查，也支持按 `parentToolCallId`
 * （父 LLM 给的 `tool_use.id`）反查到同一份 SubagentRun。
 *
 * **回归动机**：tool_use(agent) block 的 id 是父 LLM 给的 `toolu_xxx`，**不是**
 * 子 Agent 自己生成的 run UUID。之前 hook 只精确匹配导致 ToolUseBlockView 路径
 * 永远查不到 store 里的真实 run，SubagentProgressCard 字段全空，体验割裂。
 *
 * 本测试通过**完整链路**走一遍：
 *   1. 真 `useChatRuntimeStore` 模拟 handler 写入一条含 `parentToolCallId` 的 run
 *   2. 调 `useSubagentRun(sessionId, 'toolu_xxx')` 用 parentToolCallId 反查
 *   3. 调 `useSubagentRun(sessionId, 'uuid-a')` 用 subagentRunId 精确查
 *   4. 断言两者拿到同一份 SubagentRun 对象（同字段值）
 *
 * 同时验证 handler 写入路径完整：调真 `handleSubagentEvent` 处理一条
 * SUBAGENT_STARTED 事件，断言 `parentToolCallId` 被持久化到 store——这是
 * P0-1 fix 的前提条件（W0 已经把字段透传到 SUBAGENT_STARTED.parent_tool_call_id，
 * handler 在第 433 行 `parentToolCallId: strOpt(payload.parent_tool_call_id)`
 * 写到 SubagentRun）。
 */

import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import { useChatRuntimeStore } from '@stores/useChatRuntimeStore'
import { useSubagentRun } from '../useSubagentRun'
import { useSubagentRuns } from '../useSubagentRuns'

// 与 subagentHandler.test.ts 一致地 mock i18n / ws-gateway-client / speaker
// registry / chat store——这些模块在 handler 内被 import，集成测试不关心
// 它们的实现细节，只验"事件 → store → hook"主链路。
vi.mock('@/i18n', () => ({
  default: {
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  },
}))

vi.mock('@tabtin/ws-gateway-client', () => ({
  AgentStreamEvents: {
    SUBAGENT_PROGRESS: 'agent.stream.subagent_progress',
    SUBAGENT_STARTED: 'agent.stream.subagent_started',
    SUBAGENT_FAILED: 'agent.stream.subagent_failed',
    SUBAGENT_COMPLETED: 'agent.stream.subagent_completed',
    SUBAGENT_HITL_REQUIRED: 'agent.stream.subagent_hitl_required',
    SUBAGENT_QUEUED: 'agent.stream.subagent_queued',
    SUBAGENT_MODEL_CALL: 'agent.stream.subagent_model_call',
    SPEAKER_PUSH_MESSAGE: 'agent.stream.speaker_push_message',
  },
}))

vi.mock('@stores/useSpeakerRegistryStore', () => ({
  useSpeakerRegistryStore: {
    getState: () => ({
      getSpeaker: vi.fn(() => undefined),
      registerSpeaker: vi.fn(),
    }),
  },
}))

vi.mock('../../../../stores/useSpeakerRegistryStore', () => ({
  useSpeakerRegistryStore: {
    getState: () => ({
      getSpeaker: vi.fn(() => undefined),
      registerSpeaker: vi.fn(),
    }),
  },
}))

// vi.mock 工厂会被提升到文件顶部，工厂内不能引用普通 top-level const（提升时
// 还未初始化）。用 vi.hoisted 让 mock 引用一起被提升，是 vitest 官方推荐的
// "工厂内引用本文件常量"模式（与 subagentHandler.test.ts 一致）。
const { chatStoreMock } = vi.hoisted(() => ({
  chatStoreMock: Object.assign(
    (selector?: (state: Record<string, unknown>) => unknown) => {
      const state = {
        pendingApprovalBySessionId: {} as Record<string, unknown>,
        approvalSubmittingBySessionId: {} as Record<string, boolean>,
      }
      return typeof selector === 'function' ? selector(state) : state
    },
    {
      setState: () => {},
      getState: () => ({
      pendingApprovalBySessionId: {} as Record<string, unknown>,
      approvalSubmittingBySessionId: {} as Record<string, boolean>,
      }),
    },
  ),
}))
vi.mock('@stores/chat/useChatStore', () => ({ useChatStore: chatStoreMock }))
vi.mock('../../../../stores/chat/useChatStore', () => ({ useChatStore: chatStoreMock }))

import { handleSubagentEvent } from '@stores/chat/subagent/handlers/subagentHandler'
import type { HandlerContext } from '@stores/chat/stream/handlers/streamMessageHandler'

const SESSION_ID = 'session-int-w1-p0-1'
const CHILD_UUID = 'uuid-child-a-9f3e-c1d2'
const PARENT_TOOL_USE_ID = 'toolu_B_parent_call_xyz'

beforeEach(() => {
  useChatRuntimeStore.setState({ subagentRunsBySessionId: {} })
})

describe('P0 修复 1：useSubagentRun 双向匹配（subagentRunId / parentToolCallId）', () => {
  it('handler 写入含 parentToolCallId 的 run → 用 parent_tool_call_id 反查能拿到', () => {
    // 走真 handler 路径：模拟 daemon 发来的 SUBAGENT_STARTED 事件
    const ctx = {
      sessionId: SESSION_ID,
      get: () => useChatRuntimeStore.getState(),
      set: useChatRuntimeStore.setState,
    } as unknown as HandlerContext

    handleSubagentEvent(
      {
        type: 'agent.stream.subagent_started',
        payload: {
          subagent_run_id: CHILD_UUID,
          parent_tool_call_id: PARENT_TOOL_USE_ID,
          task: '探索方案 A',
          label: '调研员',
          started_at: 1700000000,
        },
      } as Parameters<typeof handleSubagentEvent>[0],
      ctx,
    )

    // 断言 handler 把 parentToolCallId 写进 store
    const runs = useChatRuntimeStore.getState().subagentRunsBySessionId[SESSION_ID]
    expect(runs).toHaveLength(1)
    expect(runs[0].subagentRunId).toBe(CHILD_UUID)
    expect(runs[0].parentToolCallId).toBe(PARENT_TOOL_USE_ID)

    // 关键：用 parent_tool_call_id 反查能拿到 run（之前会拿不到 → P0 bug）
    let viaParentLookup: ReturnType<typeof useSubagentRun>
    function ParentLookupComp() {
      viaParentLookup = useSubagentRun(SESSION_ID, PARENT_TOOL_USE_ID)
      return null
    }
    render(<ParentLookupComp />)

    expect(viaParentLookup,
      '用 parent_tool_call_id 反查必须命中 run（P0 修复 1）').toBeDefined()
    expect(viaParentLookup?.subagentRunId).toBe(CHILD_UUID)
    expect(viaParentLookup?.task).toBe('探索方案 A')
    expect(viaParentLookup?.status).toBe('running')
  })

  it('同一个 childId resume 到新 parentToolCallId 时，不覆盖旧派活运行', () => {
    const ctx = {
      sessionId: SESSION_ID,
      get: () => useChatRuntimeStore.getState(),
      set: useChatRuntimeStore.setState,
    } as unknown as HandlerContext
    const firstParentToolCallId = 'toolu_first_dispatch'
    const secondParentToolCallId = 'toolu_resume_dispatch'

    handleSubagentEvent(
      {
        type: 'agent.stream.subagent_started',
        payload: {
          subagent_run_id: CHILD_UUID,
          parent_tool_call_id: firstParentToolCallId,
          task: '首次调研',
          label: '供应链调研',
        },
      } as Parameters<typeof handleSubagentEvent>[0],
      ctx,
    )
    handleSubagentEvent(
      {
        type: 'agent.stream.subagent_completed',
        payload: {
          subagent_run_id: CHILD_UUID,
          parent_tool_call_id: firstParentToolCallId,
          label: '供应链调研',
          summary: '首次调研完成',
        },
      } as Parameters<typeof handleSubagentEvent>[0],
      ctx,
    )
    handleSubagentEvent(
      {
        type: 'agent.stream.subagent_started',
        payload: {
          subagent_run_id: CHILD_UUID,
          parent_tool_call_id: secondParentToolCallId,
          task: '读取详情',
          label: '读取核心零部件调研详情',
          resumed: true,
        },
      } as Parameters<typeof handleSubagentEvent>[0],
      ctx,
    )
    handleSubagentEvent(
      {
        type: 'agent.stream.subagent_completed',
        payload: {
          subagent_run_id: CHILD_UUID,
          parent_tool_call_id: secondParentToolCallId,
          label: '读取核心零部件调研详情',
          summary: '详情读取完成',
        },
      } as Parameters<typeof handleSubagentEvent>[0],
      ctx,
    )

    const runs = useChatRuntimeStore.getState().subagentRunsBySessionId[SESSION_ID]
    expect(runs).toHaveLength(2)
    expect(runs.map((r) => r.parentToolCallId)).toEqual([
      firstParentToolCallId,
      secondParentToolCallId,
    ])
    expect(runs.map((r) => r.status)).toEqual(['completed', 'completed'])

    let matchedRuns: ReturnType<typeof useSubagentRuns>
    function AggregateLookupComp() {
      matchedRuns = useSubagentRuns(SESSION_ID, [firstParentToolCallId, secondParentToolCallId])
      return null
    }
    render(<AggregateLookupComp />)

    expect(matchedRuns!.map((r) => r.parentToolCallId)).toEqual([
      firstParentToolCallId,
      secondParentToolCallId,
    ])
    expect(matchedRuns![0].summary).toBe('首次调研完成')
    expect(matchedRuns![1].summary).toBe('详情读取完成')
  })

  it('双向兼容：用 subagentRunId（child UUID）精确查也能拿到同一份 run', () => {
    // 直接通过 store 入口写入（绕过 handler 简化测试，只验 hook 契约）
    useChatRuntimeStore.getState().upsertSubagentRunForSession(SESSION_ID, {
      subagentRunId: CHILD_UUID,
      parentToolCallId: PARENT_TOOL_USE_ID,
      status: 'running',
      task: '探索方案 A',
      label: '调研员',
    })

    let viaChildLookup: ReturnType<typeof useSubagentRun>
    let viaParentLookup: ReturnType<typeof useSubagentRun>
    function DualLookupComp() {
      viaChildLookup = useSubagentRun(SESSION_ID, CHILD_UUID)
      viaParentLookup = useSubagentRun(SESSION_ID, PARENT_TOOL_USE_ID)
      return null
    }
    render(<DualLookupComp />)

    expect(viaChildLookup,
      '用 subagentRunId 精确查必须命中').toBeDefined()
    expect(viaParentLookup,
      '用 parentToolCallId 反查必须命中').toBeDefined()

    // 关键：两条路径拿到的是同一份 SubagentRun（同字段值）
    expect(viaChildLookup?.subagentRunId).toBe(viaParentLookup?.subagentRunId)
    expect(viaChildLookup?.parentToolCallId).toBe(viaParentLookup?.parentToolCallId)
    expect(viaChildLookup?.task).toBe(viaParentLookup?.task)
  })

  it('无 parentToolCallId 的 run（旧 daemon 不透传）仍可通过 subagentRunId 精确查', () => {
    // 防回归：W0 之前 parentToolCallId 永远 undefined，hook 也要兼容旧数据。
    // 用 parent ID 反查应该拿不到（因为字段为 undefined），但用 child UUID 精
    // 确查必须仍能拿到 run。
    useChatRuntimeStore.getState().upsertSubagentRunForSession(SESSION_ID, {
      subagentRunId: CHILD_UUID,
      status: 'completed',
      task: '旧 daemon 写入',
      // 故意不带 parentToolCallId
    })

    let viaChildLookup: ReturnType<typeof useSubagentRun>
    let viaParentLookup: ReturnType<typeof useSubagentRun>
    function CompatComp() {
      viaChildLookup = useSubagentRun(SESSION_ID, CHILD_UUID)
      viaParentLookup = useSubagentRun(SESSION_ID, PARENT_TOOL_USE_ID)
      return null
    }
    render(<CompatComp />)

    expect(viaChildLookup?.task).toBe('旧 daemon 写入')
    expect(viaParentLookup,
      '没 parentToolCallId 时不应该被任何 toolu_* 误命中').toBeUndefined()
  })

  it('错误 id（既不是 child UUID 也不是 parent tool_use.id）→ undefined', () => {
    useChatRuntimeStore.getState().upsertSubagentRunForSession(SESSION_ID, {
      subagentRunId: CHILD_UUID,
      parentToolCallId: PARENT_TOOL_USE_ID,
      status: 'running',
    })

    let result: ReturnType<typeof useSubagentRun>
    function BadIdComp() {
      result = useSubagentRun(SESSION_ID, 'totally-wrong-id-xyz')
      return null
    }
    render(<BadIdComp />)

    expect(result, '不匹配任何 run 的 id → undefined').toBeUndefined()
  })
})

// W4 review P0-B / P0-C — module 级 mock 拦截 SubagentProgressCard 的 props，
// 通过共享 capturedProps 给两个 it 用。doMock + 动态 import 在第二个 it 内
// 因 module cache 难以重置，改用 vi.mock + 共享变量更可靠（vi.mock 工厂在
// import 前 hoist，整个文件生命周期内对所有调用方一致生效）。
const { capturedPropsRef } = vi.hoisted(() => ({
  capturedPropsRef: { current: undefined as Record<string, unknown> | undefined },
}))
// 单个子 Agent 已统一到「对话内 step 形态」：SubagentBlockEntry 现在渲染
// SubagentAggregateView（runs 长度 1）而非 SubagentProgressCard。这里 stub
// 聚合视图捕获 props.runs，断言 ID 接线（真 UUID vs 占位 parentToolCallId）。
// 同时 stub SubagentProgressCard 中和 ToolUseBlockView 的副作用 bare-import。
vi.mock('../SubagentProgressCard', () => ({
  SubagentProgressCard: () => null,
}))
vi.mock('../SubagentAggregateView', () => ({
  AGGREGATE_THRESHOLD: 2,
  SubagentAggregateView: (props: Record<string, unknown>) => {
    capturedPropsRef.current = props
    return null
  },
}))

function capturedRuns(): Array<Record<string, unknown>> | undefined {
  return capturedPropsRef.current?.runs as Array<Record<string, unknown>> | undefined
}

describe('W4 review P0-B 修复：SubagentBlockEntry cancel 链路用真 childId（不是 toolCallId）', () => {
  // 之前 bug：ToolUseBlockView 给 SubagentBlockEntry 传的 subagentRunId 是
  // `block.id`（= 父 LLM `tool_use.id`，`toolu_xxx`），SubagentBlockEntry 直接
  // 透传给 useSubagentCancelState 和 SubagentProgressCard.subagentRunId。
  // 用户点 X → cancelSubagentRun(toolu_xxx) → IPC 走 runtime 的
  // BudgetTracker.cancelSubagent(childId)，但 runtime 那边的 childId 是
  // `crypto.randomUUID()` 不是 toolu_xxx → cancel 永远 no-op → 卡片永远
  // "取消中..." UI 漂移；同时子 Agent 继续跑，违背 C5「取消必须有明确语义」。
  //
  // 修后：SubagentBlockEntry 用 useSubagentRun 双向匹配反查到真正的
  // `subagentRun.subagentRunId` UUID，再把它作为 useSubagentCancelState /
  // SubagentProgressCard.subagentRunId 的 key。本测试守住这条 ID 切换路径。

  beforeEach(() => {
    capturedPropsRef.current = undefined
  })

  it('store 有 run 时：subagentRunId 反查后传聚合视图的 runs[0] 是真 UUID', async () => {
    useChatRuntimeStore.getState().upsertSubagentRunForSession(SESSION_ID, {
      subagentRunId: CHILD_UUID,
      parentToolCallId: PARENT_TOOL_USE_ID,
      status: 'running',
      task: '排查 P0-B',
      label: '执行者',
    })

    const { ToolUseBlockView } = await import('../../blocks/ToolUseBlockView')

    render(
      <ToolUseBlockView
        entry={{
          block: {
            type: 'tool_use',
            id: PARENT_TOOL_USE_ID,
            name: 'agent',
            input: { prompt: '排查 P0-B' },
          },
          block_id: PARENT_TOOL_USE_ID,
          finalized: true,
        } as unknown as Parameters<typeof ToolUseBlockView>[0]['entry']}
        sessionId={SESSION_ID}
        isStreaming={false}
      />,
    )

    const runs = capturedRuns()
    expect(runs, '聚合视图必须被 render 且带 1 条 run').toHaveLength(1)
    expect(runs?.[0].subagentRunId,
      'P0-B 修复：runs[0].subagentRunId 应是真 childId UUID，而不是 parentToolCallId').toBe(CHILD_UUID)
    // P0-C: 命中 run 时 status 用真值 'running'
    expect(runs?.[0].status).toBe('running')
  })

  it('store 无 run 时（SUBAGENT_STARTED 还没到）：fallback 用 parentToolCallId + status=pending', async () => {
    // 反查未命中时 UI 仍能渲染（用 parentToolCallId 作为占位 cancel key）——
    // 这是预期 fallback：runtime 那边子 Agent 还没注册，cancel IPC 命不中
    // 也是对的，但 UI 不应 throw；同时兜底 status 必须是中性 'pending'（W4
    // review P0-C），不是之前的 'running'（会闪一下蓝色 spin 让用户误以为开
    // 始跑了）。
    const { ToolUseBlockView } = await import('../../blocks/ToolUseBlockView')

    render(
      <ToolUseBlockView
        entry={{
          block: {
            type: 'tool_use',
            id: PARENT_TOOL_USE_ID,
            name: 'agent',
            input: { prompt: '排队中 store 还没拿到' },
          },
          block_id: PARENT_TOOL_USE_ID,
          finalized: false,
        } as unknown as Parameters<typeof ToolUseBlockView>[0]['entry']}
        sessionId={SESSION_ID}
        isStreaming={true}
      />,
    )

    const runs = capturedRuns()
    expect(runs, 'store-miss 实时窗口应合成 1 条乐观占位 run').toHaveLength(1)
    expect(runs?.[0].subagentRunId,
      'fallback 应使用 parentToolCallId 作为占位 key（不命中 runtime 是预期）').toBe(PARENT_TOOL_USE_ID)
    expect(runs?.[0].status,
      'P0-C 修复：subagentRun 还没到达时兜底应该是 pending（中性灰），不是 running（蓝色 spin）').toBe('pending')
    expect(runs?.[0].isOptimistic,
      '占位行必须标 isOptimistic（不可 drill-in / 不可 cancel）').toBe(true)
  })
})

describe('P0 修复 2：SUBAGENT_PROGRESS 的 latest_tool_status 字段透传', () => {
  it('handler 收到 latest_tool_status=pending → 写入 SubagentRun.latestToolStatus', () => {
    // 先写一条 run 把 store 初始化
    useChatRuntimeStore.getState().upsertSubagentRunForSession(SESSION_ID, {
      subagentRunId: CHILD_UUID,
      parentToolCallId: PARENT_TOOL_USE_ID,
      status: 'running',
    })

    const ctx = {
      sessionId: SESSION_ID,
      get: () => useChatRuntimeStore.getState(),
      set: useChatRuntimeStore.setState,
    } as unknown as HandlerContext

    // 模拟 cb_start 时 agent-tool 发的轻量 PROGRESS（latest_tool_status='pending'）
    handleSubagentEvent(
      {
        type: 'agent.stream.subagent_progress',
        payload: {
          subagent_run_id: CHILD_UUID,
          step_count: 0, // 不增（已完成步数仍是 0）
          latest_tool: 'read_file',
          latest_tool_status: 'pending',
          latest_success: true, // 残留前一步的值
          elapsed_ms: 100,
          tool_history: [],
        },
      } as Parameters<typeof handleSubagentEvent>[0],
      ctx,
    )

    const run = useChatRuntimeStore.getState()
      .subagentRunsBySessionId[SESSION_ID][0]
    expect(run.latestTool).toBe('read_file')
    expect(run.latestToolStatus,
      'cb_start 路径 latest_tool_status=pending 必须透传到 store').toBe('pending')
    // 关键：stepCount 没增（仍是 0 / undefined），保持"已完成步数"语义
    expect(run.stepCount ?? 0).toBe(0)
  })

  it('handler 收到 latest_tool_status=completed → 透传 + stepCount 才增', () => {
    useChatRuntimeStore.getState().upsertSubagentRunForSession(SESSION_ID, {
      subagentRunId: CHILD_UUID,
      status: 'running',
      latestToolStatus: 'pending',
    })

    const ctx = {
      sessionId: SESSION_ID,
      get: () => useChatRuntimeStore.getState(),
      set: useChatRuntimeStore.setState,
    } as unknown as HandlerContext

    handleSubagentEvent(
      {
        type: 'agent.stream.subagent_progress',
        payload: {
          subagent_run_id: CHILD_UUID,
          step_count: 1, // SYSTEM_NOTICE 路径增到 1
          latest_tool: 'read_file',
          latest_tool_status: 'completed',
          latest_success: true,
          elapsed_ms: 200,
        },
      } as Parameters<typeof handleSubagentEvent>[0],
      ctx,
    )

    const run = useChatRuntimeStore.getState()
      .subagentRunsBySessionId[SESSION_ID][0]
    expect(run.latestToolStatus,
      'SYSTEM_NOTICE 路径 latest_tool_status=completed 必须透传').toBe('completed')
    expect(run.stepCount).toBe(1)
    expect(run.toolHistory).toBeUndefined()
  })

  it('handler 收到无 latest_tool_status 字段（旧 daemon）→ latestToolStatus=undefined 不破坏', () => {
    useChatRuntimeStore.getState().upsertSubagentRunForSession(SESSION_ID, {
      subagentRunId: CHILD_UUID,
      status: 'running',
    })

    const ctx = {
      sessionId: SESSION_ID,
      get: () => useChatRuntimeStore.getState(),
      set: useChatRuntimeStore.setState,
    } as unknown as HandlerContext

    handleSubagentEvent(
      {
        type: 'agent.stream.subagent_progress',
        payload: {
          subagent_run_id: CHILD_UUID,
          step_count: 1,
          latest_tool: 'read_file',
          // 故意不带 latest_tool_status —— 旧 daemon 兼容
          latest_success: true,
          elapsed_ms: 200,
        },
      } as Parameters<typeof handleSubagentEvent>[0],
      ctx,
    )

    const run = useChatRuntimeStore.getState()
      .subagentRunsBySessionId[SESSION_ID][0]
    expect(run.latestToolStatus).toBeUndefined()
    expect(run.latestTool).toBe('read_file')
    expect(run.stepCount).toBe(1)
  })
})
