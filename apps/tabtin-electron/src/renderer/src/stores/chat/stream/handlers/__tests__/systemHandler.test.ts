import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@tabtin/smartsheet-ui/toast', () => ({
  toast: {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}))

// 记录 i18n 调用以便断言 i18n key + 模板参数
const i18nCalls: Array<{ key: string; opts?: Record<string, unknown> }> = []

vi.mock('@/i18n', () => ({
  default: {
    t: (key: string, opts?: Record<string, unknown>) => {
      i18nCalls.push({ key, opts })
      // 兜底优先返回 defaultValue（让测试侧验证 fallback 路径生效）
      if (opts?.defaultValue) return opts.defaultValue as string
      return key
    },
  },
}))

vi.mock('@tabtin/ws-gateway-client', () => ({
  AgentStreamEvents: {
    SYSTEM_NOTICE: 'agent.stream.system_notice',
    CONTEXT_PRESSURE: 'agent.stream.context_pressure',
    MONITOR_STATUS: 'agent.stream.monitor_status',
    LLM_HEARTBEAT: 'agent.stream.llm_heartbeat',
    // W4.5 第三波 C1（2026-05-13）：TOOL_TIMEOUT 已物理删
  },
}))

vi.mock('../../../shared/helpers', () => ({
  payloadStrOpt: (v: unknown) => (typeof v === 'string' ? v : undefined),
}))

// systemHandler 直接 import 了 useChatModelStore（friendlyModelName 用，仅
// model_override / model_fallback 通知分支需要），而它静态 import 了 chatApi →
// auth/api 整条 store 图，在 vitest 里 dynamic import('../systemHandler') 会被这条
// 重链路拖到超时挂死（实测首条用例 5s timeout、后续拿到半加载模块 → 导出 undefined）。
// 本测试不覆盖 model_* 分支，故注入最小桩隔离这条重依赖。
vi.mock('@stores/useChatModelStore', () => ({
  useChatModelStore: {
    getState: () => ({ availableModels: [] }),
  },
}))

describe('systemHandler', () => {
  const pushAgentStepForSession = vi.fn()
  const updateRunStateForSession = vi.fn()

  const ctx = {
    sessionId: 'session-1',
    spaceId: 'space-1',
    get: () => ({
      pushAgentStepForSession,
      updateRunStateForSession,
    }),
    set: vi.fn(),
    notifyPrefix: '',
    addStreamingSession: vi.fn(),
    removeStreamingSession: vi.fn(),
    client: { sessions: { get: vi.fn() } },
    updateSessionTokenUsageInCaches: vi.fn(),
    updateSessionInCaches: vi.fn(),
    onLifecycleEnd: vi.fn(),
  } as never

  beforeEach(() => {
    vi.clearAllMocks()
    i18nCalls.length = 0
  })

  it('handles subagent_spawn_blocked notice type', async () => {
    const { handleSystemEvent } = await import('../systemHandler')

    handleSystemEvent(
      {
        type: 'agent.stream.system_notice',
        payload: {
          notice_type: 'subagent_spawn_blocked',
          current_children: 3,
          max_concurrent_children: 5,
          content: 'Blocked',
        },
      },
      ctx,
    )

    expect(pushAgentStepForSession).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        type: 'system_notice',
        noticeType: 'subagent_spawn_blocked',
      }),
    )
  })

  it('does not push step for empty content notices', async () => {
    const { handleSystemEvent } = await import('../systemHandler')

    handleSystemEvent(
      {
        type: 'agent.stream.system_notice',
        payload: {
          notice_type: 'unknown',
          content: '',
        },
      },
      ctx,
    )

    expect(pushAgentStepForSession).not.toHaveBeenCalled()
  })

  it('silences skill credential diagnostic notices', async () => {
    const { handleSystemEvent } = await import('../systemHandler')

    for (const noticeType of ['skill_credential_unavailable', 'skill_credential_warning']) {
      handleSystemEvent(
        {
          type: 'agent.stream.system_notice',
          payload: {
            notice_type: noticeType,
            content: 'Skill API Key diagnostic',
          },
        },
        ctx,
      )
    }

    expect(pushAgentStepForSession).not.toHaveBeenCalled()
  })

  it('silences tool schema notices when runtime marks severity=silent', async () => {
    const { handleSystemEvent } = await import('../systemHandler')

    for (const noticeType of ['tool_schema_warn', 'tool_schema_strict']) {
      handleSystemEvent(
        {
          type: 'agent.stream.system_notice',
          payload: {
            notice_type: noticeType,
            severity: 'silent',
            content:
              "Tool 'ask_user' input did not match schema (warn mode — executing anyway): Missing required field 'questions[0].options[0].id'",
          },
        },
        ctx,
      )
    }

    expect(pushAgentStepForSession).not.toHaveBeenCalled()
  })

  // ── Lane H W6：tool_repetition_* 分支 ──
  // sibling 于 tool_failure_*，验证：
  //   1. 命中正确 i18n key（chat:systemNotice.toolRepetitionNotice / Nudge）
  //   2. 工具名走 chat:toolName.${tool} 二次翻译
  //   3. 模板参数齐全：tool / repeatCount / seconds / remaining / count
  //      （count 是 i18next plural keyword = remaining，与 tool-failure 同策略）
  //   4. payload 字段映射正确：count → repeatCount；window_ms → seconds（ms→s）
  //   5. step 携带 noticeType 给 UI 区分

  it('renders tool_repetition_notice with i18n template + tool name lookup', async () => {
    const { handleSystemEvent } = await import('../systemHandler')

    handleSystemEvent(
      {
        type: 'agent.stream.system_notice',
        payload: {
          notice_type: 'tool_repetition_notice',
          tool: 'ask_user',
          count: 2,
          window_ms: 30_000,
          nudge_threshold: 3,
          content: 'fallback content',
        },
      },
      ctx,
    )

    expect(pushAgentStepForSession).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        type: 'system_notice',
        noticeType: 'tool_repetition_notice',
      }),
    )

    // 命中 toolName lookup
    const toolNameCall = i18nCalls.find(c => c.key === 'chat:toolName.ask_user')
    expect(toolNameCall).toBeDefined()
    expect(toolNameCall?.opts?.defaultValue).toBe('ask_user')

    // 命中 toolRepetitionNotice i18n key + 完整模板参数
    const noticeCall = i18nCalls.find(
      c => c.key === 'chat:systemNotice.toolRepetitionNotice',
    )
    expect(noticeCall).toBeDefined()
    expect(noticeCall?.opts).toMatchObject({
      tool: 'ask_user',
      repeatCount: 2,
      seconds: 30,
      remaining: 1,
      count: 1,
    })
  })

  // nudge 用 runtime 真实合法触发数据：count=3, nudge_threshold=4
  // （上一个 notice 在 count=2 触发，nudge 在 count=3 触发；这是 runtime
  // 状态机的真实路径而非 floor 兜底边缘）。同时验证 windowMs 四舍五入：
  // 15500ms → 16s。
  it('renders tool_repetition_nudge with seconds rounded + remaining floor', async () => {
    const { handleSystemEvent } = await import('../systemHandler')

    handleSystemEvent(
      {
        type: 'agent.stream.system_notice',
        payload: {
          notice_type: 'tool_repetition_nudge',
          tool: 'edit_file',
          count: 3,
          window_ms: 15_500,
          nudge_threshold: 4,
          content: 'fallback content',
        },
      },
      ctx,
    )

    expect(pushAgentStepForSession).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        type: 'system_notice',
        noticeType: 'tool_repetition_nudge',
      }),
    )

    const nudgeCall = i18nCalls.find(
      c => c.key === 'chat:systemNotice.toolRepetitionNudge',
    )
    expect(nudgeCall).toBeDefined()
    expect(nudgeCall?.opts).toMatchObject({
      tool: 'edit_file',
      repeatCount: 3,
      seconds: 16,
      remaining: 1,
      count: 1,
    })
  })

  it('falls back to unknownTool label when payload.tool is empty', async () => {
    const { handleSystemEvent } = await import('../systemHandler')

    handleSystemEvent(
      {
        type: 'agent.stream.system_notice',
        payload: {
          notice_type: 'tool_repetition_notice',
          tool: '',
          count: 2,
          window_ms: 30_000,
          nudge_threshold: 3,
          content: 'fallback',
        },
      },
      ctx,
    )

    // unknownTool i18n key 必须被请求（保证回归不会把 '工具' 写死成字面量）
    const unknownToolCall = i18nCalls.find(
      c => c.key === 'chat:systemNotice.unknownTool',
    )
    expect(unknownToolCall).toBeDefined()

    const noticeCall = i18nCalls.find(
      c => c.key === 'chat:systemNotice.toolRepetitionNotice',
    )
    expect(noticeCall?.opts?.tool).toBe('工具')
  })

  // 数值字段非 finite 时（NaN / Infinity / 字符串）必须不污染模板，
  // 回落到与 runtime DEFAULT_TOOL_REPETITION_* 一致的默认（30s / 3）；
  // 修复 Review P1 漏洞：原始实现 typeof === 'number' 不排斥 NaN，
  // Math.max(1, NaN) === NaN 会让模板渲染 "NaN"。
  it('guards against NaN / non-finite numeric payload fields', async () => {
    const { handleSystemEvent } = await import('../systemHandler')

    handleSystemEvent(
      {
        type: 'agent.stream.system_notice',
        payload: {
          notice_type: 'tool_repetition_notice',
          tool: 'ask_user',
          count: NaN,
          window_ms: Infinity,
          nudge_threshold: 'not-a-number',
          content: 'fallback',
        },
      },
      ctx,
    )

    const noticeCall = i18nCalls.find(
      c => c.key === 'chat:systemNotice.toolRepetitionNotice',
    )
    expect(noticeCall).toBeDefined()
    const opts = noticeCall?.opts as Record<string, unknown>
    expect(Number.isFinite(opts.repeatCount as number)).toBe(true)
    expect(Number.isFinite(opts.seconds as number)).toBe(true)
    expect(Number.isFinite(opts.remaining as number)).toBe(true)
    expect(opts.repeatCount).toBe(0)
    expect(opts.seconds).toBe(30)
    expect(opts.remaining).toBe(3)
  })

  // 当 i18n key 缺失（旧客户端 / dev 启动期）时，必须回落到 runtime 提供的
  // rawContent，而不是把 i18n key 字面量当 displayContent 渲染给用户。
  // 这里通过让 mock 在没有 defaultValue 时返回 key 来模拟"无 i18n 资源"。
  it('falls back to runtime content when i18n template unavailable', async () => {
    const { handleSystemEvent } = await import('../systemHandler')

    handleSystemEvent(
      {
        type: 'agent.stream.system_notice',
        payload: {
          notice_type: 'tool_repetition_notice',
          tool: 'ask_user',
          count: 2,
          window_ms: 30_000,
          nudge_threshold: 3,
          content:
            '工具「ask_user」在 30 秒内被相同输入调用了 2 次。TabTin 正在关注，再重复几次会主动提示 Agent 别再重发。',
        },
      },
      ctx,
    )

    // 验证 displayContent 走 runtime fallback content（mock i18n 始终返回
    // defaultValue，即 rawContent）：pushAgentStep 的 detail 应来自 payload.content
    const callArgs = pushAgentStepForSession.mock.calls[0]
    expect(callArgs).toBeDefined()
    expect(callArgs?.[1]?.detail).toContain('工具「ask_user」')
    expect(callArgs?.[1]?.detail).toContain('30 秒内')
  })

  // W4.5 第三波 C1（2026-05-13）：原 TOOL_TIMEOUT 路径 4 个测试已删除——
  // wire 层 `StreamEvents.TOOL_TIMEOUT` 物理删，systemHandler 内 TOOL_TIMEOUT
  // case 也删，链路从源头封死。详见 systemHandler.ts 顶部 docblock。
})
