import { describe, expect, it } from 'vitest'
import type { KnowledgeTreeNode, SpaceContextItem } from '@/services/spaceApi'
import {
  buildResourceSiblingGroupKey,
  canNestItemUnderTarget,
  collectAncestorNodeIds,
  computeReorderedIds,
  filterKnowledgeTreeRoots,
  findKnowledgeTreeNodeDepth,
  flattenKnowledgeTreeSearchMatches,
  getResourceSiblings,
  mergeChildrenIntoTree,
  nodeNeedsLazyChildren,
  resolveContextItemForMenu,
  resolveCreateContextFromNode,
  resolveResourceDragDropZone,
} from '../knowledgeTreeUtils'

/** ：样本树仅含 tabdoc/tabdata（无 Collection folder 节点） */
const sampleRoots: KnowledgeTreeNode[] = [
  {
    id: 'doc-1',
    node_type: 'tabdoc',
    resource_id: 'resource-doc-1',
    context_item_id: 'ctx-doc-1',
    parent_node_id: null,
    parent_node_type: null,
    collection_id: null,
    title: 'Parent Doc',
    icon: null,
    order: 0,
    is_pinned: false,
    updated_at: null,
    child_count: 1,
    children: [
      {
        id: 'doc-2',
        node_type: 'tabdoc',
        resource_id: 'resource-doc-2',
        context_item_id: 'ctx-doc-2',
        parent_node_id: 'doc-1',
        parent_node_type: 'tabdoc',
        collection_id: null,
        title: 'Child Doc',
        icon: null,
        order: 0,
        is_pinned: false,
        updated_at: null,
        child_count: 0,
        children: [],
      },
    ],
  },
  {
    id: 'table-1',
    node_type: 'tabdata',
    resource_id: 'resource-table-1',
    context_item_id: 'ctx-table-1',
    parent_node_id: null,
    parent_node_type: null,
    collection_id: null,
    title: 'Root Table',
    icon: null,
    order: 0,
    is_pinned: false,
    updated_at: null,
    child_count: 0,
    children: [],
  },
]

describe('knowledgeTreeUtils', () => {
  it('filters roots by tabdoc type without inventing folder nodes', () => {
    const filtered = filterKnowledgeTreeRoots(sampleRoots, 'tabdoc')
    expect(filtered).toHaveLength(1)
    expect(filtered[0]?.node_type).toBe('tabdoc')
    expect(filtered[0]?.children?.[0]?.node_type).toBe('tabdoc')
  })

  it('finds search matches with nested titles', () => {
    const matches = flattenKnowledgeTreeSearchMatches(sampleRoots, 'child')
    expect(matches).toHaveLength(1)
    expect(matches[0]?.node.title).toBe('Child Doc')
    expect(matches[0]?.path).toContain('Parent Doc')
  })

  it('collects ancestor ids for nested doc', () => {
    const ancestors = collectAncestorNodeIds(sampleRoots, 'doc-2')
    expect(ancestors).toEqual(['doc-1'])
  })

  it('detects lazy children need', () => {
    const node = sampleRoots[0]
    expect(node).toBeTruthy()
    expect(nodeNeedsLazyChildren({ ...node!, child_count: 3, children: [] })).toBe(true)
  })

  it('preserves child_count when type filter empties nested children', () => {
    const roots = filterKnowledgeTreeRoots([
      {
        id: 'doc-1',
        node_type: 'tabdoc',
        resource_id: 'r1',
        context_item_id: 'doc-1',
        title: '1-1',
        child_count: 1,
        children: [],
        order: 0,
        is_pinned: false,
        updated_at: null,
        collection_id: null,
        parent_id: null,
        parent_node_id: null,
        parent_node_type: null,
        icon: null,
      },
    ], 'tabdoc')
    expect(roots[0]?.child_count).toBe(1)
    expect(nodeNeedsLazyChildren(roots[0]!)).toBe(true)
  })

  it('resolves create context via ContextItem.parent only', () => {
    expect(resolveCreateContextFromNode(sampleRoots[0]!)).toEqual({
      collectionId: null,
      parentDocumentId: null,
      parentItemId: 'ctx-doc-1',
    })
  })

  it('merges lazy children into cached tree', () => {
    const merged = mergeChildrenIntoTree(sampleRoots, 'doc-1', [{
      ...(sampleRoots[0]?.children?.[0] as KnowledgeTreeNode),
    }])
    expect(merged[0]?.children).toHaveLength(1)
  })

  it('computes reordered sibling ids', () => {
    expect(computeReorderedIds(['a', 'b', 'c'], 'a', 'c', 'before')).toEqual(['b', 'a', 'c'])
    expect(computeReorderedIds(['a', 'b', 'c'], 'c', 'a', 'before')).toEqual(['c', 'a', 'b'])
    expect(computeReorderedIds(['a', 'b'], 'a', 'a', 'before')).toBeNull()
  })

  it('collects resource siblings under doc parent', () => {
    const doc = sampleRoots[0]
    expect(doc).toBeTruthy()
    expect(getResourceSiblings(doc!, sampleRoots).map(node => node.id)).toEqual(['doc-2'])
    expect(getResourceSiblings(null, sampleRoots).map(node => node.id)).toEqual(['doc-1', 'table-1'])
  })

  it('resolves drag drop zones for reorder and nest', () => {
    expect(resolveResourceDragDropZone(0.1, true, false)).toBe('before')
    expect(resolveResourceDragDropZone(0.6, true, false)).toBe('after')
    expect(resolveResourceDragDropZone(0.5, false, true)).toBe('nest')
    expect(resolveResourceDragDropZone(0.1, true, true)).toBe('before')
    expect(resolveResourceDragDropZone(0.5, true, true)).toBe('nest')
    expect(resolveResourceDragDropZone(0.9, true, true)).toBe('after')
  })

  it('allows tabdoc/tabdata nesting but blocks self, descendant, and max-depth targets', () => {
    const doc = sampleRoots[0]
    expect(doc).toBeTruthy()
    const child = doc!.children?.[0]
    expect(child).toBeTruthy()
    const table = sampleRoots[1]
    expect(table).toBeTruthy()
    const payload = {
      contextItemId: 'ctx-doc-1',
      siblingGroupKey: 'root:resources',
      collectionId: null,
      resourceId: 'resource-doc-1',
      nodeType: 'tabdoc' as const,
    }
    const siblingDoc: KnowledgeTreeNode = {
      id: 'doc-3',
      node_type: 'tabdoc',
      resource_id: 'resource-doc-3',
      context_item_id: 'ctx-doc-3',
      parent_node_id: null,
      parent_node_type: null,
      collection_id: null,
      title: 'Sibling Doc',
      icon: null,
      order: 1,
      is_pinned: false,
      updated_at: null,
      child_count: 0,
      children: [],
    }
    expect(canNestItemUnderTarget(payload, child!, sampleRoots, 2)).toBe(false)
    expect(canNestItemUnderTarget(payload, doc!, sampleRoots, 1)).toBe(false)
    expect(canNestItemUnderTarget(payload, siblingDoc, sampleRoots, 1)).toBe(true)
    expect(canNestItemUnderTarget({
      ...payload,
      nodeType: 'tabdata',
      resourceId: 'resource-table-1',
      contextItemId: 'ctx-table-1',
    }, siblingDoc, sampleRoots, 1)).toBe(true)
    expect(canNestItemUnderTarget(payload, table!, sampleRoots, 0)).toBe(true)
    expect(canNestItemUnderTarget(payload, siblingDoc, sampleRoots, 3)).toBe(false)
  })

  it('builds sibling group keys for tabdoc/tabdata parents', () => {
    const doc = sampleRoots[0]
    const table = sampleRoots[1]
    expect(buildResourceSiblingGroupKey(null)).toBe('root:resources')
    expect(buildResourceSiblingGroupKey(doc!)).toBe(`item:${doc!.context_item_id}`)
    expect(buildResourceSiblingGroupKey(table!)).toBe(`item:${table!.context_item_id}`)
    expect(findKnowledgeTreeNodeDepth(sampleRoots, 'doc-2')).toBe(1)
  })

  describe('#7437 resolveContextItemForMenu capabilities', () => {
    it('falls back across buckets so can_trash from space list is reused', () => {
      const cached: SpaceContextItem = {
        id: 'ctx-doc-1',
        item_type: 'tabdoc',
        title: 'Parent Doc',
        preview: '',
        resource_id: 'resource-doc-1',
        space_id: 'space-1',
        organization_id: 'org-1',
        is_archived: false,
        updated_at: null,
        created_at: null,
        can_trash: true,
        can_edit: true,
      }
      const resolved = resolveContextItemForMenu(
        sampleRoots[0]!,
        'space-1',
        'org-1',
        { 'space-1:space': [cached] },
      )
      expect(resolved.can_trash).toBe(true)
      expect(resolved.id).toBe('ctx-doc-1')
    })
  })
})
