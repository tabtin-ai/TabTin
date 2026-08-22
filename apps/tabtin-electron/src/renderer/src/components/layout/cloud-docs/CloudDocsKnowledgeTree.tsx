/**
 * Notion 式云文档知识库树 — 侧栏「全部」视图（P2：hover 操作 + DnD + lazy）。
 */
import React, { useCallback, useMemo } from 'react'
import { ChevronRight, MoreHorizontal, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  ScrollArea,
} from '@components/ui'
import { SidebarMenuItem } from '@components/layout/SidebarMenuItem'
import { SidebarTypeEmoji } from '@components/layout/sidebarTypeEmoji'
import { ResourceCollectionSkeleton } from '@components/common/ListSkeletons'
import { contextRegistry } from '@components/context-space/registry'
import type { KnowledgeTreeNode } from '@/services/spaceApi'
import { cn } from '@utils/cn'
import {
  SIDEBAR_CHEVRON,
  SIDEBAR_ICON_SM,
  SIDEBAR_ICON_STROKE,
  SIDEBAR_INLINE_ACTION,
  SIDEBAR_LIST_PANEL,
  SIDEBAR_LIST_PANEL_SCROLL,
  SIDEBAR_SCROLLBAR_TYPE,
  SIDEBAR_TREE_INDENT_BASE,
  SIDEBAR_TREE_INDENT_STEP,
} from '@components/layout/sidebarUi'
import { canCreateKnowledgeTreeChild } from '@/stores/useKnowledgeTree'
import {
  collectAncestorNodeIds,
  isTreeNodeActive,
  type FlatKnowledgeTreeMatch,
} from './knowledgeTreeUtils'
import type { ReorderDropTarget } from './useCloudDocsKnowledgeTreeController'
import { CloudDocsListLoadError } from './CloudDocsListLoadError'

interface CloudDocsKnowledgeTreeProps {
  roots: KnowledgeTreeNode[]
  isLoading: boolean
  error: string | null
  activeTabKey: string | null
  expandedNodeIds: Set<string>
  searchMatches: FlatKnowledgeTreeMatch[] | null
  dragOverTarget?: string | null
  onToggleExpand: (node: KnowledgeTreeNode) => void
  onOpenNode: (node: KnowledgeTreeNode) => void
  onCreateFromNode?: (node: KnowledgeTreeNode, appId: string, depth?: number) => void
  onResourceMoreMenu?: (event: React.MouseEvent, node: KnowledgeTreeNode) => void
  onResourceDragStart?: (event: React.DragEvent, node: KnowledgeTreeNode, parent: KnowledgeTreeNode | null) => void
  onResourceDragOver?: (event: React.DragEvent, node: KnowledgeTreeNode, parent: KnowledgeTreeNode | null) => void
  onResourceDrop?: (event: React.DragEvent, node: KnowledgeTreeNode, parent: KnowledgeTreeNode | null) => void
  onResourceContextMenu?: (event: React.MouseEvent, node: KnowledgeTreeNode) => void
  onDragEnd?: () => void
  reorderTarget?: ReorderDropTarget | null
  /** 加载失败时「重新加载」——由面板 force reload 知识树 */
  onRetry?: () => void
}

function treeIndent(depth: number): number {
  return SIDEBAR_TREE_INDENT_BASE + depth * SIDEBAR_TREE_INDENT_STEP
}

/** 折叠箭头叠在行既有 padding 区内，不挤占 leading（与 SidebarMenuItem indent 的 0.75rem 基线对齐） */
function treeExpandGutterLeft(indentPx: number): string {
  return `calc(0.75rem + ${indentPx}px - 14px)`
}

/** 知识树当前打开行：主题色半透明底，比中性 surface-row-active 更易辨认 */
const TREE_ROW_ACTIVE =
  'bg-accent/15 text-foreground dark:bg-accent/20'

export const CloudDocsKnowledgeTree: React.FC<CloudDocsKnowledgeTreeProps> = ({
  roots,
  isLoading,
  error,
  activeTabKey,
  expandedNodeIds,
  searchMatches,
  dragOverTarget,
  onToggleExpand,
  onOpenNode,
  onCreateFromNode,
  onResourceMoreMenu,
  onResourceDragStart,
  onResourceDragOver,
  onResourceDrop,
  onResourceContextMenu,
  onDragEnd,
  reorderTarget,
  onRetry,
}) => {
  const { t } = useTranslation(['context', 'sidebar'])

  const cloudQuickActions = useMemo(
    () => contextRegistry.getQuickActions().filter(handler => {
      const appId = handler.appId ?? (handler.type as string)
      return appId === 'tabdoc' || appId === 'tabdata'
    }),
    [],
  )

  const renderNodeActions = useCallback((node: KnowledgeTreeNode, depth: number) => {
    const canCreateChild = Boolean(onCreateFromNode) && canCreateKnowledgeTreeChild(depth)
    const showResourceMore = Boolean(onResourceMoreMenu)
    if (!canCreateChild && !showResourceMore) return null

    return (
      <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/knode:opacity-100">
        {canCreateChild ? (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={SIDEBAR_INLINE_ACTION}
                aria-label={t('home.assetBrowser.createAction', { defaultValue: '新建' })}
                data-testid={`cloud-docs-tree-create-${node.id}`}
                onClick={event => event.stopPropagation()}
              >
                <Plus className={SIDEBAR_ICON_SM} strokeWidth={SIDEBAR_ICON_STROKE} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-[168px]" sideOffset={4}>
              {cloudQuickActions.map(handler => {
                const appId = handler.appId ?? (handler.type as string)
                return (
                  <DropdownMenuItem
                    key={appId}
                    className="gap-2"
                    onSelect={() => onCreateFromNode?.(node, appId, depth)}
                  >
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:h-3.5 [&_svg]:w-3.5">
                      {handler.quickAction.icon}
                    </span>
                    <span className="text-body text-foreground/80">
                      {t(handler.quickAction.shortLabelKey ?? handler.quickAction.labelKey)}
                    </span>
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        {showResourceMore ? (
          <button
            type="button"
            className={SIDEBAR_INLINE_ACTION}
            aria-label={t('sidebar.moreActions', { defaultValue: '更多' })}
            onClick={event => {
              event.stopPropagation()
              onResourceMoreMenu?.(event, node)
            }}
          >
            <MoreHorizontal className={SIDEBAR_ICON_SM} strokeWidth={SIDEBAR_ICON_STROKE} />
          </button>
        ) : null}
      </span>
    )
  }, [cloudQuickActions, onCreateFromNode, onResourceMoreMenu, t])

  const renderNode = useCallback((
    node: KnowledgeTreeNode,
    depth: number,
    parent: KnowledgeTreeNode | null,
  ) => {
    // ：文档/表格可挂子节点；有子节点时必须能展开
    const hasChildren = (node.children?.length ?? 0) > 0 || node.child_count > 0
    const showExpandControl = hasChildren
    const expanded = expandedNodeIds.has(node.id)
    const active = isTreeNodeActive(node, activeTabKey)
    const isDragOver = dragOverTarget === `item:${node.id}`
    const isReorderBefore = reorderTarget?.kind !== 'nest'
      && reorderTarget?.nodeId === node.id
      && reorderTarget?.pos === 'before'
    const isReorderAfter = reorderTarget?.kind !== 'nest'
      && reorderTarget?.nodeId === node.id
      && reorderTarget?.pos === 'after'
    const isNestTarget = reorderTarget?.kind === 'nest' && reorderTarget.nodeId === node.id
    const canCreateChild = Boolean(onCreateFromNode) && canCreateKnowledgeTreeChild(depth)
    const hasInlineActions = canCreateChild || Boolean(onResourceMoreMenu)
    const rowAs: 'button' | 'div' = hasInlineActions ? 'div' : 'button'

    const handleRowClick = () => {
      onOpenNode(node)
    }

    const handleChevronClick = (event: React.MouseEvent) => {
      event.stopPropagation()
      onToggleExpand(node)
    }

    const indentPx = treeIndent(depth)

    return (
      <React.Fragment key={node.id}>
        {isReorderBefore ? <div className="mx-2 h-0.5 rounded-full bg-accent/40" /> : null}
        <SidebarMenuItem
          as={rowAs}
          reserveActions={hasInlineActions}
          active={active}
          activeClassName={TREE_ROW_ACTIVE}
          indent={indentPx}
          className={cn(
            'group/knode',
            rowAs === 'div' && 'cursor-pointer',
            isDragOver && 'bg-foreground/[0.045] ring-1 ring-ring/30',
            isNestTarget && 'bg-accent/10 ring-1 ring-accent/35',
          )}
          role={rowAs === 'div' ? 'button' : undefined}
          tabIndex={rowAs === 'div' ? 0 : undefined}
          onKeyDown={rowAs === 'div'
            ? event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                handleRowClick()
              }
            }
            : undefined}
          draggable={Boolean(onResourceDragStart)}
          onDragStart={
            onResourceDragStart
              ? event => onResourceDragStart(event, node, parent)
              : undefined
          }
          onDragEnd={onDragEnd}
          onDragOver={event => {
            onResourceDragOver?.(event, node, parent)
          }}
          onDrop={event => {
            if (onResourceDrop) {
              void onResourceDrop(event, node, parent)
            }
          }}
          onContextMenu={onResourceContextMenu
            ? event => {
              event.preventDefault()
              event.stopPropagation()
              onResourceContextMenu(event, node)
            }
            : undefined}
          leading={(
            <>
              {showExpandControl ? (
                <button
                  type="button"
                  className={cn(
                    'absolute top-1/2 z-[1] flex h-3.5 w-3.5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground/60 transition-colors hover:bg-foreground/[0.06] hover:text-foreground',
                    !hasChildren && 'pointer-events-none opacity-0',
                  )}
                  style={{ left: treeExpandGutterLeft(indentPx) }}
                  aria-expanded={expanded}
                  aria-label={expanded ? 'Collapse' : 'Expand'}
                  data-testid={`cloud-docs-tree-expand-${node.id}`}
                  onClick={handleChevronClick}
                >
                  <ChevronRight
                    className={cn(SIDEBAR_CHEVRON, 'transition-transform', expanded && 'rotate-90')}
                    strokeWidth={SIDEBAR_ICON_STROKE}
                  />
                </button>
              ) : null}
              {node.icon ? (
                <span className="text-body">{node.icon}</span>
              ) : (
                <SidebarTypeEmoji appIdOrType={node.node_type} active={active} />
              )}
            </>
          )}
          label={node.title || t('home.untitledResource', { defaultValue: '未命名' })}
          trailing={renderNodeActions(node, depth)}
          onClick={handleRowClick}
          data-testid={`cloud-docs-tree-node-${node.node_type}-${node.id}`}
        />
        {isReorderAfter ? <div className="mx-2 h-0.5 rounded-full bg-accent/40" /> : null}
        {expanded && hasChildren && (node.children?.length ?? 0) === 0 ? (
          <div
            className="px-2.5 py-1 text-body text-muted-foreground/70"
            style={{ paddingLeft: treeIndent(depth + 1) }}
          >
            {t('sidebar:cloudDocs.tree.loadingChildren', { defaultValue: '加载中…' })}
          </div>
        ) : null}
        {expanded ? (node.children ?? []).map((child: KnowledgeTreeNode) => renderNode(child, depth + 1, node)) : null}
      </React.Fragment>
    )
  }, [
    activeTabKey,
    dragOverTarget,
    expandedNodeIds,
    onDragEnd,
    onOpenNode,
    onResourceContextMenu,
    onResourceDragOver,
    onResourceDragStart,
    onResourceDrop,
    onToggleExpand,
    renderNodeActions,
    reorderTarget,
    t,
  ])

  const searchRows = useMemo(() => {
    if (!searchMatches?.length) return null
    return searchMatches.map(({ node, path }) => (
      <SidebarMenuItem
        key={`search-${node.id}`}
        as="button"
        fullWidth
        active={isTreeNodeActive(node, activeTabKey)}
        activeClassName={TREE_ROW_ACTIVE}
        leading={node.icon ? (
          <span className="text-body">{node.icon}</span>
        ) : (
          <SidebarTypeEmoji appIdOrType={node.node_type} active={isTreeNodeActive(node, activeTabKey)} />
        )}
        label={node.title || node.id}
        meta={path.slice(0, -1).join(' / ') || undefined}
        onClick={() => onOpenNode(node)}
        data-testid={`cloud-docs-tree-search-${node.id}`}
      />
    ))
  }, [activeTabKey, onOpenNode, searchMatches])

  if (isLoading) {
    return (
      <div className={SIDEBAR_LIST_PANEL}>
        <ResourceCollectionSkeleton mode="list" count={7} />
      </div>
    )
  }

  // ：无缓存才整页失败态；有旧树时保留列表，避免断网刷新失败把可用目录挡死
  if (error && roots.length === 0) {
    // 与 cloudResources 侧栏失败态同壳：SIDEBAR_LIST_PANEL + ScrollArea，顶区水平居中
    return (
      <div className={cn(SIDEBAR_LIST_PANEL, 'flex min-h-0 flex-1 flex-col')}>
        <ScrollArea
          className={SIDEBAR_LIST_PANEL_SCROLL}
          scrollBar="vertical"
          type={SIDEBAR_SCROLLBAR_TYPE}
        >
          {onRetry ? (
            // 与「最近 / 分享给我」一致：用 i18n 失败文案，不把 ENOTFOUND 等英文技术错误直接甩给用户
            <CloudDocsListLoadError onRetry={onRetry} />
          ) : (
            <div className="px-2.5 py-6 text-center text-body text-destructive">
              {t('home.source.sharedLoadError', { defaultValue: '加载失败，请重试' })}
            </div>
          )}
        </ScrollArea>
      </div>
    )
  }

  if (searchMatches) {
    // 与目录树同壳：不套独立「搜索结果」卡片头，行用 fullWidth 铺满
    return (
      <div className={cn(SIDEBAR_LIST_PANEL, 'flex min-h-0 flex-1 flex-col')}>
        <ScrollArea className={SIDEBAR_LIST_PANEL_SCROLL} scrollBar="vertical" type={SIDEBAR_SCROLLBAR_TYPE}>
          {searchRows}
          {!searchMatches.length ? (
            <div className="px-2.5 py-3 text-center text-body text-muted-foreground">
              {t('home.assetBrowser.searchNoResults', { defaultValue: '没有匹配的结果' })}
            </div>
          ) : null}
        </ScrollArea>
      </div>
    )
  }

  return (
    <div className={cn(SIDEBAR_LIST_PANEL, 'flex min-h-0 flex-1 flex-col')}>
      <ScrollArea className={SIDEBAR_LIST_PANEL_SCROLL} scrollBar="vertical" type={SIDEBAR_SCROLLBAR_TYPE}>
        {error && onRetry ? (
          <CloudDocsListLoadError onRetry={onRetry} className="py-3" />
        ) : null}
        {roots.length === 0 ? (
          <div className="px-2.5 py-3 text-center text-body text-muted-foreground">
            {t('sidebar:cloudDocs.tree.empty', { defaultValue: '还没有文档或表格' })}
          </div>
        ) : (
          roots.map(node => renderNode(node, 0, null))
        )}
      </ScrollArea>
    </div>
  )
}

CloudDocsKnowledgeTree.displayName = 'CloudDocsKnowledgeTree'

export { collectAncestorNodeIds }
