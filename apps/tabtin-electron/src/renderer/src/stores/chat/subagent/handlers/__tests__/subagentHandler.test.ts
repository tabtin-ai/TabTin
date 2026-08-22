/**
 * subagentHandler 测试 — 覆盖 PRD 06 协调三件套 + SPEAKER_PUSH_MESSAGE。
 *
 * 重点：W4.5-A3 W4a-L28 修复——4 个事件原本被 streamMessageHandler
 * `startsWith('agent.stream.subagent_')` 路由进 subagentHandler 但被
 * fallback 错误当成 status='running' 写入 SubagentRun（污染状态机）；
 * SPEAKER_PUSH_MESSAGE 不在 subagent_ 前缀里更是完全 silent drop。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n', () => ({
  default: {
    t: (key: string, opts?: { defaultValue?: string; [k: string]: unknown }) => {
      const tpl = (opts?.defaultValue as string | undefined) ?? key
      // 简单插值 {{var}} → opts.var；保持与 i18next 同形态以便测试断言文案
      return tpl.replace(/\{\{(\w+)\}\}/g, (_, name) => {
        const v = opts?.[name]
        return v === undefined ? `{{${name}}}` : String(v)
      })
    },
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

const mockGetSpeaker = vi.fn(() => undefined as unknown as { display_name?: string } | undefined)
const mockRegisterSpeaker = vi.fn()

vi.mock('../../../../useSpeakerRegistryStore', () => ({
  useSpeakerRegistryStore: {
    getState: () => ({
      getSpeaker: mockGetSpeaker,
      registerSpeaker: mockRegisterSpeaker,
    }),
  },
}))

// W4.5-A3 P0 修复：HITL handler 通过 useChatStore.setState 写
// pendingApprovalBySessionId 接通 ApprovalPanel——本测试拿 setState updater
// 在内存里推进 mockChatState，让断言能直接读最终态。
//
// 用 vi.hoisted 是因为 vi.mock 工厂会被提升到文件顶部，工厂内部不能引用
// 普通的 top-level const（提升时变量还未初始化）。hoisted 拿到的引用会
// 跟着被一起提升，是 vitest 官方推荐的"工厂内引用本文件常量"模式。
const { mockChatState, mockChatSetState } = vi.hoisted(() => {
  const state: {
    pendingApprovalBySessionId: Record<string, unknown>
    approvalSubmittingBySessionId: Record<string, boolean>
    messagesBySessionId: Record<string, unknown[]>
    rewriteSessionMessages: (sid: string, reason: string, updater: (prev: unknown[]) => unknown[]) => void
  } = {
    pendingApprovalBySessionId: {},
    approvalSubmittingBySessionId: {},
    messagesBySessionId: {},
    rewriteSessionMessages: (sid, _reason, updater) => {
      state.messagesBySessionId[sid] = updater(state.messagesBySessionId[sid] ?? [])
    },
  }
  const setState = vi.fn(
    (updater: ((s: typeof state) => Partial<typeof state>) | Partial<typeof state>) => {
      const patch = typeof updater === 'function' ? updater(state) : updater
      Object.assign(state, patch)
    },
  )
  return { mockChatState: state, mockChatSetState: setState }
})

vi.mock('../../../useChatStore', () => ({
  useChatStore: {
    setState: mockChatSetState,
    getState: () => mockChatState,
  },
}))

import type { SubagentRun } from '../../../shared/types'
import { handleSubagentEvent } from '../subagentHandler'

interface MockStore {
  subagentRunsBySessionId: Record<string, SubagentRun[]>
  upsertSubagentRunForSession: (
    sessionId: string,
    run: SubagentRun,
    options?: { allowRevive?: boolean },
  ) => void
  pushAgentStepForSession: ReturnType<typeof vi.fn>
}

describe('subagentHandler — PRD 06 协调事件', () => {
  let store: MockStore
  let upsertCalls: Array<{
    sessionId: string
    run: SubagentRun
    options?: { allowRevive?: boolean }
  }>

  function makeCtx() {
    return {
      sessionId: 'session-1',
      get: () => store,
      set: vi.fn(),
      addStreamingSession: vi.fn(),
      removeStreamingSession: vi.fn(),
      client: { sessions: { get: vi.fn() } },
      updateSessionTokenUsageInCaches: vi.fn(),
      updateSessionInCaches: vi.fn(),
      onLifecycleEnd: vi.fn(),
      notifyPrefix: '',
    } as never
  }

  beforeEach(() => {
    vi.clearAllMocks()
    upsertCalls = []
    mockChatState.pendingApprovalBySessionId = {}
    mockChatState.approvalSubmittingBySessionId = {}
    store = {
      subagentRunsBySessionId: {},
      upsertSubagentRunForSession: (sessionId, run, options) => {
        upsertCalls.push({ sessionId, run, options })
        const prev = store.subagentRunsBySessionId[sessionId] ?? []
        const idx = prev.findIndex(r => r.subagentRunId === run.subagentRunId)
        if (idx >= 0) {
          const merged = { ...prev[idx], ...run }
          const next = [...prev]
          next[idx] = merged
          store.subagentRunsBySessionId[sessionId] = next
        } else {
          store.subagentRunsBySessionId[sessionId] = [...prev, run]
        }
      },
      pushAgentStepForSession: vi.fn(),
    }
  })

  describe('最小身份模型', () => {
    it('优先读取 run_id / tool_call_id，并写入兼容 SubagentRun 字段', () => {
      handleSubagentEvent(
        {
          type: 'agent.stream.subagent_started',
          payload: {
            run_id: 'child-run-new',
            tool_call_id: 'tu-parent-new',
            dispatcher_run_id: 'owner-run-1',
            label: '研究员',
          },
        },
        makeCtx(),
      )

      expect(upsertCalls).toHaveLength(1)
      expect(upsertCalls[0].run).toMatchObject({
        subagentRunId: 'child-run-new',
        parentToolCallId: 'tu-parent-new',
        dispatchedByRunId: 'owner-run-1',
        status: 'running',
      })
    })

    it('observer-only trace 副本不污染业务 SubagentRun store', () => {
      handleSubagentEvent(
        {
          type: 'agent.stream.subagent_completed',
          payload: {
            run_id: 'child-run-trace',
            subagent_run_id: 'child-run-trace',
            tool_call_id: 'tu-parent-trace',
            observer_only: true,
            summary: 'trace copy',
          },
        },
        makeCtx(),
      )

      expect(upsertCalls).toHaveLength(0)
    })

    it('resumed STARTED 从终态复活时传 allowRevive', () => {
      store.subagentRunsBySessionId['session-1'] = [
        {
          subagentRunId: 'child-run-resume',
          parentToolCallId: 'tu-old',
          status: 'completed',
        } as SubagentRun,
      ]

      handleSubagentEvent(
        {
          type: 'agent.stream.subagent_started',
          payload: {
            run_id: 'child-run-resume',
            tool_call_id: 'tu-new',
            resumed: true,
          },
        },
        makeCtx(),
      )

      expect(upsertCalls).toHaveLength(1)
      expect(upsertCalls[0].run).toMatchObject({
        subagentRunId: 'child-run-resume',
        parentToolCallId: 'tu-new',
        status: 'running',
      })
      expect(upsertCalls[0].options).toEqual({ allowRevive: true })
    })
  })

  // ── SUBAGENT_HITL_REQUIRED ────────────────────────────────────────
  describe('SUBAGENT_HITL_REQUIRED', () => {
    it('push system_notice agentStep（noticeType=subagent_hitl_required，title 含 label）', () => {
      handleSubagentEvent(
        {
          type: 'agent.stream.subagent_hitl_required',
          payload: {
            subagent_run_id: 'sub-1',
            approval_id: 'apr-1',
            label: '研究员',
            prompt: '准备读取敏感文件，是否继续？',
          },
        },
        makeCtx(),
      )

      expect(store.pushAgentStepForSession).toHaveBeenCalledTimes(1)
      const [sid, step] = store.pushAgentStepForSession.mock.calls[0] as [string, Record<string, unknown>]
      expect(sid).toBe('session-1')
      expect(step.type).toBe('system_notice')
      expect(step.noticeType).toBe('subagent_hitl_required')
      expect(step.status).toBe('running')
      expect(step.title).toContain('研究员')
      expect(step.detail).toContain('准备读取敏感文件')
    })

    it('requires_host_platform=electron 时 detail 加"请在桌面端处理"提示（mobile 平台 graceful）', () => {
      handleSubagentEvent(
        {
          type: 'agent.stream.subagent_hitl_required',
          payload: {
            subagent_run_id: 'sub-1',
            approval_id: 'apr-1',
            label: '研究员',
            prompt: '准备读敏感文件',
            requires_host_platform: 'electron',
          },
        },
        makeCtx(),
      )

      const step = store.pushAgentStepForSession.mock.calls[0]?.[1] as Record<string, unknown>
      expect(step.detail).toContain('请在桌面端处理')
    })

    it('不动 SubagentRun.status（HITL 是临时 pause，保留已有 running / pending）', () => {
      // 先种入一条 running 的 SubagentRun
      store.subagentRunsBySessionId['session-1'] = [
        { subagentRunId: 'sub-1', status: 'running' } as SubagentRun,
      ]

      handleSubagentEvent(
        {
          type: 'agent.stream.subagent_hitl_required',
          payload: {
            subagent_run_id: 'sub-1',
            approval_id: 'apr-1',
            prompt: '请审批',
          },
        },
        makeCtx(),
      )

      // 不应调 upsertSubagentRunForSession（不污染 status）
      expect(upsertCalls).toHaveLength(0)
      // SubagentRun 保持 running
      expect(store.subagentRunsBySessionId['session-1'][0].status).toBe('running')
    })

    it('payload 缺 prompt 时仍 push step（用 fallback 文案）', () => {
      handleSubagentEvent(
        {
          type: 'agent.stream.subagent_hitl_required',
          payload: {
            subagent_run_id: 'sub-1',
            approval_id: 'apr-1',
            label: '研究员',
          },
        },
        makeCtx(),
      )

      expect(store.pushAgentStepForSession).toHaveBeenCalledTimes(1)
      const step = store.pushAgentStepForSession.mock.calls[0]?.[1] as Record<string, unknown>
      expect(step.detail).toContain('研究员')
      expect(step.detail).toContain('请求审批')
    })

    // ── ApprovalPanel 接通（W4.5-A3 P0 修复）─────────────────────────
    // 之前只 push system_notice agentStep，缺真正的"高视觉权重审批入口"。
    // 修复后必须同步写 useChatStore.pendingApprovalBySessionId，让
    // ChatContent.tsx 的 selector 立即捕获并渲染 ApprovalPanel。
    describe('ApprovalPanel 接通 (P0 修复 W45-A3)', () => {
      it('approval_id 存在 → 写 pendingApproval（batchId / actionRequests / threadId 全齐）', () => {
        handleSubagentEvent(
          {
            type: 'agent.stream.subagent_hitl_required',
            payload: {
              subagent_run_id: 'sub-1',
              approval_id: 'apr-batch-001',
              label: '研究员',
              prompt: '准备读取敏感文件 /etc/passwd，是否继续？',
            },
          },
          makeCtx(),
        )

        const pending = mockChatState.pendingApprovalBySessionId['session-1'] as Record<string, unknown>
        expect(pending).toBeDefined()
        // batchId == approval_id：daemon 端 LocalPermissionHandler 用此 key 索引 resolver
        expect(pending.batchId).toBe('apr-batch-001')
        // threadId 与本地 IPC 路径一致
        expect(pending.threadId).toBe('chat-session-session-1')
        // ApprovalPanel 头部展示用
        expect(pending.interactionType).toBe('review')
        expect(pending.blockingPolicy).toBe('hard')
        expect(pending.runtimeMode).toBe('interactive')
        // actionRequests 单元素：子 Agent 整体审批，不是 multi-tool batch
        const actionRequests = pending.actionRequests as Array<Record<string, unknown>>
        expect(actionRequests).toHaveLength(1)
        expect(actionRequests[0]).toMatchObject({
          request_id: 'apr-batch-001',
          tool_call_id: 'sub-1',
          tool_name: '研究员',
          risk_level: 'medium',
        })
        expect((actionRequests[0].description as string)).toContain('敏感文件')
      })

      it('提交后默认非提交中态（approvalSubmittingBySessionId[sid] = false）', () => {
        handleSubagentEvent(
          {
            type: 'agent.stream.subagent_hitl_required',
            payload: {
              subagent_run_id: 'sub-1',
              approval_id: 'apr-1',
              label: '研究员',
            },
          },
          makeCtx(),
        )

        expect(mockChatState.approvalSubmittingBySessionId['session-1']).toBe(false)
      })

      it('expires_at 存在 → 计算 approvalTtlSeconds + interruptedAt（倒计时数据齐）', () => {
        const futureExpires = Date.now() + 60_000 // 60 秒后过期
        handleSubagentEvent(
          {
            type: 'agent.stream.subagent_hitl_required',
            payload: {
              subagent_run_id: 'sub-1',
              approval_id: 'apr-1',
              label: '研究员',
              expires_at: futureExpires,
            },
          },
          makeCtx(),
        )

        const pending = mockChatState.pendingApprovalBySessionId['session-1'] as Record<string, unknown>
        expect(pending.expiresAt).toBe(futureExpires)
        // 应该约等于 60 秒（允许 ±2 秒漂移防 CI 慢）
        const ttl = pending.approvalTtlSeconds as number
        expect(ttl).toBeGreaterThan(57)
        expect(ttl).toBeLessThanOrEqual(60)
        expect(pending.interruptedAt).toBeDefined()
      })

      it('已有在途 pendingApproval → 不覆盖（主路径 approval_requested 的 payload 更丰富）', () => {
        mockChatState.pendingApprovalBySessionId['session-1'] = {
          sessionId: 'session-1',
          batchId: 'existing-batch',
          actionRequests: [{ request_id: 'existing-req', tool_name: 'real_tool' }],
        }

        handleSubagentEvent(
          {
            type: 'agent.stream.subagent_hitl_required',
            payload: {
              subagent_run_id: 'sub-1',
              approval_id: 'apr-late',
              label: '研究员',
              prompt: '请审批',
            },
          },
          makeCtx(),
        )

        // banner 兜底仍 push，但 pendingApproval 保持原样
        expect(store.pushAgentStepForSession).toHaveBeenCalledTimes(1)
        const pending = mockChatState.pendingApprovalBySessionId['session-1'] as Record<string, unknown>
        expect(pending.batchId).toBe('existing-batch')
      })

      it('approval_id 缺失 → 仅 push banner，**不写** pendingApproval（防 ApprovalPanel 卡 submit）', () => {
        // 缺 batchId 时 submitHitlBatch 必失败，让 panel 不渲染比卡住强
        handleSubagentEvent(
          {
            type: 'agent.stream.subagent_hitl_required',
            payload: {
              subagent_run_id: 'sub-1',
              label: '研究员',
              prompt: '准备读敏感文件',
            },
          },
          makeCtx(),
        )

        // banner 还是要 push（兜底）
        expect(store.pushAgentStepForSession).toHaveBeenCalledTimes(1)
        // 但 pendingApproval 不写
        expect(mockChatState.pendingApprovalBySessionId['session-1']).toBeUndefined()
        // setState 未被调用（因为不写 pending）
        expect(mockChatSetState).not.toHaveBeenCalled()
      })

      it('payload 自带 risk_level=high → 透传到 actionRequest（不被默认 medium 覆盖）', () => {
        handleSubagentEvent(
          {
            type: 'agent.stream.subagent_hitl_required',
            payload: {
              subagent_run_id: 'sub-1',
              approval_id: 'apr-1',
              label: '研究员',
              risk_level: 'high',
            },
          },
          makeCtx(),
        )

        const pending = mockChatState.pendingApprovalBySessionId['session-1'] as Record<string, unknown>
        const actionRequests = pending.actionRequests as Array<Record<string, unknown>>
        expect(actionRequests[0].risk_level).toBe('high')
      })

      it('runtime_mode=batch → 透传（runtimeMode 影响 ApprovalPanel 头部展示文案）', () => {
        handleSubagentEvent(
          {
            type: 'agent.stream.subagent_hitl_required',
            payload: {
              subagent_run_id: 'sub-1',
              approval_id: 'apr-1',
              runtime_mode: 'batch',
            },
          },
          makeCtx(),
        )

        const pending = mockChatState.pendingApprovalBySessionId['session-1'] as Record<string, unknown>
        expect(pending.runtimeMode).toBe('batch')
      })
    })
  })

  // ── SUBAGENT 终态守门 ─────────────────────────────────────────────
  describe('SUBAGENT terminal guard', () => {
    it('completed SubagentRun 不被迟到 PROGRESS 覆盖回 running', () => {
      store.subagentRunsBySessionId['session-1'] = [
        { subagentRunId: 'sub-1', status: 'completed' } as SubagentRun,
      ]

      handleSubagentEvent(
        {
          type: 'agent.stream.subagent_progress',
          payload: {
            subagent_run_id: 'sub-1',
            step_count: 2,
            latest_tool: 'run_terminal_command',
          },
        },
        makeCtx(),
      )

      expect(upsertCalls).toHaveLength(0)
      expect(store.subagentRunsBySessionId['session-1'][0].status).toBe('completed')
    })

    it('failed SubagentRun 不被迟到 PROGRESS 覆盖回 running', () => {
      store.subagentRunsBySessionId['session-1'] = [
        { subagentRunId: 'sub-1', status: 'failed' } as SubagentRun,
      ]

      handleSubagentEvent(
        {
          type: 'agent.stream.subagent_progress',
          payload: {
            subagent_run_id: 'sub-1',
            step_count: 2,
          },
        },
        makeCtx(),
      )

      expect(upsertCalls).toHaveLength(0)
      expect(store.subagentRunsBySessionId['session-1'][0].status).toBe('failed')
    })

    it('completed SubagentRun 不被迟到 STARTED 覆盖回 running', () => {
      store.subagentRunsBySessionId['session-1'] = [
        { subagentRunId: 'sub-1', status: 'completed' } as SubagentRun,
      ]

      handleSubagentEvent(
        {
          type: 'agent.stream.subagent_started',
          payload: {
            subagent_run_id: 'sub-1',
            label: '执行者',
          },
        },
        makeCtx(),
      )

      expect(upsertCalls).toHaveLength(0)
      expect(store.subagentRunsBySessionId['session-1'][0].status).toBe('completed')
    })

    it('completed SubagentRun 不被迟到 FAILED 覆盖成 failed', () => {
      store.subagentRunsBySessionId['session-1'] = [
        { subagentRunId: 'sub-1', status: 'completed' } as SubagentRun,
      ]

      handleSubagentEvent(
        {
          type: 'agent.stream.subagent_failed',
          payload: {
            subagent_run_id: 'sub-1',
            error: 'late failure',
          },
        },
        makeCtx(),
      )

      expect(upsertCalls).toHaveLength(0)
      expect(store.subagentRunsBySessionId['session-1'][0].status).toBe('completed')
    })

    it('正常序列 STARTED → PROGRESS → COMPLETED 仍写入最终 completed', () => {
      handleSubagentEvent(
        {
          type: 'agent.stream.subagent_started',
          payload: {
            subagent_run_id: 'sub-1',
            label: '执行者',
          },
        },
        makeCtx(),
      )
      handleSubagentEvent(
        {
          type: 'agent.stream.subagent_progress',
          payload: {
            subagent_run_id: 'sub-1',
            step_count: 1,
          },
        },
        makeCtx(),
      )
      handleSubagentEvent(
        {
          type: 'agent.stream.subagent_completed',
          payload: {
            subagent_run_id: 'sub-1',
            summary: '完成',
          },
        },
        makeCtx(),
      )

      expect(store.subagentRunsBySessionId['session-1'][0]).toMatchObject({
        subagentRunId: 'sub-1',
        status: 'completed',
        summary: '完成',
      })
    })

    it('PROGRESS 可回填 parentToolCallId，避免 STARTED 丢失时聚合卡反查失败', () => {
      handleSubagentEvent(
        {
          type: 'agent.stream.subagent_progress',
          payload: {
            subagent_run_id: 'sub-1',
            parent_tool_call_id: 'agent:0',
            step_count: 1,
          },
        },
        makeCtx(),
      )

      expect(store.subagentRunsBySessionId['session-1'][0]).toMatchObject({
        subagentRunId: 'sub-1',
        status: 'running',
        parentToolCallId: 'agent:0',
      })
    })
  })

  // ── SUBAGENT_QUEUED ───────────────────────────────────────────────
  describe('SUBAGENT_QUEUED', () => {
    it('upsert SubagentRun status=queued', () => {
      handleSubagentEvent(
        {
          type: 'agent.stream.subagent_queued',
          payload: {
            subagent_run_id: 'sub-q1',
            label: '执行者',
            queue_position: 2,
          },
        },
        makeCtx(),
      )

      expect(upsertCalls).toHaveLength(1)
      expect(upsertCalls[0].sessionId).toBe('session-1')
      expect(upsertCalls[0].run).toMatchObject({
        subagentRunId: 'sub-q1',
        status: 'queued',
        label: '执行者',
      })
      // QUEUED 不 push agentStep（STARTED 到达时自动切到 running）
      expect(store.pushAgentStepForSession).not.toHaveBeenCalled()
    })

    it('从 speaker.model 回填 SubagentRun.model，供对话内卡片展示', () => {
      handleSubagentEvent(
        {
          type: 'agent.stream.subagent_queued',
          payload: {
            subagent_run_id: 'sub-q-model',
            label: '执行者',
            speaker: {
              speaker_id: 'sub-q-model',
              display_name: '执行者',
              model: 'kimi-k2.6',
            },
          },
        },
        makeCtx(),
      )

      expect(upsertCalls).toHaveLength(1)
      expect(upsertCalls[0].run.model).toBe('kimi-k2.6')
    })

    it('终态 SubagentRun（completed/failed/cancelled）不被 QUEUED 覆盖回 queued（防 daemon 异常补发）', () => {
      store.subagentRunsBySessionId['session-1'] = [
        { subagentRunId: 'sub-q1', status: 'completed' } as SubagentRun,
      ]

      handleSubagentEvent(
        {
          type: 'agent.stream.subagent_queued',
          payload: { subagent_run_id: 'sub-q1' },
        },
        makeCtx(),
      )

      expect(upsertCalls).toHaveLength(0)
      expect(store.subagentRunsBySessionId['session-1'][0].status).toBe('completed')
    })

    it('cancelled SubagentRun 不被 QUEUED 复活', () => {
      store.subagentRunsBySessionId['session-1'] = [
        { subagentRunId: 'sub-q1', status: 'cancelled' } as SubagentRun,
      ]

      handleSubagentEvent(
        {
          type: 'agent.stream.subagent_queued',
          payload: { subagent_run_id: 'sub-q1' },
        },
        makeCtx(),
      )

      expect(upsertCalls).toHaveLength(0)
      expect(store.subagentRunsBySessionId['session-1'][0].status).toBe('cancelled')
    })
  })

  // ── SUBAGENT_MODEL_CALL ───────────────────────────────────────────
  describe('SUBAGENT_MODEL_CALL', () => {
    it('纯 observability：不动 store / 不 push agentStep', () => {
      handleSubagentEvent(
        {
          type: 'agent.stream.subagent_model_call',
          payload: {
            subagent_run_id: 'sub-m1',
            model: 'claude-sonnet-4-20250514',
            iteration: 3,
          },
        },
        makeCtx(),
      )

      expect(upsertCalls).toHaveLength(0)
      expect(store.pushAgentStepForSession).not.toHaveBeenCalled()
    })
  })

  // ── SPEAKER_PUSH_MESSAGE ──────────────────────────────────────────
  describe('SPEAKER_PUSH_MESSAGE', () => {
    it('push system_notice agentStep（noticeType=speaker_push_message）+ speaker label 来自 SpeakerRegistry', () => {
      mockGetSpeaker.mockReturnValue({ display_name: '研究员 Alice' })

      handleSubagentEvent(
        {
          type: 'agent.stream.speaker_push_message',
          payload: {
            speaker_id: 'spkr-alice',
            content: '我已经完成了第一阶段的调研。',
          },
        },
        makeCtx(),
      )

      expect(store.pushAgentStepForSession).toHaveBeenCalledTimes(1)
      const step = store.pushAgentStepForSession.mock.calls[0]?.[1] as Record<string, unknown>
      expect(step.type).toBe('system_notice')
      expect(step.noticeType).toBe('speaker_push_message')
      expect(step.title).toContain('研究员 Alice')
      expect(step.detail).toContain('第一阶段的调研')
    })

    it('SpeakerRegistry 未注册时 fallback 到 speaker_id 短前缀', () => {
      mockGetSpeaker.mockReturnValue(undefined)

      handleSubagentEvent(
        {
          type: 'agent.stream.speaker_push_message',
          payload: {
            speaker_id: 'spkr-unknown-uuid',
            content: '主动汇报',
          },
        },
        makeCtx(),
      )

      const step = store.pushAgentStepForSession.mock.calls[0]?.[1] as Record<string, unknown>
      expect(step.title).toContain('spkr')
    })

    it('payload 无 content 时不 push step（防空通知卡）', () => {
      handleSubagentEvent(
        {
          type: 'agent.stream.speaker_push_message',
          payload: {
            speaker_id: 'spkr-alice',
          },
        },
        makeCtx(),
      )

      expect(store.pushAgentStepForSession).not.toHaveBeenCalled()
    })

    it('SPEAKER_PUSH_MESSAGE 不绑 subagent_run_id —— payload 没 subagent_run_id 也 push step', () => {
      handleSubagentEvent(
        {
          type: 'agent.stream.speaker_push_message',
          payload: {
            speaker_id: 'spkr-alice',
            content: '汇报',
          },
        },
        makeCtx(),
      )

      expect(store.pushAgentStepForSession).toHaveBeenCalledTimes(1)
    })
  })

  // ── 反 silent drop 兜底守门 ───────────────────────────────────────
  describe('反 silent drop default 分支', () => {
    it('未识别的 subagent_* 事件不污染 SubagentRun.status 为 running', () => {
      store.subagentRunsBySessionId['session-1'] = [
        { subagentRunId: 'sub-1', status: 'completed' } as SubagentRun,
      ]

      handleSubagentEvent(
        {
          type: 'agent.stream.subagent_future_event_2030',
          payload: { subagent_run_id: 'sub-1' },
        },
        makeCtx(),
      )

      // 未识别事件 → 无 upsert（旧实现会被 fallback 写成 'running' 覆盖 'completed'）
      expect(upsertCalls).toHaveLength(0)
      expect(store.subagentRunsBySessionId['session-1'][0].status).toBe('completed')
    })
  })
})
