/**
 * openSharedResource — 把"分享给我"的资源作为独立 tab 在当前工作台打开
 *
 * Agent 私有化后，协作者并非资源所属 workspace 的成员，无法切换到该 Space。
 * 这里把被分享的文档/表格作为一个 tab 开在用户**当前可访问的 Space**（hostSpaceId）
 * 的工作台里，但 tab 内容按资源**自身**的 space/organization 渲染：
 *  - 文档：meta.spaceId / meta.organizationId 指向资源真实归属，tabdoc renderPane 据此挂载；
 *    meta.foreignShared 让 workbench restore 跳过"资源属于当前 Space"的成员校验，
 *    避免外部分享资源在 restore 时被当作 missing 清除。
 *  - 表格：同样携带 meta.foreignShared；内容仍按 tableId 渲染并由 TablePermission 鉴权，
 *    但 restore 不能按当前 Space 的资源索引清掉 owner 私有 workspace 里的表格。
 *
 *  / ：同一 resource 不得静默双写到多个 scope。
 * TabDoc 走 dirty-aware claim；其它类型仍 sync migrate。
 */
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { buildDesktopScopeKey } from '@components/layout/workspaceContextState'
import {
  claimTabDocScope,
  listScopesForTabKey,
  migrateTabKeyToScope,
  tryClaimTabDocScopeSync,
} from '@components/context-space/tabdoc/tabdocScopeClaim'
import { useAuthStore } from '@/stores/useAuthStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { buildResourceTabKey } from '@stores/contextTabs/helpers'
import { createLogger } from '@/utils/logger'

const log = createLogger('OpenSharedResource')

export interface OpenSharedResourceParams {
  /** 承载 tab 的当前 Space（用户可访问的，通常是当前选中 Space） */
  hostSpaceId: string
  resourceType: 'doc' | 'table' | 'file'
  resourceId: string
  /** 资源真实归属的 Space（owner 的私有 workspace；org-only 时可为空） */
  resourceSpaceId?: string
  /** 资源真实归属的 organization */
  organizationId?: string
  title?: string
  /** 显式标签组；IM 会话桌面用它把资源留在当前会话现场。 */
  tabScopeKey?: string
  /** 由通知等入口附加的资源内定位意图。 */
  meta?: Record<string, unknown>
}

export { listScopesForTabKey, migrateTabKeyToScope }

export function openSharedResourceTab(params: OpenSharedResourceParams): void {
  const { hostSpaceId, resourceType, resourceId, resourceSpaceId, organizationId, title } = params
  if (!hostSpaceId || !resourceId) {
    log.warn('open skipped: missing hostSpaceId or resourceId', {
      hostSpaceId: hostSpaceId || null,
      resourceType,
      resourceId: resourceId || null,
    })
    return
  }

  const tabs = useSpaceContextTabsStore.getState()
  const spaces = useSpaceStore.getState().spaces
  const resourceOrganizationId = resourceSpaceId
    ? spaces.find(space => space.id === resourceSpaceId)?.organization_id
    : undefined
  // IM/共享卡片语义是"在工作台打开"，不要落入当前对话的 conversation:{sessionId} tab scope。
  // 云文档侧栏必须由调用方显式传 cloud-docs:… scope，否则会落到 desktop 桶、前台无变化。
  const hostOrganizationId = spaces.find(space => space.id === hostSpaceId)?.organization_id
    ?? organizationId
    ?? resourceOrganizationId
  const resolvedOrganizationId = organizationId ?? resourceOrganizationId ?? hostOrganizationId
  const tabScopeKey = params.tabScopeKey ?? buildDesktopScopeKey({
    organizationId: hostOrganizationId,
    userId: useAuthStore.getState().user?.id ?? null,
  })

  const tabType =
    resourceType === 'table' ? 'tabdata' : resourceType === 'file' ? 'tabfiles' : 'tabdoc'
  const tabKey = buildResourceTabKey(tabType, resourceId)

  const openInTarget = () => {
    log.info('open shared resource tab', {
      resourceType,
      resourceId,
      tabType,
      tabScopeKey,
      hostSpaceId,
      resourceSpaceId: resourceSpaceId || null,
      organizationId: resolvedOrganizationId || null,
      explicitScope: Boolean(params.tabScopeKey),
    })

    tabs.openResourceTab(tabScopeKey, {
      type: tabType,
      id: resourceId,
      title: title || '',
      meta: {
        // org-only 资源 spaceId 可为空；打开时依赖 organizationId + resourceId
        spaceId: resourceSpaceId || undefined,
        organizationId: resolvedOrganizationId,
        foreignShared: true,
        ...params.meta,
        ...(resourceType === 'file' ? { context_item_id: undefined, file_record_id: resourceId } : {}),
      },
    })
  }

  if (tabType === 'tabdoc') {
    const sync = tryClaimTabDocScopeSync(tabKey, tabScopeKey)
    if (sync === 'needs-confirm') {
      void claimTabDocScope(tabKey, tabScopeKey, { displayName: title }).then((result) => {
        if (result === 'cancelled') return
        openInTarget()
      })
      return
    }
    openInTarget()
    return
  }

  const closedScopes = migrateTabKeyToScope(tabKey, tabScopeKey)
  if (closedScopes.length > 0) {
    log.info('migrated shared resource tab to single scope', {
      tabKey,
      targetScope: tabScopeKey,
      closedScopes,
    })
  }
  openInTarget()
}
