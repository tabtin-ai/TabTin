import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  registerHitlStoreAccess,
  registerChatStoreCallbacks,
  __resetHitlStoreAccessForTest,
} from '../../../shared/storeAccessRegistry'
import {
  computeApprovalCanResolve,
  handleApprovalRequestedStreamEvent,
  handleApprovalResolvedStreamEvent,
  handleAskInteractionRequiredStreamEvent,
  handlePendingInteractionRequestedEvent,
  handleSingleHitlResolvedStreamEvent,
  handlePendingInteractionTerminalEvent,
  isHitlResolvedKey,
  normalizeTeamSpaceExecution,
  __resetHitlResolvedTombstoneForTest,
} from '../hitlStreamHandlers'
import { useAuthStore } from '@stores/useAuthStore'
import { SystemNotification } from '@/services/systemNotification'

const chatStoreState = vi.hoisted(() => ({
  currentSessionId: null as string | null,
}))

vi.mock('@/services/systemNotification', () => ({
  SystemNotification: {
    agentHitlWaiting: vi.fn(),
  },
}))

describe('hitlStreamHandlers', () => {
  const updateSessionMessages = vi.fn((sessionId: string, updater: (prev: unknown[]) => unknown[]) => {
    updater([])
  })
  let pendingApprovalBySessionId: Record<string, unknown> = {}
  let approvalSubmittingBySessionId: Record<string, boolean> = {}
  let pendingAskUserBySessionId: Record<string, unknown> = {}
  let askUserSubmittingBySessionId: Record<string, boolean> = {}

  beforeEach(() => {
    pendingApprovalBySessionId = {}
    approvalSubmittingBySessionId = {}
    pendingAskUserBySessionId = {}
    askUserSubmittingBySessionId = {}
    chatStoreState.currentSessionId = null
    updateSessionMessages.mockClear()
    vi.mocked(SystemNotification.agentHitlWaiting).mockClear()
    useAuthStore.setState({ user: null } as never)
    __resetHitlResolvedTombstoneForTest()
    __resetHitlStoreAccessForTest?.()
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden' as DocumentVisibilityState,
    })
    registerHitlStoreAccess({
      getState: () => ({
        pendingApprovalBySessionId,
        approvalSubmittingBySessionId,
        pendingAskUserBySessionId,
        askUserSubmittingBySessionId,
      }),
      applyState: (partial) => {
        const slice = {
          pendingApprovalBySessionId,
          approvalSubmittingBySessionId,
          pendingAskUserBySessionId,
          askUserSubmittingBySessionId,
        }
        const patch = typeof partial === 'function' ? partial(slice) : partial
        if (patch.pendingApprovalBySessionId) {
          pendingApprovalBySessionId = patch.pendingApprovalBySessionId
        }
        if (patch.approvalSubmittingBySessionId) {
          approvalSubmittingBySessionId = patch.approvalSubmittingBySessionId
        }
        if (patch.pendingAskUserBySessionId) {
          pendingAskUserBySessionId = patch.pendingAskUserBySessionId
        }
        if (patch.askUserSubmittingBySessionId) {
          askUserSubmittingBySessionId = patch.askUserSubmittingBySessionId
        }
      },
      upsertHitlBubble: vi.fn((sid: string) => {
        updateSessionMessages(sid, (prev) => prev)
      }),
    })
    registerChatStoreCallbacks({
      isSessionBusy: () => false,
      getStreamingSessionIds: () => [],
      getCurrentSessionId: () => chatStoreState.currentSessionId,
      syncSessionMessagesFromServer: vi.fn(),
      getSessionsBySpaceId: () => ({}),
      updateSessionTitleInCaches: vi.fn(),
      upsertSessionInSpace: vi.fn(),
      injectErrorBubble: vi.fn(),
      upsertObservedUserMessage: vi.fn(),
      linkServerMessageId: vi.fn(),
      rebindMessageIds: vi.fn(),
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('approval_requested 写入 pendingApprovalBySessionId（后台 push 路径核心）', () => {
    const messageId = '2c07a4d6-60fb-54af-8491-786b724e100c'
    const ok = handleApprovalRequestedStreamEvent(
      {
        type: 'agent.stream.approval_requested',
        payload: {
          batch_id: 'batch-bg-1',
          message_id: messageId,
          action_requests: [{
            request_id: 'req-1',
            tool_call_id: 'tc-1',
            tool_name: 'run_terminal_command',
            tool_input: { command: 'rm -rf /tmp/test' },
          }],
          runtime_mode: 'interactive',
          expires_at: Date.now() + 60_000,
        },
      },
      { sessionId: 'session-bg-1', spaceName: 'Test Space' },
    )

    expect(ok).toBe(true)
    expect(pendingApprovalBySessionId['session-bg-1']).toMatchObject({
      batchId: 'batch-bg-1',
      sessionId: 'session-bg-1',
      messageId,
    })
    expect(updateSessionMessages).toHaveBeenCalled()
  })

  it('重放已过期的 approval_requested 不打开授权面板', () => {
    const ok = handleApprovalRequestedStreamEvent(
      {
        type: 'agent.stream.approval_requested',
        payload: {
          batch_id: 'batch-expired',
          expires_at: Date.now() - 1,
          action_requests: [{ tool_call_id: 'tc-expired', tool_name: 'browser.open' }],
        },
      },
      { sessionId: 'session-expired' },
    )

    expect(ok).toBe(true)
    expect(pendingApprovalBySessionId['session-expired']).toBeUndefined()
    expect(updateSessionMessages).not.toHaveBeenCalled()
  })

  it('已过期的 approval_requested 清除同 batch 的僵尸面板', () => {
    pendingApprovalBySessionId['session-expired-open'] = {
      batchId: 'batch-expired-open',
      sessionId: 'session-expired-open',
    }

    handleApprovalRequestedStreamEvent(
      {
        type: 'agent.stream.approval_requested',
        payload: {
          batch_id: 'batch-expired-open',
          expires_at: Date.now() - 1,
          action_requests: [],
        },
      },
      { sessionId: 'session-expired-open' },
    )

    expect(pendingApprovalBySessionId['session-expired-open']).toBeUndefined()
  })

  it('#6893 无 message_id 时仍开面板但不造 hitl-review 气泡', () => {
    const ok = handleApprovalRequestedStreamEvent(
      {
        type: 'agent.stream.approval_requested',
        payload: {
          batch_id: 'batch-no-mid',
          action_requests: [{
            request_id: 'req-1',
            tool_call_id: 'tc-1',
            tool_name: 'run_terminal_command',
          }],
        },
      },
      { sessionId: 'session-no-mid' },
    )

    expect(ok).toBe(true)
    expect(pendingApprovalBySessionId['session-no-mid']).toMatchObject({
      batchId: 'batch-no-mid',
    })
    expect(updateSessionMessages).not.toHaveBeenCalled()
  })

  it('相同 batch_id 重复投递时去重（local IPC + WS relay 双发）', () => {
    handleApprovalRequestedStreamEvent(
      {
        type: 'agent.stream.approval_requested',
        payload: {
          batch_id: 'batch-dedupe-1',
          action_requests: [{ tool_call_id: 'tc-dedupe', tool_name: 'browser.open' }],
        },
      },
      { sessionId: 'session-dedupe' },
    )

    const ok = handleApprovalRequestedStreamEvent(
      {
        type: 'agent.stream.approval_requested',
        payload: {
          batch_id: 'batch-dedupe-1',
          action_requests: [{ tool_call_id: 'tc-dedupe', tool_name: 'browser.open' }],
        },
      },
      { sessionId: 'session-dedupe' },
    )

    expect(ok).toBe(true)
    expect(Object.keys(pendingApprovalBySessionId)).toEqual(['session-dedupe'])
  })

  it('approval_requested 透传 subagent_context 到 actionRequests', () => {
    const ok = handleApprovalRequestedStreamEvent(
      {
        type: 'agent.stream.approval_requested',
        payload: {
          batch_id: 'batch-sub-1',
          action_requests: [{
            request_id: 'req-sub-1',
            tool_call_id: 'tc-sub-1',
            tool_name: 'write_file',
            tool_input: { path: '/tmp/x' },
            subagent_context: {
              parent_tool_call_id: 'toolu_parent_abc',
              subagent_run_id: 'run-sub-abc',
              label: '执行助手',
            },
          }],
        },
      },
      { sessionId: 'session-sub-1' },
    )

    expect(ok).toBe(true)
    const pending = pendingApprovalBySessionId['session-sub-1'] as {
      actionRequests?: Array<{ subagent_context?: Record<string, string> }>
    }
    expect(pending?.actionRequests?.[0]?.subagent_context).toEqual({
      parent_tool_call_id: 'toolu_parent_abc',
      subagent_run_id: 'run-sub-abc',
      label: '执行助手',
    })
  })

  it('team Space approval_requested 写入 Owner 等待元数据，非 Owner 只读', () => {
    const ok = handleApprovalRequestedStreamEvent(
      {
        type: 'agent.stream.approval_requested',
        payload: {
          batch_id: 'batch-team-1',
          action_requests: [{
            request_id: 'req-team-1',
            tool_call_id: 'tc-team-1',
            tool_name: 'run_terminal_command',
            tool_input: { command: 'touch team.txt' },
          }],
          runtime_mode: 'interactive',
          expires_at: Date.now() + 60_000,
          team_space_execution: {
            collaboration_space_id: 'space-team',
            execution_space_id: 'space-owner',
            initiator_user_id: 'user-member',
            execution_owner_user_id: 'user-owner',
            execution_owner_display_name: 'Owner User',
          },
        },
      },
      { sessionId: 'session-team-1', spaceName: 'Project' },
    )

    expect(ok).toBe(true)
    expect(pendingApprovalBySessionId['session-team-1']).toMatchObject({
      batchId: 'batch-team-1',
      canResolve: false,
      teamSpaceExecution: {
        executionOwnerUserId: 'user-owner',
        executionOwnerDisplayName: 'Owner User',
      },
    })
  })

  it('team Space 脱敏 approval_requested 仍写入等待态但不含审批详情', () => {
    useAuthStore.setState({ user: { id: 'user-member' } } as never)

    const ok = handleApprovalRequestedStreamEvent(
      {
        type: 'agent.stream.approval_requested',
        payload: {
          batch_id: 'batch-team-redacted',
          action_requests: [{
            request_id: 'req-team-redacted',
            tool_call_id: 'tc-team-redacted',
            tool_name: 'redacted_tool',
          }],
          runtime_mode: 'interactive',
          expires_at: Date.now() + 60_000,
          details_redacted: true,
          team_space_execution: {
            collaboration_space_id: 'space-team',
            execution_space_id: 'space-owner',
            initiator_user_id: 'user-member',
            execution_owner_user_id: 'user-owner',
            execution_owner_display_name: 'Owner User',
          },
        },
      },
      { sessionId: 'session-team-redacted', spaceName: 'Project' },
    )

    expect(ok).toBe(true)
    expect(pendingApprovalBySessionId['session-team-redacted']).toMatchObject({
      batchId: 'batch-team-redacted',
      canResolve: false,
      actionRequests: [{
        request_id: 'req-team-redacted',
        tool_call_id: 'tc-team-redacted',
        tool_name: 'redacted_tool',
        arguments: undefined,
        decision_reason: undefined,
        allowed_scopes: undefined,
        allowed_outcomes: undefined,
      }],
    })
  })

  describe('computeApprovalCanResolve（IPC / WS 镜像 / 子 Agent 三路共用判定）', () => {
    const teamMeta = normalizeTeamSpaceExecution({
      collaboration_space_id: 'space-team',
      execution_space_id: 'space-owner',
      initiator_user_id: 'user-member',
      execution_owner_user_id: 'user-owner',
    })

    afterEach(() => {
      useAuthStore.setState({ user: null } as never)
    })

    it('无 team_space_execution（Workspace）→ 任何人可处理', () => {
      expect(computeApprovalCanResolve(undefined)).toBe(true)
    })

    it('当前用户是执行 Owner → 可处理', () => {
      useAuthStore.setState({ user: { id: 'user-owner' } } as never)
      expect(computeApprovalCanResolve(teamMeta)).toBe(true)
    })

    it('当前用户是普通成员 → 只读等待', () => {
      useAuthStore.setState({ user: { id: 'user-member' } } as never)
      expect(computeApprovalCanResolve(teamMeta)).toBe(false)
    })
  })

  it('owner-only interaction_requested 用完整 payload 打开 Project 审批卡', () => {
    useAuthStore.setState({ user: { id: 'user-owner' } } as never)

    const ok = handlePendingInteractionRequestedEvent({
      type: 'agent.user.interaction_requested',
      payload: {
        interaction: {
          kind: 'tool_approval',
          request_key: 'batch-team-owner',
          session_id: 'session-team-owner',
          payload: {
            batch_id: 'batch-team-owner',
            action_requests: [{
              request_id: 'req-team-owner',
              tool_call_id: 'tc-team-owner',
              tool_name: 'run_terminal_command',
              tool_input: { command: 'touch owner-only.txt' },
            }],
            team_space_execution: {
              collaboration_space_id: 'space-team',
              execution_space_id: 'space-owner',
              initiator_user_id: 'user-member',
              execution_owner_user_id: 'user-owner',
              execution_owner_display_name: 'Owner User',
            },
          },
        },
      },
    })

    expect(ok).toBe(true)
    expect(pendingApprovalBySessionId['session-team-owner']).toMatchObject({
      batchId: 'batch-team-owner',
      canResolve: true,
      actionRequests: [{
        tool_name: 'run_terminal_command',
        arguments: { command: 'touch owner-only.txt' },
      }],
      teamSpaceExecution: {
        executionOwnerUserId: 'user-owner',
      },
    })
  })

  it('#4737 interaction_requested(ask_choice) 用权威 payload 打开追问面板', () => {
    const ok = handlePendingInteractionRequestedEvent({
      type: 'agent.user.interaction_requested',
      payload: {
        interaction: {
          kind: 'ask_choice',
          status: 'pending',
          request_key: 'req-ask-choice-1',
          session_id: 'session-ask-choice',
          payload: {
            request_id: 'req-ask-choice-1',
            message: '请选择',
            context_hint: { kind: 'login_wall', domain: 'example.com', tab_id: 'view-login-wall' },
            questions: [{ id: 'q1', prompt: '选项？', options: [{ id: 'a', label: 'A' }] }],
          },
        },
      },
    })

    expect(ok).toBe(true)
    expect(pendingAskUserBySessionId['session-ask-choice']).toMatchObject({
      kind: 'choice',
      sessionId: 'session-ask-choice',
      interruptId: 'req-ask-choice-1',
      contextHint: { kind: 'login_wall', domain: 'example.com', tabId: 'view-login-wall' },
    })
    expect(askUserSubmittingBySessionId['session-ask-choice']).toBe(false)
  })

  it('#login-relay 旧权威 ask payload 缺 context_hint 时保持普通卡片', () => {
    handlePendingInteractionRequestedEvent({
      type: 'agent.user.interaction_requested',
      payload: {
        interaction: {
          kind: 'ask_choice',
          status: 'pending',
          request_key: 'req-ask-choice-old',
          session_id: 'session-ask-choice-old',
          payload: {
            request_id: 'req-ask-choice-old',
            questions: [{ id: 'q1', prompt: '选项？', options: [{ id: 'a', label: 'A' }] }],
          },
        },
      },
    })

    expect(pendingAskUserBySessionId['session-ask-choice-old']).toMatchObject({
      kind: 'choice',
      contextHint: undefined,
    })
  })

  it('#4737 interaction_requested(ask_form) 打开表单面板', () => {
    const ok = handlePendingInteractionRequestedEvent({
      type: 'agent.user.interaction_requested',
      payload: {
        interaction: {
          kind: 'ask_form',
          status: 'pending',
          request_key: 'req-ask-form-1',
          session_id: 'session-ask-form',
          payload: { request_id: 'req-ask-form-1', fields: [], form_mode: 'fields' },
        },
      },
    })

    expect(ok).toBe(true)
    expect(pendingAskUserBySessionId['session-ask-form']).toMatchObject({
      kind: 'form',
      sessionId: 'session-ask-form',
      interruptId: 'req-ask-form-1',
      formMode: 'fields',
    })
  })

  it('#4737 interaction_requested 非 pending status 不打开面板（挡 offline 重放复活）', () => {
    const ok = handlePendingInteractionRequestedEvent({
      type: 'agent.user.interaction_requested',
      payload: {
        interaction: {
          kind: 'ask_choice',
          status: 'resolved',
          request_key: 'req-stale',
          session_id: 'session-stale',
          payload: { request_id: 'req-stale', questions: [] },
        },
      },
    })

    expect(ok).toBe(true)
    expect(pendingAskUserBySessionId['session-stale']).toBeUndefined()
  })

  it('approval_resolved 清除匹配的 pendingApproval', () => {
    pendingApprovalBySessionId = {
      'session-bg-1': { batchId: 'batch-bg-1', sessionId: 'session-bg-1' },
    }

    handleApprovalResolvedStreamEvent(
      {
        type: 'agent.stream.approval_resolved',
        payload: { batch_id: 'batch-bg-1' },
      },
      { sessionId: 'session-bg-1' },
    )

    expect(pendingApprovalBySessionId['session-bg-1']).toBeUndefined()
  })

  it('#4737 已解决审批重放不复活：approval_resolved 后同 batch 的 approval_requested 被墓碑挡下', () => {
    // 先开面板
    handleApprovalRequestedStreamEvent(
      { type: 'agent.stream.approval_requested', payload: { batch_id: 'batch-replay', action_requests: [] } },
      { sessionId: 'session-replay' },
    )
    expect(pendingApprovalBySessionId['session-replay']).toBeDefined()

    // 解决（记墓碑 + 清面板）
    handleApprovalResolvedStreamEvent(
      { type: 'agent.stream.approval_resolved', payload: { batch_id: 'batch-replay' } },
      { sessionId: 'session-replay' },
    )
    expect(pendingApprovalBySessionId['session-replay']).toBeUndefined()

    // 重放同 batch 的 approval_requested → 不复活
    const ok = handleApprovalRequestedStreamEvent(
      { type: 'agent.stream.approval_requested', payload: { batch_id: 'batch-replay', action_requests: [] } },
      { sessionId: 'session-replay' },
    )
    expect(ok).toBe(true)
    expect(pendingApprovalBySessionId['session-replay']).toBeUndefined()
  })

  it('#4737 interaction_resolved(tool_approval) 记墓碑，后续 approval_requested 重放不复活', () => {
    handlePendingInteractionTerminalEvent({
      type: 'agent.user.interaction_resolved',
      payload: {
        interaction: {
          kind: 'tool_approval',
          session_id: 'session-term',
          request_key: 'batch-term',
          status: 'resolved',
        },
      },
    })

    const ok = handleApprovalRequestedStreamEvent(
      { type: 'agent.stream.approval_requested', payload: { batch_id: 'batch-term', action_requests: [] } },
      { sessionId: 'session-term' },
    )
    expect(ok).toBe(true)
    expect(pendingApprovalBySessionId['session-term']).toBeUndefined()
  })

  it('#4737 不同 batch 不受墓碑影响：新审批正常打开', () => {
    handleApprovalResolvedStreamEvent(
      { type: 'agent.stream.approval_resolved', payload: { batch_id: 'batch-old' } },
      { sessionId: 'session-new' },
    )
    const ok = handleApprovalRequestedStreamEvent(
      { type: 'agent.stream.approval_requested', payload: { batch_id: 'batch-fresh', action_requests: [] } },
      { sessionId: 'session-new' },
    )
    expect(ok).toBe(true)
    expect(pendingApprovalBySessionId['session-new']).toMatchObject({ batchId: 'batch-fresh' })
  })

  it('#4737 interaction_requested(tool_approval, status=resolved) 不打开审批面板', () => {
    useAuthStore.setState({ user: { id: 'user-owner' } } as never)
    const ok = handlePendingInteractionRequestedEvent({
      type: 'agent.user.interaction_requested',
      payload: {
        interaction: {
          kind: 'tool_approval',
          status: 'resolved',
          request_key: 'batch-stale-approval',
          session_id: 'session-stale-approval',
          payload: {
            batch_id: 'batch-stale-approval',
            action_requests: [],
            team_space_execution: {
              collaboration_space_id: 'space-team',
              execution_owner_user_id: 'user-owner',
            },
          },
        },
      },
    })
    expect(ok).toBe(true)
    expect(pendingApprovalBySessionId['session-stale-approval']).toBeUndefined()
  })

  it('single_hitl_resolved 清除匹配的 pendingAskUser', () => {
    pendingAskUserBySessionId = {
      'session-ask-1': {
        kind: 'choice',
        sessionId: 'session-ask-1',
        interruptId: 'req-ask-1',
      },
    }
    askUserSubmittingBySessionId = { 'session-ask-1': true }

    handleSingleHitlResolvedStreamEvent(
      {
        type: 'agent.stream.single_hitl_resolved',
        payload: { request_id: 'req-ask-1', outcome: 'skipped' },
      },
      { sessionId: 'session-ask-1' },
    )

    expect(pendingAskUserBySessionId['session-ask-1']).toBeUndefined()
    expect(askUserSubmittingBySessionId['session-ask-1']).toBeUndefined()
  })

  it('single_hitl_resolved 不清除 interruptId 不匹配的 pendingAskUser', () => {
    pendingAskUserBySessionId = {
      'session-ask-1': {
        kind: 'choice',
        sessionId: 'session-ask-1',
        interruptId: 'req-new',
      },
    }

    handleSingleHitlResolvedStreamEvent(
      {
        type: 'agent.stream.single_hitl_resolved',
        payload: { request_id: 'req-old', outcome: 'skipped' },
      },
      { sessionId: 'session-ask-1' },
    )

    expect(pendingAskUserBySessionId['session-ask-1']).toBeDefined()
  })

  it('single_hitl_resolved 无 pending 时 no-op', () => {
    handleSingleHitlResolvedStreamEvent(
      {
        type: 'agent.stream.single_hitl_resolved',
        payload: { request_id: 'req-orphan', outcome: 'answered' },
      },
      { sessionId: 'session-empty' },
    )

    expect(pendingAskUserBySessionId['session-empty']).toBeUndefined()
  })

  it('【#6744】single_hitl_resolved 无 pending 也记墓碑（挡 lifecycle-end 对账复活）', () => {
    handleSingleHitlResolvedStreamEvent(
      {
        type: 'agent.stream.single_hitl_resolved',
        payload: { request_id: 'req-race', outcome: 'answered' },
      },
      { sessionId: 'session-race' },
    )

    expect(isHitlResolvedKey('session-race', 'req-race')).toBe(true)

    // stream 重放不得再开
    handleAskInteractionRequiredStreamEvent(
      {
        type: 'agent.stream.ask_user_required',
        payload: {
          request_id: 'req-race',
          questions: [{ id: 'q1', prompt: '选一个', options: [] }],
        },
      },
      'choice',
      { sessionId: 'session-race' },
    )
    expect(pendingAskUserBySessionId['session-race']).toBeUndefined()
  })

  it('【#6744】single_hitl_resolved 清除匹配面板时记候选 key 墓碑', () => {
    pendingAskUserBySessionId = {
      'session-ask-tomb': {
        kind: 'choice',
        sessionId: 'session-ask-tomb',
        interruptId: 'req-ask-tomb',
        toolCallId: 'tc-ask-tomb',
        messageId: 'msg-ask-tomb',
      },
    }

    handleSingleHitlResolvedStreamEvent(
      {
        type: 'agent.stream.single_hitl_resolved',
        payload: { request_id: 'req-ask-tomb', outcome: 'answered' },
      },
      { sessionId: 'session-ask-tomb' },
    )

    expect(pendingAskUserBySessionId['session-ask-tomb']).toBeUndefined()
    expect(isHitlResolvedKey('session-ask-tomb', 'req-ask-tomb')).toBe(true)
    expect(isHitlResolvedKey('session-ask-tomb', 'tc-ask-tomb')).toBe(true)
    expect(isHitlResolvedKey('session-ask-tomb', 'msg-ask-tomb')).toBe(true)
  })

  it('用户级 interaction_resolved 清除匹配的 ask_form 卡片', () => {
    pendingAskUserBySessionId = {
      'session-bg-1': {
        kind: 'form',
        sessionId: 'session-bg-1',
        interruptId: 'ask-form-1',
      },
    }
    askUserSubmittingBySessionId = { 'session-bg-1': true }

    handlePendingInteractionTerminalEvent({
      type: 'agent.user.interaction_resolved',
      payload: {
        interaction: {
          kind: 'ask_form',
          session_id: 'session-bg-1',
          thread_id: 'chat-session-session-bg-1',
          request_key: 'ask-form-1',
          status: 'resolved',
        },
      },
    })

    expect(pendingAskUserBySessionId['session-bg-1']).toBeUndefined()
    expect(askUserSubmittingBySessionId['session-bg-1']).toBeUndefined()
    expect(isHitlResolvedKey('session-bg-1', 'ask-form-1')).toBe(true)
  })

  it('【#6744】权威 interaction_requested 命中 ask 墓碑时不重开', () => {
    handleSingleHitlResolvedStreamEvent(
      {
        type: 'agent.stream.single_hitl_resolved',
        payload: { request_id: 'ask-authority-1', outcome: 'answered' },
      },
      { sessionId: 'session-authority' },
    )

    handlePendingInteractionRequestedEvent({
      type: 'agent.user.interaction_requested',
      payload: {
        interaction: {
          kind: 'ask_choice',
          session_id: 'session-authority',
          request_key: 'ask-authority-1',
          status: 'pending',
          payload: {
            request_id: 'ask-authority-1',
            questions: [{ id: 'q1', prompt: '选一个', options: [] }],
          },
        },
      },
    })

    expect(pendingAskUserBySessionId['session-authority']).toBeUndefined()
  })

  it('用户级 interaction_resolved 不清除同会话不同 request 的新卡片', () => {
    pendingAskUserBySessionId = {
      'session-bg-1': {
        kind: 'form',
        sessionId: 'session-bg-1',
        interruptId: 'ask-form-new',
      },
    }

    handlePendingInteractionTerminalEvent({
      type: 'agent.user.interaction_resolved',
      payload: {
        interaction: {
          kind: 'ask_form',
          session_id: 'session-bg-1',
          request_key: 'ask-form-old',
          status: 'resolved',
        },
      },
    })

    expect(pendingAskUserBySessionId['session-bg-1']).toBeDefined()
  })

  it('用户级 interaction_resolved 可按 message_id 兜底清除 ask 卡片', () => {
    pendingAskUserBySessionId = {
      'session-bg-1': {
        kind: 'form',
        sessionId: 'session-bg-1',
        interruptId: 'ask-form-1',
        toolCallId: 'tool-form-1',
        messageId: 'msg-form-1',
      },
    }

    handlePendingInteractionTerminalEvent({
      type: 'agent.user.interaction_resolved',
      payload: {
        interaction: {
          kind: 'ask_form',
          session_id: 'session-bg-1',
          request_key: 'msg-form-1',
          status: 'resolved',
        },
      },
    })

    expect(pendingAskUserBySessionId['session-bg-1']).toBeUndefined()
  })

  it('用户级 interaction_expired 清除匹配的 approval batch', () => {
    pendingApprovalBySessionId = {
      'session-bg-1': { batchId: 'batch-bg-1', sessionId: 'session-bg-1' },
    }
    approvalSubmittingBySessionId = { 'session-bg-1': true }

    handlePendingInteractionTerminalEvent({
      type: 'agent.user.interaction_expired',
      payload: {
        interaction: {
          kind: 'tool_approval',
          session_id: 'session-bg-1',
          request_key: 'batch-bg-1',
          status: 'expired',
        },
      },
    })

    expect(pendingApprovalBySessionId['session-bg-1']).toBeUndefined()
    expect(approvalSubmittingBySessionId['session-bg-1']).toBeUndefined()
  })

  describe('前台当前会话 OS HITL 降噪', () => {
    function focusForegroundSession(sessionId: string) {
      chatStoreState.currentSessionId = sessionId
      vi.spyOn(document, 'hasFocus').mockReturnValue(true)
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible' as DocumentVisibilityState,
      })
    }

    it('前台当前会话 approval 交给主进程原生焦点门闩，且 pending 已写', () => {
      focusForegroundSession('session-fg-1')

      const ok = handleApprovalRequestedStreamEvent(
        {
          type: 'agent.stream.approval_requested',
          payload: {
            batch_id: 'batch-fg-1',
            action_requests: [{
              request_id: 'req-fg-1',
              tool_call_id: 'tc-fg-1',
              tool_name: 'run_terminal_command',
              tool_input: { command: 'echo hi' },
            }],
          },
        },
        { sessionId: 'session-fg-1', spaceName: 'Space' },
      )

      expect(ok).toBe(true)
      expect(pendingApprovalBySessionId['session-fg-1']).toMatchObject({
        batchId: 'batch-fg-1',
        sessionId: 'session-fg-1',
      })
      expect(SystemNotification.agentHitlWaiting).toHaveBeenCalledWith(
        expect.objectContaining({
          dedupRef: 'agent-hitl:batch-fg-1',
          suppressWhenSourceWindowFocused: true,
        }),
      )
    })

    it('前台当前会话 ask 交给主进程原生焦点门闩，且 pendingAskUser 已写', () => {
      focusForegroundSession('session-fg-ask')

      const ok = handleAskInteractionRequiredStreamEvent(
        {
          type: 'agent.stream.ask_user_required',
          payload: {
            interaction_type: 'ask_user',
            request_id: 'ask-fg-1',
            tool_call_id: 'ask-fg-1',
            message: '选一个？',
            context_hint: { kind: 'login_wall', domain: 'example.com', tab_id: 'view-login-wall' },
            questions: [{ id: 'q1', prompt: '选项？', options: [{ id: 'a', label: 'A' }] }],
          },
        },
        'choice',
        { sessionId: 'session-fg-ask', spaceName: 'Space' },
      )

      expect(ok).toBe(true)
      expect(pendingAskUserBySessionId['session-fg-ask']).toBeTruthy()
      expect(pendingAskUserBySessionId['session-fg-ask']).toMatchObject({
        contextHint: { kind: 'login_wall', domain: 'example.com', tabId: 'view-login-wall' },
      })
      expect(SystemNotification.agentHitlWaiting).toHaveBeenCalledWith(
        expect.objectContaining({
          dedupRef: 'agent-hitl:ask-fg-1',
          suppressWhenSourceWindowFocused: true,
        }),
      )
    })

    it('其他 session 的 approval 仍调 agentHitlWaiting', () => {
      focusForegroundSession('session-fg-1')

      handleApprovalRequestedStreamEvent(
        {
          type: 'agent.stream.approval_requested',
          payload: {
            batch_id: 'batch-other',
            action_requests: [{ tool_call_id: 'tc-other', tool_name: 'browser.open' }],
          },
        },
        { sessionId: 'session-other', spaceName: 'Space' },
      )

      expect(pendingApprovalBySessionId['session-other']).toBeTruthy()
      expect(SystemNotification.agentHitlWaiting).toHaveBeenCalledTimes(1)
    })

    it('当前 session 失焦时 approval 仍调 agentHitlWaiting', () => {
      chatStoreState.currentSessionId = 'session-fg-1'
      vi.spyOn(document, 'hasFocus').mockReturnValue(false)
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible' as DocumentVisibilityState,
      })

      handleApprovalRequestedStreamEvent(
        {
          type: 'agent.stream.approval_requested',
          payload: {
            batch_id: 'batch-blur',
            action_requests: [{ tool_call_id: 'tc-blur', tool_name: 'browser.open' }],
          },
        },
        { sessionId: 'session-fg-1' },
      )

      expect(pendingApprovalBySessionId['session-fg-1']).toBeTruthy()
      expect(SystemNotification.agentHitlWaiting).toHaveBeenCalledTimes(1)
    })

    it('当前 session hidden 时 approval 仍调 agentHitlWaiting', () => {
      chatStoreState.currentSessionId = 'session-fg-1'
      vi.spyOn(document, 'hasFocus').mockReturnValue(true)
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden' as DocumentVisibilityState,
      })

      handleApprovalRequestedStreamEvent(
        {
          type: 'agent.stream.approval_requested',
          payload: {
            batch_id: 'batch-hidden',
            action_requests: [{ tool_call_id: 'tc-hidden', tool_name: 'browser.open' }],
          },
        },
        { sessionId: 'session-fg-1' },
      )

      expect(pendingApprovalBySessionId['session-fg-1']).toBeTruthy()
      expect(SystemNotification.agentHitlWaiting).toHaveBeenCalledTimes(1)
    })
  })
})
