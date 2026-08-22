/**
 * useEnsureAgentHomeTab — 确保 Workspace 永远有一个 `apphome:orchestration` 起始页 Tab
 *
 * 这是 Space 的常驻"Agent"起始页（PRD §10）：
 *   - 进入 Space 时如果还没有该 Tab，自动注入到 tabOrder 最前
 *   - Space 已有该 Tab → 强制排到最前（防御 / 修正用户可能的旧持久化顺序）
 *   - 该 Tab 永远不可关闭（关闭逻辑在 useCloseHandlers / Tab 渲染层屏蔽）
 *   - 该 Tab 内容由 OrchestrationSection 单一驱动，按 agent.working_dir + working_dir_type 渲染
 *
 * 注意：该 hook 只负责"注入 + 排序"，不决定 active key。首次进入 Space 时 active 由
 * 现有恢复 / activeKey 逻辑接管——若用户上次离开时 active 是某个普通 Tab，进来仍恢复
 * 那个 Tab；若没有持久化 active，则 fallback 到第一个 Tab（也就是 Agent 起始页）。
 */
import { useEffect } from 'react'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { contextRegistry } from '../registry'
import type { Agent } from '@tabtin/app-shell'

const AGENT_HOME_APP_ID = 'orchestration'
const AGENT_HOME_TAB_TYPE = 'apphome'

interface UseEnsureAgentHomeTabParams {
  spaceId: string
  tabScopeKey?: string
  spaceType?: string
  agent: Agent | null
  hydrated: boolean
  restoreSettled: boolean
  enabled?: boolean
}

export function useEnsureAgentHomeTab({
  spaceId,
  tabScopeKey,
  spaceType,
  agent,
  hydrated,
  restoreSettled,
  enabled = true,
}: UseEnsureAgentHomeTabParams): void {
  useEffect(() => {
    if (!enabled) return
    if (!hydrated || !restoreSettled) return
    if (spaceType !== 'workspace') return
    if (!agent) return

    const storageKey = tabScopeKey ?? spaceId
    const stickyTabKey = contextRegistry.buildTabKey(AGENT_HOME_TAB_TYPE, AGENT_HOME_APP_ID)
    const state = useSpaceContextTabsStore.getState()
    const existingItems = state.itemsBySpace[storageKey] ?? {}

    // 清理前两轮残留的 placeholder Tab —— 之前用过 `tabfolder:__empty_working_dir__`
    // 作为"未设置 working_dir"的占位 Tab。第三轮把这个职责交给 sticky Agent 起始页 Tab，
    // 老的 placeholder 应该被清掉，否则用户会看到两个 Tab 并存（Bug 报告 #1）。
    const LEGACY_PLACEHOLDER_KEYS: string[] = []
    for (const [key, item] of Object.entries(existingItems)) {
      const isLegacyEmpty =
        item.type === 'tabfolder' &&
        (item.id === '__empty_working_dir__' || item.meta?.emptyNeedsSetup === true)
      if (isLegacyEmpty) LEGACY_PLACEHOLDER_KEYS.push(key)
    }
    if (LEGACY_PLACEHOLDER_KEYS.length > 0) {
      useSpaceContextTabsStore.setState((prev) => {
        const nextItems = { ...(prev.itemsBySpace[storageKey] ?? {}) }
        for (const k of LEGACY_PLACEHOLDER_KEYS) delete nextItems[k]
        const nextOrder = (prev.tabOrderBySpace[storageKey] ?? []).filter(
          k => !LEGACY_PLACEHOLDER_KEYS.includes(k),
        )
        const currentActive = prev.activeKeyBySpace[storageKey]
        const nextActive =
          currentActive && LEGACY_PLACEHOLDER_KEYS.includes(currentActive)
            ? stickyTabKey
            : currentActive
        return {
          itemsBySpace: { ...prev.itemsBySpace, [storageKey]: nextItems },
          tabOrderBySpace: { ...prev.tabOrderBySpace, [storageKey]: nextOrder },
          activeKeyBySpace: { ...prev.activeKeyBySpace, [storageKey]: nextActive ?? null },
        }
      })
    }

    // 重新读 state（cleanup 可能改了）
    const afterCleanup = useSpaceContextTabsStore.getState()
    const items = afterCleanup.itemsBySpace[storageKey] ?? {}
    const order = afterCleanup.tabOrderBySpace[storageKey] ?? []
    const hasItem = stickyTabKey in items
    const isFirst = order[0] === stickyTabKey

    if (hasItem && isFirst) return

    if (!hasItem) {
      // 注入 apphome:orchestration Tab。
      // silent: true —— 注入起始页时**不**抢 active key。
      // 起始页内容是 Agent 的本地工作目录视图；过去 openResourceTab 默认会把它设成
      // active，于是用户一进 Space / 聊天就被默认顶到「本地目录」，不符合预期。
      // 改为 silent 注入后，新 Space 的 active 保持 null，由桌面主页按
      // workspace 默认 surface 接管（见 SpaceContextContainer 的 lastActiveSurface 默认）。
      // 用户仍可主动点这个起始页 Tab 进入本地目录。
      useSpaceContextTabsStore.getState().openResourceTab(storageKey, {
        type: AGENT_HOME_TAB_TYPE,
        id: AGENT_HOME_APP_ID,
        title: 'Agent',
        meta: { appId: AGENT_HOME_APP_ID, sticky: true },
        silent: true,
      })
    }

    // 排到最前（防御性 reorder）：openResourceTab 会插到 active 之后，
    // 这里强制把 sticky tab 放到第一位
    const refreshed = useSpaceContextTabsStore.getState()
    const orderAfterInject = refreshed.tabOrderBySpace[storageKey] ?? []
    if (orderAfterInject[0] !== stickyTabKey && orderAfterInject.includes(stickyTabKey)) {
      const reordered = [stickyTabKey, ...orderAfterInject.filter(k => k !== stickyTabKey)]
      useSpaceContextTabsStore.setState((prev) => ({
        tabOrderBySpace: { ...prev.tabOrderBySpace, [storageKey]: reordered },
      }))
    }
  }, [spaceId, tabScopeKey, spaceType, agent, hydrated, restoreSettled, enabled])
}
