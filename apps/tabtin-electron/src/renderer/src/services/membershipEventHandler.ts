/**
 * Wave 3: `organization.membership_changed` 事件处理器
 *
 * Wave 1 在服务端新增了 60s 周期 membership 同步 + 主动推送事件，payload 形如：
 *   { added: string[], removed: string[], all_ids: string[], primary_id: string|null,
 *     pruned_topics_count: number, reason?: 'removed_from_all_organizations' | ... }
 *
 * 本 handler 的职责：
 *   1. 刷新 organization 列表（与推送字段做一致性兜底）；
 *   2. 被移出的 organization：清理所属缓存（spaces / agents / background 事件桶 /
 *      chat store 的 per-space 条目）；
 *   3. 当前前台 organization 被移出：toast 提示「你已被移出 XX」→ 自动切到 primary / fallback；
 *   4. 被移出所有 organization：toast 提示 + 触发登出流程。
 *
 * 设计约束：
 *   - 事件到达时 `WsGatewayClient.applyMembershipChange` 已经把
 *     `authContext.organizationIds` / primary 更新为新值（Wave 2 R2-03 修复），
 *     所以此 handler 只需要做**前端 UI 层面的状态同步**。
 *   - 不触发 `resetChatClient`：Wave 3 目标就是 membership 变更不断 WS。
 */

import { useOrganizationStore, useSpaceStore, getRuntime, type Organization } from '@tabtin/app-shell'
import { useIMStore } from '@/stores/useIMStore'
import { useChatStore } from '@/stores/chat/useChatStore'
import { useBackgroundEventStore } from '@/stores/useBackgroundEventStore'
import { useAuthStore } from '@/stores/useAuthStore'
import { notifyLogoutRequired } from '@/utils/authPersistence'
import { toast } from '@tabtin/smartsheet-ui/toast'
import i18n from '@/i18n'
import { logger } from '@/utils/logger'
import { useWsConnectionStore } from '@/stores/useWsConnectionStore'
import { isOrganizationPermissionMessage } from './organizationAccessErrors'
import { useOrganizationMembershipNoticeStore } from '@/stores/useOrganizationMembershipNoticeStore'
import { invalidateLocalWorkspaceBootstrapForOrganization } from '@components/sidebar/ensureLocalWorkspace'

export { isOrganizationPermissionMessage }

interface MembershipChangedPayload {
  added?: unknown
  removed?: unknown
  all_ids?: unknown
  primary_id?: unknown
  pruned_topics_count?: unknown
  reason?: unknown
}

function sanitizeIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0) result.push(item)
  }
  return result
}

function resolveOrganizationName(organizationId: string): string {
  const wt = useOrganizationStore.getState().organizations.find((w) => w.id === organizationId)
  return wt?.name ?? i18n.t('organization:unnamed', { defaultValue: '组织' })
}

function showOrganizationMembershipNotice(
  id: string,
  kind: 'removed' | 'access_denied' | 'removed_all',
  title: string,
  description: string,
): void {
  useOrganizationMembershipNoticeStore.getState().showNotice({
    id,
    kind,
    title,
    description,
  })
}

/**
 * 清除被移出 organization 的所有缓存：
 *   - useSpaceStore: spaces / agentCache / selectedSpace（若命中被移出）；
 *   - useChatStore: `purgeOrganizationSpaces` 负责 sessions / messages / streaming /
 *     HITL / LRU accessOrder 的一致性清理（见 store 定义的注释）；
 *   - useIMStore: 按 organization_id 过滤的 conversations；
 *   - useBackgroundEventStore: 对应 organization 的事件桶。
 *
 * 每个 store 的写入用 try/catch 独立保护，一个失败不会阻塞其他 store 的清理。
 */
function purgeRemovedOrganizationCaches(organizationId: string): void {
  const safely = (label: string, fn: () => void) => {
    try {
      fn()
    } catch (err) {
      logger.warn(`[Membership] purge ${label} failed`, { organizationId, err })
    }
  }

  // 1) Space store：spaces / agents / selected
  //
  // Wave 3.2 复核加固：先把每个被剔除的 spaceId **同步**走一遍 bridge.onSpaceDeleted，
  // 再 setState 减少 spaces 列表。原因——`onSpaceDeleted` 入口会同步调
  // `useWorkbenchSceneStore.removeFromHot(sceneId)` + 触发 dirty 兜底 / tab clean /
  // crawlspace purge。如果只走 setState 直接 silent removal，会重现 onSpaceDeleted
  // dirty 异步路径同形漏洞：SpaceWorkbenchHost 立即不再渲染该 Space → useRunManager
  // cleanup 跑 → workspaceRunGuard 双条件 hot=true、config=true（purge 还没跑）→ 错
  // 误保活 → Run 永久泄漏。被移出团队的"幽灵 Run"比删 Space 路径更隐蔽（没有 UI 入
  // 口可见，用户不知道有 Run 还在跑）。
  let removedSpaceIds: string[] = []
  safely('spaces', () => {
    removedSpaceIds = useSpaceStore.getState()
      .spaces.filter((s) => s.organization_id === organizationId)
      .map((s) => s.id)
    if (removedSpaceIds.length === 0) return

    // 先走每个 spaceId 的标准退出链路（hot 剔除 + dirty save + tab clean + cs purge）
    const bridge = getRuntime().bridge
    for (const spaceId of removedSpaceIds) {
      try {
        bridge.onSpaceDeleted?.(spaceId)
      } catch (err) {
        logger.warn('[Membership] onSpaceDeleted hook 失败（继续清理 store）', {
          organizationId,
          spaceId,
          err,
        })
      }
    }

    // 再走 setState 减少 spaces 列表（onSpaceDeleted 不管 spaces 列表本身，由
    // use-space-store 自己维护——所以这里仍要剔除 + 顺手清 agentCache 与 selected）
    useSpaceStore.setState((prev) => {
      const filteredSpaces = prev.spaces.filter((s) => s.organization_id !== organizationId)
      if (filteredSpaces.length === prev.spaces.length) return prev
      const removedSet = new Set(removedSpaceIds)
      const filteredAgentCache = { ...prev.agentCache }
      for (const space of prev.spaces) {
        if (removedSet.has(space.id) && space.agent_id) {
          delete filteredAgentCache[space.agent_id]
        }
      }
      const nextSelectedSpace =
        prev.selectedSpace && removedSet.has(prev.selectedSpace.id)
          ? null
          : prev.selectedSpace
      return {
        spaces: filteredSpaces,
        agentCache: filteredAgentCache,
        selectedSpace: nextSelectedSpace,
        selectedAgent:
          nextSelectedSpace === null ? null : prev.selectedAgent,
      }
    })
  })

  // 2) chat store：走 store 自带的 purgeOrganizationSpaces，保证 LRU accessOrder
  //    与缓存快照一致，不会残留僵尸 spaceId 污染 MAX_CACHED_AGENT_SPACES 配额
  safely('chat', () => {
    useChatStore.getState().purgeOrganizationSpaces(organizationId, removedSpaceIds)
  })

  // 3) IM conversations：按 organization_id 剔除
  safely('im', () => {
    useIMStore.setState((prev) => {
      const filtered = prev.conversations.filter((c) => c.organization_id !== organizationId)
      if (filtered.length === prev.conversations.length) return prev
      return { conversations: filtered }
    })
  })

  // 4) 背景事件桶
  safely('backgroundEvents', () => {
    useBackgroundEventStore.getState().clearOrganization(organizationId)
  })
}

/**
 * 从给定候选列表里挑一个 fallback organization。
 *
 * 优先级：`primaryIdHint` > personal 团队 > `is_default` > 第一个可用
 *
 * - `removedSet` 里的 organization 一定被剔除（避免选到本次事件里刚被移出的团队）
 * - `allIdSet` 非空时作为白名单过滤（服务端 SSOT），避免选到本地已过期的团队
 */
function pickFallbackOrganization(
  organizations: readonly Organization[],
  removedSet: ReadonlySet<string>,
  allIdSet: ReadonlySet<string>,
  primaryIdHint: string | null,
): Organization | null {
  const candidates = organizations.filter((w) => {
    if (removedSet.has(w.id)) return false
    if (allIdSet.size > 0 && !allIdSet.has(w.id)) return false
    return true
  })

  return (
    (primaryIdHint ? candidates.find((w) => w.id === primaryIdHint) : undefined) ??
    candidates.find((w) => w.type === 'personal') ??
    candidates.find((w) => w.is_default) ??
    candidates[0] ??
    null
  )
}

/**
 * 当前前台 organization 被移出时：把用户切到 primary / fallback。
 * 若没有任何可切的 organization（all_ids 为空）则交给调用方触发登出流程。
 *
 * 修复要点（产品 Review #4/#5）：
 * 1. **先 await loadOrganizations() 再选 fallback**：服务端可能把用户从 A 移到 B（B 本地未加载），
 *    陈旧列表挑不到 target 会让用户卡在已被移出的 A。loadOrganizations 完成后再从新列表里挑。
 * 2. **先切 organization 后清缓存**：在 selectOrganization(target) 成功后再 purge 被移出 organization 的
 *    local cache，避免"切换瞬间空白态"。
 * 3. **selectOrganization 失败给兼底 toast + 重试按钮**：失败时给用户 retry 路径（不再静默吞错）。
 *
 * 接收 `removedIds` 整个数组（而非单个 removedId），避免一次事件里移出多个
 * organization 时 fallback 选到另一个同样被移出的 team（连续切换两次的糟糕体验）。
 */
async function switchAwayFromRemovedForegroundOrganization(
  removedIds: readonly string[],
  allIds: readonly string[],
  primaryIdHint: string | null,
  foregroundRemovedId: string,
  removedIdsForDeferredPurge: readonly string[],
  toastMode: 'removed' | 'access_denied' = 'removed',
): Promise<boolean> {
  const removedSet = new Set(removedIds)
  const allIdSet = new Set(allIds)
  const removedName = resolveOrganizationName(foregroundRemovedId)

  // 先等 loadOrganizations 把最新列表拉下来，再挑 fallback：避免"fallback 基于陈旧列表"竞态。
  try {
    await useOrganizationStore.getState().loadOrganizations()
  } catch (err) {
    logger.warn('[Membership] loadOrganizations refresh failed, will fall back to cached list', err)
  }

  const organizations = useOrganizationStore.getState().organizations
  const target = pickFallbackOrganization(organizations, removedSet, allIdSet, primaryIdHint)

  if (!target) {
    logger.warn('[Membership] no fallback organization after removal', {
      removed: Array.from(removedSet),
      allIds,
    })
    // 没 fallback 候选但也没 removed_from_all_organizations 语义——异常 payload 防御。
    // 先清被移出的 cache，UI 显示将以 sidebar 刷新后的状态为准。
    for (const rid of removedIdsForDeferredPurge) {
      purgeRemovedOrganizationCaches(rid)
    }
    showOrganizationMembershipNotice(
      `membership-${toastMode}-blocked-${foregroundRemovedId}`,
      toastMode === 'access_denied' ? 'access_denied' : 'removed',
      toastMode === 'access_denied'
        ? i18n.t('organization:membership.accessDeniedTitle', {
            defaultValue: '无法访问「{{name}}」',
            name: removedName,
          })
        : i18n.t('organization:membership.removedTitle', {
            defaultValue: '已被移出「{{name}}」',
            name: removedName,
          }),
      i18n.t('organization:welcome.organizationBlockedDesc', {
        defaultValue: '组织「{{name}}」已不存在或你已无访问权限，请在左侧选择其他组织',
        name: removedName,
      }),
    )
    return false
  }

  const title = toastMode === 'access_denied'
    ? i18n.t('organization:membership.accessDeniedTitle', {
        defaultValue: '无法访问「{{name}}」',
        name: removedName,
      })
    : i18n.t('organization:membership.removedTitle', {
        defaultValue: '已被移出「{{name}}」',
        name: removedName,
      })
  const description = toastMode === 'access_denied'
    ? i18n.t('organization:membership.accessDeniedAutoSwitch', {
        defaultValue: '正在切换到「{{name}}」',
        name: target.name,
      })
    : i18n.t('organization:membership.autoSwitched', {
        defaultValue: '已切换到「{{name}}」，可在左侧手动切换其他组织',
        name: target.name,
      })
  showOrganizationMembershipNotice(
    `membership-${toastMode}-${foregroundRemovedId}`,
    toastMode === 'access_denied' ? 'access_denied' : 'removed',
    title,
    description,
  )
  toast({
    id: `membership-removed-${foregroundRemovedId}`,
    title,
    description,
    duration: 6000,
  })

  try {
    await useOrganizationStore.getState().selectOrganization(target)
    // 切换成功后再清 cache —— 避免 purge 早于切换完成，产生"中间态 UI 空白"
    for (const rid of removedIdsForDeferredPurge) {
      purgeRemovedOrganizationCaches(rid)
    }
    return true
  } catch (err) {
    logger.warn('[Membership] selectOrganization after removal failed', err)
    // 失败兼底：给用户可见的 toast + 重试入口
    toast({
      id: `membership-switch-failed-${target.id}`,
      title: i18n.t('organization:membership.switchFailedTitle', {
        defaultValue: '切换组织失败',
      }),
      description: i18n.t('organization:membership.switchFailedDesc', {
        defaultValue: '无法切换到「{{name}}」，请在左侧手动选择一个组织',
        name: target.name,
      }),
      duration: 10000,
    })
    // 即便切换失败也把被移出 organization 的本地 cache 清掉（服务端已拒绝访问，
    // 继续显示只会让用户更困惑）。
    for (const rid of removedIdsForDeferredPurge) {
      purgeRemovedOrganizationCaches(rid)
    }
    return false
  }
}

/**
 * 被加入新 organization 时的友好提示。
 *
 * 仅在"本次事件带 added"的路径触发；不受 `reason` 字段控制。避免用户**静默地**
 * 在 sidebar 多出一个团队却没有任何反馈（见用户 Review Y-14）。
 *
 * 但用户**自己创建**的团队也会被服务端 60s 周期 membership 同步捞到 `added` 里
 * 推过来（DB 集合 diff，后端不区分"自建"还是"被邀请"）。这种场景下"你被邀请加
 * 入了新团队"的文案与事实相反。这里用 organization.owner_id === 当前
 * 用户 id 过滤掉自建团队——自建流程本身已有 `freeTeamCreatedTitle` 等本地反馈覆盖，
 * 不需要重复 toast。
 */
function notifyOrganizationAdded(addedIds: readonly string[]): void {
  const currentUserId = useAuthStore.getState().user?.id
  const organizations = useOrganizationStore.getState().organizations

  for (const addedId of addedIds) {
    const wt = organizations.find((w) => w.id === addedId)
    if (!wt) {
      logger.warn('[Membership] skip added toast because organization metadata is unavailable', {
        addedId,
      })
      continue
    }
    const isSelfOwned =
      !!currentUserId && !!wt.owner_id && String(wt.owner_id) === String(currentUserId)

    if (isSelfOwned) {
      logger.info('[Membership] skip "invited" toast for self-created organization', {
        addedId,
        ownerId: wt.owner_id,
        currentUserId,
      })
      continue
    }

    logger.info('[Membership] added to organization', { addedId })
    // loadOrganizations 完成后再取 name 会更准；先丢 toast 里显示 id 兜底，
    // name lookup 失败时 resolveOrganizationName 会回退到默认文案。
    toast({
      id: `membership-added-${addedId}`,
      title: i18n.t('organization:membership.addedTitle', {
        defaultValue: '你被邀请加入了新组织',
      }),
      description: i18n.t('organization:membership.addedDesc', {
        defaultValue: '现在可以在左侧切换到「{{name}}」',
        name: resolveOrganizationName(addedId),
      }),
      duration: 6000,
    })
  }
}

export function handleMembershipChangedEnvelope(payload: unknown): void {
  try {
    if (!payload || typeof payload !== 'object') return
    const p = payload as MembershipChangedPayload

    const added = sanitizeIdList(p.added)
    const removed = sanitizeIdList(p.removed)
    const allIds = sanitizeIdList(p.all_ids)
    const primaryId = typeof p.primary_id === 'string' ? p.primary_id : null
    const reason = typeof p.reason === 'string' ? p.reason : null

    logger.info('[Membership] organization.membership_changed', {
      added,
      removed,
      all_ids: allIds,
      primary_id: primaryId,
      reason,
    })

    for (const removedId of removed) {
      invalidateLocalWorkspaceBootstrapForOrganization(removedId)
    }

    if (reason === 'removed_from_all_organizations' || allIds.length === 0) {
      const title = i18n.t('organization:membership.removedFromAllTitle', {
        defaultValue: '你已被移出所有组织',
      })
      const description = i18n.t('organization:membership.removedFromAllDesc', {
        defaultValue: '账号已没有活跃组织，应用即将登出',
      })
      showOrganizationMembershipNotice(
        'membership-removed-all',
        'removed_all',
        title,
        description,
      )
      toast({
        id: 'membership-removed-all',
        title,
        description,
        duration: 8000,
      })
      // Y-7 修复：给 toast 留 ~4s 展示窗口再触发 logout，让用户看清原因
      // （toast 8s vs logout 4s：用户至少有 4s 读完 title/desc）。
      // 保守估计：4s 够 2 个中等长度的句子阅读（见 Jakob Nielsen "average reading speed"）。
      setTimeout(() => {
        try {
          notifyLogoutRequired('organization_removed_from_all')
        } catch (err) {
          logger.error('[Membership] notifyLogoutRequired failed', err)
        }
      }, 4000)
      return
    }

    // 非前台被移出：立即 purge（只是清 cache，UI 不受影响）
    // 当前前台被移出：purge 要推迟到 selectOrganization 成功后，避免空白态（产品 Review #5）
    const currentForegroundId = useOrganizationStore.getState().selectedOrganization?.id ?? null
    const needSwitch = !!currentForegroundId && removed.includes(currentForegroundId)

    for (const removedId of removed) {
      if (needSwitch && removedId === currentForegroundId) continue
      purgeRemovedOrganizationCaches(removedId)
    }

    let organizationRefresh: Promise<unknown> | null = null

    if (needSwitch && currentForegroundId) {
      // 切换路径会 await loadOrganizations + selectOrganization，然后延迟 purge 当前前台
      void switchAwayFromRemovedForegroundOrganization(
        removed,
        allIds,
        primaryId,
        currentForegroundId,
        [currentForegroundId],
      ).then((switched) => {
        const nextOrganization = useOrganizationStore.getState().selectedOrganization
        if (switched && nextOrganization?.id && nextOrganization.id !== currentForegroundId) return
        useWsConnectionStore.getState().setOrganizationAccessBlocked(
          currentForegroundId,
          resolveOrganizationName(currentForegroundId),
        )
      })
    } else {
      // 无需切换：直接异步刷新列表即可
      organizationRefresh = useOrganizationStore
        .getState()
        .loadOrganizations()
        .catch((err) => {
          logger.warn('[Membership] loadOrganizations refresh failed', err)
        })
    }

    // 先等组织资料刷新，再根据 owner_id 区分“自建”与“被邀请”。
    // 事件先于列表到达时，不能把“资料未知”误判成“被邀请”。
    if (added.length > 0) {
      const refreshBeforeNotify =
        organizationRefresh
        ?? useOrganizationStore
          .getState()
          .loadOrganizations()
          .catch((err) => {
            logger.warn('[Membership] loadOrganizations refresh before added notice failed', err)
          })
      void refreshBeforeNotify.then(() => notifyOrganizationAdded(added))
    }
  } catch (err) {
    logger.error('[Membership] handler unexpected error', err)
  }
}

let organizationRecoveryInFlight: Promise<boolean> | null = null

/**
 * 当前 organization 已无 viewer 权限（WS auth / 设备注册 / 持久化恢复）时，
 * 刷新组织列表并自动切到可用 organization，避免 Gateway 无限重连 + 工作空间卡加载。
 */
export async function recoverFromInvalidOrganizationAccess(
  invalidOrganizationId: string,
): Promise<boolean> {
  const state = useOrganizationStore.getState()
  const activeOrganizationId =
    state.selectedOrganization?.id
    ?? state.lastOpenedOrganizationId
  if (activeOrganizationId && activeOrganizationId !== invalidOrganizationId) {
    return false
  }
  if (organizationRecoveryInFlight) {
    return organizationRecoveryInFlight
  }

  organizationRecoveryInFlight = (async () => {
    const wsStore = useWsConnectionStore.getState()
    wsStore.setOrganizationAccessRecoveryInFlight(true)
    try {
      const switched = await switchAwayFromRemovedForegroundOrganization(
        [invalidOrganizationId],
        [],
        null,
        invalidOrganizationId,
        [invalidOrganizationId],
        'access_denied',
      )

      const nextOrganization = useOrganizationStore.getState().selectedOrganization
      if (!switched || !nextOrganization?.id || nextOrganization.id === invalidOrganizationId) {
        wsStore.setOrganizationAccessBlocked(
          invalidOrganizationId,
          resolveOrganizationName(invalidOrganizationId),
        )
        return false
      }

      wsStore.clearOrganizationAccessState()
      try {
        const { getChatClient } = await import('@/services/chatApi')
        const gateway = getChatClient().getGateway()
        const forceReconnect = (gateway as { forceReconnect?: () => Promise<boolean> }).forceReconnect
        if (forceReconnect) {
          await forceReconnect()
        } else {
          gateway.close()
          await gateway.connect()
        }
      } catch (err) {
        logger.warn('[Membership] gateway reconnect after organization recovery failed', err)
      }
      return true
    } finally {
      useWsConnectionStore.getState().setOrganizationAccessRecoveryInFlight(false)
      organizationRecoveryInFlight = null
    }
  })()

  return organizationRecoveryInFlight
}
