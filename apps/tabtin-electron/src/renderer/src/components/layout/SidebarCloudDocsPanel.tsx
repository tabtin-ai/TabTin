/**
 * SidebarCloudDocsPanel —— 云文档一级域第二列：浏览 + 已打开 Dock。
 */
import React, { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useResourceInit } from '@components/context-space/hooks/useResourceInit'
import { useCloudDocsSidebarCreateHandlers } from './useCloudDocsSidebarCreateHandlers'
import type { CloudDocsBrowseView } from './cloudDocsOpenTabs'
import { SidebarCloudDocsBrowseNav } from './SidebarCloudDocsBrowseNav'
import { SidebarCloudDocsOpenTabsDock } from './SidebarCloudDocsOpenTabsDock'
import { CloudDocsKnowledgePanel } from './cloud-docs/CloudDocsKnowledgePanel'
import {
  isLoadableResourceHostSpaceId,
  resolveCloudDocsHostSpaceId,
} from './cloud-docs/cloudDocsHostSpace'

interface SidebarCloudDocsPanelProps {
  /** 云文档资源归属 Organization（ org-only）。 */
  organizationId: string
  /** 云文档标签组 scope（organization + user，侧栏/主画布 SSOT）。 */
  tabScopeKey: string
  /**
   * 仍走 Space 宿主 API 的兼容锚点（如 TabData source / create handler）。
   * 不参与知识库树与 org 资源列表身份。
   */
  resourceHostSpaceId?: string | null
}

export const SidebarCloudDocsPanel: React.FC<SidebarCloudDocsPanelProps> = ({
  organizationId,
  tabScopeKey,
  resourceHostSpaceId = null,
}) => {
  const { t } = useTranslation('context')
  const browseView = useSpaceViewPrefsStore(
    state => state.getPrefs(tabScopeKey).cloudDocsBrowseView ?? 'all',
  )
  const setCloudDocsBrowseView = useSpaceViewPrefsStore(state => state.setCloudDocsBrowseView)
  const storeOrganizationId = useOrganizationStore(state => state.getEffectiveOrganizationId())
  const spaces = useSpaceStore(state => state.spaces)
  const effectiveHostSpaceId = resolveCloudDocsHostSpaceId({
    organizationId,
    resourceHostSpaceId,
    spaces,
    storeOrganizationId,
  })
  const hostSpace = useSpaceStore(state => (
    effectiveHostSpaceId
      ? state.spaces.find(item => item.id === effectiveHostSpaceId) ?? null
      : null
  ))
  const { handleSearchNavigate } = useResourceInit({
    spaceId: effectiveHostSpaceId ?? '',
    tabScopeKey,
    spaceName: hostSpace?.name ?? t('sidebar:cloudDocs.browse.all', { defaultValue: '云文档' }),
    spaceOrganizationId: organizationId,
    crawlspaceId: null,
    activeTabType: 'apphome',
    isForeground: isLoadableResourceHostSpaceId(effectiveHostSpaceId),
  })
  const { onCreateResource } = useCloudDocsSidebarCreateHandlers({
    organizationId,
    tabScopeKey,
    resourceHostSpaceId,
  })

  const handleBrowseViewChange = useCallback((view: CloudDocsBrowseView) => {
    setCloudDocsBrowseView(tabScopeKey, view)
  }, [setCloudDocsBrowseView, tabScopeKey])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <SidebarCloudDocsBrowseNav value={browseView} onChange={handleBrowseViewChange} />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <CloudDocsKnowledgePanel
          organizationId={organizationId}
          tabScopeKey={tabScopeKey}
          resourceHostSpaceId={resourceHostSpaceId}
          browseView={browseView}
          onCreateResource={onCreateResource}
          onSearchNavigate={handleSearchNavigate}
        />
      </div>
      <SidebarCloudDocsOpenTabsDock
        tabScopeKey={tabScopeKey}
        resourceHostSpaceId={effectiveHostSpaceId}
      />
    </div>
  )
}

SidebarCloudDocsPanel.displayName = 'SidebarCloudDocsPanel'
