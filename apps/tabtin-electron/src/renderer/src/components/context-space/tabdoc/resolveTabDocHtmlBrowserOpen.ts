import { resolveBrowserOpenTabScopeKey, resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'
import { buildCloudDocsScopeKey } from '@components/layout/cloudDocsDomain'
import type { WorkbenchMode } from '@components/layout/useShellLayoutState'

export interface TabDocHtmlBrowserOpenTarget {
  tabScopeKey: string
}

export function resolveTabDocHtmlBrowserOpenTarget(input: {
  workbenchMode: WorkbenchMode
  spaceId: string
  documentId: string
  organizationId?: string | null
  userId?: string | null
  fallbackTabScopeKey?: string | null
}): TabDocHtmlBrowserOpenTarget {
  if (input.workbenchMode === 'cloud-docs') {
    // 与 tabdoc/tabdata 相同：tabweb 写入 cloud-docs scope，出现在侧栏「当前打开」Dock，
    // 主画布切换展示——不在 TabdocPanelApp 内嵌右侧面板（缺 workspaceLayerHost 会卡在初始化）。
    return {
      tabScopeKey: buildCloudDocsScopeKey({
        organizationId: input.organizationId,
        userId: input.userId,
      }),
    }
  }

  const foreground = input.fallbackTabScopeKey?.trim()
    || resolveForegroundTabScopeKey(input.spaceId)
  return {
    tabScopeKey: resolveBrowserOpenTabScopeKey(input.spaceId, foreground),
  }
}
