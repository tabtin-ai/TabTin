/**
 * useCloseHandlers — 聚合所有「关闭标签」相关 handler
 *
 * ⭐ 契约：handler.onClose 只负责清理自己的资源，**不得**修改 activeKey / tabOrder。
 *   - 第一道防线：`ContextRegistry.dispatchClose` 在 dev/test 环境对违约 throw（让 CI 挂）
 *   - 第二道防线（本 hook）：activeKey 的 fallback 统一由本 hook 计算，对运行期偏移做防御性纠正
 *
 * activeKey fallback 优先级：
 *   1. 优先选 canvas group 内的 survivor pane
 *   2. 其次选 visible 邻居
 *   3. 再次从完整 tabOrder 中找可见 tab
 *   4. 都没有则 null（回到 home）
 *
 * 时序（关闭活动 tab 时）：
 *   beforeClose → 计算 plannedFallback → dispatchClose（资源销毁 + 守卫）
 *   → 纠正 activeKey 到 plannedFallback（防御性覆盖 handler 的意外改动）
 *   → closeCanvasPane → 按 dispatchClose.needsClose 决定是否 closeTab
 */
import { useCallback } from 'react'
import { useCanvasLayoutStore } from '@stores/useCanvasLayoutStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { useDiscardedViewStore } from '@hooks/useTabDiscardListener'
import { contextRegistry } from '../registry'
import type { ContextItem, ContextTabKey } from '../registry/types'
import type { ContainerContext } from '../registry/types'
import { EMPTY_CANVAS_GROUPS, findGroupForTabKey } from '../utils/canvasLayout'
import { computeFallbackTabKey as computeFallbackTabKeyPure } from '../utils/activeKeyFallback'
import type { CanvasLayoutGroup } from '@stores/useCanvasLayoutStore'
import { computeSlotsFromTabOrder, collectTabKeysFromSlots } from '../utils/slotSequence'

interface UseCloseHandlersParams {
  spaceId: string
  tabScopeKey?: string
  containerCtx: ContainerContext
  /** tab 条上可见的 tab key 列表（与 useTabSync 返回的 visibleTabKeys 对齐） */
  visibleTabKeys: readonly ContextTabKey[]
  /** 全量 tab key 列表（含 group 内 tabs），用于 group 版 close 的 slot 序列计算 */
  currentTabKeys: readonly ContextTabKey[]
  /** 属于任意 canvas group 的 tab key 集合 */
  groupedTabKeys: ReadonlySet<string>
  /** 当前 space 的 canvas groups */
  canvasGroups: readonly CanvasLayoutGroup[]
  contextItemByTabKey: Map<string, ContextItem>
  setActiveKey: (spaceId: string, tabKey: string | null) => void
  handleSelectItem: (item: ContextItem) => void
}

export function useCloseHandlers({
  spaceId,
  tabScopeKey,
  containerCtx,
  visibleTabKeys,
  currentTabKeys,
  groupedTabKeys,
  canvasGroups,
  contextItemByTabKey,
  setActiveKey,
  handleSelectItem,
}: UseCloseHandlersParams) {
  const storageKey = tabScopeKey ?? spaceId
  const closePane = useCanvasLayoutStore(state => state.closePane)

  /**
   * 为即将关闭的 item 计算合理的 activeKey fallback。
   * 实现在 utils/activeKeyFallback.ts 里的纯函数，tool 侧也复用同一函数保证体验一致。
   * 调用方负责判断"是否正在关闭活动 tab"以决定是否使用该值。
   */
  const computeFallbackTabKey = useCallback((item: ContextItem): string | null => {
    const freshGroups = useCanvasLayoutStore.getState().spaceGroups[storageKey] ?? EMPTY_CANVAS_GROUPS
    const tabOrder = useSpaceContextTabsStore.getState().tabOrderBySpace[storageKey] ?? []
    return computeFallbackTabKeyPure({
      closingTabKey: item.tabKey,
      visibleTabKeys,
      tabOrder,
      spaceGroups: freshGroups,
    })
  }, [spaceId, storageKey, visibleTabKeys])

  /**
   * 若 item 位于某个 canvas group 内，把它对应的 pane 销毁。
   *
   * W4 D-W4-7：已删除 survivor reorder 整段。理由：
   * - W4 后 closePane 在仍有内容 pane 时保留 group，survivor 留在 group 内自然有位置
   * - 只剩空 pane 时销毁 group，不存在需要重排的 survivor
   * - 之前的 reorder 是为"group 销毁后 survivor 跳到 tab 末尾"补的补丁；有 survivor 时现在不销毁 group
   * - 0-pane 销毁场景通常无 survivor，reorder 无意义
   *
   * 本函数只操作 canvas layout，**不**改 activeKey（由上层统一管理）。
   */
  const closeCanvasPane = useCallback((item: ContextItem) => {
    const freshGroups = useCanvasLayoutStore.getState().spaceGroups[storageKey] ?? EMPTY_CANVAS_GROUPS
    const group = findGroupForTabKey(freshGroups, item.tabKey)
    if (!group) return
    const pane = group.panes.find(p => p.content?.tabKey === item.tabKey)
    if (!pane) return

    closePane(storageKey, group.id, pane.id)
  }, [closePane, spaceId, storageKey])

  const handleCloseItem = useCallback((item: ContextItem) => {
    // 走 registry 统一判断：handler.closable === false 或函数返回 false 的 item 永远不可关闭
    // （PRD §10 Agent 起始页 = apphome:orchestration 走这条）
    if (!contextRegistry.isClosable(item)) return
    void (async () => {
      try {
        const allowed = await contextRegistry.dispatchBeforeClose(item, containerCtx)
        if (!allowed) return

        if (item.meta?.discarded) {
          const parsed = contextRegistry.parseTabKey(item.tabKey)
          if (parsed) useDiscardedViewStore.getState().clearDiscarded(parsed.id)
        }

        // 提前固定 fallback：dispatchClose 期间资源异步销毁可能触发多次 store 更新，
        // 在这里一锁定就能保证最终 activeKey 的目标与用户点"关闭"时所见的 UI 上下文一致。
        const initialActive = useSpaceContextTabsStore.getState().activeKeyBySpace[storageKey] ?? null
        const isClosingActive = initialActive === item.tabKey
        const plannedFallback = isClosingActive ? computeFallbackTabKey(item) : null

        // dispatchClose 内置契约守卫（dev/test throw、prod warn）。
        // 返回 needsClose 取代了旧版的 `!handled || freshTabOrder?.includes(...)` 兜底判断。
        const dispatchResult = await contextRegistry.dispatchClose(item, containerCtx)

        // 第二道防线：即使守卫降级（prod）或异步副作用偏离 plannedFallback，拉回。
        if (isClosingActive) {
          const postActive = useSpaceContextTabsStore.getState().activeKeyBySpace[storageKey] ?? null
          if (postActive !== plannedFallback) {
            setActiveKey(storageKey, plannedFallback)
          }
        }

        closeCanvasPane(item)

        if (dispatchResult.needsClose) {
          const tabs = useSpaceContextTabsStore.getState()
          // 兼容旧测试 / 嵌入宿主的精简 store mock；真实 store 一律走带意图的 action。
          if (tabs.closeExplicitTab) {
            tabs.closeExplicitTab(storageKey, item.tabKey, plannedFallback ?? undefined)
          } else {
            tabs.closeTab(storageKey, item.tabKey, plannedFallback ?? undefined)
          }
        } else {
          // source-driven handler 已自行移除了 tab；仍要保留这次明确的关闭意图，
          // 让最后一个标签关闭时聊天主位能收回空画布。
          useSpaceContextTabsStore.getState().recordExplicitTabClose?.(storageKey, item.tabKey)
        }

        // closeTab 后的最终清理（见 ContextTypeHandler.onAfterClose 文档）。
        // 这里要紧接着 closeTab 同步调用——让 source store 删除（如 terminal session）
        // 与 closeTab 处于同一 sync render 闭环，避免 syncTabOrder 看到中间状态把
        // 已关闭的 tabKey 重新加回 tabOrder。
        contextRegistry.dispatchAfterClose(item, containerCtx)
      } catch (error) {
        // 此 catch 主要承接两类异常：
        //   1. handler.beforeClose / handler.onClose 自身抛错（资源销毁失败）
        //   2. ContextRegistry 守卫 throw（dev/test 环境对违约 handler 的强制断路）
        // 当后者触发时，本路径会跳过 closeTab → 短暂出现"幽灵 tab"（条上仍有但底层资源已清理）。
        // 这是**有意权衡**：让 dev/test 立即看见违约（CI 挂掉 + tab 残留可视化），
        // prod 永远不会到这里——因为现有 handler.onClose 全部合规、不动 activeKey/tabOrder。
        // 如果未来真出现 prod 违约场景，应在 ContextRegistry 加更激进的兜底（如 prod 也 throw）
        // 而非掩盖症状。
        console.warn('[useCloseHandlers] close handler failed:', {
          spaceId,
          tabKey: item.tabKey,
          error,
        })
      }
    })()
  }, [closeCanvasPane, computeFallbackTabKey, containerCtx, setActiveKey, spaceId, storageKey])

  const resolveItemsByKeys = useCallback((keys: readonly string[]) => {
    return keys
      .map(key => contextItemByTabKey.get(key))
      .filter((item): item is ContextItem => Boolean(item))
  }, [contextItemByTabKey])

  const batchClose = useCallback(async (targets: readonly string[], preferredSurvivor?: ContextItem | null) => {
    // 关闭其他/左侧/右侧时跳过 registry.isClosable === false 的 item（PRD §10 Agent 起始页）。
    // 先 resolve items 再 filter——比 isAgentHomeStickyTab 字符串匹配更稳，将来加新 sticky 自动生效。
    const resolved = resolveItemsByKeys(targets).filter(item => contextRegistry.isClosable(item))
    if (resolved.length === 0) return

    const allowed = (await Promise.all(
      resolved.map(async target => {
        const ok = await contextRegistry.dispatchBeforeClose(target, containerCtx)
        return ok ? target : null
      }),
    )).filter((t): t is ContextItem => t !== null)

    if (allowed.length === 0) return

    const keysToClose = allowed.map(t => t.tabKey)
    // 显式 widen 成 Set<string>，避免后续 closingSet.has(initialActive: string | null) 因
    // ContextTabKey 模板字面量类型收窄触发 TS2345（运行时一致，仅类型层面声明 contravariance）
    const closingSet = new Set<string>(keysToClose)

    // 提前固定 fallback：如果 active 在 closingSet 里，优先落到 preferredSurvivor；
    // 否则从 visibleTabKeys 中找第一个不在 closingSet 的 tab
    const initialActive = useSpaceContextTabsStore.getState().activeKeyBySpace[storageKey] ?? null
    const isClosingActive = initialActive != null && closingSet.has(initialActive)
    let plannedFallback: string | null = null
    if (isClosingActive) {
      plannedFallback = preferredSurvivor && !closingSet.has(preferredSurvivor.tabKey)
        ? preferredSurvivor.tabKey
        : visibleTabKeys.find(k => !closingSet.has(k)) ?? null
    }

    for (const target of allowed) {
      if (target.meta?.discarded) {
        const parsed = contextRegistry.parseTabKey(target.tabKey)
        if (parsed) useDiscardedViewStore.getState().clearDiscarded(parsed.id)
      }
    }

    const tabs = useSpaceContextTabsStore.getState()
    if (tabs.batchCloseExplicitTabs) {
      tabs.batchCloseExplicitTabs(storageKey, keysToClose)
    } else {
      tabs.batchCloseTab(storageKey, keysToClose)
    }

    if (isClosingActive) {
      const postActive = useSpaceContextTabsStore.getState().activeKeyBySpace[storageKey] ?? null
      if (postActive !== plannedFallback) {
        setActiveKey(storageKey, plannedFallback)
      }
    }

    for (const target of allowed) {
      closeCanvasPane(target)
    }

    // 资源销毁失败时统一提示用户，而不是静默 warn。
    // dispatchClose 内置守卫：dev/test 环境对违约 handler throw（这里被 catch 转 Error），
    // prod 环境降级为 warn，dispatchClose resolve 正常返回 DispatchCloseResult。
    //
    // dispatchAfterClose 紧跟每个 dispatchClose 的 .then() / .catch() 跑——保证 per-item
    // 的 onClose（kill PTY、清 split layout 等）先完成，再做 source 清理（删 session 等），
    // 否则 sub-pane removeLayout 时序错乱（详见 terminal handler 注释）。
    void Promise.allSettled(
      allowed.map(t =>
        contextRegistry.dispatchClose(t, containerCtx)
          .then(result => {
            contextRegistry.dispatchAfterClose(t, containerCtx)
            return result
          })
          .catch(err => {
            console.warn('[useCloseHandlers] dispatchClose failed:', t.tabKey, err)
            // 即使 dispatchClose 失败也跑 onAfterClose（清 source 是 best effort，
            // dispatchAfterClose 自身带 try/catch，不会再抛）
            contextRegistry.dispatchAfterClose(t, containerCtx)
            return err
          })
      )
    ).then(results => {
      const failures = results.filter(r => r.status === 'fulfilled' && r.value instanceof Error).length
      if (failures > 0 && import.meta.env?.DEV) {
        console.warn(`[useCloseHandlers] batchClose: ${failures}/${allowed.length} handler.onClose 抛错或违约`)
      }
    })
  }, [closeCanvasPane, containerCtx, resolveItemsByKeys, setActiveKey, storageKey, visibleTabKeys])

  const computeVisibleSlots = useCallback(() => {
    const visibleKeySet = new Set<string>(visibleTabKeys)
    groupedTabKeys.forEach(key => visibleKeySet.add(key))
    return computeSlotsFromTabOrder({
      tabOrder: currentTabKeys.filter(key => visibleKeySet.has(key)),
      groupedTabKeys,
      canvasGroups,
    })
  }, [canvasGroups, currentTabKeys, groupedTabKeys, visibleTabKeys])

  const handleCloseOtherItems = useCallback(async (item: ContextItem) => {
    const targets = visibleTabKeys.filter(key => key !== item.tabKey)
    if (targets.length === 0) return
    handleSelectItem(item)
    await batchClose(targets, item)
  }, [batchClose, handleSelectItem, visibleTabKeys])

  const handleCloseLeftItems = useCallback(async (item: ContextItem) => {
    const baseIndex = visibleTabKeys.indexOf(item.tabKey)
    if (baseIndex <= 0) return
    await batchClose(visibleTabKeys.slice(0, baseIndex), item)
  }, [batchClose, visibleTabKeys])

  const handleCloseRightItems = useCallback(async (item: ContextItem) => {
    const baseIndex = visibleTabKeys.indexOf(item.tabKey)
    if (baseIndex === -1 || baseIndex >= visibleTabKeys.length - 1) return
    await batchClose(visibleTabKeys.slice(baseIndex + 1), item)
  }, [batchClose, visibleTabKeys])

  // ── Group 版本：基于 renderSlots 视觉序列（D-W5-3） ──

  const handleCloseOthersForGroup = useCallback(async (group: CanvasLayoutGroup) => {
    const slots = computeVisibleSlots()
    const targets = collectTabKeysFromSlots(slots.filter(slot => !(slot.kind === 'group' && slot.groupId === group.id)))
    if (targets.length === 0) return
    // 优先选 activePaneId 对应的 tabKey 保持用户视觉焦点不变
    const activePane = group.panes.find(p => p.id === group.activePaneId)
    const survivorKey = activePane?.content?.tabKey ?? group.panes[0]?.content?.tabKey ?? null
    const survivorItem = survivorKey ? contextItemByTabKey.get(survivorKey) ?? null : null
    if (survivorItem) handleSelectItem(survivorItem)
    await batchClose(targets, survivorItem)
  }, [batchClose, computeVisibleSlots, contextItemByTabKey, handleSelectItem])

  const handleCloseLeftForGroup = useCallback(async (group: CanvasLayoutGroup) => {
    const slots = computeVisibleSlots()
    const groupSlotIndex = slots.findIndex(s => s.kind === 'group' && s.groupId === group.id)
    if (groupSlotIndex <= 0) return
    const leftSlots = slots.slice(0, groupSlotIndex)
    const targets = collectTabKeysFromSlots(leftSlots)
    if (targets.length === 0) return
    const ownTabKey = group.panes[0]?.content?.tabKey
    const survivor = ownTabKey ? contextItemByTabKey.get(ownTabKey) ?? null : null
    await batchClose(targets, survivor)
  }, [batchClose, computeVisibleSlots, contextItemByTabKey])

  const handleCloseRightForGroup = useCallback(async (group: CanvasLayoutGroup) => {
    const slots = computeVisibleSlots()
    const groupSlotIndex = slots.findIndex(s => s.kind === 'group' && s.groupId === group.id)
    if (groupSlotIndex === -1 || groupSlotIndex >= slots.length - 1) return
    const rightSlots = slots.slice(groupSlotIndex + 1)
    const targets = collectTabKeysFromSlots(rightSlots)
    if (targets.length === 0) return
    const ownTabKey = group.panes[0]?.content?.tabKey
    const survivor = ownTabKey ? contextItemByTabKey.get(ownTabKey) ?? null : null
    await batchClose(targets, survivor)
  }, [batchClose, computeVisibleSlots, contextItemByTabKey])

  return {
    handleCloseItem,
    handleCloseOtherItems,
    handleCloseLeftItems,
    handleCloseRightItems,
    handleCloseOthersForGroup,
    handleCloseLeftForGroup,
    handleCloseRightForGroup,
  }
}
