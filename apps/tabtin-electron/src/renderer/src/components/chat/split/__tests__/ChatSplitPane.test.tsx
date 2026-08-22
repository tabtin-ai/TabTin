/**
 * Wave 5 二次续作 P1(新)-A (charter v1.8 §6.7):
 * ChatSplitPane 在分屏模式下也必须渲染 4 表达点之 #1/#3/#4。
 *
 * 此前 ChatSplitPane 是独立会话渲染路径(不调用 ChatContent),
 * 一旦用户在分屏内打开 Tracker Run 关联的 ChatSession,
 * Breadcrumb / SystemNote / StatusIndicator 全部缺失 — 违反 charter §6.7。
 *
 * 本 smoke test 用最小 store stub 验证: 当 session.tracker_run 存在时,
 * 三个 data-testid 都出现在 DOM 里。
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ChatSession, TrackerRunMeta } from '@tabtin/chat-client'

const billingState = vi.hoisted(() => ({
  billingBlocked: false,
  memberLimitReached: false,
  memberLimitReason: null as string | null,
}))
const loadModels = vi.hoisted(() => vi.fn(async () => {}))
const modelState = vi.hoisted(() => ({
  availableModels: [{
    id: '00000000-0000-0000-0000-000000000001',
    name: 'Doubao',
    promotion_credit: {
      eligible: true,
      remaining_credits: 10,
    },
  }],
  defaultModelName: 'Doubao',
  loadedOrganizationId: 'wt-1' as string | null,
  isLoadingModels: false,
  modelLoadError: null as string | null,
  loadModels,
  switchModel: vi.fn(async () => {}),
  switchContextTier: vi.fn(async () => {}),
}))
// ── 复杂依赖最小桩 ─────────────────────────────────────────────
// MessageList / ChatInput / RestoreOverlay / RevertBanner 都是带 store 副作用的
// 重组件,这里替换成 stub div 就够 — 我们只关心 4 表达点是否渲染。
vi.mock('../../message', () => ({
  MessageList: () => <div data-testid="stub-message-list" />,
}))
vi.mock('../../composer/ChatInput', () => ({
  ChatInput: ({
    acceptGlobalInputEvents,
    currentModel,
    disabled,
    disabledReason,
    sessionId,
  }: {
    acceptGlobalInputEvents?: boolean
    currentModel?: { id: string } | null
    disabled?: boolean
    disabledReason?: string
    sessionId?: string | null
  }) => (
    <div
      data-testid="stub-chat-input"
      data-accept-global-input-events={String(acceptGlobalInputEvents)}
      data-current-model-id={currentModel?.id ?? ''}
      data-disabled={String(disabled)}
      data-disabled-reason={disabledReason ?? ''}
      data-session-id={sessionId ?? ''}
    />
  ),
}))
// CH-19：pane header 直接渲染 ChatIconTooltip（关闭/停止按钮），它从
// @tabtin/smartsheet-ui 取 TooltipProvider 等导出。本 smoke test 的 smartsheet-ui
// mock 不含这些导出，故 stub 成透传 children（测试只关心 4 表达点，不关心 tooltip）。
vi.mock('../../panel/ChatIconTooltip', () => ({
  ChatIconTooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}))
vi.mock('../../checkpoint/RestoreOverlay', () => ({
  RestoreOverlay: () => null,
}))
vi.mock('../../checkpoint/RevertBanner', () => ({
  RevertBanner: () => null,
}))
vi.mock('../../composer-presets/useComposerPresetInjection', () => ({
  useComposerPresetInjection: () => {},
}))
vi.mock('../../context/useContextInjection', () => ({
  useContextInjection: () => ({
    contextRefs: [],
    addContextRef: () => {},
    removeRef: () => {},
    clearRefs: () => {},
  }),
}))
vi.mock('@/hooks/useChatSessionEventStream', () => ({
  useChatSessionEventStream: () => {},
}))
// RT-10 后 ChatSplitPane 依赖 useRemoteExecutionGate（内部走 useIsRemoteViewer +
// 真实 useDeviceStore）。本 smoke test 不测遥控器闸门（已由 useRemoteExecutionGate.test
// 覆盖），stub 成「不拦」以隔离真实 device store 的重依赖树。
vi.mock('../../hooks/useRemoteExecutionGate', () => ({
  useRemoteExecutionGate: () => ({
    isBlocked: false,
    isResolving: false,
    controlDeviceName: null,
    controlDeviceOffline: false,
  }),
}))
// 其余 store 用最小 selector-shape stub。每个 hook 接收一个 selector,
// 返回 selector 作用在 stub state 上的结果。
function makeStoreMock(state: Record<string, unknown>) {
  return Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel(state),
    {
      getState: () => state,
    },
  )
}

vi.mock('@/stores/chat/useChatStore', () => {
  const state: Record<string, unknown> = {
    messagesBySessionId: { 'sess-tracker': [] },
    streamingBySessionId: {},
    isSessionStreaming: () => false,
    sendMessage: vi.fn(),
    abortStream: vi.fn(),
    loadSessionMessages: vi.fn(),
    submitApprovalDecisionsForSession: vi.fn(),
    submitAskUserAnswerForSession: vi.fn(),
    submitAskUserTextForSession: vi.fn(),
    submitAskUserFieldValuesForSession: vi.fn(),
    submitAskUserApprovalForSession: vi.fn(),
    skipAskUserForSession: vi.fn(),
    pendingApprovalBySessionId: {},
    approvalSubmittingBySessionId: {},
    pendingAskUserBySessionId: {},
    askUserSubmittingBySessionId: {},
    restoringSessionId: null,
    hasMoreBySessionId: {},
    isLoadingMoreBySessionId: {},
    loadMoreMessages: vi.fn(),
    sessions: [],
  }
  return { useChatStore: makeStoreMock(state) }
})

vi.mock('@/stores/useChatRuntimeStore', () => ({
  useChatRuntimeStore: makeStoreMock({
    setCancellingForSession: vi.fn(),
    runProjectionBySessionId: {},
  }),
}))

vi.mock('@/stores/chat/execution/sessionRunProjection', () => ({
  useSessionBusy: () => false,
  useSessionRunProjection: () => null,
  isSessionBusy: () => false,
}))

vi.mock('@/stores/useBillingStore', () => ({
  useBillingStore: (sel: (s: typeof billingState) => unknown) =>
    sel(billingState),
}))

vi.mock('@/stores/useChatModelStore', () => ({
  useChatModelStore: (sel: (s: typeof modelState) => unknown) =>
    sel(modelState),
}))

vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: makeStoreMock({}),
  selectIsAuthenticated: () => true,
}))

vi.mock('@/stores/useSpaceStore', () => ({
  useSpaceStore: makeStoreMock({
    spaces: [{ id: 'space-1', name: 'My Space' }],
    selectedSpace: { id: 'space-1' },
    selectedAgent: null,
  }),
}))

vi.mock('@/stores/useSessionReadStore', () => ({
  useSessionReadStore: makeStoreMock({
    markViewed: vi.fn(),
    isUnread: () => false,
  }),
}))

vi.mock('@/stores/chat/checkpoint/handlers/checkpointHandler', () => ({
  applyDecisionSummaryUpdate: vi.fn(),
}))

vi.mock('@utils/cn', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  ScrollArea: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  ConfirmDialog: () => null,
  toast: { error: vi.fn(), success: vi.fn() },
}))

vi.mock('../../tracker/TrackerRunBreadcrumb', () => ({
  TrackerRunBreadcrumb: ({ trackerRun }: { trackerRun: TrackerRunMeta }) => (
    <button
      type="button"
      data-testid="tracker-run-breadcrumb"
      data-tracker-name={trackerRun.tracker_name}
    >
      查看自动化任务
    </button>
  ),
  resolveTrackerRunSessionTitle: (trackerRun: TrackerRunMeta) => (
    `自动化任务 "${trackerRun.tracker_name}" 的第 ${trackerRun.run_index} 次记录`
  ),
}))
vi.mock('../../tracker/TrackerRunStatusIndicator', () => ({
  TrackerRunStatusIndicator: ({ trackerRun }: { trackerRun: TrackerRunMeta }) => (
    <div data-testid="tracker-run-status-indicator" data-status={trackerRun.run_status} />
  ),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: unknown) => {
      if (typeof fallback === 'string') return fallback
      if (fallback && typeof fallback === 'object' && 'defaultValue' in fallback) {
        return (fallback as { defaultValue: string }).defaultValue
      }
      return _key
    },
  }),
}))

// 必须 import 在 mock 之后
import { ChatSplitPane } from '../ChatSplitPane'

// ── Helpers ─────────────────────────────────────────────
const trackerMeta: TrackerRunMeta = {
  run_id: 'run-1',
  run_index: 7,
  run_status: 'running',
  tracker_id: 'tracker-1',
  tracker_name: '每日整理 PR',
  tracker_origin: 'user_created',
  trigger_type: 'cron',
  trigger_context: { cron_expr: '0 9 * * *' },
}

function makeSession(overrides: Partial<ChatSession> & { id: string }): ChatSession {
  return {
    id: overrides.id,
    title: '会话标题',
    organization_id: 'wt-1',
    space_id: 'space-1',
    created_by: 'user-1',
    created_at: '2026-04-27T01:00:00Z',
    updated_at: '2026-04-27T01:00:00Z',
    ...overrides,
  } as ChatSession
}

// ── Tests ─────────────────────────────────────────────
describe('ChatSplitPane — Wave 5 二次续作 P1(新)-A: 分屏 4 表达点', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    billingState.billingBlocked = false
    billingState.memberLimitReached = false
    billingState.memberLimitReason = null
    modelState.loadedOrganizationId = 'wt-1'
    modelState.isLoadingModels = false
    modelState.modelLoadError = null
    modelState.availableModels = [{
      id: '00000000-0000-0000-0000-000000000001',
      name: 'Doubao',
      promotion_credit: {
        eligible: true,
        remaining_credits: 10,
      },
    }]
  })

  it('Tracker Run 关联会话 → 标题旁「查看自动化任务」+ StatusIndicator；不再渲染 SystemNote', () => {
    const session = makeSession({ id: 'sess-tracker', tracker_run: trackerMeta })
    render(
      <ChatSplitPane
        paneId="pane-1"
        sessionId="sess-tracker"
        spaceId="space-1"
        organizationId="wt-1"
        isActive={true}
        isSplit={true}
        sessions={[session]}
        onActivate={() => {}}
        onClose={() => {}}
        onSelectSession={() => {}}
      />,
    )

    expect(screen.getByText('自动化任务 "每日整理 PR" 的第 7 次记录')).toBeTruthy()
    const bc = screen.getByTestId('tracker-run-breadcrumb')
    expect(bc.getAttribute('data-tracker-name')).toBe('每日整理 PR')
    expect(bc.textContent).toContain('查看自动化任务')
    expect(screen.queryByTestId('tracker-run-system-message')).toBeNull()
    expect(screen.queryByTestId('tracker-run-breadcrumb-host')).toBeNull()

    const status = screen.getByTestId('tracker-run-status-indicator')
    expect(status.getAttribute('data-status')).toBe('running')
  })

  it('普通会话(无 tracker_run) → 不渲染查看自动化任务 / StatusIndicator', () => {
    const session = makeSession({ id: 'sess-normal' })
    render(
      <ChatSplitPane
        paneId="pane-2"
        sessionId="sess-normal"
        spaceId="space-1"
        organizationId="wt-1"
        isActive={true}
        isSplit={true}
        sessions={[session]}
        onActivate={() => {}}
        onClose={() => {}}
        onSelectSession={() => {}}
      />,
    )

    expect(screen.queryByTestId('tracker-run-breadcrumb')).toBeNull()
    expect(screen.queryByTestId('tracker-run-system-message')).toBeNull()
    expect(screen.queryByTestId('tracker-run-status-indicator')).toBeNull()
  })

  it('非激活分屏 pane 也渲染自己的输入区', () => {
    const session = makeSession({ id: 'sess-normal' })
    render(
      <ChatSplitPane
        paneId="pane-2"
        sessionId="sess-normal"
        spaceId="space-1"
        organizationId="wt-1"
        isActive={false}
        isSplit={true}
        sessions={[session]}
        onActivate={() => {}}
        onClose={() => {}}
        onSelectSession={() => {}}
      />,
    )

    const input = screen.getByTestId('stub-chat-input')
    expect(input).toBeTruthy()
    expect(input.getAttribute('data-session-id')).toBe('sess-normal')
    expect(input.getAttribute('data-accept-global-input-events')).toBe('false')
  })

  it('激活分屏 pane 的输入区接收全局输入事件', () => {
    const session = makeSession({ id: 'sess-normal' })
    render(
      <ChatSplitPane
        paneId="pane-2"
        sessionId="sess-normal"
        spaceId="space-1"
        organizationId="wt-1"
        isActive={true}
        isSplit={true}
        sessions={[session]}
        onActivate={() => {}}
        onClose={() => {}}
        onSelectSession={() => {}}
      />,
    )

    expect(screen.getByTestId('stub-chat-input').getAttribute('data-accept-global-input-events')).toBe('true')
  })

  it('billingBlocked 仅作为风险状态，不禁用分屏 Chat 输入', () => {
    billingState.billingBlocked = true
    const session = makeSession({ id: 'sess-normal' })

    render(
      <ChatSplitPane
        paneId="pane-2"
        sessionId="sess-normal"
        spaceId="space-1"
        organizationId="wt-1"
        isActive={true}
        isSplit={true}
        sessions={[session]}
        onActivate={() => {}}
        onClose={() => {}}
        onSelectSession={() => {}}
      />,
    )

    const input = screen.getByTestId('stub-chat-input')
    expect(input.getAttribute('data-disabled')).toBe('false')
    expect(input.getAttribute('data-disabled-reason')).toBe('')
    expect(input.getAttribute('data-current-model-id')).toBe(
      '00000000-0000-0000-0000-000000000001',
    )
  })

  it('成员额度限制仍禁用分屏 Chat 输入', () => {
    billingState.memberLimitReached = true
    billingState.memberLimitReason = 'member_model_restricted'
    const session = makeSession({ id: 'sess-normal' })

    render(
      <ChatSplitPane
        paneId="pane-2"
        sessionId="sess-normal"
        spaceId="space-1"
        organizationId="wt-1"
        isActive={true}
        isSplit={true}
        sessions={[session]}
        onActivate={() => {}}
        onClose={() => {}}
        onSelectSession={() => {}}
      />,
    )

    const input = screen.getByTestId('stub-chat-input')
    expect(input.getAttribute('data-disabled')).toBe('true')
    expect(input.getAttribute('data-disabled-reason')).toBe('member_model_restricted')
  })

  it('没有可发送模型时仍禁用分屏 Chat 输入', () => {
    modelState.availableModels = []
    const session = makeSession({ id: 'sess-normal' })

    render(
      <ChatSplitPane
        paneId="pane-2"
        sessionId="sess-normal"
        spaceId="space-1"
        organizationId="wt-1"
        isActive={true}
        isSplit={true}
        sessions={[session]}
        onActivate={() => {}}
        onClose={() => {}}
        onSelectSession={() => {}}
      />,
    )

    const input = screen.getByTestId('stub-chat-input')
    expect(input.getAttribute('data-disabled')).toBe('true')
    expect(input.getAttribute('data-disabled-reason')).toBe('no_chat_model')
  })
})
