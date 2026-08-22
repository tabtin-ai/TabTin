import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  buildContextAttachment: vi.fn(),
  contextRefsToBlocks: vi.fn(),
}))

vi.mock('@components/context-space/registry', () => ({
  contextRegistry: { buildContextAttachment: mocks.buildContextAttachment },
}))

vi.mock('@components/chat/context/useContextInjection', () => ({
  contextRefsToBlocks: mocks.contextRefsToBlocks,
}))

import { resolveCollaborationSource } from './resolveCollaborationSource'

const docItem = {
  tabKey: 'tabdoc:doc-1',
  type: 'tabdoc',
  id: 'doc-1',
  title: '项目周报',
}

describe('resolveCollaborationSource', () => {
  beforeEach(() => {
    mocks.buildContextAttachment.mockReset()
    mocks.contextRefsToBlocks.mockReset()
    mocks.buildContextAttachment.mockReturnValue({
      refType: 'document',
      resourceId: 'doc-1',
      label: '项目周报',
    })
    mocks.contextRefsToBlocks.mockReturnValue([{ type: 'doc_selection', document_id: 'doc-1' }])
  })

  it('分屏 pane 显式来源优先于当前 scope 活跃标签', () => {
    const result = resolveCollaborationSource({
      sourceItem: docItem,
      tabScopeKey: 'conversation:session-1',
      activeKeyBySpace: { 'conversation:session-1': 'tabdata:table-1' },
      itemsBySpace: {
        'conversation:session-1': {
          'tabdata:table-1': {
            tabKey: 'tabdata:table-1',
            type: 'tabdata',
            id: 'table-1',
          },
        },
      },
      spaceId: 'space-1',
    })

    expect(result?.sourceItem).toEqual(docItem)
    expect(mocks.buildContextAttachment).toHaveBeenCalledWith(docItem)
    expect(result?.contextBlocks).toEqual([{ type: 'doc_selection', document_id: 'doc-1' }])
  })

  it('没有显式来源时只从传入 scope 解析，不读取其他标签桶', () => {
    const result = resolveCollaborationSource({
      tabScopeKey: 'conversation:session-1',
      activeKeyBySpace: {
        'desktop:org:user': 'tabdoc:desktop-doc',
        'conversation:session-1': 'tabdoc:doc-1',
      },
      itemsBySpace: {
        'conversation:session-1': { 'tabdoc:doc-1': docItem },
      },
    })

    expect(result?.sourceItem).toEqual(docItem)
  })

  it('handler 无法构建稳定引用时不开放协作', () => {
    mocks.buildContextAttachment.mockReturnValue(null)
    expect(resolveCollaborationSource({
      sourceItem: docItem,
      activeKeyBySpace: {},
      itemsBySpace: {},
    })).toBeNull()
  })
})
