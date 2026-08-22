/**
 * 云文档侧栏「已打开」Dock —— 从 cloud-docs scope tab store 派生可见 tab 列表。
 */
import type { ContextItemRecord } from '@stores/useSpaceContextTabsStore'
import { DESKTOP_TAB_KEY } from '@components/context-space/desktopTabHandler'

export type CloudDocsBrowseView = 'all' | 'recent' | 'shared'

export const CLOUD_DOCS_HOME_TAB_KEY = 'apphome:cloud-resources'

export type CloudDocsDockTabKind = 'home' | 'tabdoc' | 'tabdata' | 'file' | 'tabweb'

export interface CloudDocsDockTab {
  tabKey: string
  kind: CloudDocsDockTabKind
  title: string
  type: string
  id: string
  isHome: boolean
  closable: boolean
}

// ：'tabfiles' 为后端 item_type，前端归一化后统一用 'file:' 建 tabKey；这里防御性也认
// 'tabfiles:' 前缀，避免上游未归一化时误判非云文档 tab。
export function isCloudDocsDockTabKey(tabKey: string): boolean {
  if (tabKey === DESKTOP_TAB_KEY || tabKey === 'home') return false
  if (tabKey === CLOUD_DOCS_HOME_TAB_KEY) return true
  return tabKey.startsWith('tabdoc:') || tabKey.startsWith('tabdata:')
    || tabKey.startsWith('file:') || tabKey.startsWith('tabfiles:')
    || tabKey.startsWith('tabweb:')
}

function resolveDockTabKind(tabKey: string): CloudDocsDockTabKind | null {
  if (tabKey === CLOUD_DOCS_HOME_TAB_KEY) return 'home'
  if (tabKey.startsWith('tabdoc:')) return 'tabdoc'
  if (tabKey.startsWith('tabdata:')) return 'tabdata'
  if (tabKey.startsWith('file:') || tabKey.startsWith('tabfiles:')) return 'file'
  if (tabKey.startsWith('tabweb:')) return 'tabweb'
  return null
}

/** 'tabfiles:xxx' 归一化为 'file:xxx'，与前端 ContextItemType 对齐。 */
function normalizeFileTabKey(tabKey: string): string {
  return tabKey.startsWith('tabfiles:') ? `file:${tabKey.slice('tabfiles:'.length)}` : tabKey
}

function buildDockTab(tabKey: string, item: ContextItemRecord | undefined): CloudDocsDockTab | null {
  const kind = resolveDockTabKind(tabKey)
  if (!kind) return null
  const normalizedTabKey = kind === 'file' ? normalizeFileTabKey(tabKey) : tabKey
  const isHome = kind === 'home'
  const type = item?.type ?? (isHome ? 'apphome' : normalizedTabKey.split(':')[0] ?? '')
  const id = item?.id ?? (isHome ? 'cloud-resources' : normalizedTabKey.slice(type.length + 1))
  const title = item?.title?.trim()
    || (isHome ? 'Cloud Documents' : id)
  return {
    tabKey: normalizedTabKey,
    kind,
    title,
    type,
    id,
    isHome,
    closable: !isHome,
  }
}

/** 从 tabOrder + items 派生 Dock 行（首页强制排第一）。 */
export function selectCloudDocsDockTabs(input: {
  tabOrder: readonly string[]
  itemsByKey: Record<string, ContextItemRecord | undefined>
}): CloudDocsDockTab[] {
  const tabs: CloudDocsDockTab[] = []
  const seen = new Set<string>()

  for (const tabKey of input.tabOrder) {
    if (!isCloudDocsDockTabKey(tabKey) || seen.has(tabKey)) continue
    const item = input.itemsByKey[tabKey]
    if (!item && tabKey !== CLOUD_DOCS_HOME_TAB_KEY) continue
    const dockTab = buildDockTab(tabKey, item)
    if (!dockTab) continue
    seen.add(tabKey)
    tabs.push(dockTab)
  }

  const homeIndex = tabs.findIndex(tab => tab.isHome)
  if (homeIndex > 0) {
    const [homeTab] = tabs.splice(homeIndex, 1)
    tabs.unshift(homeTab)
  }

  return tabs
}

/** 关闭 tab 时的 fallback：优先左侧相邻项，否则右侧，最后回首页。 */
export function resolveCloudDocsCloseFallback(
  dockTabs: readonly CloudDocsDockTab[],
  closingTabKey: string,
): string {
  const index = dockTabs.findIndex(tab => tab.tabKey === closingTabKey)
  if (index < 0) return CLOUD_DOCS_HOME_TAB_KEY
  return dockTabs[index - 1]?.tabKey
    ?? dockTabs[index + 1]?.tabKey
    ?? CLOUD_DOCS_HOME_TAB_KEY
}

export function buildCloudDocsResourceTabKey(input: {
  itemType: string
  resourceId: string | null | undefined
}): string | null {
  // ：'tabfiles'（后端 item_type）归一化为 'file'（前端类型）；tabfolder 仍不构建 tabKey——
  // 文件夹走 SpaceCollection 浏览，不是可打开的 dock tab。
  const type = input.itemType === 'tabfiles' ? 'file' : input.itemType
  if (type !== 'tabdoc' && type !== 'tabdata' && type !== 'file') return null
  const resourceId = input.resourceId?.trim()
  if (!resourceId) return null
  return `${type}:${resourceId}`
}

/** 当前 Dock 中已打开且可关闭的资源 tabKey 集合（用于浏览列表高亮）。 */
export function selectCloudDocsOpenResourceTabKeys(input: {
  tabOrder: readonly string[]
  itemsByKey: Record<string, ContextItemRecord | undefined>
}): ReadonlySet<string> {
  const keys = selectCloudDocsDockTabs(input)
    .filter(tab => tab.closable)
    .map(tab => tab.tabKey)
  return new Set(keys)
}
