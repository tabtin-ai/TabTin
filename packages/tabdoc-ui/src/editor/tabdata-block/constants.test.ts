import { describe, expect, it } from 'vitest'
import { isEmbedFieldsReady } from './constants'

describe('isEmbedFieldsReady', () => {
  it('fields 已加载时就绪', () => {
    expect(isEmbedFieldsReady(4)).toBe(true)
    expect(isEmbedFieldsReady(1, { loadAttempted: false, expectedFieldCount: 4 })).toBe(true)
  })

  it('加载前快照为 0 字段且已尝试加载时可放行', () => {
    expect(isEmbedFieldsReady(0, { loadAttempted: true, expectedFieldCount: 0 })).toBe(true)
  })

  it('fields 空时未就绪（含失败后 store 把 field_count 清 0 的情况）', () => {
    expect(isEmbedFieldsReady(0)).toBe(false)
    expect(isEmbedFieldsReady(0, { loadAttempted: false, expectedFieldCount: 0 })).toBe(false)
    expect(isEmbedFieldsReady(0, { loadAttempted: true, expectedFieldCount: 4 })).toBe(false)
    // loadFields 失败后 store 可能把 field_count 写成 0；不得用事后值放行
    expect(isEmbedFieldsReady(0, { loadAttempted: true, expectedFieldCount: undefined })).toBe(false)
  })
})
