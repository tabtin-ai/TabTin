import { create } from 'zustand'
import {
  SpaceApiService,
  type KnowledgeTreeNode,
  type KnowledgeTreeResponse,
} from '@/services/spaceApi'
import {
  canCreateKnowledgeTreeChild,
  KNOWLEDGE_TREE_MAX_NESTING_DEPTH,
  mergeChildrenIntoTree,
} from '@components/layout/cloud-docs/knowledgeTreeUtils'
import { createLogger } from '@/utils/logger'

export {
  canCreateKnowledgeTreeChild,
  KNOWLEDGE_TREE_MAX_NESTING_DEPTH,
}

/** 初始拉树深度与最大嵌套对齐 */
export const KNOWLEDGE_TREE_DEFAULT_DEPTH = KNOWLEDGE_TREE_MAX_NESTING_DEPTH

const log = createLogger('KnowledgeTree')

/** 作废进行中的 loadTree，避免过期失败把已恢复的树重新打成 error */
const loadTreeGenerationByOrg = new Map<string, number>()

interface KnowledgeTreeState {
  treesByOrganizationId: Record<string, KnowledgeTreeResponse | undefined>
  loadingByOrganizationId: Record<string, boolean>
  loadingChildrenByNode: Record<string, boolean>
  errorByOrganizationId: Record<string, string | null>
  loadTree: (
    organizationId: string,
    options?: { depth?: number; force?: boolean },
  ) => Promise<KnowledgeTreeResponse | null>
  loadNodeChildren: (
    organizationId: string,
    node: KnowledgeTreeNode,
  ) => Promise<KnowledgeTreeNode[] | null>
  /** 就地改标题/更新时间，避免 content 保存触发整树闪动 */
  patchNodeMeta: (
    organizationId: string,
    patch: { resourceId?: string | null; contextItemId?: string | null; title?: string; updatedAt?: string | null },
  ) => void
  /**
   * ：删除/进回收站后乐观移除节点，并按后端 orphan 规则把子节点上提一级。
   * 随后仍应 force reload 对账。
   */
  removeNodeAndPromoteChildren: (
    organizationId: string,
    resourceId: string,
  ) => void
  invalidateTree: (organizationId: string) => void
}

function buildNodeLoadingKey(organizationId: string, nodeId: string): string {
  return `${organizationId}:${nodeId}`
}

function patchNodesMeta(
  nodes: KnowledgeTreeNode[],
  patch: { resourceId?: string | null; contextItemId?: string | null; title?: string; updatedAt?: string | null },
): { nodes: KnowledgeTreeNode[]; changed: boolean } {
  let changed = false
  const next = nodes.map(node => {
    const matchResource = patch.resourceId && node.resource_id === patch.resourceId
    const matchItem = patch.contextItemId && (
      node.id === patch.contextItemId || node.context_item_id === patch.contextItemId
    )
    let current = node
    if (matchResource || matchItem) {
      const title = typeof patch.title === 'string' ? patch.title : node.title
      const updated_at = patch.updatedAt !== undefined ? patch.updatedAt : node.updated_at
      if (title !== node.title || updated_at !== node.updated_at) {
        changed = true
        current = { ...node, title, updated_at }
      }
    }
    if (current.children?.length) {
      const childResult = patchNodesMeta(current.children, patch)
      if (childResult.changed) {
        changed = true
        current = { ...current, children: childResult.nodes }
      }
    }
    return current
  })
  return { nodes: changed ? next : nodes, changed }
}

/** 移除匹配 resource_id 的节点，并将其直接子节点提升到当前位置（对齐后端 promote_children_on_trash）。 */
function removeNodesAndPromoteChildren(
  nodes: KnowledgeTreeNode[],
  resourceId: string,
): { nodes: KnowledgeTreeNode[]; changed: boolean } {
  let changed = false
  const next: KnowledgeTreeNode[] = []

  for (const node of nodes) {
    if (node.resource_id === resourceId) {
      changed = true
      if (node.children?.length) {
        next.push(...node.children)
      }
      continue
    }

    let current = node
    if (node.children?.length) {
      const childResult = removeNodesAndPromoteChildren(node.children, resourceId)
      if (childResult.changed) {
        changed = true
        current = {
          ...node,
          children: childResult.nodes,
          child_count: Math.max(childResult.nodes.length, (node.child_count ?? 0) - 1),
        }
      }
    }
    next.push(current)
  }

  return { nodes: changed ? next : nodes, changed }
}

export const useKnowledgeTree = create<KnowledgeTreeState>((set, get) => ({
  treesByOrganizationId: {},
  loadingByOrganizationId: {},
  loadingChildrenByNode: {},
  errorByOrganizationId: {},

  loadTree: async (organizationId, options) => {
    if (!organizationId) return null
    if (!options?.force && get().treesByOrganizationId[organizationId]) {
      return get().treesByOrganizationId[organizationId] ?? null
    }

    const generation = (loadTreeGenerationByOrg.get(organizationId) ?? 0) + 1
    loadTreeGenerationByOrg.set(organizationId, generation)

    const hasCached = Boolean(get().treesByOrganizationId[organizationId])
    // 有缓存时静默刷新：不置 loading，避免侧栏整树 skeleton 闪动。
    // ：无论是否有缓存都清掉上次 error，否则成功后 sticky error 仍挡整树。
    set(state => ({
      ...(hasCached
        ? {}
        : {
            loadingByOrganizationId: {
              ...state.loadingByOrganizationId,
              [organizationId]: true,
            },
          }),
      errorByOrganizationId: { ...state.errorByOrganizationId, [organizationId]: null },
    }))

    try {
      const data = await SpaceApiService.listKnowledgeTree(organizationId, {
        item_types: 'tabdoc,tabdata',
        depth: options?.depth ?? KNOWLEDGE_TREE_DEFAULT_DEPTH,
        owned_only: true,
      })
      if (loadTreeGenerationByOrg.get(organizationId) !== generation) {
        log.info('忽略过期 loadTree 响应', { organizationId, generation })
        return data
      }
      set(state => ({
        treesByOrganizationId: { ...state.treesByOrganizationId, [organizationId]: data },
        loadingByOrganizationId: { ...state.loadingByOrganizationId, [organizationId]: false },
        errorByOrganizationId: { ...state.errorByOrganizationId, [organizationId]: null },
      }))
      return data
    } catch (error) {
      if (loadTreeGenerationByOrg.get(organizationId) !== generation) {
        log.info('忽略过期 loadTree 错误', { organizationId, generation })
        return null
      }
      const message = error instanceof Error ? error.message : 'Failed to load knowledge tree'
      log.warn('loadTree failed', { organizationId, generation, message })
      set(state => ({
        loadingByOrganizationId: { ...state.loadingByOrganizationId, [organizationId]: false },
        errorByOrganizationId: { ...state.errorByOrganizationId, [organizationId]: message },
      }))
      return null
    }
  },

  loadNodeChildren: async (organizationId, node) => {
    if (!organizationId || (node.node_type !== 'tabdoc' && node.node_type !== 'tabdata')) {
      return []
    }
    const nodeKey = buildNodeLoadingKey(organizationId, node.id)
    if (get().loadingChildrenByNode[nodeKey]) {
      return null
    }

    set(state => ({
      loadingChildrenByNode: { ...state.loadingChildrenByNode, [nodeKey]: true },
    }))

    try {
      const data = await SpaceApiService.listKnowledgeTreeChildren(organizationId, node.id, {
        node_type: node.node_type,
        item_types: 'tabdoc,tabdata',
        owned_only: true,
      })
      set(state => {
        const existing = state.treesByOrganizationId[organizationId]
        if (!existing) {
          return {
            loadingChildrenByNode: { ...state.loadingChildrenByNode, [nodeKey]: false },
          }
        }
        return {
          treesByOrganizationId: {
            ...state.treesByOrganizationId,
            [organizationId]: {
              ...existing,
              roots: mergeChildrenIntoTree(existing.roots, node.id, data.children),
            },
          },
          loadingChildrenByNode: { ...state.loadingChildrenByNode, [nodeKey]: false },
        }
      })
      return data.children
    } catch {
      set(state => ({
        loadingChildrenByNode: { ...state.loadingChildrenByNode, [nodeKey]: false },
      }))
      return null
    }
  },

  patchNodeMeta: (organizationId, patch) => {
    if (!organizationId || (!patch.resourceId && !patch.contextItemId)) return
    set(state => {
      const existing = state.treesByOrganizationId[organizationId]
      if (!existing) return state
      const result = patchNodesMeta(existing.roots, patch)
      if (!result.changed) return state
      return {
        treesByOrganizationId: {
          ...state.treesByOrganizationId,
          [organizationId]: { ...existing, roots: result.nodes },
        },
      }
    })
  },

  removeNodeAndPromoteChildren: (organizationId, resourceId) => {
    if (!organizationId || !resourceId) return
    set(state => {
      const existing = state.treesByOrganizationId[organizationId]
      if (!existing) return state
      const result = removeNodesAndPromoteChildren(existing.roots, resourceId)
      if (!result.changed) return state
      return {
        treesByOrganizationId: {
          ...state.treesByOrganizationId,
          [organizationId]: { ...existing, roots: result.nodes },
        },
      }
    })
  },

  invalidateTree: (organizationId) => {
    if (!organizationId) return
    set(state => {
      const treesByOrganizationId = { ...state.treesByOrganizationId }
      delete treesByOrganizationId[organizationId]
      return { treesByOrganizationId }
    })
  },
}))

export function getKnowledgeTreeCacheKey(organizationId: string): string {
  return organizationId
}

export function getKnowledgeTreeNodeLoadingKey(organizationId: string, nodeId: string): string {
  return buildNodeLoadingKey(organizationId, nodeId)
}
