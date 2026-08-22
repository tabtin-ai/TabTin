import { beforeEach, describe, expect, it, vi } from 'vitest'

const listKnowledgeTree = vi.fn()
const listKnowledgeTreeChildren = vi.fn()

vi.mock('@/services/spaceApi', () => ({
  SpaceApiService: {
    listKnowledgeTree: (...args: unknown[]) => listKnowledgeTree(...args),
    listKnowledgeTreeChildren: (...args: unknown[]) => listKnowledgeTreeChildren(...args),
  },
}))

import {
  canCreateKnowledgeTreeChild,
  KNOWLEDGE_TREE_MAX_NESTING_DEPTH,
  useKnowledgeTree,
} from '../useKnowledgeTree'

describe('canCreateKnowledgeTreeChild', () => {
  it('allows create under levels 1-3 and blocks level 4', () => {
    expect(KNOWLEDGE_TREE_MAX_NESTING_DEPTH).toBe(4)
    expect(canCreateKnowledgeTreeChild(0)).toBe(true) // 根
    expect(canCreateKnowledgeTreeChild(1)).toBe(true)
    expect(canCreateKnowledgeTreeChild(2)).toBe(true) // 第 3 层，子为第 4 层
    expect(canCreateKnowledgeTreeChild(3)).toBe(false) // 第 4 层，不可再加
    expect(canCreateKnowledgeTreeChild(4)).toBe(false)
  })
})

describe('useKnowledgeTree', () => {
  beforeEach(() => {
    useKnowledgeTree.setState({
      treesByOrganizationId: {},
      loadingByOrganizationId: {},
      loadingChildrenByNode: {},
      errorByOrganizationId: {},
    })
    listKnowledgeTree.mockReset()
    listKnowledgeTreeChildren.mockReset()
  })

  it('silent reloads keep loading=false when cache exists', async () => {
    listKnowledgeTree.mockResolvedValue({
      organization_id: 'org-1',
      roots: [{ id: 'a', node_type: 'tabdoc', title: 'A', child_count: 0, children: [] }],
    })

    await useKnowledgeTree.getState().loadTree('org-1')
    expect(useKnowledgeTree.getState().loadingByOrganizationId['org-1']).toBe(false)

    listKnowledgeTree.mockResolvedValue({
      organization_id: 'org-1',
      roots: [{ id: 'a', node_type: 'tabdoc', title: 'A2', child_count: 0, children: [] }],
    })
    const pending = useKnowledgeTree.getState().loadTree('org-1', { force: true })
    expect(useKnowledgeTree.getState().loadingByOrganizationId['org-1']).toBe(false)
    await pending
    expect(useKnowledgeTree.getState().treesByOrganizationId['org-1']?.roots[0]?.title).toBe('A2')
  })

  it('#11281 requests only resources owned by the current user', async () => {
    listKnowledgeTree.mockResolvedValue({
      organization_id: 'org-1',
      roots: [],
    })

    await useKnowledgeTree.getState().loadTree('org-1')

    expect(listKnowledgeTree).toHaveBeenCalledWith('org-1', {
      item_types: 'tabdoc,tabdata',
      depth: KNOWLEDGE_TREE_MAX_NESTING_DEPTH,
      owned_only: true,
    })
  })

  it('#8153 force reload success clears sticky error when cache exists', async () => {
    listKnowledgeTree.mockResolvedValue({
      organization_id: 'org-1',
      roots: [{ id: 'a', node_type: 'tabdoc', title: 'A', child_count: 0, children: [] }],
    })
    await useKnowledgeTree.getState().loadTree('org-1')

    listKnowledgeTree.mockRejectedValueOnce(
      new Error('Network error: getaddrinfo ENOTFOUND api.example.com'),
    )
    await useKnowledgeTree.getState().loadTree('org-1', { force: true })
    expect(useKnowledgeTree.getState().errorByOrganizationId['org-1']).toContain('ENOTFOUND')

    listKnowledgeTree.mockResolvedValue({
      organization_id: 'org-1',
      roots: [{ id: 'a', node_type: 'tabdoc', title: 'A2', child_count: 0, children: [] }],
    })
    await useKnowledgeTree.getState().loadTree('org-1', { force: true })

    expect(useKnowledgeTree.getState().errorByOrganizationId['org-1']).toBeNull()
    expect(useKnowledgeTree.getState().treesByOrganizationId['org-1']?.roots[0]?.title).toBe('A2')
  })

  it('#8153 stale loadTree failure does not overwrite newer success', async () => {
    let rejectSlow!: (reason?: unknown) => void
    const slow = new Promise((_resolve, reject) => {
      rejectSlow = reject
    })

    listKnowledgeTree.mockImplementationOnce(() => slow)
    const pendingSlow = useKnowledgeTree.getState().loadTree('org-1', { force: true })

    listKnowledgeTree.mockResolvedValueOnce({
      organization_id: 'org-1',
      roots: [{ id: 'b', node_type: 'tabdoc', title: 'B', child_count: 0, children: [] }],
    })
    await useKnowledgeTree.getState().loadTree('org-1', { force: true })
    expect(useKnowledgeTree.getState().errorByOrganizationId['org-1']).toBeNull()
    expect(useKnowledgeTree.getState().treesByOrganizationId['org-1']?.roots[0]?.title).toBe('B')

    rejectSlow(new Error('Network error: stale'))
    await pendingSlow

    expect(useKnowledgeTree.getState().errorByOrganizationId['org-1']).toBeNull()
    expect(useKnowledgeTree.getState().treesByOrganizationId['org-1']?.roots[0]?.title).toBe('B')
  })

  it('patchNodeMeta updates title in place without reload', () => {
    useKnowledgeTree.setState({
      treesByOrganizationId: {
        'org-1': {
          organization_id: 'org-1',
          folder_scope: 'none',
          orphan_policy: 'promote_to_root',
          roots: [{
            id: 'item-1',
            node_type: 'tabdoc',
            resource_id: 'doc-1',
            context_item_id: 'item-1',
            title: '旧标题',
            child_count: 0,
            children: [],
            order: 0,
            is_pinned: false,
            updated_at: null,
            collection_id: null,
            parent_node_id: null,
            parent_node_type: null,
            icon: null,
          }],
          stats: { folder_count: 0, doc_count: 1, table_count: 0, orphan_count: 0 },
          warnings: [],
        },
      },
    })

    useKnowledgeTree.getState().patchNodeMeta('org-1', {
      resourceId: 'doc-1',
      title: '新标题',
    })

    expect(useKnowledgeTree.getState().treesByOrganizationId['org-1']?.roots[0]?.title).toBe('新标题')
    expect(listKnowledgeTree).not.toHaveBeenCalled()
  })

  it('#7437 removeNodeAndPromoteChildren 移除节点并把子节点上提', () => {
    useKnowledgeTree.setState({
      treesByOrganizationId: {
        'org-1': {
          organization_id: 'org-1',
          folder_scope: 'none',
          orphan_policy: 'promote_to_root',
          roots: [{
            id: 'parent-1',
            node_type: 'tabdoc',
            resource_id: 'doc-parent',
            context_item_id: 'parent-1',
            title: '父文档',
            child_count: 1,
            children: [{
              id: 'child-1',
              node_type: 'tabdata',
              resource_id: 'table-child',
              context_item_id: 'child-1',
              title: '子表格',
              child_count: 0,
              children: [],
              order: 0,
              is_pinned: false,
              updated_at: null,
              collection_id: null,
              parent_node_id: 'parent-1',
              parent_node_type: 'tabdoc',
              icon: null,
            }],
            order: 0,
            is_pinned: false,
            updated_at: null,
            collection_id: null,
            parent_node_id: null,
            parent_node_type: null,
            icon: null,
          }],
          stats: { folder_count: 0, doc_count: 1, table_count: 1, orphan_count: 0 },
          warnings: [],
        },
      },
    })

    useKnowledgeTree.getState().removeNodeAndPromoteChildren('org-1', 'doc-parent')

    const roots = useKnowledgeTree.getState().treesByOrganizationId['org-1']?.roots ?? []
    expect(roots).toHaveLength(1)
    expect(roots[0]?.resource_id).toBe('table-child')
    expect(roots[0]?.title).toBe('子表格')
    expect(listKnowledgeTree).not.toHaveBeenCalled()
  })
})
