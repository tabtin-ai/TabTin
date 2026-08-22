/**
 * useResourceShareDowngrade — F6 实时降级响应(PRD §五块 2.3 末段)
 *
 * 编辑器壳层订阅 NotificationStore,当出现 ``type='resource_shared'`` 且
 * ``metadata.resource_id === <当前资源 id>`` 时,根据 ``metadata.action`` 计算降级状态。
 *
 * 调用方需注入 ``notifications`` 数组(各端 useNotificationStore 持有的 selector),
 * 避免 share-dialog 包反向依赖 Electron/Web 的 store 实现。
 *
 * **性能**:编辑器 mount 时每次 store.notifications 数组引用变化都会重算 — zustand
 * 默认浅比较已让 ``addNotification`` 等更新时只触发一次,re-render 风险低。
 * 调用方若担心性能,可用 ``selectResourceShareNotifications`` selector 减少订阅面。
 *
 * **判定口径**：同一资源只认时间最新一条 ``resource_shared`` 的 action。
 * 旧逻辑「列表里存在过 removed 就永久遮罩」会挡住 IM DM 重授权后的 invited。
 */
import { useMemo } from 'react'
import type { ResourceType } from '../types'

/**
 * Zustand selector:从全量 notifications 提取当前资源命中的子集。
 * 减少订阅面:仅当本资源相关通知变化时编辑器才重渲染。
 *
 * 用法:
 * ```ts
 * const matched = useNotificationStore((s) => selectResourceShareNotifications(s.notifications, 'doc', docId))
 * useResourceShareDowngrade('doc', docId, matched)
 * ```
 *
 * 注:Zustand 默认浅比较数组,所以返回新数组在元素相同时仍可能触发重渲染。
 * 如需进一步优化,可用 zustand/shallow + useShallow,或在调用侧用 useMemo 缓存。
 */
export function selectResourceShareNotifications<
  N extends { type: string; metadata?: Record<string, unknown> | null },
>(
  notifications: readonly N[],
  resourceType: ResourceType,
  resourceId: string | null | undefined,
): readonly N[] {
  if (!resourceId) return []
  return notifications.filter((n) => {
    if (n.type !== 'resource_shared') return false
    const md = (n.metadata ?? {}) as Record<string, unknown>
    return md.resource_type === resourceType && md.resource_id === resourceId
  })
}

export type DowngradeAction = 'removed' | 'auto_removed' | 'permission_changed'

/**
 * 单条 resource_shared 通知的最小消费形态 — 不绑特定 store 的 NotificationItem 类型,
 * 让 Electron / Web / 未来移动端可对齐传入。
 */
export interface ResourceShareNotificationLike {
  id: string
  type: string
  is_read?: boolean
  metadata?: Record<string, unknown> | null
  created_at: string
}

export interface ResourceShareDowngradeState {
  /** 是否被移除(removed / auto_removed) — 编辑器应显示遮罩 */
  isRemoved: boolean
  /** 移除场景下的 action,展现遮罩文案用 */
  removalAction: 'removed' | 'auto_removed' | null
  /** permission_changed 时携带的最新权限(viewer/editor/admin)— 编辑器可据此设 readonly */
  changedPermission: string | null
  /** permission_from 字段,展示用 */
  changedFromPermission: string | null
  /** 触发的通知 id — 用于 Bell 标记已读或导航等下游消费 */
  sourceNotificationId: string | null
  /** 触发通知的 created_at（ISO）— 供「实时权限兜底」与陈旧 role 对比 */
  sourceCreatedAt: string | null
  /** 触发时的资源标题(后端 metadata.resource_title)— 遮罩展示用 */
  resourceTitle: string | null
}

const EMPTY: ResourceShareDowngradeState = {
  isRemoved: false,
  removalAction: null,
  changedPermission: null,
  changedFromPermission: null,
  sourceNotificationId: null,
  sourceCreatedAt: null,
  resourceTitle: null,
}

/**
 * 纯函数：给定当前资源标识 + 通知列表,计算"最新"应触发的降级状态。
 *
 * - 已读不影响判定（用户已点过通知仍要看到降级）
 * - **只认时间最新一条**命中通知的 action
 * - 最新为 invited → 不遮罩（重授权/IM 补权后应可打开）
 */
export function resolveResourceShareDowngrade(
  resourceType: ResourceType,
  resourceId: string | null | undefined,
  notifications: readonly ResourceShareNotificationLike[],
): ResourceShareDowngradeState {
  if (!resourceId) return EMPTY

  const matched = notifications
    .filter((n) => {
      if (n.type !== 'resource_shared') return false
      const md = (n.metadata ?? {}) as Record<string, unknown>
      return md.resource_type === resourceType && md.resource_id === resourceId
    })
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

  if (matched.length === 0) return EMPTY

  const latest = matched[0]
  const md = (latest.metadata ?? {}) as Record<string, unknown>
  const action = md.action
  const resourceTitle = typeof md.resource_title === 'string' ? md.resource_title : null

  if (action === 'removed' || action === 'auto_removed') {
    return {
      isRemoved: true,
      removalAction: action,
      changedPermission: null,
      changedFromPermission: null,
      sourceNotificationId: latest.id,
      sourceCreatedAt: latest.created_at,
      resourceTitle,
    }
  }

  if (action === 'permission_changed') {
    return {
      isRemoved: false,
      removalAction: null,
      changedPermission: typeof md.permission_to === 'string' ? md.permission_to : null,
      changedFromPermission: typeof md.permission_from === 'string' ? md.permission_from : null,
      sourceNotificationId: latest.id,
      sourceCreatedAt: latest.created_at,
      resourceTitle,
    }
  }

  // invited 或其他 action：不遮罩、不降级
  return EMPTY
}

/**
 * 给定当前资源标识 + 通知列表,计算"最新"应触发的降级状态。
 *
 * @param resourceType 'doc' | 'table'
 * @param resourceId 当前打开的资源 id
 * @param notifications 当前 store 中的通知列表(已按 organization scope 过滤)
 * @returns 降级状态;无命中时返回 EMPTY
 */
export function useResourceShareDowngrade(
  resourceType: ResourceType,
  resourceId: string | null | undefined,
  notifications: readonly ResourceShareNotificationLike[],
): ResourceShareDowngradeState {
  return useMemo(
    () => resolveResourceShareDowngrade(resourceType, resourceId, notifications),
    [resourceType, resourceId, notifications],
  )
}

/**
 * 权限词汇 → 数字等级,用于"新权限是否够编辑"判定。
 * 与后端 ROLE_LEVELS 对齐(viewer < editor < admin)。
 */
export const PERMISSION_LEVEL: Record<string, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
}

/**
 * 判断"新权限是否不再支持编辑"。
 * editing 需要 editor+(级别 ≥ 2),否则编辑器应进入只读。
 */
export function isPermissionInsufficientForEditing(permission: string | null | undefined): boolean {
  if (!permission) return false
  const level = PERMISSION_LEVEL[permission]
  return level !== undefined && level < PERMISSION_LEVEL.editor
}

/**
 * 后端已确认当前用户仍有资源级访问（viewer+ / owner）。
 */
export function hasLiveResourceAccess(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'viewer' || role === 'editor' || role === 'admin'
}

/**
 *  遮罩是否展示：
 * - 最新通知不是 removed → 不遮罩
 * - 最新是 removed，但 detail/getTable **在该通知之后**再次确认了 viewer+ → 视为重授权成功，不遮罩
 * - 最新是 removed，且本地 role 来自通知之前的缓存 → 仍遮罩（避免压住实时 F6 撤权）
 */
export function shouldShowRemovedOverlay(params: {
  isRemoved: boolean
  role: string | null | undefined
  removedAt: string | null | undefined
  roleFetchedAtMs: number | null | undefined
}): boolean {
  if (!params.isRemoved) return false
  if (!hasLiveResourceAccess(params.role)) return true
  const removedMs = params.removedAt ? Date.parse(params.removedAt) : NaN
  const fetchedMs = params.roleFetchedAtMs ?? NaN
  if (!Number.isFinite(removedMs) || !Number.isFinite(fetchedMs)) {
    // 缺时间戳时保守：有 live role 仍遮罩，避免误压实时撤权
    return true
  }
  return fetchedMs <= removedMs
}
