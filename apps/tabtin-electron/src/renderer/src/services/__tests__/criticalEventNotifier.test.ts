/**
 * criticalEventNotifier 测试。
 *
 * 处理范围：stream 级"需要人工确认"事件（仅 `agent.stream.{thread_id}` topic）：
 *   - agent.stream.approval_requested（v0.4 W1.5：批量审批 HITL）
 *   - agent.stream.ask_user_required（W4 / 2026-05-11 合一形态：原 ask 三件套合并为单 ask_user）
 *
 * 历史背景：早期（Wave 5/6/7）有"跨 wt 任务通知"机制（user.{userId} 通道 +
 * useGlobalTaskMonitor + 角标 + inbox 离线补送），2026-05 整套删除；
 * 本 notifier 是仅存的"非前台 stream 级关键事件"toast 路径。
 *
 * 反向断言下方保留：agent.run.status_changed / goal.run.failed /
 * agent.action.approval_request 在前端不再被任何 listener 处理。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockToast = vi.fn()

vi.mock('@tabtin/smartsheet-ui/toast', () => ({
  toast: mockToast,
}))

vi.mock('@tabtin/app-shell', () => ({
  useOrganizationStore: {
    getState: () => ({
      organizations: [
        { id: 'ws-A', name: 'Team Alpha' },
        { id: 'ws-B', name: 'Team Beta' },
      ],
    }),
  },
}))

vi.mock('@/i18n', () => ({
  default: {
    t: (key: string, options?: Record<string, unknown>) => {
      const def =
        typeof options?.defaultValue === 'string'
          ? options.defaultValue
          : key
      return def.replace('{{name}}', String(options?.name ?? ''))
    },
  },
}))

vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

let useBackgroundEventStore: typeof import('../../stores/useBackgroundEventStore').useBackgroundEventStore
let registerCriticalBackgroundEventNotifier: typeof import('../criticalEventNotifier').registerCriticalBackgroundEventNotifier
let __resetCriticalNotifierRegistrationForTest: typeof import('../criticalEventNotifier').__resetCriticalNotifierRegistrationForTest
let __resetBackgroundEventListenersForTest: typeof import('../../stores/useBackgroundEventStore').__resetBackgroundEventListenersForTest

beforeEach(async () => {
  vi.resetModules()
  mockToast.mockClear()

  const storeMod = await import('../../stores/useBackgroundEventStore')
  useBackgroundEventStore = storeMod.useBackgroundEventStore
  __resetBackgroundEventListenersForTest = storeMod.__resetBackgroundEventListenersForTest

  const notifierMod = await import('../criticalEventNotifier')
  registerCriticalBackgroundEventNotifier = notifierMod.registerCriticalBackgroundEventNotifier
  __resetCriticalNotifierRegistrationForTest = notifierMod.__resetCriticalNotifierRegistrationForTest

  useBackgroundEventStore.getState().clearAll()
  __resetBackgroundEventListenersForTest()
  __resetCriticalNotifierRegistrationForTest()
})

describe('registerCriticalBackgroundEventNotifier (Wave 5 收敛后)', () => {
  it('agent.stream.approval_requested 触发 toast（user 通道不覆盖）', () => {
    registerCriticalBackgroundEventNotifier()

    useBackgroundEventStore.getState().enqueue('ws-B', {
      type: 'agent.stream.approval_requested',
      payload: { batch_id: 'batch-1' },
      organization_id: 'ws-B',
      event_id: 'e-rev',
    })

    expect(mockToast).toHaveBeenCalledTimes(1)
    const call = mockToast.mock.calls[0][0]
    expect(call.title).toContain('确认')
    expect(call.description).toContain('Team Beta')
  })

  it('agent.stream.ask_user_required 触发 toast (W4: 单形态合一)', () => {
    registerCriticalBackgroundEventNotifier()

    useBackgroundEventStore.getState().enqueue('ws-A', {
      type: 'agent.stream.ask_user_required',
      payload: { session_id: 's-2' },
      organization_id: 'ws-A',
      event_id: 'e-ask',
    })

    expect(mockToast).toHaveBeenCalledTimes(1)
  })

  it('agent.run.status_changed / goal.run.failed / agent.action.approval_request 均不在白名单内，不触发 toast', () => {
    registerCriticalBackgroundEventNotifier()

    useBackgroundEventStore.getState().enqueue('ws-A', {
      type: 'agent.run.status_changed',
      payload: { status: 'failed', run_id: 'r-1' },
      organization_id: 'ws-A',
      event_id: 'e-run-failed',
    })

    useBackgroundEventStore.getState().enqueue('ws-A', {
      type: 'tracker.run.failed',
      payload: { run_id: 'r-1', organization_id: 'ws-A' },
      organization_id: 'ws-A',
      event_id: 'e-goal',
    })

    useBackgroundEventStore.getState().enqueue('ws-A', {
      type: 'agent.action.approval_request',
      payload: { approval_id: 'apr-1' },
      organization_id: 'ws-A',
      event_id: 'e-approval',
    })

    expect(mockToast).not.toHaveBeenCalled()
  })

  it('已废弃的 action_required 字面量不再误匹配（精确白名单）', () => {
    registerCriticalBackgroundEventNotifier()
    useBackgroundEventStore.getState().enqueue('ws-A', {
      type: 'agent.action.action_required',
      payload: {},
      organization_id: 'ws-A',
      event_id: 'e-3a',
    })
    expect(mockToast).not.toHaveBeenCalled()
  })

  it('普通 agent.stream 流式 delta 不触发 toast', () => {
    registerCriticalBackgroundEventNotifier()

    useBackgroundEventStore.getState().enqueue('ws-A', {
      type: 'agent.stream.text_delta',
      payload: { content: 'hi' },
      organization_id: 'ws-A',
      event_id: 'e-delta',
    })

    expect(mockToast).not.toHaveBeenCalled()
  })

  it('生产代码调返回的 unsubscribe 是 no-op（防止 Wave 5 误解绑）', () => {
    const unsub = registerCriticalBackgroundEventNotifier()
    unsub()

    useBackgroundEventStore.getState().enqueue('ws-A', {
      type: 'agent.stream.approval_requested',
      payload: { batch_id: 'batch-x' },
      organization_id: 'ws-A',
      event_id: 'e-still-active',
    })

    // listener 仍然在 —— 符合"renderer 全生命周期单例"的设计意图
    expect(mockToast).toHaveBeenCalledTimes(1)
  })

  it('只有 __resetCriticalNotifierRegistrationForTest 能真正解绑（test helper）', () => {
    registerCriticalBackgroundEventNotifier()

    useBackgroundEventStore.getState().enqueue('ws-A', {
      type: 'agent.stream.approval_requested',
      payload: { batch_id: 'batch-1' },
      organization_id: 'ws-A',
      event_id: 'e-6',
    })
    expect(mockToast).toHaveBeenCalledTimes(1)

    __resetCriticalNotifierRegistrationForTest()

    useBackgroundEventStore.getState().enqueue('ws-A', {
      type: 'agent.stream.approval_requested',
      payload: { batch_id: 'batch-2' },
      organization_id: 'ws-A',
      event_id: 'e-7',
    })
    // 第二次不应触发
    expect(mockToast).toHaveBeenCalledTimes(1)
  })

  it('重复 register 是 no-op，listener 只挂一次', () => {
    registerCriticalBackgroundEventNotifier()
    registerCriticalBackgroundEventNotifier()

    useBackgroundEventStore.getState().enqueue('ws-A', {
      type: 'agent.stream.approval_requested',
      payload: { batch_id: 'batch-1' },
      organization_id: 'ws-A',
      event_id: 'e-dup',
    })

    // 只响应一次
    expect(mockToast).toHaveBeenCalledTimes(1)
  })
})
