/**
 * Notification react-query hooks
 *
 * 替代 useNotificationStore 中的数据获取逻辑，
 * 提供自动缓存、去重、stale-while-revalidate 能力。
 *
 * 写操作（markRead/markAllRead）使用 useMutation + invalidation。
 * WS 推送通过 queryClient.setQueryData 乐观更新缓存。
 */
import { useQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { NotificationApiService, type NotificationItem } from '@services/notificationApi'
import { withResolvedNotificationNavigateTarget } from '@/services/notificationTargetResolver'
import { isNotificationCenterExcludedType } from '@/services/inboxNotificationPolicy'
import { resolveNotificationCenterCategory } from '@/services/notificationCenterCatalog'
import { isPersonalGlobalNotificationType } from '@/services/inboxNotificationPolicy'
import { useNotificationStore } from '@stores/useNotificationStore'

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const notificationKeys = {
  all: ['notifications'] as const,
  list: (organizationId: string | null, page: number) =>
    [...notificationKeys.all, 'list', { organizationId, page }] as const,
  unreadCount: (organizationId: string | null) =>
    [...notificationKeys.all, 'unread-count', { organizationId }] as const,
  centerList: (
    organizationId: string | null,
    page: number,
    status: 'all' | 'unread',
    category: string,
    search: string,
  ) => [...notificationKeys.all, 'center-list', { organizationId, page, status, category, search }] as const,
}

/** ：点券充值后要求铃铛未读重拉（后端会标已读 balance_low） */
export const NOTIFICATION_REFRESH_EVENT = 'tabtin:notifications-refresh'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeItems(items: NotificationItem[]): NotificationItem[] {
  return items.map(withResolvedNotificationNavigateTarget)
}

function normalizeCenterItems(items: NotificationItem[]): NotificationItem[] {
  return normalizeItems(items).filter((item) => resolveNotificationCenterCategory(item) !== null)
}

/** 主窗口与 modal 子窗口共用同一套“本地通知是否进入通知中心”规则。 */
export function selectLocalNotificationCenterItems(
  notifications: NotificationItem[],
  organizationId: string | null,
): NotificationItem[] {
  return notifications.filter((item) => (
    item.id.startsWith('local-')
    && isNotificationVisibleInScope(item, organizationId)
    && resolveNotificationCenterCategory(item) !== null
  ))
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function useNotificationsQuery(
  organizationId: string | null,
  options?: { page?: number; enabled?: boolean },
) {
  const page = options?.page ?? 1
  return useQuery({
    queryKey: notificationKeys.list(organizationId, page),
    queryFn: async () => {
      const result = await NotificationApiService.list(
        page,
        20,
        organizationId ?? undefined,
        { includePersonalInvitations: true },
      )
      return {
        ...result,
        items: normalizeItems(result.items),
      }
    },
    enabled: options?.enabled !== false,
  })
}

export function useNotificationCenterQuery(
  organizationId: string | null,
  options: {
    page: number
    status: 'all' | 'unread'
    category: string
    search: string
    enabled?: boolean
  },
) {
  const localNotifications = useNotificationStore((state) => state.notifications)
  const query = useQuery({
    queryKey: notificationKeys.centerList(
      organizationId,
      options.page,
      options.status,
      options.category,
      options.search,
    ),
    queryFn: async () => {
      const result = await NotificationApiService.list(
        options.page,
        30,
        organizationId ?? undefined,
        {
          status: options.status,
          category: options.category || undefined,
          search: options.search || undefined,
          includePersonalInvitations: true,
          centerOnly: true,
        },
      )
      return { ...result, items: normalizeCenterItems(result.items) }
    },
    enabled: options.enabled !== false,
  })
  const localItems = options.page === 1
    ? selectLocalNotificationCenterItems(localNotifications, organizationId).filter((item) => {
        const itemCategory = resolveNotificationCenterCategory(item)
        if (options.status === 'unread' && item.is_read) return false
        if (options.category && itemCategory !== options.category) return false
        const search = options.search.trim().toLocaleLowerCase()
        return !search || `${item.title} ${item.body}`.toLocaleLowerCase().includes(search)
      })
    : []
  const serverItems = query.data?.items ?? []
  const mergedItems = [...localItems, ...serverItems]
    .filter((item, index, items) => items.findIndex((candidate) => candidate.id === item.id) === index)
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))

  return {
    ...query,
    data: query.data || localItems.length > 0
      ? {
          ...(query.data ?? { page: options.page, limit: 30, total: 0 }),
          items: mergedItems,
          total: (query.data?.total ?? 0) + localItems.length,
        }
      : query.data,
  }
}

export function useUnreadCountQuery(organizationId: string | null) {
  const notifications = useNotificationStore((state) => state.notifications)
  const localUnreadCount = selectLocalNotificationCenterItems(notifications, organizationId)
    .filter((item) => !item.is_read)
    .length
  const query = useQuery({
    queryKey: notificationKeys.unreadCount(organizationId),
    queryFn: async () => {
      const count = await NotificationApiService.getUnreadCount(organizationId ?? undefined)
      return count
    },
    staleTime: 60_000,
    refetchInterval: 120_000,
  })
  return { ...query, data: (query.data ?? 0) + localUnreadCount }
}

// ---------------------------------------------------------------------------
// Optimistic cache helpers (shared by main renderer mutations + overlay panel)
// ---------------------------------------------------------------------------

type NotificationListCache = { items: NotificationItem[]; total?: number; page?: number; limit?: number }

function isNotificationVisibleInScope(
  item: Pick<NotificationItem, 'type' | 'organization_id'>,
  organizationId: string | null,
): boolean {
  const itemOrganizationId = item.organization_id || null
  return itemOrganizationId === (organizationId || null)
    || isPersonalGlobalNotificationType(item.type)
}

function isCenterQueryForOrganization(
  queryKey: readonly unknown[],
  organizationId: string | null,
): boolean {
  if (queryKey[0] !== notificationKeys.all[0] || queryKey[1] !== 'center-list') return false
  const scope = queryKey[2] as { organizationId?: string | null } | undefined
  return scope?.organizationId === organizationId
}

/**
 * 乐观标记单条通知已读。overlay 子窗口与主 renderer 各自持有 QueryClient，
 * 面板内点击已读时须在本进程缓存上同步更新，否则圆点/高亮不会消失。
 */
export function optimisticMarkNotificationRead(
  queryClient: QueryClient,
  organizationId: string | null,
  notificationId: string,
  wasUnreadHint = false,
): { prevList?: NotificationListCache; prevCount?: number } {
  const listKey = notificationKeys.list(organizationId, 1)
  const countKey = notificationKeys.unreadCount(organizationId)
  const prevList = queryClient.getQueryData<NotificationListCache>(listKey)
  const prevCount = queryClient.getQueryData<number>(countKey)
  const centerLists = queryClient.getQueriesData<NotificationListCache>({
    predicate: (query) => isCenterQueryForOrganization(query.queryKey, organizationId),
  })
  const wasUnreadInCache = Boolean(
    prevList?.items.some((n) =>
      n.id === notificationId
      && !n.is_read
      && resolveNotificationCenterCategory(n) !== null,
    )
    || centerLists.some(([, list]) => list?.items.some((n) => n.id === notificationId && !n.is_read)),
  )
  const wasUnread = wasUnreadInCache || (wasUnreadHint && (prevCount ?? 0) > 0)
  if (prevList) {
    queryClient.setQueryData(listKey, {
      ...prevList,
      items: prevList.items.map((n) =>
        n.id === notificationId ? { ...n, is_read: true } : n,
      ),
    })
  }
  queryClient.setQueriesData<NotificationListCache>(
    { predicate: (query) => isCenterQueryForOrganization(query.queryKey, organizationId) },
    (old) => old
      ? {
          ...old,
          items: old.items.map((n) =>
            n.id === notificationId ? { ...n, is_read: true } : n,
          ),
        }
      : old,
  )
  if (wasUnread) {
    queryClient.setQueryData<number>(countKey, (old) => Math.max(0, (old ?? 1) - 1))
  }
  return { prevList, prevCount }
}

/** 乐观标记当前 scope 全部通知已读。 */
export function optimisticMarkAllNotificationsRead(
  queryClient: QueryClient,
  organizationId: string | null,
): { prevList?: NotificationListCache; prevCount?: number } {
  const listKey = notificationKeys.list(organizationId, 1)
  const countKey = notificationKeys.unreadCount(organizationId)
  const prevList = queryClient.getQueryData<NotificationListCache>(listKey)
  const prevCount = queryClient.getQueryData<number>(countKey)
  if (prevList) {
    queryClient.setQueryData(listKey, {
      ...prevList,
      items: prevList.items.map((n) =>
        resolveNotificationCenterCategory(n) !== null ? { ...n, is_read: true } : n,
      ),
    })
  }
  queryClient.setQueriesData<NotificationListCache>(
    { predicate: (query) => isCenterQueryForOrganization(query.queryKey, organizationId) },
    (old) => old
      ? { ...old, items: old.items.map((n) => ({ ...n, is_read: true })) }
      : old,
  )
  queryClient.setQueryData<number>(countKey, 0)
  return { prevList, prevCount }
}

/**
 * 取消本 QueryClient 上未完成的 list / unread-count 请求。
 * overlay 与主 renderer 各有独立 QueryClient：主窗口 cancel 挡不住浮层打开时发出的旧 GET；
 * 旧响应晚到会把乐观已读盖回未读。
 *
 * 调用即同步 abort；返回的 Promise 仅表示清理结束。
 */
export function cancelNotificationQueries(
  queryClient: QueryClient,
  organizationId: string | null,
): Promise<void> {
  return Promise.all([
    queryClient.cancelQueries({ queryKey: notificationKeys.list(organizationId, 1) }),
    queryClient.cancelQueries({ queryKey: notificationKeys.unreadCount(organizationId) }),
    queryClient.cancelQueries({
      predicate: (query) => isCenterQueryForOrganization(query.queryKey, organizationId),
    }),
  ]).then(() => undefined)
}

/** cancel 在途请求后再乐观已读——mutation onMutate 与 overlay 共用。 */
export async function prepareOptimisticMarkNotificationRead(
  queryClient: QueryClient,
  organizationId: string | null,
  notificationId: string,
  wasUnreadHint = false,
): Promise<{ prevList?: NotificationListCache; prevCount?: number }> {
  // cancelQueries 在 Promise.all 求值时已同步 abort；先乐观写缓存保证 UI 立即响应
  const cancelPromise = cancelNotificationQueries(queryClient, organizationId)
  const prev = optimisticMarkNotificationRead(
    queryClient,
    organizationId,
    notificationId,
    wasUnreadHint,
  )
  await cancelPromise
  return prev
}

/** cancel 在途请求后再乐观全部已读——mutation onMutate 与 overlay 共用。 */
export async function prepareOptimisticMarkAllNotificationsRead(
  queryClient: QueryClient,
  organizationId: string | null,
): Promise<{ prevList?: NotificationListCache; prevCount?: number }> {
  const cancelPromise = cancelNotificationQueries(queryClient, organizationId)
  const prev = optimisticMarkAllNotificationsRead(queryClient, organizationId)
  await cancelPromise
  return prev
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function useMarkReadMutation(organizationId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ notificationId }: { notificationId: string; wasUnread: boolean }) =>
      notificationId.startsWith('local-')
        ? useNotificationStore.getState().markRead(notificationId)
        : NotificationApiService.markRead(notificationId),
    onMutate: ({ notificationId, wasUnread }) =>
      prepareOptimisticMarkNotificationRead(
        queryClient,
        organizationId,
        notificationId,
        wasUnread,
      ),
    onError: (_err, _id, ctx) => {
      if (ctx?.prevList) {
        queryClient.setQueryData(notificationKeys.list(organizationId, 1), ctx.prevList)
      }
      if (ctx?.prevCount !== undefined) {
        queryClient.setQueryData(notificationKeys.unreadCount(organizationId), ctx.prevCount)
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: notificationKeys.unreadCount(organizationId) })
      void queryClient.invalidateQueries({
        predicate: (query) => isCenterQueryForOrganization(query.queryKey, organizationId),
      })
    },
  })
}

export function useMarkAllReadMutation(organizationId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const count = await NotificationApiService.markAllRead(organizationId ?? undefined)
      useNotificationStore.getState().markAllLocalRead()
      return count
    },
    onMutate: () => prepareOptimisticMarkAllNotificationsRead(queryClient, organizationId),
    onError: (_err, _vars, ctx) => {
      if (ctx?.prevList) {
        queryClient.setQueryData(notificationKeys.list(organizationId, 1), ctx.prevList)
      }
      if (ctx?.prevCount !== undefined) {
        queryClient.setQueryData(notificationKeys.unreadCount(organizationId), ctx.prevCount)
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: notificationKeys.all })
    },
  })
}

// ---------------------------------------------------------------------------
// Cache helpers (for WS event stream)
// ---------------------------------------------------------------------------

function readInvitationIdFromItem(item: NotificationItem): string | undefined {
  const metadata = item.metadata as Record<string, unknown> | undefined
  const raw = metadata?.invitation_id ?? metadata?.invitationId
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
}

const AGENT_TASK_TERMINAL_TYPES = new Set([
  'agent.task.completed',
  'agent.task.error',
  'agent.task.interrupted',
  'agent.task.session_interrupted',
])

function readAgentSessionIdFromItem(item: NotificationItem): string | undefined {
  const metadata = item.metadata as Record<string, unknown> | undefined
  const fromMeta = metadata?.session_id ?? metadata?.sessionId
  if (typeof fromMeta === 'string' && fromMeta.trim()) return fromMeta.trim()
  const nav = item.navigate_to as { id?: unknown } | undefined
  if (typeof nav?.id === 'string' && nav.id.trim()) return nav.id.trim()
  return undefined
}

/**
 * 乐观将某 Agent 会话的终态通知标已读。
 * 只动已存在 list 中的 agent.task.* 终态，不动 HITL。
 * Bell 的 unread-count 不依赖这里推导，acknowledge 成功后会另行权威刷新。
 */
export function optimisticMarkAgentSessionTerminalRead(
  queryClient: QueryClient,
  organizationId: string | null,
  sessionId: string,
): number {
  const sid = sessionId.trim()
  if (!sid) return 0

  let marked = 0
  queryClient.setQueryData<NotificationListCache>(
    notificationKeys.list(organizationId, 1),
    (old) => {
      if (!old) return old
      const items = old.items.map((n) => {
        if (n.is_read || !AGENT_TASK_TERMINAL_TYPES.has(n.type)) return n
        if (readAgentSessionIdFromItem(n) !== sid) return n
        marked += 1
        return { ...n, is_read: true, read_at: n.read_at ?? new Date().toISOString() }
      })
      if (marked === 0) return old
      return { ...old, items }
    },
  )
  return marked
}

/**
 * 乐观地将一条新通知插入 react-query 缓存。
 * 同 id 已存在时原地替换（邀请卡被后端升级为 sync/cancelled 时走这条路径，）。
 * 未读计数按「旧卡是否未读 → 新卡是否未读」差分；系统角标由 NotificationBell 从最终展示值统一同步。
 */
export function optimisticAddNotification(
  queryClient: QueryClient,
  organizationId: string | null,
  item: NotificationItem,
) {
  if (isNotificationCenterExcludedType(item.type)) return
  // 普通业务通知按 organization 隔离；邀请、成员加入/移除等账号生命周期事实
  // 属于个人全局消息，即使 organization_id 指向目标组织，也必须进入当前账号收件箱。
  // 其它跨 scope 通知不能插进当前缓存 / 抬当前未读，避免点开后被服务端刷新掉。
  if (!isNotificationVisibleInScope(item, organizationId)) return
  const isCenterItem = resolveNotificationCenterCategory(item) !== null

  let unreadDelta = 0
  const listKey = notificationKeys.list(organizationId, 1)
  const prevList = queryClient.getQueryData<{
    items: NotificationItem[]
    total: number
    page: number
    limit: number
  }>(listKey)

  // 主窗铃铛常只有 unread-count 查询、无 list 缓存（list 在 overlay）。
  // 无 list 时仍须抬未读，否则图标角标不亮、面板里却有红点。
  if (!prevList) {
    if (isCenterItem && !item.is_read) {
      queryClient.setQueryData<number>(
        notificationKeys.unreadCount(organizationId),
        (old) => Math.max(0, (old ?? 0) + 1),
      )
    }
    return
  }

  queryClient.setQueryData<{ items: NotificationItem[]; total: number; page: number; limit: number }>(
    listKey,
    (old) => {
      if (!old) return old
      const existingIdx = old.items.findIndex((n) => n.id === item.id)
      if (existingIdx >= 0) {
        const prev = old.items[existingIdx]
        const previousCenterUnread = !prev.is_read
          && resolveNotificationCenterCategory(prev) !== null
        unreadDelta = (previousCenterUnread ? -1 : 0) + (isCenterItem && !item.is_read ? 1 : 0)
        const rest = old.items.filter((_, idx) => idx !== existingIdx)
        return {
          ...old,
          items: [item, ...rest],
        }
      }
      unreadDelta = isCenterItem && !item.is_read ? 1 : 0
      return {
        ...old,
        items: [item, ...old.items],
        total: old.total + 1,
      }
    },
  )
  if (unreadDelta !== 0) {
    queryClient.setQueryData<number>(
      notificationKeys.unreadCount(organizationId),
      (old) => Math.max(0, (old ?? 0) + unreadDelta),
    )
  }
}

/**
 * 从缓存移除仍挂着「查看邀请」的旧 organization.invitation 卡（按 invitation_id）。
 * 用于后端删旧建新、或历史脏数据与 sync 并存时的前端兜底。
 */
export function optimisticRemoveInvitationNotifications(
  queryClient: QueryClient,
  organizationId: string | null,
  invitationId: string | undefined,
) {
  if (!invitationId) return

  let removedUnread = 0
  queryClient.setQueryData<{ items: NotificationItem[]; total: number; page: number; limit: number }>(
    notificationKeys.list(organizationId, 1),
    (old) => {
      if (!old) return old
      const kept: NotificationItem[] = []
      for (const n of old.items) {
        if (
          n.type === 'organization.invitation'
          && readInvitationIdFromItem(n) === invitationId
        ) {
          if (!n.is_read) removedUnread += 1
          continue
        }
        kept.push(n)
      }
      if (kept.length === old.items.length) return old
      return {
        ...old,
        items: kept,
        total: Math.max(0, old.total - (old.items.length - kept.length)),
      }
    },
  )
  if (removedUnread > 0) {
    queryClient.setQueryData<number>(
      notificationKeys.unreadCount(organizationId),
      (old) => Math.max(0, (old ?? 0) - removedUnread),
    )
  }
}

export function invalidateNotifications(
  queryClient: QueryClient,
) {
  void queryClient.invalidateQueries({ queryKey: notificationKeys.all })
}
