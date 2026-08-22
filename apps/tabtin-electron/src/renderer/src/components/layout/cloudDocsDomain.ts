/**
 * 云文档一级域：窄栏 + 侧栏列表 + 主画布。
 * 标签组 scope 与任务域 / IM 会话桌面隔离，避免 tab 串台。
 */
import { useLayoutEffect } from 'react'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { useWorkbenchSurfaceStore } from '@stores/useWorkbenchSurfaceStore'
import { resolveAppHomeTabModel } from '@components/context-space/registry/resolveUtils'
import { DESKTOP_TAB_KEY } from '@components/context-space/desktopTabHandler'
import type { WorkbenchMode } from './shellLayoutTypes'
import { CLOUD_DOCS_HOME_TAB_KEY } from './cloudDocsOpenTabs'

export { CLOUD_DOCS_HOME_TAB_KEY } from './cloudDocsOpenTabs'

function normalizeScopePart(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim()
  return trimmed || fallback
}

/** 云文档标签组 scope：组织 + 用户（与 desktop 桶对齐，内容归属 organization）。 */
export function buildCloudDocsScopeKey(input: {
  organizationId?: string | null
  userId?: string | null
}): string {
  const organizationId = normalizeScopePart(input.organizationId, 'unknown-organization')
  const userId = normalizeScopePart(input.userId, 'anonymous')
  return `cloud-docs:organization:${organizationId}:user:${userId}`
}

export function resolveCloudDocsTabScopeKey(input: {
  organizationId?: string | null
  userId?: string | null
}): string {
  return buildCloudDocsScopeKey(input)
}

export function isCloudDocsScopeKey(scopeKey: string | null | undefined): boolean {
  return Boolean(scopeKey?.startsWith('cloud-docs:'))
}

export function parseCloudDocsScopeKey(
  scopeKey: string | null | undefined,
): { organizationId: string; userId: string } | null {
  if (!scopeKey || !isCloudDocsScopeKey(scopeKey)) return null
  const match = scopeKey.match(/^cloud-docs:organization:([^:]+):user:(.+)$/)
  if (!match) return null
  return { organizationId: match[1], userId: match[2] }
}

/**
 * 判断进入云文档域时是否需要强制回首页 tab。
 * ：已打开 tabdoc/tabdata/file（普通文件）资源 tab 时不应被打断回首页。
 * export 供单测直接覆盖各类型分支。
 */
export function shouldEnsureCloudDocsHomeTab(activeKey: string | null | undefined): boolean {
  if (!activeKey || activeKey === 'home' || activeKey === DESKTOP_TAB_KEY) return true
  if (activeKey === CLOUD_DOCS_HOME_TAB_KEY) return false
  if (
    activeKey.startsWith('tabdoc:')
    || activeKey.startsWith('tabdata:')
    || activeKey.startsWith('file:')
  ) return false
  return true
}

/** 进入云文档域时确保 cloud-resources 起始 tab 已打开（cloud-docs scope）。 */
export function useEnsureCloudDocsHomeTab(input: {
  workbenchMode: WorkbenchMode
  tabScopeKey: string | null
}): void {
  const { workbenchMode, tabScopeKey } = input

  useLayoutEffect(() => {
    if (workbenchMode !== 'cloud-docs' || !tabScopeKey) return
    const tabsStore = useSpaceContextTabsStore.getState()
    const activeKey = tabsStore.activeKeyBySpace[tabScopeKey] ?? null
    if (!shouldEnsureCloudDocsHomeTab(activeKey)) return

    useWorkbenchSurfaceStore.getState().setLastActiveSurface(tabScopeKey, 'real_tab')

    const model = resolveAppHomeTabModel('cloud-resources')
    tabsStore.openResourceTab(tabScopeKey, {
      type: 'apphome',
      id: 'cloud-resources',
      title: model.title,
      meta: {
        appId: 'cloud-resources',
        labelKey: model.labelKey,
        displayLabel: model.displayLabel,
        displayEmoji: model.displayEmoji,
        cloudDocsDomain: true,
      },
    })
  }, [tabScopeKey, workbenchMode])
}
