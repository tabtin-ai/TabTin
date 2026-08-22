/**
 * 云文档侧栏知识库面板 — 「全部」走 Notion 树，「最近/分享」仍走 flat 列表。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CloudResourcesHome } from '@components/context-space/registry/homeSections/cloudResources'
import type { CreateResourceHandler, CreateResourceOptions } from '@components/context-space/hooks/useCreateHandlers'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useSpaceContextTabsStore, EMPTY_TAB_ORDER } from '@stores/useSpaceContextTabsStore'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'
import {
  KNOWLEDGE_TREE_DEFAULT_DEPTH,
  useKnowledgeTree,
} from '@stores/useKnowledgeTree'
import { useSpaceContextNavigation } from '@components/context-space/hooks/useSpaceContextNavigation'
import { useTableContextSource } from '@components/context-space/sources'
import type { Table } from '@tabtin/table-core'
import type { KnowledgeTreeNode, SpaceContextItem } from '@/services/spaceApi'
import { cn } from '@utils/cn'
import type { CloudDocsBrowseView } from '../cloudDocsOpenTabs'
import { SidebarCloudDocsCreateButton } from '../SidebarCloudDocsCreateButton'
import { SIDEBAR_EMBEDDED_CONTROL_INSET } from '../sidebarUi'
import { CloudDocsKnowledgeTree } from './CloudDocsKnowledgeTree'
import { useCloudDocsKnowledgeTreeController } from './useCloudDocsKnowledgeTreeController'
import { useKnowledgeTreeEventSync } from './useKnowledgeTreeEventSync'
import {
  collectAncestorNodeIds,
  flattenKnowledgeTreeSearchMatches,
  nodeNeedsLazyChildren,
  resolveContextItemForMenu,
} from './knowledgeTreeUtils'
import { useResourceContextMenu, ResourceContextMenuOverlay } from '@components/context-space/ResourceContextMenu'
import { useRemoveFolderConfirm } from '@components/context-space/hooks/useRemoveFolderConfirm'
import { recordContextItemAccess, useUnifiedResources } from '@stores/useUnifiedResources'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { FeishuImportDialog } from '@components/context-space/feishu/FeishuImportDialog'
import { useEffectiveFeature } from '@/hooks/useEffectiveFeature'
import {
  CLOUD_DOCS_PLACEHOLDER_ORG_ID,
  isLoadableResourceHostSpaceId,
  resolveCloudDocsHostSpaceId,
  resolveEffectiveCloudDocsOrganizationId,
} from './cloudDocsHostSpace'

const EMPTY_EXPANDED_NODE_IDS: string[] = []

interface CloudDocsKnowledgePanelProps {
  organizationId: string
  tabScopeKey: string
  resourceHostSpaceId?: string | null
  browseView: CloudDocsBrowseView
  onCreateResource: (appId: string, options?: CreateResourceOptions) => void
  onSearchNavigate?: (item: SpaceContextItem) => void | Promise<void>
}

export const CloudDocsKnowledgePanel: React.FC<CloudDocsKnowledgePanelProps> = ({
  organizationId,
  tabScopeKey,
  resourceHostSpaceId = null,
  browseView,
  onCreateResource,
  onSearchNavigate,
}) => {
  const storeOrganizationId = useOrganizationStore(state => state.getEffectiveOrganizationId())
  const spaces = useSpaceStore(state => state.spaces)
  const listHostSpaceId = resolveCloudDocsHostSpaceId({
    organizationId,
    resourceHostSpaceId,
    spaces,
    storeOrganizationId,
  })
  if (browseView !== 'all') {
    if (!listHostSpaceId) {
      return null
    }
    return (
      <CloudResourcesHome
        spaceId={listHostSpaceId}
        tabScopeKey={tabScopeKey}
        presentation="cloud-docs-domain"
        layout="sidebar"
        browseView={browseView}
        onCreateResource={onCreateResource}
        onSearchNavigate={onSearchNavigate}
      />
    )
  }

  return (
    <CloudDocsKnowledgeTreePanel
      organizationId={organizationId}
      tabScopeKey={tabScopeKey}
      resourceHostSpaceId={resourceHostSpaceId}
      onCreateResource={onCreateResource}
    />
  )
}

CloudDocsKnowledgePanel.displayName = 'CloudDocsKnowledgePanel'

const CloudDocsKnowledgeTreePanel: React.FC<{
  organizationId: string
  tabScopeKey: string
  resourceHostSpaceId?: string | null
  onCreateResource: (appId: string, options?: CreateResourceOptions) => void
}> = ({ organizationId, tabScopeKey, resourceHostSpaceId = null, onCreateResource }) => {
  const { t } = useTranslation(['context', 'sidebar'])
  const [feishuImportOpen, setFeishuImportOpen] = useState(false)
  const storeOrganizationId = useOrganizationStore(state => state.getEffectiveOrganizationId())
  const spaces = useSpaceStore(state => state.spaces)
  const effectiveOrganizationId = resolveEffectiveCloudDocsOrganizationId(
    organizationId,
    storeOrganizationId,
  )
  const feishuImportEnabled = useEffectiveFeature('feishu_import', effectiveOrganizationId).enabled
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
  const space = hostSpace
  const tabOrder = useSpaceContextTabsStore(state => state.tabOrderBySpace[tabScopeKey] ?? EMPTY_TAB_ORDER)
  const activeTabKey = useSpaceContextTabsStore(
    state => state.activeKeyBySpace[tabScopeKey] ?? null,
  )
  const tableSource = useTableContextSource({
    spaceId: effectiveHostSpaceId ?? '',
    tabScopeKey,
    tabOrder,
  })
  const { openDocument, openTable } = useSpaceContextNavigation({
    spaceId: effectiveHostSpaceId ?? '',
    tabScopeKey,
    spaceName: space?.name,
    tables: tableSource.tables,
  })

  const expandedNodeIds = useSpaceViewPrefsStore(
    state => state.cloudDocsExpandedNodeIdsByScopeKey[tabScopeKey] ?? EMPTY_EXPANDED_NODE_IDS,
  )
  const toggleCloudDocsExpandedNode = useSpaceViewPrefsStore(
    state => state.toggleCloudDocsExpandedNode,
  )
  const setCloudDocsExpandedNodeIds = useSpaceViewPrefsStore(
    state => state.setCloudDocsExpandedNodeIds,
  )

  const treeData = useKnowledgeTree(state => state.treesByOrganizationId[effectiveOrganizationId])
  const isLoading = useKnowledgeTree(state => state.loadingByOrganizationId[effectiveOrganizationId] ?? false)
  const error = useKnowledgeTree(state => state.errorByOrganizationId[effectiveOrganizationId] ?? null)
  const loadTree = useKnowledgeTree(state => state.loadTree)
  const loadNodeChildren = useKnowledgeTree(state => state.loadNodeChildren)

  const refreshTree = useCallback(() => {
    if (effectiveOrganizationId === CLOUD_DOCS_PLACEHOLDER_ORG_ID) return
    // 静默 force reload：保留旧树直到新数据到达，避免骨架闪动
    void loadTree(effectiveOrganizationId, {
      depth: KNOWLEDGE_TREE_DEFAULT_DEPTH,
      force: true,
    })
  }, [loadTree, effectiveOrganizationId])

  useKnowledgeTreeEventSync({
    organizationId: effectiveOrganizationId,
    enabled: effectiveOrganizationId !== CLOUD_DOCS_PLACEHOLDER_ORG_ID,
  })

  useEffect(() => {
    if (!isLoadableResourceHostSpaceId(effectiveHostSpaceId)) return
    // ：云文档知识树不加载 Collection store；仅预热组织资源缓存供右键菜单
    void useUnifiedResources.getState().load(effectiveHostSpaceId, false, 'organization')
  }, [effectiveHostSpaceId])

  const createHandlers = useMemo(() => {
    const wrap = (appId: string): CreateResourceHandler => (options?: CreateResourceOptions) => {
      onCreateResource(appId, options)
    }
    return {
      tabdoc: wrap('tabdoc'),
      tabdata: wrap('tabdata'),
    } satisfies Record<string, CreateResourceHandler>
  }, [onCreateResource])

  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    if (effectiveOrganizationId === CLOUD_DOCS_PLACEHOLDER_ORG_ID) return
    // ：进入云文档必须与后端对账。删除事件可能发生在本面板未挂载期间，
    // 或缺 organization_id 无法做模块级乐观移除；不能直接复用旧树缓存。
    void loadTree(effectiveOrganizationId, {
      depth: KNOWLEDGE_TREE_DEFAULT_DEPTH,
      force: true,
    })
  }, [loadTree, effectiveOrganizationId])

  // 已打开 tab 若缺 title（历史 openTableTab 未写入），用知识树名称回填，避免 Dock 显示 UUID
  useEffect(() => {
    const rootsForSync = treeData?.roots
    if (!rootsForSync?.length) return
    const items = useSpaceContextTabsStore.getState().itemsBySpace[tabScopeKey] ?? {}
    const syncTitle = useSpaceContextTabsStore.getState().syncOpenResourceTabTitle
    const walk = (nodes: KnowledgeTreeNode[]) => {
      for (const node of nodes) {
        if (
          node.resource_id
          && node.title?.trim()
          && (node.node_type === 'tabdoc' || node.node_type === 'tabdata')
        ) {
          const tabKey = `${node.node_type}:${node.resource_id}`
          const item = items[tabKey]
          const current = item?.title?.trim()
          if (item && (!current || current === node.resource_id)) {
            syncTitle({
              type: node.node_type,
              id: node.resource_id,
              title: node.title,
            })
          }
        }
        if (node.children?.length) walk(node.children)
      }
    }
    walk(rootsForSync)
  }, [tabScopeKey, treeData?.roots])

  const roots = treeData?.roots ?? []

  const treeController = useCloudDocsKnowledgeTreeController({
    resourceHostSpaceId: effectiveHostSpaceId ?? '',
    organizationId: effectiveOrganizationId,
    roots,
    createHandlers,
    onTreeMutated: refreshTree,
    onDocumentNested: parentNodeId => {
      // 确保展开（勿 toggle：已展开时再 toggle 会把刚挂上的子节点收起）
      const current = useSpaceViewPrefsStore.getState()
        .cloudDocsExpandedNodeIdsByScopeKey[tabScopeKey] ?? EMPTY_EXPANDED_NODE_IDS
      if (!current.includes(parentNodeId)) {
        setCloudDocsExpandedNodeIds(tabScopeKey, [...current, parentNodeId])
      }
    },
  })

  const contextMenu = useResourceContextMenu(effectiveHostSpaceId ?? '')
  // Overlay 签名仍要求 folderConfirm；知识树无 Collection 节点，确认框不会触发
  const folderConfirm = useRemoveFolderConfirm(effectiveHostSpaceId ?? '')

  const handleResourceContextMenu = useCallback((
    event: React.MouseEvent,
    node: KnowledgeTreeNode,
  ) => {
    if (!effectiveHostSpaceId) return
    if (!node.context_item_id) return
    contextMenu.handleContextMenu(
      event,
      resolveContextItemForMenu(
        node,
        effectiveHostSpaceId,
        effectiveOrganizationId,
        useUnifiedResources.getState().resourcesBySpaceId,
      ),
    )
  }, [contextMenu, effectiveHostSpaceId, effectiveOrganizationId])

  const searchMatches = useMemo(() => {
    const q = searchQuery.trim()
    if (!q) return null
    return flattenKnowledgeTreeSearchMatches(treeData?.roots ?? [], q)
  }, [searchQuery, treeData?.roots])

  const expandedSet = useMemo(() => {
    const set = new Set(expandedNodeIds)
    const activeResourceId = activeTabKey?.includes(':')
      ? activeTabKey.split(':').slice(1).join(':')
      : null
    if (activeResourceId && treeData?.roots?.length) {
      for (const root of treeData.roots) {
        const walk = (node: KnowledgeTreeNode): string[] | null => {
          if (node.resource_id === activeResourceId) return [node.id]
          for (const child of node.children ?? []) {
            const childPath = walk(child)
            if (childPath) return [node.id, ...childPath]
          }
          return null
        }
        const path = walk(root)
        if (path) {
          for (const nodeId of path.slice(0, -1)) set.add(nodeId)
          break
        }
      }
    }
    return set
  }, [activeTabKey, expandedNodeIds, treeData?.roots])

  // 已展开但被 depth 截断的节点：自动补拉子节点（修 1-1 下有 1-1-1 却展不开）
  useEffect(() => {
    if (effectiveOrganizationId === CLOUD_DOCS_PLACEHOLDER_ORG_ID) return
    if (!treeData?.roots?.length || expandedSet.size === 0) return
    const walk = (nodes: KnowledgeTreeNode[]) => {
      for (const node of nodes) {
        if (expandedSet.has(node.id) && nodeNeedsLazyChildren(node)) {
          void loadNodeChildren(effectiveOrganizationId, node)
        }
        if (node.children?.length) walk(node.children)
      }
    }
    walk(treeData.roots)
  }, [effectiveOrganizationId, expandedSet, loadNodeChildren, treeData?.roots])

  const handleToggleExpand = useCallback((node: KnowledgeTreeNode) => {
    void treeController.handleToggleExpand(node, nodeId => {
      toggleCloudDocsExpandedNode(tabScopeKey, nodeId)
    })
  }, [tabScopeKey, toggleCloudDocsExpandedNode, treeController])

  const handleOpenNode = useCallback((node: KnowledgeTreeNode) => {
    if (!node.resource_id) return
    if (node.node_type === 'tabdoc') {
      openDocument(node.resource_id, node.title)
    } else if (node.node_type === 'tabdata') {
      // 传入 name，避免「当前打开」Dock 在 title 未写入时回退成 UUID
      openTable(node.resource_id, {
        id: node.resource_id,
        name: node.title || '',
      } as Table)
    } else {
      return
    }
    // ：知识树打开不经 useResourceInit，需自行记访问，否则「最近」无本人打开记录
    // context_item_id 与 node.id 在服务端同源；优先前者，缺省回落 id
    recordContextItemAccess(node.context_item_id ?? node.id)
  }, [openDocument, openTable])

  const handleSearchResultOpen = useCallback((node: KnowledgeTreeNode) => {
    if (treeData?.roots?.length) {
      const ancestors = collectAncestorNodeIds(treeData.roots, node.id)
      if (ancestors.length) {
        setCloudDocsExpandedNodeIds(tabScopeKey, Array.from(new Set([...expandedNodeIds, ...ancestors])))
      }
    }
    handleOpenNode(node)
  }, [expandedNodeIds, handleOpenNode, setCloudDocsExpandedNodeIds, tabScopeKey, treeData?.roots])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className={cn('flex shrink-0 items-center gap-2 pb-2', SIDEBAR_EMBEDDED_CONTROL_INSET)}>
        <div
          className={cn(
            'flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[12px] bg-foreground/[0.025] px-2.5',
            'transition-colors duration-200 focus-within:bg-foreground/[0.04]',
            'dark:bg-black/10 dark:focus-within:bg-foreground/[0.06]',
          )}
        >
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
          <input
            type="search"
            value={searchQuery}
            onChange={event => setSearchQuery(event.target.value)}
            placeholder={t('sidebar:cloudDocs.tree.searchPlaceholder', { defaultValue: '搜索文档与表格…' })}
            aria-label={t('sidebar:cloudDocs.tree.searchPlaceholder', { defaultValue: '搜索文档与表格…' })}
            className="min-w-0 flex-1 border-0 bg-transparent text-body leading-[22px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
          />
        </div>
        <SidebarCloudDocsCreateButton
          onCreateResource={onCreateResource}
          onImportFeishu={feishuImportEnabled ? () => setFeishuImportOpen(true) : undefined}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <CloudDocsKnowledgeTree
          roots={roots}
          isLoading={Boolean(isLoading && !treeData)}
          error={error}
          activeTabKey={activeTabKey}
          expandedNodeIds={expandedSet}
          searchMatches={searchMatches}
          dragOverTarget={treeController.dragOverTarget}
          reorderTarget={treeController.reorderTarget}
          onToggleExpand={handleToggleExpand}
          onOpenNode={searchMatches ? handleSearchResultOpen : handleOpenNode}
          onCreateFromNode={treeController.handleCreateFromNode}
          onResourceMoreMenu={handleResourceContextMenu}
          onResourceDragStart={treeController.handleResourceDragStart}
          onResourceDragOver={treeController.handleResourceDragOver}
          onResourceDrop={treeController.handleResourceDrop}
          onResourceContextMenu={handleResourceContextMenu}
          onDragEnd={treeController.handleDragEnd}
          onRetry={refreshTree}
        />
      </div>

      {effectiveHostSpaceId ? (
        <>
          <ResourceContextMenuOverlay
            spaceId={effectiveHostSpaceId}
            menuState={contextMenu.menuState}
            onClose={contextMenu.closeMenu}
            onTogglePin={contextMenu.handleTogglePin}
            onRename={contextMenu.handleRename}
            onArchive={contextMenu.handleArchive}
            folderConfirm={folderConfirm}
          />
          {feishuImportEnabled ? (
            <FeishuImportDialog
              open={feishuImportOpen}
              onOpenChange={setFeishuImportOpen}
              organizationId={effectiveOrganizationId}
              spaceId={effectiveHostSpaceId}
              collectionId={null}
            />
          ) : null}
        </>
      ) : null}
    </div>
  )
}
