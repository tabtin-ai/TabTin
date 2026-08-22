import { describe, expect, it } from 'vitest'

import { DRAG_TYPE_CHAT_CONTEXT } from '@/utils/split-coordinator'
import { buildContextRefExtraFromPayload, readChatContextDragPayload } from '../chatContextDrag'

function dataTransferWith(raw: string): Pick<DataTransfer, 'getData'> {
  return {
    getData: (type: string) => (type === DRAG_TYPE_CHAT_CONTEXT ? raw : ''),
  }
}

describe('chatContextDrag', () => {
  it('解析 TabDoc 块拖拽上下文 payload', () => {
    const payload = readChatContextDragPayload(dataTransferWith(JSON.stringify({
      type: 'doc_selection',
      resourceId: 'doc-1',
      label: '设计文档 · 第一段',
      spaceId: 'space-1',
      tabType: 'tabdoc',
      preview: '第一段',
      meta: {
        block_ids: ['block-1'],
        full_text: '第一段',
      },
    })))

    expect(payload).toEqual({
      type: 'doc_selection',
      resourceId: 'doc-1',
      label: '设计文档 · 第一段',
      spaceId: 'space-1',
      tabType: 'tabdoc',
      preview: '第一段',
      meta: {
        block_ids: ['block-1'],
        full_text: '第一段',
      },
    })
  })

  it('把顶层 preview 合并进 ContextRef meta', () => {
    const extra = buildContextRefExtraFromPayload({
      type: 'doc_selection',
      resourceId: 'doc-1',
      label: '设计文档 · 第一段',
      preview: '第一段',
      meta: { block_ids: ['block-1'], full_text: '第一段' },
    })

    expect(extra.meta).toEqual({
      block_ids: ['block-1'],
      full_text: '第一段',
      preview: '第一段',
    })
  })

  it('解析完整文档和表格资源拖拽上下文 payload', () => {
    expect(readChatContextDragPayload(dataTransferWith(JSON.stringify({
      type: 'document',
      resourceId: 'doc-1',
      label: '需求文档',
      spaceId: 'space-1',
      spaceName: '默认 Space',
      tabType: 'tabdoc',
      preview: '文档摘要',
    })))).toEqual({
      type: 'document',
      resourceId: 'doc-1',
      label: '需求文档',
      spaceId: 'space-1',
      spaceName: '默认 Space',
      tabType: 'tabdoc',
      preview: '文档摘要',
    })

    expect(readChatContextDragPayload(dataTransferWith(JSON.stringify({
      type: 'table',
      resourceId: 'tbl-1',
      label: '客户表',
      tabType: 'tabdata',
      meta: { view_id: 'view-1' },
    })))).toEqual({
      type: 'table',
      resourceId: 'tbl-1',
      label: '客户表',
      tabType: 'tabdata',
      meta: { view_id: 'view-1' },
    })
  })

  it('忽略损坏或缺少必填字段的 payload', () => {
    expect(readChatContextDragPayload(dataTransferWith('{'))).toBeNull()
    expect(readChatContextDragPayload(dataTransferWith(JSON.stringify({
      type: 'doc_selection',
      label: '缺少 resourceId',
    })))).toBeNull()
    expect(readChatContextDragPayload(dataTransferWith(JSON.stringify({
      type: 'unknown_resource',
      resourceId: 'res-1',
      label: '当前不支持的拖拽类型',
    })))).toBeNull()
  })

  it('收口 TabDoc 选区 meta 字段类型', () => {
    const payload = readChatContextDragPayload(dataTransferWith(JSON.stringify({
      type: 'doc_selection',
      resourceId: 'doc-1',
      label: '设计文档',
      meta: {
        block_ids: ['block-1', '', 123],
        full_text: 123,
        unexpected: 'ignored',
      },
    })))

    expect(payload?.meta).toEqual({ block_ids: ['block-1'] })
  })
})
