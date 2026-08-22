/**
 * useNotificationEventStream — W2 用户级事件治理后协议测试
 *
 * 切换点：
 *   - 旧实现走 `useGatewayTopic({ topic: 'notifications.{userId}' })` —— W1 后端
 *     已停止往该 topic 发通知，改为 user-level group `user.{user_id}`
 *   - 新实现直接挂全局 `gateway.addListener` 监听 envelope.type === `agent.user.notification.new`
 *
 * 本测试覆盖三件事：
 *   1. envelope.type 必须是 `agent.user.notification.new` 才处理（旧 `notification.new` 短名忽略）
 *   2. 推到 react-query / zustand store / SystemNotification 这三条业务路径仍走通
 *   3. reconnect 触发 invalidateNotifications + 邀请刷新事件
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

const {
  mockAddNotification,
  mockOptimisticAddNotification,
  mockOptimisticMarkAgentSessionTerminalRead,
  mockInvalidateNotifications,
  mockInvalidateQueries,
  mockExtensionEvent,
  mockQueryClient,
  notificationState,
  gatewayAddListener,
  gatewayRemoveListener,
  gatewayOnReconnected,
  gatewayOffReconnected,
  capturedListeners,
  capturedReconnectHandlers,
} = vi.hoisted(() => {
  const captured: Array<(env: unknown) => void> = []
  const reconnects: Array<() => void> = []
  const invalidateQueries = vi.fn()
  return {
    mockAddNotification: vi.fn(),
    mockOptimisticAddNotification: vi.fn(),
    mockOptimisticMarkAgentSessionTerminalRead: vi.fn(),
    mockInvalidateNotifications: vi.fn(),
    mockInvalidateQueries: invalidateQueries,
    mockExtensionEvent: vi.fn(),
    mockQueryClient: { id: 'query-client', invalidateQueries },
    notificationState: {
      addNotification: vi.fn(),
      currentOrganizationId: 'ws-current',
    },
    gatewayAddListener: vi.fn((cb: (env: unknown) => void) => {
      captured.push(cb)
    }),
    gatewayRemoveListener: vi.fn(),
    gatewayOnReconnected: vi.fn((cb: () => void) => {
      reconnects.push(cb)
    }),
    gatewayOffReconnected: vi.fn(),
    capturedListeners: captured,
    capturedReconnectHandlers: reconnects,
  }
})

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => mockQueryClient,
}))

vi.mock('@/services/chatApi', () => ({
  getChatClient: () => ({
    getGateway: () => ({
      addListener: gatewayAddListener,
      removeListener: gatewayRemoveListener,
      onReconnectedEvent: gatewayOnReconnected,
      offReconnectedEvent: gatewayOffReconnected,
    }),
  }),
}))

vi.mock('@stores/useNotificationStore', () => ({
  useNotificationStore: (selector: (state: typeof notificationState) => unknown) =>
    selector({
      ...notificationState,
      addNotification: mockAddNotification,
    }),
}))

vi.mock('@/services/systemNotification', () => ({
  SystemNotification: {
    extensionEvent: mockExtensionEvent,
  },
}))

vi.mock('@/hooks/queries/notification', () => ({
  NOTIFICATION_REFRESH_EVENT: 'tabtin:notifications-refresh',
  optimisticAddNotification: mockOptimisticAddNotification,
  optimisticRemoveInvitationNotifications: vi.fn(),
  optimisticMarkAgentSessionTerminalRead: mockOptimisticMarkAgentSessionTerminalRead,
  invalidateNotifications: mockInvalidateNotifications,
  notificationKeys: {
    unreadCount: (organizationId: string | null) => [
      'notifications',
      'unread-count',
      { organizationId },
    ],
  },
}))

vi.mock('@/services/agentSessionNotificationAck', () => ({
  ACKNOWLEDGE_AGENT_SESSION_COMPLETED_EVENT:
    'tabtin:agent-session-notif-acknowledge-completed',
}))

// members.ts / membership.ts 真实模块会牵出 API service 的重依赖链，这里只需要
// 两个纯 key 工厂，直接给 mock 版本，与真实 memberKeys.lists / membershipKeys.status 同构。
vi.mock('@/hooks/queries/members', () => ({
  memberKeys: {
    all: ['members'],
    lists: (organizationId: string) => ['members', 'list', organizationId],
  },
}))

vi.mock('@/hooks/queries/membership', () => ({
  membershipKeys: {
    all: ['membership'],
    status: (organizationId?: string) => ['membership', 'status', organizationId ?? '__personal__'],
  },
}))

vi.mock('@/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

describe('useNotificationEventStream (W2 user-level)', () => {
  const mockOverlayPush = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    capturedListeners.length = 0
    capturedReconnectHandlers.length = 0
    ;(window as unknown as { tabtin?: { overlay: { push: typeof mockOverlayPush } } }).tabtin = {
      overlay: { push: mockOverlayPush },
    }
  })

  it('收到 agent.user.notification.new envelope → 走 react-query / zustand / 桌面通知', async () => {
    const { useNotificationEventStream } = await import('../useNotificationEventStream')
    renderHook(() => useNotificationEventStream({ userId: 'user-1' }))

    expect(capturedListeners.length).toBe(1)
    capturedListeners[0]({
      type: 'agent.user.notification.new',
      payload: {
        id: 'notif-1',
        type: 'tracker.run.completed',
        title: 'Tracker done',
        organization_id: 'ws-event-1',
        space_id: 'as-event-1',
        navigate_to: { type: 'tracker', id: 'tracker-1' },
      },
    })

    const expectedItem = expect.objectContaining({
      id: 'notif-1',
      organization_id: 'ws-event-1',
      space_id: 'as-event-1',
      navigate_to: {
        type: 'tracker',
        id: 'tracker-1',
        organizationId: 'ws-event-1',
        spaceId: 'as-event-1',
      },
    })

    expect(mockOptimisticAddNotification).toHaveBeenCalledWith(
      mockQueryClient,
      'ws-current',
      expectedItem,
    )
    expect(mockAddNotification).toHaveBeenCalledWith(expectedItem)
    expect(mockExtensionEvent).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'ws-event-1',
      spaceId: 'as-event-1',
      navigateTo: {
        type: 'tracker',
        id: 'tracker-1',
        organizationId: 'ws-event-1',
        spaceId: 'as-event-1',
      },
    }))
    // ：推 refresh 给 overlay，已开面板立刻重拉列表
    expect(mockOverlayPush).toHaveBeenCalledWith({
      type: 'notification-refresh',
      organizationId: 'ws-event-1',
    })
  })

  it('跨组织 member_added 作为个人全局通知刷新当前收件箱', async () => {
    const { useNotificationEventStream } = await import('../useNotificationEventStream')
    renderHook(() => useNotificationEventStream({ userId: 'user-1' }))

    capturedListeners[0]({
      type: 'agent.user.notification.new',
      payload: {
        id: 'member-added-global',
        type: 'member_added',
        title: '你已被添加到组织',
        body: '',
        organization_id: 'ws-target',
        category: 'organization',
      },
    })

    expect(mockOptimisticAddNotification).toHaveBeenCalledWith(
      mockQueryClient,
      'ws-current',
      expect.objectContaining({ id: 'member-added-global' }),
    )
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ['notifications', 'unread-count', { organizationId: 'ws-current' }],
    })
    expect(mockOverlayPush).toHaveBeenCalledWith({
      type: 'notification-refresh',
      organizationId: 'ws-current',
    })
  })

  it('跨组织邀请作为个人全局通知刷新当前收件箱', async () => {
    const { useNotificationEventStream } = await import('../useNotificationEventStream')
    renderHook(() => useNotificationEventStream({ userId: 'user-1' }))

    capturedListeners[0]({
      type: 'agent.user.notification.new',
      payload: {
        id: 'organization-invitation-global',
        type: 'organization.invitation',
        title: '邀请加入组织',
        organization_id: 'ws-target',
        category: 'organization',
      },
    })

    expect(mockOptimisticAddNotification).toHaveBeenCalledWith(
      mockQueryClient,
      'ws-current',
      expect.objectContaining({ id: 'organization-invitation-global' }),
    )
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ['notifications', 'unread-count', { organizationId: 'ws-current' }],
    })
    expect(mockOverlayPush).toHaveBeenCalledWith({
      type: 'notification-refresh',
      organizationId: 'ws-current',
    })
  })

  it('外部联系人拒绝通知不触发收到组织邀请事件', async () => {
    const { useNotificationEventStream } = await import('../useNotificationEventStream')
    renderHook(() => useNotificationEventStream({ userId: 'user-1' }))

    const invitationReceived = vi.fn()
    window.addEventListener('tabtin:invitation-received', invitationReceived)

    capturedListeners[0]({
      type: 'agent.user.notification.new',
      payload: {
        id: 'external-contact-rejected',
        type: 'organization.invitation.external_contact.rejected',
        title: '外部联系人申请已被拒绝',
        body: '对方拒绝了你的外部联系人申请',
        metadata: { invitation_id: 'external-invitation-1' },
        organization_id: '',
        category: 'organization',
      },
    })

    expect(mockOptimisticAddNotification).toHaveBeenCalledWith(
      mockQueryClient,
      'ws-current',
      expect.objectContaining({ id: 'external-contact-rejected' }),
    )
    expect(invitationReceived).not.toHaveBeenCalled()

    window.removeEventListener('tabtin:invitation-received', invitationReceived)
  })

  it('余额预警通过持久通知触发桌面通知', async () => {
    const { useNotificationEventStream } = await import('../useNotificationEventStream')
    renderHook(() => useNotificationEventStream({ userId: 'user-1' }))

    capturedListeners[0]({
      type: 'agent.user.notification.new',
      payload: {
        id: 'balance-low-1',
        type: 'account.balance_low',
        title: '账户余额提醒',
        body: '组织可用额度已低于提醒阈值。',
        organization_id: 'ws-current',
        category: 'account',
      },
    })

    expect(mockExtensionEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'account.balance_low',
      title: '账户余额提醒',
    }))
  })

  it('仅当持久通知宣告 desktop_fallback 时启用可用性 Toast 回退', async () => {
    const { useNotificationEventStream } = await import('../useNotificationEventStream')
    renderHook(() => useNotificationEventStream({ userId: 'user-1' }))

    capturedListeners[0]({
      type: 'agent.user.notification.new',
      payload: {
        id: 'account-degradation-1',
        type: 'account.degradation_alert',
        title: '服务降级提醒',
        body: '部分能力暂时受限',
        organization_id: 'ws-current',
        category: 'account',
        source_event_id: 'billing:event:1',
        metadata: {
          presentation_owner: 'notification_projection',
          toast_policy: 'desktop_fallback',
        },
      },
    })

    expect(mockExtensionEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'account.degradation_alert',
      toastFallback: 'desktop-unavailable',
    }))
  })

  it.each([
    [undefined, '缺失 owner'],
    ['legacy_billing', '错误 owner'],
  ])('toast_policy 存在但%s时不启用新回退策略', async (presentationOwner) => {
    const { useNotificationEventStream } = await import('../useNotificationEventStream')
    renderHook(() => useNotificationEventStream({ userId: 'user-1' }))

    capturedListeners[0]({
      type: 'agent.user.notification.new',
      payload: {
        id: `account-degradation-owner-${presentationOwner ?? 'missing'}`,
        type: 'account.degradation_alert',
        title: '服务降级提醒',
        body: '部分能力暂时受限',
        organization_id: 'ws-current',
        category: 'account',
        metadata: {
          ...(presentationOwner ? { presentation_owner: presentationOwner } : {}),
          toast_policy: 'desktop_fallback',
        },
      },
    })

    const payload = mockExtensionEvent.mock.calls[0]?.[0]
    expect(payload).not.toHaveProperty('toastFallback')
  })

  it('没有 desktop_fallback metadata 时不改变旧通知契约', async () => {
    const { useNotificationEventStream } = await import('../useNotificationEventStream')
    renderHook(() => useNotificationEventStream({ userId: 'user-1' }))

    capturedListeners[0]({
      type: 'agent.user.notification.new',
      payload: {
        id: 'account-degradation-legacy',
        type: 'account.degradation_alert',
        title: '服务降级提醒',
        body: '部分能力暂时受限',
        organization_id: 'ws-current',
        category: 'account',
      },
    })

    const payload = mockExtensionEvent.mock.calls[0]?.[0]
    expect(payload).not.toHaveProperty('toastFallback')
  })

  it('Agent 持久通知把 trace_id 映射为 desktop dedup_ref', async () => {
    const { useNotificationEventStream } = await import('../useNotificationEventStream')
    renderHook(() => useNotificationEventStream({ userId: 'user-1' }))

    capturedListeners[0]({
      type: 'agent.user.notification.new',
      payload: {
        id: 'notif-agent-1',
        type: 'agent.task.completed',
        title: 'Agent 任务完成',
        organization_id: 'ws-current',
        metadata: { trace_id: 'trace-shared', message_id: 'message-1' },
        navigate_to: { type: 'chat-session', id: 'session-1' },
      },
    })

    expect(mockExtensionEvent).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        dedup_ref: 'trace-shared',
      }),
      suppressWhenSourceWindowFocused: false,
    }))
    expect(mockOptimisticAddNotification).not.toHaveBeenCalled()
    expect(mockAddNotification).not.toHaveBeenCalled()
    expect(mockInvalidateQueries).not.toHaveBeenCalled()
    expect(mockOverlayPush).not.toHaveBeenCalled()
  })

  it('HITL 持久通知把 request_key 映射为本地共用的 dedup_ref', async () => {
    const { useNotificationEventStream } = await import('../useNotificationEventStream')
    renderHook(() => useNotificationEventStream({ userId: 'user-1' }))

    capturedListeners[0]({
      type: 'agent.user.notification.new',
      payload: {
        id: 'notif-hitl-1',
        type: 'agent.hitl.waiting',
        title: 'Agent 等待回答',
        organization_id: 'ws-current',
        metadata: { request_key: 'ask-1', interaction_id: 'interaction-1' },
        navigate_to: { type: 'chat-session', id: 'session-1' },
      },
    })

    expect(mockExtensionEvent).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { dedup_ref: 'agent-hitl:ask-1' },
    }))
  })

  it.each([
    ['tracker.run.failed', undefined],
    ['tracker.health_alert', undefined],
    ['system', 'waiting_device'],
    ['system', 'waiting_timeout'],
  ])('自动化通知 %s/%s 同时进入通知中心并投递桌面通知', async (type, event) => {
    const { useNotificationEventStream } = await import('../useNotificationEventStream')
    renderHook(() => useNotificationEventStream({ userId: 'user-1' }))

    capturedListeners[0]({
      type: 'agent.user.notification.new',
      payload: {
        id: `automation-${type}-${event ?? 'terminal'}`,
        type,
        title: '自动化任务提醒',
        organization_id: 'ws-current',
        metadata: event ? { event } : {},
      },
    })

    expect(mockOptimisticAddNotification).toHaveBeenCalledOnce()
    expect(mockAddNotification).toHaveBeenCalledOnce()
    expect(mockInvalidateQueries).toHaveBeenCalled()
    expect(mockOverlayPush).toHaveBeenCalledOnce()
    expect(mockExtensionEvent).toHaveBeenCalledWith(expect.objectContaining({ type }))
  })

  it('IM 通知不进铃铛缓存 / 桌面镜像路径', async () => {
    const { useNotificationEventStream } = await import('../useNotificationEventStream')
    renderHook(() => useNotificationEventStream({ userId: 'user-1' }))

    capturedListeners[0]({
      type: 'agent.user.notification.new',
      payload: {
        id: 'notif-im',
        type: 'im.message',
        title: '新消息',
        organization_id: 'ws-current',
        navigate_to: { type: 'im-conversation', id: 'conv-1' },
      },
    })

    expect(mockOptimisticAddNotification).not.toHaveBeenCalled()
    expect(mockAddNotification).not.toHaveBeenCalled()
    expect(mockExtensionEvent).not.toHaveBeenCalled()
    expect(mockOverlayPush).not.toHaveBeenCalled()
  })

  it('仅桌面提及事件前台弹出原生通知且不写入小铃铛', async () => {
    const { useNotificationEventStream } = await import('../useNotificationEventStream')
    renderHook(() => useNotificationEventStream({ userId: 'user-1' }))

    capturedListeners[0]({
      type: 'agent.user.notification.new',
      payload: {
        id: 'comment-1:mention:user-1',
        type: 'tabdata.comment.mention.desktop_only',
        title: '你收到一条提及提醒',
        body: '你暂时没有访问关联内容的权限。',
        metadata: {
          desktop_only: true,
          source_event_id: 'comment-1:mention:user-1',
        },
        organization_id: 'org-1',
      },
    })

    expect(mockExtensionEvent).toHaveBeenCalledWith({
      type: 'tabdata.comment.mention.desktop_only',
      title: '你收到一条提及提醒',
      body: '你暂时没有访问关联内容的权限。',
      priority: 'normal',
      organizationId: 'org-1',
      spaceId: undefined,
      navigateTo: undefined,
      metadata: { dedup_ref: 'comment-1:mention:user-1' },
      desktopDelivery: 'always',
      mirrorToCenter: false,
      suppressWhenSourceWindowFocused: false,
    })
    expect(mockOptimisticAddNotification).not.toHaveBeenCalled()
    expect(mockAddNotification).not.toHaveBeenCalled()
    expect(mockInvalidateQueries).not.toHaveBeenCalled()
    expect(mockOverlayPush).not.toHaveBeenCalled()
  })

  it('#5851: invite_accepted envelope → invalidate 对应组织的成员列表与会员额度状态', async () => {
    const { useNotificationEventStream } = await import('../useNotificationEventStream')
    renderHook(() => useNotificationEventStream({ userId: 'user-1' }))

    const invitationsChanged = vi.fn()
    window.addEventListener('tabtin:organization-invitations-changed', invitationsChanged)

    capturedListeners[0]({
      type: 'agent.user.notification.new',
      payload: {
        id: 'notif-invite-accepted',
        type: 'invite_accepted',
        title: '张三 加入了「某某组织」',
        body: '角色：编辑者',
        metadata: { member_name: '张三', role: 'editor' },
        organization_id: 'ws-target-org',
      },
    })

    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ['members', 'list', 'ws-target-org'],
    })
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ['membership', 'status', 'ws-target-org'],
    })
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ['memberBudget', 'usageSummary', 'ws-target-org'],
    })
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ['memberBudget', 'policies', 'ws-target-org'],
    })
    expect(invitationsChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ organizationId: 'ws-target-org' }),
      }),
    )

    window.removeEventListener('tabtin:organization-invitations-changed', invitationsChanged)
  })

  it('#6261: organization.invitation.responded(accepted) → invalidate 成员 + 派发邀请列表刷新', async () => {
    const { useNotificationEventStream } = await import('../useNotificationEventStream')
    renderHook(() => useNotificationEventStream({ userId: 'user-1' }))

    const invitationsChanged = vi.fn()
    window.addEventListener('tabtin:organization-invitations-changed', invitationsChanged)

    capturedListeners[0]({
      type: 'agent.user.notification.new',
      payload: {
        id: 'notif-invite-responded',
        type: 'organization.invitation.responded',
        title: '张三 接受了邀请',
        body: '张三 接受了组织「某某组织」的邀请',
        metadata: {
          accepted: true,
          invitation_id: 'invite-42',
          responder_name: '张三',
        },
        organization_id: 'ws-target-org',
      },
    })

    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ['members', 'list', 'ws-target-org'],
    })
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ['membership', 'status', 'ws-target-org'],
    })
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ['memberBudget', 'usageSummary', 'ws-target-org'],
    })
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ['memberBudget', 'policies', 'ws-target-org'],
    })
    expect(invitationsChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: {
          organizationId: 'ws-target-org',
          invitationId: 'invite-42',
        },
      }),
    )

    window.removeEventListener('tabtin:organization-invitations-changed', invitationsChanged)
  })

  it('#6261: organization.invitation.responded(rejected) → 只刷新邀请列表，不 invalidate 成员', async () => {
    const { useNotificationEventStream } = await import('../useNotificationEventStream')
    renderHook(() => useNotificationEventStream({ userId: 'user-1' }))

    const invitationsChanged = vi.fn()
    window.addEventListener('tabtin:organization-invitations-changed', invitationsChanged)

    capturedListeners[0]({
      type: 'agent.user.notification.new',
      payload: {
        id: 'notif-invite-rejected',
        type: 'organization.invitation.responded',
        title: '张三 拒绝了邀请',
        body: '张三 拒绝了组织「某某组织」的邀请',
        metadata: {
          accepted: false,
          invitation_id: 'invite-43',
        },
        organization_id: 'ws-target-org',
      },
    })

    // 未读通知会刷新 unread-count（铃铛角标），但拒绝邀请不 invalidate 成员列表
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ['notifications', 'unread-count', { organizationId: 'ws-target-org' }],
    })
    expect(mockInvalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ['members', 'list', 'ws-target-org'],
    })
    expect(invitationsChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: {
          organizationId: 'ws-target-org',
          invitationId: 'invite-43',
        },
      }),
    )

    window.removeEventListener('tabtin:organization-invitations-changed', invitationsChanged)
  })

  it('#5851: 其它通知类型不应触发成员相关 invalidate', async () => {
    const { useNotificationEventStream } = await import('../useNotificationEventStream')
    renderHook(() => useNotificationEventStream({ userId: 'user-1' }))

    capturedListeners[0]({
      type: 'agent.user.notification.new',
      payload: {
        id: 'notif-other',
        type: 'tracker.run.completed',
        title: 'Tracker done',
        organization_id: 'ws-target-org',
      },
    })

    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ['notifications', 'unread-count', { organizationId: 'ws-target-org' }],
    })
    expect(mockInvalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ['members', 'list', 'ws-target-org'],
    })
    expect(mockInvalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ['membership', 'status', 'ws-target-org'],
    })
  })

  it('反退化：旧 notification.new 短名 envelope 不应触发处理', async () => {
    const { useNotificationEventStream } = await import('../useNotificationEventStream')
    renderHook(() => useNotificationEventStream({ userId: 'user-1' }))

    capturedListeners[0]({
      type: 'notification.new', // 旧短名 — W1 后端已停止使用
      payload: { id: 'old-x', title: 'old', body: '', metadata: {}, organization_id: 'ws-1' },
    })

    expect(mockOptimisticAddNotification).not.toHaveBeenCalled()
    expect(mockAddNotification).not.toHaveBeenCalled()
    expect(mockExtensionEvent).not.toHaveBeenCalled()
  })

  it('#6179/#5337: 停在 B 收到 A 的 is_read=true WS，只刷新 A 且不弹 OS', async () => {
    const { useNotificationEventStream } = await import('../useNotificationEventStream')
    renderHook(() => useNotificationEventStream({ userId: 'user-1' }))

    capturedListeners[0]({
      type: 'agent.user.notification.new',
      payload: {
        id: 'notif-already-read',
        type: 'tracker.run.completed',
        title: 'done',
        body: 'summary',
        metadata: { session_id: 'sess-1' },
        organization_id: 'ws-1',
        is_read: true,
        read_at: '2026-07-21T03:00:00.000Z',
      },
    })

    const expectedItem = expect.objectContaining({
      id: 'notif-already-read',
      is_read: true,
      read_at: '2026-07-21T03:00:00.000Z',
    })
    expect(mockOptimisticAddNotification).toHaveBeenCalledWith(
      mockQueryClient,
      'ws-1',
      expectedItem,
    )
    expect(mockAddNotification).toHaveBeenCalledWith(expectedItem)
    expect(mockExtensionEvent).not.toHaveBeenCalled()
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ['notifications', 'unread-count', { organizationId: 'ws-1' }],
    })
    expect(mockInvalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ['notifications', 'unread-count', { organizationId: 'ws-current' }],
    })
  })

  it('#5337: A 的 is_read WS 同时刷新 A 与 null 聚合，且只刷新这两个 key', async () => {
    const { useNotificationEventStream } = await import('../useNotificationEventStream')
    renderHook(() => useNotificationEventStream({ userId: 'user-1' }))

    capturedListeners[0]({
      type: 'agent.user.notification.new',
      payload: {
        id: 'notif-read-aggregate',
        type: 'tracker.run.failed',
        title: 'resolved',
        organization_id: 'ws-a',
        is_read: true,
        read_at: '2026-07-21T03:00:00.000Z',
      },
    })

    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ['notifications', 'unread-count', { organizationId: 'ws-a' }],
    })
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ['notifications', 'unread-count', { organizationId: null }],
    })
    expect(mockInvalidateQueries).toHaveBeenCalledTimes(2)
    expect(mockExtensionEvent).not.toHaveBeenCalled()
  })

  it('#6179: A 发起 acknowledge 后切到 B，完成事件仍更新 A list + unreadCount', async () => {
    const { useNotificationEventStream } = await import('../useNotificationEventStream')
    renderHook(() => useNotificationEventStream({ userId: 'user-1' }))

    window.dispatchEvent(new CustomEvent(
      'tabtin:agent-session-notif-acknowledge-completed',
      { detail: { sessionId: 'sess-1', organizationId: 'ws-a', count: 1 } },
    ))

    expect(mockOptimisticMarkAgentSessionTerminalRead).toHaveBeenCalledWith(
      mockQueryClient,
      'ws-a',
      'sess-1',
    )
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ['notifications', 'unread-count', { organizationId: 'ws-a' }],
    })
    expect(mockInvalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ['notifications', 'unread-count', { organizationId: 'ws-current' }],
    })
  })

  it('#6179: A acknowledge 完成同时刷新 A 与 null 聚合，且只刷新这两个 key', async () => {
    const { useNotificationEventStream } = await import('../useNotificationEventStream')
    renderHook(() => useNotificationEventStream({ userId: 'user-1' }))

    window.dispatchEvent(new CustomEvent(
      'tabtin:agent-session-notif-acknowledge-completed',
      { detail: { sessionId: 'sess-aggregate', organizationId: 'ws-a', count: 1 } },
    ))

    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ['notifications', 'unread-count', { organizationId: 'ws-a' }],
    })
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ['notifications', 'unread-count', { organizationId: null }],
    })
    expect(mockInvalidateQueries).toHaveBeenCalledTimes(2)
  })

  it('#6179: 完成事件归属缺失时只刷新 null 聚合 key，不猜当前组织', async () => {
    const { useNotificationEventStream } = await import('../useNotificationEventStream')
    renderHook(() => useNotificationEventStream({ userId: 'user-1' }))

    window.dispatchEvent(new CustomEvent(
      'tabtin:agent-session-notif-acknowledge-completed',
      { detail: { sessionId: 'sess-global', organizationId: null, count: 1 } },
    ))

    expect(mockOptimisticMarkAgentSessionTerminalRead).toHaveBeenCalledWith(
      mockQueryClient,
      null,
      'sess-global',
    )
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ['notifications', 'unread-count', { organizationId: null }],
    })
    expect(mockInvalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ['notifications', 'unread-count', { organizationId: 'ws-current' }],
    })
    expect(mockInvalidateQueries).toHaveBeenCalledTimes(1)
  })

  it('event_id 重复时只处理一次（dedup）', async () => {
    const { useNotificationEventStream } = await import('../useNotificationEventStream')
    renderHook(() => useNotificationEventStream({ userId: 'user-1' }))

    const env = {
      event_id: 'evt-dup',
      type: 'agent.user.notification.new',
      payload: { id: 'dup-1', title: 'dup', body: '', metadata: {}, organization_id: 'ws-1' },
    }
    capturedListeners[0](env)
    capturedListeners[0](env)
    capturedListeners[0](env)

    expect(mockOptimisticAddNotification).toHaveBeenCalledTimes(1)
  })

  it('重连后触发 invalidateNotifications + 邀请刷新事件', async () => {
    const { useNotificationEventStream } = await import('../useNotificationEventStream')
    renderHook(() => useNotificationEventStream({ userId: 'user-1' }))

    expect(capturedReconnectHandlers.length).toBe(1)

    const dispatched = vi.fn()
    const orgInvitationsChanged = vi.fn()
    const projectDispatched = vi.fn()
    window.addEventListener('tabtin:invitation-received', dispatched)
    window.addEventListener('tabtin:organization-invitations-changed', orgInvitationsChanged)
    window.addEventListener('tabtin:project-invitation-received', projectDispatched)

    capturedReconnectHandlers[0]()

    expect(mockInvalidateNotifications).toHaveBeenCalledWith(mockQueryClient)
    expect(dispatched).toHaveBeenCalled()
    expect(orgInvitationsChanged).toHaveBeenCalled()
    expect(projectDispatched).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ isSync: true }),
      }),
    )

    window.removeEventListener('tabtin:invitation-received', dispatched)
    window.removeEventListener('tabtin:organization-invitations-changed', orgInvitationsChanged)
    window.removeEventListener('tabtin:project-invitation-received', projectDispatched)
  })

  it('#6355: space.invitation envelope → 派发 tabtin:project-invitation-received', async () => {
    const { useNotificationEventStream } = await import('../useNotificationEventStream')
    renderHook(() => useNotificationEventStream({ userId: 'user-1' }))

    const dispatched = vi.fn()
    window.addEventListener('tabtin:project-invitation-received', dispatched)

    capturedListeners[0]({
      type: 'agent.user.notification.new',
      payload: {
        id: 'notif-project-invite',
        type: 'space.invitation',
        title: '邀请加入项目「团建」',
        body: '主人 邀请你加入',
        metadata: { project_id: 'project-team-building', project_name: '团建' },
        organization_id: 'org-duo',
      },
    })

    expect(dispatched).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: {
          projectId: 'project-team-building',
          organizationId: 'org-duo',
          isSync: false,
        },
      }),
    )

    window.removeEventListener('tabtin:project-invitation-received', dispatched)
  })

  it('userId 为空 → 不挂监听', async () => {
    const { useNotificationEventStream } = await import('../useNotificationEventStream')
    renderHook(() => useNotificationEventStream({ userId: null }))

    expect(gatewayAddListener).not.toHaveBeenCalled()
    expect(gatewayOnReconnected).not.toHaveBeenCalled()
  })

  it('enabled=false → 不挂监听', async () => {
    const { useNotificationEventStream } = await import('../useNotificationEventStream')
    renderHook(() => useNotificationEventStream({ userId: 'user-1', enabled: false }))

    expect(gatewayAddListener).not.toHaveBeenCalled()
    expect(gatewayOnReconnected).not.toHaveBeenCalled()
  })

  it('卸载时 detach gateway listener', async () => {
    const { useNotificationEventStream } = await import('../useNotificationEventStream')
    const { unmount } = renderHook(() => useNotificationEventStream({ userId: 'user-1' }))
    expect(gatewayAddListener).toHaveBeenCalledTimes(1)
    expect(gatewayOnReconnected).toHaveBeenCalledTimes(1)

    unmount()
    expect(gatewayRemoveListener).toHaveBeenCalledTimes(1)
    expect(gatewayOffReconnected).toHaveBeenCalledTimes(1)
  })
})
