import { describe, expect, it } from 'vitest'

import { resolveDataGridRecordWriteMode } from '../useDataGridCollabBridge'

describe('resolveDataGridRecordWriteMode', () => {
  it('协作通道只读时回退 REST，让后端执行权威鉴权', () => {
    expect(resolveDataGridRecordWriteMode({
      canEdit: false,
      isFallback: false,
      isOnline: true,
      hasYdoc: true,
    })).toBe('rest')
  })

  it('协作通道未就绪时回退 REST', () => {
    expect(resolveDataGridRecordWriteMode({
      canEdit: true,
      isFallback: false,
      isOnline: false,
      hasYdoc: false,
    })).toBe('rest')
  })

  it('仅在可编辑且在线的 Y.Doc 通道使用协作写入', () => {
    expect(resolveDataGridRecordWriteMode({
      canEdit: true,
      isFallback: false,
      isOnline: true,
      hasYdoc: true,
    })).toBe('collab')
  })
})
