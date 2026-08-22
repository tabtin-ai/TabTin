/**
 * 资源 membership 护栏。
 *
 * UnifiedResources 索引滞后时，restore 会把 requireResourceMembership 的 tab
 * 判成 resource_missing，再把 activeKey 打回 apphome:tabdata。
 *
 * - ：打开路径补 pending
 * - ：打开后长时间停留再切/建视图时，`setItemMeta({ viewId })` 会触发 restore 重算；
 *   若 pending 已过期且索引瞬时缺失，同样会被打回首页——故写 meta 时续期 pending 并刷新索引
 *
 * 本模块集中「补/续期 pending + 触发索引刷新」。
 * 刻意不放进 useSpaceContextTabsStore：store ↔ registry / UnifiedResources 有循环依赖。
 */

// 只依赖 registry/instance，避免 import registry/index（会 eager 加载 handlers → 再 import 本模块）
import { contextRegistry } from '../registry/instance'
import {
  getEffectiveScopeForResourceType,
  reloadResourceBucketsForScope,
} from '@components/context-space/resourceScope'
import type { ContextItemMeta } from '@stores/contextTabs/types'
import type { OpenResourceTabParams } from '@stores/useSpaceContextTabsStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'
import { useUnifiedResources } from '@stores/useUnifiedResources'
import { buildResourceTabKey } from '@stores/contextTabs/helpers'
import {
  claimTabDocScope,
  migrateTabKeyToScope,
  tryClaimTabDocScopeSync,
} from '../tabdoc/tabdocScopeClaim'
import {
  isResourceMembershipPending,
  markResourceMembershipPending,
} from './resourceMembershipPending'
import { createLogger } from '@/utils/logger'

const log = createLogger('OpenResourceMembershipGuard')

const REFRESH_DELAY_MS = 300
const pendingRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function typeRequiresResourceMembership(type: string): boolean {
  return Boolean(contextRegistry.getHandler(type as never)?.requireResourceMembership)
}

/** 对 requireResourceMembership 的类型合并 pending；foreignShared / 已有未过期 pending 则原样返回 */
export function ensureMembershipPendingMeta(
  type: string,
  meta?: ContextItemMeta,
  nowMs = Date.now(),
): ContextItemMeta | undefined {
  if (!typeRequiresResourceMembership(type)) return meta
  if (meta?.foreignShared) return meta
  if (isResourceMembershipPending(meta, nowMs)) return meta
  return markResourceMembershipPending(meta, nowMs)
}

/**
 * 用户仍在资源 tab 内操作时强制续期 pending。
 * 与 ensure 不同：即使未过期也会刷新时间戳，避免「打开很久后切视图」撞上 TTL 边界。
 */
export function touchMembershipPendingMeta(
  type: string,
  meta?: ContextItemMeta,
  nowMs = Date.now(),
): ContextItemMeta | undefined {
  if (!typeRequiresResourceMembership(type)) return meta
  if (meta?.foreignShared) return meta
  return markResourceMembershipPending(meta, nowMs)
}

/**
 * 写 tab meta 并续期 membership pending（切视图等会触发 restore 重算的路径）。
 */
export function setItemMetaGuarded(
  tabScopeKey: string,
  tabKey: string,
  type: string,
  metaPatch: ContextItemMeta,
  options?: {
    refreshSpaceId?: string | null
    nowMs?: number
  },
): void {
  const store = useSpaceContextTabsStore.getState()
  const existing = store.itemsBySpace[tabScopeKey]?.[tabKey]
  if (!existing) return

  const merged: ContextItemMeta = {
    ...(existing.meta ?? {}),
    ...metaPatch,
  }
  const nextMeta = touchMembershipPendingMeta(type, merged, options?.nowMs) ?? merged
  store.setItemMeta(tabScopeKey, tabKey, nextMeta)

  const spaceId =
    options?.refreshSpaceId ||
    (typeof nextMeta.spaceId === 'string' ? nextMeta.spaceId : null) ||
    useUnifiedResources.getState().currentSpaceId
  if (spaceId) {
    scheduleResourceMembershipRefresh(spaceId, type)
  }
}

export function scheduleResourceMembershipRefresh(spaceId: string, resourceType: string): void {
  if (!spaceId || !typeRequiresResourceMembership(resourceType)) return
  const requestedScope = useSpaceViewPrefsStore.getState().getPrefs(spaceId).resourceScope
  const effectiveScope = getEffectiveScopeForResourceType(requestedScope, resourceType)
  const debounceKey = `${spaceId}:${resourceType}:${effectiveScope}`
  const existing = pendingRefreshTimers.get(debounceKey)
  if (existing) clearTimeout(existing)
  pendingRefreshTimers.set(
    debounceKey,
    setTimeout(() => {
      pendingRefreshTimers.delete(debounceKey)
      if (useUnifiedResources.getState().currentSpaceId !== spaceId) return
      void reloadResourceBucketsForScope(
        useUnifiedResources.getState().load,
        spaceId,
        effectiveScope,
      )
    }, REFRESH_DELAY_MS),
  )
}

export type OpenResourceTabGuardedOptions = {
  /**
   * Agent silent / registerOnly 等路径：不抢前台、不做双桶 migrate。
   * 用户打开意图默认做 dirty-aware claim。
   */
  skipScopeClaim?: boolean
}

function commitOpenResourceTabGuarded(
  tabScopeKey: string,
  params: OpenResourceTabParams,
  refreshSpaceId?: string | null,
): void {
  const meta = ensureMembershipPendingMeta(params.type, params.meta)
  useSpaceContextTabsStore.getState().openResourceTab(tabScopeKey, {
    ...params,
    meta,
  })
  const spaceId = refreshSpaceId || (typeof meta?.spaceId === 'string' ? meta.spaceId : null)
  if (spaceId) {
    scheduleResourceMembershipRefresh(spaceId, params.type)
  }
}

export function openResourceTabGuarded(
  tabScopeKey: string,
  params: OpenResourceTabParams,
  refreshSpaceId?: string | null,
  options?: OpenResourceTabGuardedOptions,
): void {
  const shouldClaimTabDoc =
    params.type === 'tabdoc'
    && !params.silent
    && !options?.skipScopeClaim
    && Boolean(params.id)

  if (shouldClaimTabDoc) {
    const tabKey = buildResourceTabKey('tabdoc', params.id)
    const sync = tryClaimTabDocScopeSync(tabKey, tabScopeKey)
    if (sync === 'needs-confirm') {
      void claimTabDocScope(tabKey, tabScopeKey, { displayName: params.title }).then((result) => {
        if (result === 'cancelled') return
        commitOpenResourceTabGuarded(tabScopeKey, params, refreshSpaceId)
      })
      return
    }
  }

  commitOpenResourceTabGuarded(tabScopeKey, params, refreshSpaceId)
}

export function openTableTabGuarded(
  tabScopeKey: string,
  tableId: string,
  options?: {
    activate?: boolean
    meta?: ContextItemMeta
    refreshSpaceId?: string | null
    /** 写入 tab title，避免「当前打开」等 UI 回退成 UUID */
    title?: string
    /**
     * Agent silent / registerOnly：不做跨桶 migrate。
     * 用户打开意图默认收口到单 scope，避免 cloud-docs + conversation 双写后 self-healing 顶掉任务标签。
     */
    skipScopeClaim?: boolean
  },
): void {
  const meta = ensureMembershipPendingMeta('tabdata', options?.meta)
  // ：与 tabdoc claim 对称——工作台/任务打开表格前先关掉其它桶的同 tabKey
  if (tableId && !options?.skipScopeClaim) {
    const tabKey = buildResourceTabKey('tabdata', tableId)
    const closedScopes = migrateTabKeyToScope(tabKey, tabScopeKey)
    if (closedScopes.length > 0) {
      log.info('migrated tabdata tab to single scope', {
        tabKey,
        targetScope: tabScopeKey,
        closedScopes,
      })
    }
  }
  useSpaceContextTabsStore.getState().openTableTab(
    tabScopeKey,
    tableId,
    options?.activate !== false,
    meta,
    options?.title,
  )
  const spaceId =
    options?.refreshSpaceId || (typeof meta?.spaceId === 'string' ? meta.spaceId : null)
  if (spaceId) {
    scheduleResourceMembershipRefresh(spaceId, 'tabdata')
  }
}
