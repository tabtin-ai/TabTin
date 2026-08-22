/**
 * optimisticAddNotification — organization scope 校验回归锁
 *
 * 普通业务通知按 organization 隔离；组织邀请、成员加入/移除等个人生命周期消息
 * 不受当前 organization 限制，必须在账号任意上下文可见。
 */
import { describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import {
  optimisticAddNotification,
  optimisticMarkNotificationRead,
  optimisticMarkAllNotificationsRead,
  optimisticMarkAgentSessionTerminalRead,
  optimisticRemoveInvitationNotifications,
  prepareOptimisticMarkAllNotificationsRead,
  selectLocalNotificationCenterItems,
  notificationKeys,
} from '../notification'
import type { NotificationItem } from '@services/notificationApi'

function makeItem(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 'notif-1',
    type: 'organization.invitation',
    title: '邀请加入组织',
    body: 'x 邀请你加入',
    metadata: {},
    organization_id: 'ws-target',
    is_read: false,
    read_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  } as NotificationItem
}

function seedScope(qc: QueryClient, organizationId: string) {
  qc.setQueryData(notificationKeys.list(organizationId, 1), {
    items: [],
    total: 0,
    page: 1,
    limit: 20,
  })
  qc.setQueryData(notificationKeys.unreadCount(organizationId), 0)
}

describe('selectLocalNotificationCenterItems', () => {
  it('只同步当前组织可在通知中心展示的本地镜像', () => {
    const current = makeItem({
      id: 'local-current',
      type: 'tracker.run.completed',
      organization_id: 'ws-current',
    })
    const otherOrganization = makeItem({
      id: 'local-other',
      type: 'tracker.run.completed',
      organization_id: 'ws-other',
    })
    const serverItem = makeItem({
      id: 'server-current',
      type: 'tracker.run.completed',
      organization_id: 'ws-current',
    })

    expect(selectLocalNotificationCenterItems(
      [current, otherOrganization, serverItem],
      'ws-current',
    )).toEqual([current])
  })
})

describe('optimisticAddNotification (organization scope 校验)', () => {
  it('Agent 通知不插入通知中心缓存', () => {
    const qc = new QueryClient()
    seedScope(qc, 'ws-a')

    optimisticAddNotification(qc, 'ws-a', makeItem({
      id: 'agent-1',
      type: 'agent.task.completed',
      organization_id: 'ws-a',
    }))

    const list = qc.getQueryData<{ items: NotificationItem[] }>(notificationKeys.list('ws-a', 1))
    expect(list?.items).toHaveLength(0)
    expect(qc.getQueryData<number>(notificationKeys.unreadCount('ws-a'))).toBe(0)
  })

  it('同 scope：插入列表 + 未读 +1', () => {
    const qc = new QueryClient()
    seedScope(qc, 'ws-a')

    optimisticAddNotification(qc, 'ws-a', makeItem({ id: 'n-a', organization_id: 'ws-a' }))

    const list = qc.getQueryData<{ items: NotificationItem[] }>(notificationKeys.list('ws-a', 1))
    expect(list?.items.map((i) => i.id)).toEqual(['n-a'])
    expect(qc.getQueryData<number>(notificationKeys.unreadCount('ws-a'))).toBe(1)
  })

  it('跨 scope 的普通组织通知不插入、不抬未读', () => {
    const qc = new QueryClient()
    seedScope(qc, 'ws-current')

    optimisticAddNotification(
      qc,
      'ws-current',
      makeItem({ id: 'task-1', type: 'agent.task.completed', organization_id: 'ws-target' }),
    )

    const list = qc.getQueryData<{ items: NotificationItem[] }>(
      notificationKeys.list('ws-current', 1),
    )
    expect(list?.items.length).toBe(0)
    expect(qc.getQueryData<number>(notificationKeys.unreadCount('ws-current'))).toBe(0)
  })

  it('跨 scope 的组织邀请仍进入当前账号收件箱', () => {
    const qc = new QueryClient()
    seedScope(qc, 'ws-current')

    optimisticAddNotification(
      qc,
      'ws-current',
      makeItem({ id: 'inv-1', type: 'organization.invitation', organization_id: 'ws-target' }),
    )

    const list = qc.getQueryData<{ items: NotificationItem[] }>(
      notificationKeys.list('ws-current', 1),
    )
    expect(list?.items.map((item) => item.id)).toEqual(['inv-1'])
    expect(qc.getQueryData<number>(notificationKeys.unreadCount('ws-current'))).toBe(1)
  })

  it('跨 scope 的个人成员加入通知仍进入当前收件箱', () => {
    const qc = new QueryClient()
    seedScope(qc, 'ws-current')

    optimisticAddNotification(
      qc,
      'ws-current',
      makeItem({ id: 'member-added-1', type: 'member_added', organization_id: 'ws-target' }),
    )

    const list = qc.getQueryData<{ items: NotificationItem[] }>(
      notificationKeys.list('ws-current', 1),
    )
    expect(list?.items.map((item) => item.id)).toEqual(['member-added-1'])
    expect(qc.getQueryData<number>(notificationKeys.unreadCount('ws-current'))).toBe(1)
  })

  it('全局通知（organization_id 为空）只进全局 scope，不进具体团队 scope', () => {
    const qc = new QueryClient()
    seedScope(qc, 'ws-a')

    optimisticAddNotification(
      qc,
      'ws-a',
      makeItem({ id: 'g-1', type: 'system', organization_id: '' }),
    )

    const list = qc.getQueryData<{ items: NotificationItem[] }>(notificationKeys.list('ws-a', 1))
    expect(list?.items.length).toBe(0)
    expect(qc.getQueryData<number>(notificationKeys.unreadCount('ws-a'))).toBe(0)
  })

  it('无 list 缓存时仍抬 unread-count（主窗铃铛角标）', () => {
    const qc = new QueryClient()
    qc.setQueryData(notificationKeys.unreadCount('ws-a'), 0)

    optimisticAddNotification(
      qc,
      'ws-a',
      makeItem({ id: 'n-new', organization_id: 'ws-a', is_read: false, type: 'balance_low' }),
    )

    expect(qc.getQueryData(notificationKeys.list('ws-a', 1))).toBeUndefined()
    expect(qc.getQueryData<number>(notificationKeys.unreadCount('ws-a'))).toBe(1)
  })

  it('Agent 等其它渠道事件不抬通知中心未读数', () => {
    const qc = new QueryClient()
    qc.setQueryData(notificationKeys.unreadCount('ws-a'), 3)

    optimisticAddNotification(
      qc,
      'ws-a',
      makeItem({
        id: 'agent-done',
        organization_id: 'ws-a',
        type: 'agent.task.completed',
        category: 'agent.task',
        is_read: false,
      }),
    )

    expect(qc.getQueryData<number>(notificationKeys.unreadCount('ws-a'))).toBe(3)
  })
})

describe('optimisticAddNotification upsert ', () => {
  it('同 id 已存在：原地替换并校正未读（邀请→sync 已读）', () => {
    const qc = new QueryClient()
    const invite = makeItem({
      id: 'same-id',
      organization_id: 'ws-a',
      is_read: false,
      type: 'organization.invitation',
      metadata: { invitation_id: 'inv-1' },
    })
    qc.setQueryData(notificationKeys.list('ws-a', 1), {
      items: [invite],
      total: 1,
      page: 1,
      limit: 20,
    })
    qc.setQueryData(notificationKeys.unreadCount('ws-a'), 1)

    optimisticAddNotification(
      qc,
      'ws-a',
      makeItem({
        id: 'same-id',
        organization_id: 'ws-a',
        is_read: true,
        type: 'organization.invitation.sync',
        title: '邀请已接受',
        metadata: { invitation_id: 'inv-1', accepted: true },
      }),
    )

    const list = qc.getQueryData<{ items: NotificationItem[]; total: number }>(
      notificationKeys.list('ws-a', 1),
    )
    expect(list?.items).toHaveLength(1)
    expect(list?.total).toBe(1)
    expect(list?.items[0]?.type).toBe('organization.invitation.sync')
    expect(list?.items[0]?.is_read).toBe(true)
    expect(qc.getQueryData<number>(notificationKeys.unreadCount('ws-a'))).toBe(0)
  })

  it('#5337: 没有 list 缓存时，服务端已读结果不得增加现有 unreadCount', () => {
    const qc = new QueryClient()
    qc.setQueryData(notificationKeys.unreadCount('ws-a'), 5)

    optimisticAddNotification(
      qc,
      'ws-a',
      makeItem({
        id: 'same-id-read-update',
        organization_id: 'ws-a',
        type: 'agent.hitl.waiting',
        is_read: true,
        read_at: '2026-07-21T03:00:00.000Z',
      }),
    )

    expect(qc.getQueryData(notificationKeys.list('ws-a', 1))).toBeUndefined()
    expect(qc.getQueryData<number>(notificationKeys.unreadCount('ws-a'))).toBe(5)
  })
})

describe('optimisticRemoveInvitationNotifications ', () => {
  it('按 invitation_id 移除旧 organization.invitation 并递减未读', () => {
    const qc = new QueryClient()
    qc.setQueryData(notificationKeys.list('ws-a', 1), {
      items: [
        makeItem({
          id: 'inv-card',
          organization_id: 'ws-a',
          is_read: false,
          metadata: { invitation_id: 'inv-1' },
        }),
        makeItem({
          id: 'other',
          organization_id: 'ws-a',
          is_read: false,
          type: 'system',
          metadata: {},
        }),
      ],
      total: 2,
      page: 1,
      limit: 20,
    })
    qc.setQueryData(notificationKeys.unreadCount('ws-a'), 2)

    optimisticRemoveInvitationNotifications(qc, 'ws-a', 'inv-1')

    const list = qc.getQueryData<{ items: NotificationItem[]; total: number }>(
      notificationKeys.list('ws-a', 1),
    )
    expect(list?.items.map((i) => i.id)).toEqual(['other'])
    expect(list?.total).toBe(1)
    expect(qc.getQueryData<number>(notificationKeys.unreadCount('ws-a'))).toBe(1)
  })
})

describe('optimisticMarkAgentSessionTerminalRead ', () => {
  it('只标记已有 list 的同 session 终态，不自行误扣权威 unreadCount', () => {
    const qc = new QueryClient()
    qc.setQueryData(notificationKeys.list('ws-a', 1), {
      items: [
        makeItem({
          id: 'n-done',
          type: 'agent.task.completed',
          organization_id: 'ws-a',
          metadata: { session_id: 'sess-1' },
          is_read: false,
        }),
        makeItem({
          id: 'n-hitl',
          type: 'agent.hitl.waiting',
          organization_id: 'ws-a',
          metadata: { session_id: 'sess-1', interaction_id: 'ix-1' },
          is_read: false,
        }),
        makeItem({
          id: 'n-session-interrupted',
          type: 'agent.task.session_interrupted',
          organization_id: 'ws-a',
          metadata: { session_id: 'sess-1' },
          is_read: false,
        }),
        makeItem({
          id: 'n-other',
          type: 'agent.task.error',
          organization_id: 'ws-a',
          metadata: { session_id: 'sess-2' },
          is_read: false,
        }),
      ],
      total: 4,
      page: 1,
      limit: 20,
    })
    qc.setQueryData(notificationKeys.unreadCount('ws-a'), 4)

    const marked = optimisticMarkAgentSessionTerminalRead(qc, 'ws-a', 'sess-1')
    expect(marked).toBe(2)
    const list = qc.getQueryData<{ items: NotificationItem[] }>(notificationKeys.list('ws-a', 1))
    expect(list?.items.find((n) => n.id === 'n-done')?.is_read).toBe(true)
    expect(list?.items.find((n) => n.id === 'n-session-interrupted')?.is_read).toBe(true)
    expect(list?.items.find((n) => n.id === 'n-hitl')?.is_read).toBe(false)
    expect(list?.items.find((n) => n.id === 'n-other')?.is_read).toBe(false)
    expect(qc.getQueryData<number>(notificationKeys.unreadCount('ws-a'))).toBe(4)
  })
})

describe('optimisticMarkNotificationRead', () => {
  it('单条已读：清除 is_read 并递减未读数', () => {
    const qc = new QueryClient()
    const item = makeItem({ id: 'n-1', organization_id: 'ws-a', is_read: false })
    qc.setQueryData(notificationKeys.list('ws-a', 1), {
      items: [item],
      total: 1,
      page: 1,
      limit: 20,
    })
    qc.setQueryData(notificationKeys.unreadCount('ws-a'), 1)

    optimisticMarkNotificationRead(qc, 'ws-a', 'n-1')

    const list = qc.getQueryData<{ items: NotificationItem[] }>(notificationKeys.list('ws-a', 1))
    expect(list?.items[0]?.is_read).toBe(true)
    expect(qc.getQueryData<number>(notificationKeys.unreadCount('ws-a'))).toBe(0)
  })

  it('已是已读：不重复递减未读数', () => {
    const qc = new QueryClient()
    const item = makeItem({ id: 'n-1', organization_id: 'ws-a', is_read: true })
    qc.setQueryData(notificationKeys.list('ws-a', 1), {
      items: [item],
      total: 1,
      page: 1,
      limit: 20,
    })
    qc.setQueryData(notificationKeys.unreadCount('ws-a'), 0)

    optimisticMarkNotificationRead(qc, 'ws-a', 'n-1')

    expect(qc.getQueryData<number>(notificationKeys.unreadCount('ws-a'))).toBe(0)
  })

  it('通知中心未加载铃铛列表时：仍同步卡片与未读数', () => {
    const qc = new QueryClient()
    const centerKey = notificationKeys.centerList('ws-a', 1, 'all', '', '')
    qc.setQueryData(centerKey, {
      items: [makeItem({ id: 'n-center', organization_id: 'ws-a', is_read: false })],
      total: 1,
      page: 1,
      limit: 30,
    })
    qc.setQueryData(notificationKeys.unreadCount('ws-a'), 1)

    optimisticMarkNotificationRead(qc, 'ws-a', 'n-center')

    const center = qc.getQueryData<{ items: NotificationItem[] }>(centerKey)
    expect(center?.items[0]?.is_read).toBe(true)
    expect(qc.getQueryData<number>(notificationKeys.unreadCount('ws-a'))).toBe(0)
  })

  it('主窗口只有未读数缓存时：点击浮层查看仍立即递减角标', () => {
    const qc = new QueryClient()
    qc.setQueryData(notificationKeys.unreadCount('ws-a'), 2)

    optimisticMarkNotificationRead(qc, 'ws-a', 'n-overlay', true)

    expect(qc.getQueryData(notificationKeys.list('ws-a', 1))).toBeUndefined()
    expect(qc.getQueryData<number>(notificationKeys.unreadCount('ws-a'))).toBe(1)
  })
})

describe('optimisticMarkAllNotificationsRead', () => {
  it('全部已读：列表项 is_read 置 true、未读归零', () => {
    const qc = new QueryClient()
    qc.setQueryData(notificationKeys.list('ws-a', 1), {
      items: [
        makeItem({ id: 'n-1', organization_id: 'ws-a', is_read: false }),
        makeItem({ id: 'n-2', organization_id: 'ws-a', is_read: false }),
      ],
      total: 2,
      page: 1,
      limit: 20,
    })
    qc.setQueryData(notificationKeys.unreadCount('ws-a'), 2)

    optimisticMarkAllNotificationsRead(qc, 'ws-a')

    const list = qc.getQueryData<{ items: NotificationItem[] }>(notificationKeys.list('ws-a', 1))
    expect(list?.items.every((n) => n.is_read)).toBe(true)
    expect(qc.getQueryData<number>(notificationKeys.unreadCount('ws-a'))).toBe(0)
  })

  it('通知中心未加载铃铛列表时：全部卡片已读、未读归零', () => {
    const qc = new QueryClient()
    const centerKey = notificationKeys.centerList('ws-a', 1, 'unread', 'organization', '')
    qc.setQueryData(centerKey, {
      items: [
        makeItem({ id: 'n-1', organization_id: 'ws-a', is_read: false }),
        makeItem({ id: 'n-2', organization_id: 'ws-a', is_read: false }),
      ],
      total: 2,
      page: 1,
      limit: 30,
    })
    qc.setQueryData(notificationKeys.unreadCount('ws-a'), 2)

    optimisticMarkAllNotificationsRead(qc, 'ws-a')

    const center = qc.getQueryData<{ items: NotificationItem[] }>(centerKey)
    expect(center?.items.every((notification) => notification.is_read)).toBe(true)
    expect(qc.getQueryData<number>(notificationKeys.unreadCount('ws-a'))).toBe(0)
  })

  it('全部已读不改动只走侧栏的 Agent 通知', () => {
    const qc = new QueryClient()
    qc.setQueryData(notificationKeys.list('ws-a', 1), {
      items: [
        makeItem({ id: 'organization', organization_id: 'ws-a', is_read: false }),
        makeItem({
          id: 'agent',
          organization_id: 'ws-a',
          type: 'agent.task.completed',
          category: 'agent.task',
          is_read: false,
        }),
      ],
      total: 2,
      page: 1,
      limit: 20,
    })
    qc.setQueryData(notificationKeys.unreadCount('ws-a'), 1)

    optimisticMarkAllNotificationsRead(qc, 'ws-a')

    const list = qc.getQueryData<{ items: NotificationItem[] }>(notificationKeys.list('ws-a', 1))
    expect(list?.items.find((item) => item.id === 'organization')?.is_read).toBe(true)
    expect(list?.items.find((item) => item.id === 'agent')?.is_read).toBe(false)
    expect(qc.getQueryData<number>(notificationKeys.unreadCount('ws-a'))).toBe(0)
  })

  it('全部已读只更新当前 organization 的通知中心缓存', () => {
    const qc = new QueryClient()
    const currentKey = notificationKeys.centerList('ws-a', 1, 'all', '', '')
    const otherKey = notificationKeys.centerList('ws-b', 1, 'all', '', '')
    qc.setQueryData(currentKey, {
      items: [makeItem({ id: 'n-a', organization_id: 'ws-a', is_read: false })],
      total: 1,
    })
    qc.setQueryData(otherKey, {
      items: [makeItem({ id: 'n-b', organization_id: 'ws-b', is_read: false })],
      total: 1,
    })

    optimisticMarkAllNotificationsRead(qc, 'ws-a')

    expect(qc.getQueryData<{ items: NotificationItem[] }>(currentKey)?.items[0]?.is_read).toBe(true)
    expect(qc.getQueryData<{ items: NotificationItem[] }>(otherKey)?.items[0]?.is_read).toBe(false)
  })
})

describe('prepareOptimisticMarkAllNotificationsRead ( 旧 GET 竞态)', () => {
  it('不 cancel 时：乐观已读后迟到的 list 响应会盖回未读（复现）', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const orgId = 'ws-a'
    const listKey = notificationKeys.list(orgId, 1)
    const unreadSnapshot = {
      items: [
        makeItem({ id: 'n-1', organization_id: orgId, is_read: false }),
        makeItem({ id: 'n-2', organization_id: orgId, is_read: false }),
      ],
      total: 2,
      page: 1,
      limit: 20,
    }
    qc.setQueryData(listKey, unreadSnapshot)
    qc.setQueryData(notificationKeys.unreadCount(orgId), 2)

    let resolveFetch!: (value: typeof unreadSnapshot) => void
    const pending = new Promise<typeof unreadSnapshot>((resolve) => {
      resolveFetch = resolve
    })
    const fetchPromise = qc.fetchQuery({
      queryKey: listKey,
      queryFn: () => pending,
      staleTime: 0,
    })

    // 只乐观、不 cancel —— 旧 GET 晚到会覆盖
    optimisticMarkAllNotificationsRead(qc, orgId)
    expect(
      qc.getQueryData<{ items: NotificationItem[] }>(listKey)?.items.every((n) => n.is_read),
    ).toBe(true)

    resolveFetch(unreadSnapshot)
    await fetchPromise

    const list = qc.getQueryData<{ items: NotificationItem[] }>(listKey)
    expect(list?.items.some((n) => !n.is_read)).toBe(true)
  })

  it('cancel + 乐观后：迟到的 list 响应不得盖回未读', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const orgId = 'ws-a'
    const listKey = notificationKeys.list(orgId, 1)
    const unreadSnapshot = {
      items: [
        makeItem({ id: 'n-1', organization_id: orgId, is_read: false }),
        makeItem({ id: 'n-2', organization_id: orgId, is_read: false }),
      ],
      total: 2,
      page: 1,
      limit: 20,
    }
    qc.setQueryData(listKey, unreadSnapshot)
    qc.setQueryData(notificationKeys.unreadCount(orgId), 2)

    let resolveFetch!: (value: typeof unreadSnapshot) => void
    const pending = new Promise<typeof unreadSnapshot>((resolve) => {
      resolveFetch = resolve
    })
    const fetchPromise = qc.fetchQuery({
      queryKey: listKey,
      queryFn: () => pending,
      staleTime: 0,
    })

    await prepareOptimisticMarkAllNotificationsRead(qc, orgId)

    resolveFetch(unreadSnapshot)
    await fetchPromise.catch(() => undefined)

    const list = qc.getQueryData<{ items: NotificationItem[] }>(listKey)
    expect(list?.items.every((n) => n.is_read)).toBe(true)
    expect(qc.getQueryData<number>(notificationKeys.unreadCount(orgId))).toBe(0)
  })
})
