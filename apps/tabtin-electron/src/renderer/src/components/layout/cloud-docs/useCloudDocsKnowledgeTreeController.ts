/**
 * 云文档知识库树 — 交互控制器（DnD / 创建 / ContextItem.parent 嵌套）。
 * ：与云盘 Collection 文件夹完全解耦；不再创建/拖拽/重排 folder 节点。
 */
import { useCallback, useRef, useState } from 'react'
import { toast } from '@components/ui'
import { useTranslation } from 'react-i18next'
import { canCreateKnowledgeTreeChild, useKnowledgeTree } from '@/stores/useKnowledgeTree'
import {
  buildCollectionDragItem,
  type CollectionDragItem,
} from '@components/context-space/hooks/useCollectionDnD'
import { SpaceApiService, type KnowledgeTreeNode } from '@/services/spaceApi'
import type { CreateResourceHandler } from '@components/context-space/hooks/useCreateHandlers'
import { createCloudResourceInFolder } from '@components/context-space/registry/homeSections/createCloudResourceInFolder'
import {
  buildResourceSiblingGroupKey,
  canNestItemUnderTarget,
  computeReorderedIds,
  findKnowledgeTreeNodeDepth,
  getResourceSiblings,
  KNOWLEDGE_ITEM_REORDER_MIME,
  nodeNeedsLazyChildren,
  resolveCreateContextFromNode,
  resolveResourceDragDropZone,
  type KnowledgeItemReorderPayload,
} from './knowledgeTreeUtils'

export type ReorderDropTarget =
  | { nodeId: string; pos: 'before' | 'after'; kind: 'resource' }
  | { nodeId: string; kind: 'nest' }

interface UseCloudDocsKnowledgeTreeControllerOptions {
  /** 兼容锚点（创建资源等遗留路径）；知识树排序已改走 organization API。 */
  resourceHostSpaceId: string
  organizationId: string
  roots: KnowledgeTreeNode[]
  createHandlers: Record<string, CreateResourceHandler>
  onTreeMutated: () => void
  onDocumentNested?: (parentNodeId: string) => void
}

function parseItemReorderPayload(raw: string): KnowledgeItemReorderPayload | null {
  try {
    const parsed = JSON.parse(raw) as KnowledgeItemReorderPayload
    if (!parsed?.contextItemId || !parsed?.siblingGroupKey) return null
    return {
      ...parsed,
      resourceId: parsed.resourceId ?? null,
      nodeType: parsed.nodeType ?? 'tabdoc',
    }
  } catch {
    return null
  }
}

export function useCloudDocsKnowledgeTreeController({
  resourceHostSpaceId: _resourceHostSpaceId,
  organizationId,
  roots,
  createHandlers,
  onTreeMutated,
  onDocumentNested,
}: UseCloudDocsKnowledgeTreeControllerOptions) {
  const { t } = useTranslation(['context', 'sidebar'])

  const loadNodeChildren = useKnowledgeTree(state => state.loadNodeChildren)
  const [reorderTarget, setReorderTarget] = useState<ReorderDropTarget | null>(null)
  const activeItemReorderRef = useRef<KnowledgeItemReorderPayload | null>(null)
  const activeDragItemRef = useRef<CollectionDragItem | null>(null)
  const [dragOverTarget] = useState<string | null>(null)

  const clearReorderTarget = useCallback(() => {
    setReorderTarget(null)
  }, [])

  const handleToggleExpand = useCallback(async (
    node: KnowledgeTreeNode,
    toggle: (nodeId: string) => void,
  ) => {
    toggle(node.id)
    if (!organizationId || !nodeNeedsLazyChildren(node)) return
    await loadNodeChildren(organizationId, node)
  }, [loadNodeChildren, organizationId])

  const handleCreateFromNode = useCallback((node: KnowledgeTreeNode, appId: string, depth = 0) => {
    if (!canCreateKnowledgeTreeChild(depth)) {
      toast.info(t('sidebar:cloudDocs.tree.maxNestingDepth', {
        defaultValue: '最多嵌套 4 层，无法继续添加子文档',
      }))
      return
    }
    const ctx = resolveCreateContextFromNode(node)
    createCloudResourceInFolder(createHandlers, appId, null, {
      parentDocumentId: ctx.parentDocumentId,
      parentItemId: ctx.parentItemId,
    })
    onDocumentNested?.(node.id)
    if (organizationId) {
      void loadNodeChildren(organizationId, node)
    }
  }, [createHandlers, loadNodeChildren, onDocumentNested, organizationId, t])

  const handleResourceDragStart = useCallback((
    event: React.DragEvent,
    node: KnowledgeTreeNode,
    parent: KnowledgeTreeNode | null,
  ) => {
    if (!node.context_item_id) return
    const dragItem = buildCollectionDragItem({
      id: node.context_item_id,
      collection_id: node.collection_id,
      resource_id: node.resource_id ?? undefined,
    })
    if (!dragItem) return
    activeDragItemRef.current = dragItem
    const reorderPayload: KnowledgeItemReorderPayload = {
      contextItemId: node.context_item_id,
      siblingGroupKey: buildResourceSiblingGroupKey(parent),
      collectionId: node.collection_id,
      resourceId: node.resource_id,
      nodeType: node.node_type,
    }
    activeItemReorderRef.current = reorderPayload
    event.dataTransfer.setData('application/x-collection-item', JSON.stringify(dragItem))
    event.dataTransfer.setData(KNOWLEDGE_ITEM_REORDER_MIME, JSON.stringify(reorderPayload))
    event.dataTransfer.effectAllowed = 'move'
  }, [])

  const handleResourceDragOver = useCallback((
    event: React.DragEvent,
    node: KnowledgeTreeNode,
    parent: KnowledgeTreeNode | null,
  ) => {
    if (!event.dataTransfer.types.includes(KNOWLEDGE_ITEM_REORDER_MIME)) return
    const payload = activeItemReorderRef.current
    if (!payload || payload.contextItemId === node.context_item_id) return

    const canReorder = payload.siblingGroupKey === buildResourceSiblingGroupKey(parent)
    const targetDepth = findKnowledgeTreeNodeDepth(roots, node.id) ?? 0
    const canNest = canNestItemUnderTarget(payload, node, roots, targetDepth)
    if (!canReorder && !canNest) return

    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const relY = (event.clientY - rect.top) / rect.height
    const zone = resolveResourceDragDropZone(relY, canReorder, canNest)
    if (!zone) return

    if (zone === 'nest') {
      setReorderTarget({ nodeId: node.id, kind: 'nest' })
      return
    }
    setReorderTarget({
      nodeId: node.id,
      pos: zone,
      kind: 'resource',
    })
  }, [roots])

  const handleResourceDrop = useCallback(async (
    event: React.DragEvent,
    node: KnowledgeTreeNode,
    parent: KnowledgeTreeNode | null,
  ) => {
    if (!event.dataTransfer.types.includes(KNOWLEDGE_ITEM_REORDER_MIME)) return
    event.preventDefault()
    event.stopPropagation()

    const payload = activeItemReorderRef.current
      ?? parseItemReorderPayload(event.dataTransfer.getData(KNOWLEDGE_ITEM_REORDER_MIME))
    const nestTarget = reorderTarget?.kind === 'nest' && reorderTarget.nodeId === node.id
      ? reorderTarget
      : null
    const reorderTargetMatch = reorderTarget?.kind === 'resource' && reorderTarget.nodeId === node.id
      ? reorderTarget
      : null
    clearReorderTarget()
    if (!payload) return

    if (nestTarget) {
      const targetDepth = findKnowledgeTreeNodeDepth(roots, node.id) ?? 0
      if (!canNestItemUnderTarget(payload, node, roots, targetDepth)) return
      if (!node.context_item_id) return

      try {
        await SpaceApiService.updateContextItemParent(
          payload.contextItemId,
          node.context_item_id,
        )
        onDocumentNested?.(node.id)
        if (nodeNeedsLazyChildren(node) || (node.children?.length ?? 0) === 0) {
          void loadNodeChildren(organizationId, node)
        }
        onTreeMutated()
      } catch (error) {
        toast.error(t('errorToast.documentNestFailed', { defaultValue: '移入子页失败' }))
        console.error('[CloudDocsKnowledgeTree] nest item failed', error)
      }
      return
    }

    if (!reorderTargetMatch || !node.context_item_id) return
    if (payload.siblingGroupKey !== buildResourceSiblingGroupKey(parent)) return

    const siblings = getResourceSiblings(parent, roots)
    const currentIds = siblings
      .map(item => item.context_item_id)
      .filter((id): id is string => Boolean(id))
    const nextIds = computeReorderedIds(
      currentIds,
      payload.contextItemId,
      node.context_item_id,
      reorderTargetMatch.pos,
    )
    if (!nextIds || !organizationId) return

    try {
      // ：按 parent_id 同级重排，不要求 collection_id 为空
      const parentItemId = parent?.context_item_id ?? null
      await SpaceApiService.reorderKnowledgeTreeSiblings(organizationId, nextIds, parentItemId)
      onTreeMutated()
    } catch (error) {
      toast.error(t('errorToast.collectionReorderFailed', { defaultValue: '排序失败' }))
      console.error('[CloudDocsKnowledgeTree] resource reorder failed', error)
    }
  }, [
    clearReorderTarget,
    loadNodeChildren,
    onDocumentNested,
    onTreeMutated,
    organizationId,
    reorderTarget,
    roots,
    t,
  ])

  const handleDragEnd = useCallback(() => {
    activeDragItemRef.current = null
    activeItemReorderRef.current = null
    clearReorderTarget()
  }, [clearReorderTarget])

  return {
    dragOverTarget,
    reorderTarget,
    handleToggleExpand,
    handleCreateFromNode,
    handleResourceDragStart,
    handleResourceDragOver,
    handleResourceDrop,
    handleDragEnd,
    organizationId,
  }
}
