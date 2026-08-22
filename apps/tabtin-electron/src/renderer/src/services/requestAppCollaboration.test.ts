import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  tabsState: {
    activeKeyBySpace: {
      'desktop:organization:org-1:user:user-1': 'tabdoc:doc-1',
    },
    itemsBySpace: {
      'desktop:organization:org-1:user:user-1': {
        'tabdoc:doc-1': {
          tabKey: 'tabdoc:doc-1',
          type: 'tabdoc',
          id: 'doc-1',
          title: '项目周报',
        },
      },
    },
  },
}))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => mocks.tabsState,
  },
}))

vi.mock('./resolveCollaborationSource', () => ({
  resolveCollaborationSource: (input: { sourceItem?: unknown; contextBlocks?: unknown }) => ({
    sourceItem: input.sourceItem,
    contextBlocks: input.contextBlocks ?? [{ type: 'doc_selection', document_id: 'doc-1' }],
  }),
}))

vi.mock('@stores/useAppCollaborationStore', () => ({
  useAppCollaborationStore: {
    getState: () => ({ open: mocks.open }),
  },
}))

import { requestAppCollaboration } from './requestAppCollaboration'

describe('requestAppCollaboration', () => {
  beforeEach(() => {
    mocks.open.mockClear()
  })

  it('把 pane 显式资源作为正式协作任务来源', () => {
    const sourceItem = mocks.tabsState.itemsBySpace[
      'desktop:organization:org-1:user:user-1'
    ]['tabdoc:doc-1']
    requestAppCollaboration({
      sourceLabel: '文档',
      spaceId: 'space-1',
      prompt: '  总结这份文档  ',
      sourceItem,
      tabScopeKey: 'conversation:session-1',
    })

    expect(mocks.open).toHaveBeenCalledWith({
      sourceLabel: '文档',
      preferredSpaceId: 'space-1',
      prompt: '总结这份文档',
      contextBlocks: [{ type: 'doc_selection', document_id: 'doc-1' }],
      sourceItem,
    })
  })
})
