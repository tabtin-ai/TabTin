import { describe, expect, it } from 'vitest'
import { shouldIncludeClipboardHeaders } from './clipboardHeaders'

describe('shouldIncludeClipboardHeaders', () => {
  it('copyHeaders 关闭时永不带表头', () => {
    expect(shouldIncludeClipboardHeaders(false, {
      minRow: 0, maxRow: 2, minCol: 0, maxCol: 2,
    })).toBe(false)
    expect(shouldIncludeClipboardHeaders(undefined, {
      minRow: 0, maxRow: 0, minCol: 0, maxCol: 0,
    })).toBe(false)
  })

  it('单格复制不带表头（URL 只要纯地址）', () => {
    expect(shouldIncludeClipboardHeaders(true, {
      minRow: 3, maxRow: 3, minCol: 1, maxCol: 1,
    })).toBe(false)
  })

  it('多格 / 多列复制仍带表头', () => {
    expect(shouldIncludeClipboardHeaders(true, {
      minRow: 0, maxRow: 0, minCol: 0, maxCol: 1,
    })).toBe(true)
    expect(shouldIncludeClipboardHeaders(true, {
      minRow: 0, maxRow: 2, minCol: 1, maxCol: 1,
    })).toBe(true)
  })
})
