import { removeLeafFromTree } from '@/utils/split-layout'
import {
  buildCanvasLayoutSignature,
  buildContextTabsSignature,
} from '@stores/workbenchRestoreSignature'
import type { ContextActiveKey, ContextItemRecord } from '@stores/useSpaceContextTabsStore'
import type { CanvasLayoutGroup, CanvasTabKey } from '@stores/useCanvasLayoutStore'
import { ensureLayout, repairGroupConsistency } from '@stores/canvasLayout/helpers'
import { stableRestoreStringify } from '@stores/workbenchRestoreSignature'
import { buildMinimalItem, classifyRestoreTab, isKeepStatus, isUsableActiveStatus } from './policies'
import type { RestoreDecision, RestoreTabStatus, WorkbenchRestoreInput } from './types'

const deriveDisplayKey = (activeKey: ContextActiveKey): ContextActiveKey =>
  typeof activeKey === 'string' && activeKey.startsWith('tabweb:') ? activeKey : null

const sameSignature = (left: string, right: string) => left === right

const pushUnique = (target: string[], key: string) => {
  if (!target.includes(key)) target.push(key)
}

const collectCanvasTabKeys = (groups: readonly CanvasLayoutGroup[]): string[] => {
  const keys: string[] = []
  groups.forEach(group => {
    group.panes.forEach(pane => {
      if (pane.content?.tabKey) pushUnique(keys, pane.content.tabKey)
    })
  })
  return keys
}

const tabwebKey = (viewId: string | null | undefined): string | null =>
  viewId ? `tabweb:${viewId}` : null

const statusList = (statuses: Record<string, RestoreTabStatus>, kind: RestoreTabStatus['kind']) =>
  Object.values(statuses)
    .filter(status => status.kind === kind)
    .map(status => status.tabKey)

const buildItemForKey = (
  input: WorkbenchRestoreInput,
  tabKey: string,
  existing?: ContextItemRecord,
): ContextItemRecord | null => {
  if (existing) return existing
  const sourceItem = [
    ...input.browser.items,
    ...input.table.items,
    ...input.terminal.items,
  ].find(item => item.tabKey === tabKey)
  if (sourceItem) return sourceItem

  if (tabKey.startsWith('tabweb:')) {
    const viewId = tabKey.slice('tabweb:'.length)
    const seed = input.browser.persistedSeeds.find(item => item.viewId === viewId)
    return buildMinimalItem(tabKey, seed?.title, seed?.url)
  }
  return buildMinimalItem(tabKey)
}

const reconcileCanvasGroups = (
  input: WorkbenchRestoreInput,
  statuses: Record<string, RestoreTabStatus>,
): {
  groups: CanvasLayoutGroup[]
  prunedPaneIds: string[]
} => {
  const prunedPaneIds: string[] = []
  const groups: CanvasLayoutGroup[] = []

  input.canvasGroups.forEach(group => {
    const stalePaneIds = group.panes
      .filter(pane => {
        const tabKey = pane.content?.tabKey
        if (!tabKey) return false
        return statuses[tabKey]?.kind === 'stale'
      })
      .map(pane => pane.id)

    if (stalePaneIds.length === 0) {
      groups.push(repairGroupConsistency(group, input.spaceId))
      return
    }

    const staleSet = new Set(stalePaneIds)
    const nextPanes = group.panes.filter(pane => !staleSet.has(pane.id))
    if (nextPanes.length === 0) {
      prunedPaneIds.push(...stalePaneIds)
      return
    }

    let nextLayout = ensureLayout(group)
    stalePaneIds.forEach(paneId => {
      nextLayout = removeLeafFromTree(nextLayout, paneId)
    })

    const nextActivePaneId = nextPanes.some(pane => pane.id === group.activePaneId)
      ? group.activePaneId
      : nextPanes.find(pane => pane.content)?.id ?? nextPanes[0]?.id ?? null

    const anchorStillPresent = nextPanes.some(pane => pane.content?.tabKey === group.anchorTabKey)
    const fallbackAnchor =
      (nextPanes.find(pane => pane.content)?.content?.tabKey as CanvasTabKey | undefined) ??
      (input.tabOrder.find(tabKey => statuses[tabKey]?.kind !== 'stale') as CanvasTabKey | undefined) ??
      group.anchorTabKey
    const nextAnchor = anchorStillPresent
      ? group.anchorTabKey
      : fallbackAnchor

    prunedPaneIds.push(...stalePaneIds)
    groups.push(repairGroupConsistency({
      ...group,
      panes: nextPanes,
      layout: nextLayout,
      activePaneId: nextActivePaneId,
      anchorTabKey: nextAnchor,
      updatedAt: Date.now(),
    }, input.spaceId))
  })

  return { groups, prunedPaneIds }
}

const pickActiveKey = (
  input: WorkbenchRestoreInput,
  statuses: Record<string, RestoreTabStatus>,
  nextTabOrder: string[],
): { activeKey: ContextActiveKey; reason: string } => {
  // 用户当前 store.activeKey 优先于历史 surface。
  //
  // 之前的实现是先看 lastActiveSurface——虚拟 surface 直接强制清空 activeKey。
  // 但 SpaceContextContainerInner 的 effect 看到 store 里有 valid activeKey
  // 又会把 lastSurface 改回 real_tab，下一次 reconcile 又选回真实 tab →
  // effect 又改 surface → ...React  死循环。
  //
  // 修复：把"持久化 activeKey valid"判断提到最前面。语义保持：
  //   - 用户上次主动留在桌面主页（store.activeKey=null + lastSurface=desktop）
  //     仍然恢复桌面（input.activeKey=null 走不到这里，往下到 lastSurface 分支）。
  //   - 用户上次主动留在某个真实 tab → 持久化的 activeKey 还在，直接保留，
  //     不被 lastSurface 覆盖。
  if (input.activeKey && isUsableActiveStatus(statuses[input.activeKey])) {
    return { activeKey: input.activeKey, reason: 'persisted_active' }
  }

  if (input.lastActiveSurface === 'desktop') {
    return { activeKey: null, reason: 'last_surface_desktop' }
  }

  const browserActiveKey =
    tabwebKey(input.browser.activeViewId) ||
    tabwebKey(input.browser.persistedSeeds.find(seed => seed.isActive)?.viewId)
  if (browserActiveKey && isUsableActiveStatus(statuses[browserActiveKey])) {
    return { activeKey: browserActiveKey, reason: 'browser_active_candidate' }
  }

  // ：优先真实资源 tab，避免仅因 order 把 apphome:* 排在前面就把用户从文档/表格踢回首页。
  const usableKeys = nextTabOrder.filter(key => isUsableActiveStatus(statuses[key]))
  const fallback =
    usableKeys.find(key => !key.startsWith('apphome:'))
    ?? usableKeys[0]
    ?? null
  return { activeKey: fallback, reason: fallback ? 'first_restorable_tab' : 'no_real_tab' }
}

export function reconcileWorkbenchRestore(input: WorkbenchRestoreInput): RestoreDecision {
  const baseSignature = {
    contextTabs: buildContextTabsSignature({
      activeKey: input.activeKey,
      displayKey: input.displayKey,
      tabOrder: input.tabOrder,
      items: input.itemsByTabKey,
    }),
    canvasLayout: buildCanvasLayoutSignature(input.canvasGroups),
  }

  const explicitKeys = new Set<string>([
    ...input.tabOrder,
    ...Object.keys(input.itemsByTabKey),
    ...collectCanvasTabKeys(input.canvasGroups),
  ])
  if (input.activeKey) explicitKeys.add(input.activeKey)
  const sourceKeys = [
    ...input.browser.items.map(item => item.tabKey),
    ...input.table.items.map(item => item.tabKey),
    ...input.terminal.items.map(item => item.tabKey),
  ].filter(key => !input.isIsolatedScope || explicitKeys.has(key))
  const allKeys = new Set<string>([
    ...explicitKeys,
    ...sourceKeys,
  ])
  if (input.activeKey) allKeys.add(input.activeKey)
  const activeBrowserKey =
    tabwebKey(input.browser.activeViewId) ||
    tabwebKey(input.browser.persistedSeeds.find(seed => seed.isActive)?.viewId)
  if (activeBrowserKey && (!input.isIsolatedScope || explicitKeys.has(activeBrowserKey))) {
    allKeys.add(activeBrowserKey)
  }

  const statusByTabKey: Record<string, RestoreTabStatus> = {}
  allKeys.forEach(tabKey => {
    statusByTabKey[tabKey] = classifyRestoreTab(input, tabKey)
  })

  const nextTabOrder: string[] = []
  input.tabOrder.forEach(tabKey => {
    if (isKeepStatus(statusByTabKey[tabKey])) pushUnique(nextTabOrder, tabKey)
  })
  ;[
    ...input.table.items,
    ...input.browser.items,
    ...input.terminal.items,
  ].forEach(item => {
    if (input.isIsolatedScope && !explicitKeys.has(item.tabKey)) return
    if (isKeepStatus(statusByTabKey[item.tabKey])) pushUnique(nextTabOrder, item.tabKey)
  })

  const nextItems: Record<string, ContextItemRecord> = {}
  Object.entries(input.itemsByTabKey).forEach(([tabKey, item]) => {
    if (isKeepStatus(statusByTabKey[tabKey])) {
      nextItems[tabKey] = item
    }
  })
  allKeys.forEach(tabKey => {
    if (!isKeepStatus(statusByTabKey[tabKey])) return
    const item = buildItemForKey(input, tabKey, nextItems[tabKey])
    if (item) nextItems[tabKey] = item
  })

  const { activeKey: nextActiveKey, reason: activeReason } =
    pickActiveKey(input, statusByTabKey, nextTabOrder)
  const nextDisplayKey = deriveDisplayKey(nextActiveKey)
  // activeKey=null 既可能是“用户停在虚拟桌面主页”，也可能只是“真实 tab 关光后回到 home”。
  // 只有 lastActiveSurface 明确指向桌面时，restore 才应激活桌面 surface。
  const activeSurface = nextActiveKey
    ? 'real_tab'
    : activeReason === 'last_surface_desktop'
      ? 'desktop'
      : 'real_tab'
  const desiredActiveViewId =
    nextActiveKey && nextActiveKey.startsWith('tabweb:')
      ? nextActiveKey.slice('tabweb:'.length)
      : null

  const { groups: nextCanvasGroups, prunedPaneIds } =
    reconcileCanvasGroups(input, statusByTabKey)

  const contextPatch = {
    tabOrder: nextTabOrder,
    items: nextItems,
    activeKey: nextActiveKey,
    displayKey: nextDisplayKey,
  }
  const canvasPatch = { groups: nextCanvasGroups }

  const nextContextSignature = buildContextTabsSignature({
    activeKey: contextPatch.activeKey,
    displayKey: contextPatch.displayKey,
    tabOrder: contextPatch.tabOrder,
    items: contextPatch.items,
  })
  const nextCanvasSignature = buildCanvasLayoutSignature(canvasPatch.groups)

  const prunedTabKeys = statusList(statusByTabKey, 'stale')
  const keptUnknownKeys = statusList(statusByTabKey, 'unknown')
  const suspendedKeys = statusList(statusByTabKey, 'suspended')
  const recoverableKeys = statusList(statusByTabKey, 'recoverable')

  return {
    settled: true,
    statusByTabKey,
    contextPatch,
    canvasPatch,
    activeSurface,
    desiredActiveViewId,
    baseSignature,
    changed: {
      contextTabs: !sameSignature(baseSignature.contextTabs, nextContextSignature),
      canvasLayout: !sameSignature(baseSignature.canvasLayout, nextCanvasSignature),
    },
    trace: {
      prunedTabKeys,
      prunedPaneIds,
      keptUnknownKeys,
      suspendedKeys,
      recoverableKeys,
      activeReason,
    },
  }
}

export const signatureRestoreDecision = (decision: RestoreDecision): string =>
  stableRestoreStringify({
    contextPatch: decision.contextPatch,
    canvasPatch: decision.canvasPatch,
    activeSurface: decision.activeSurface,
    desiredActiveViewId: decision.desiredActiveViewId,
  })
