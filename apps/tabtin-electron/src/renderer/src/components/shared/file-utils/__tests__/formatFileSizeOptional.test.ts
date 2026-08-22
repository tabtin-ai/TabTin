/**
 * formatFileSizeOptional — Folder meta 与 Office 预览共用的大小格式化
 */
import { describe, it, expect } from 'vitest'
import { formatFileSize, formatFileSizeOptional } from '@components/shared/file-utils'

describe('formatFileSizeOptional', () => {
  it('undefined / null 返回 unknownLabel', () => {
    expect(formatFileSizeOptional(undefined)).toBe('—')
    expect(formatFileSizeOptional(null)).toBe('—')
    expect(formatFileSizeOptional(undefined, '未知')).toBe('未知')
  })

  it('有效字节数委托 formatFileSize', () => {
    expect(formatFileSizeOptional(0)).toBe('0 B')
    expect(formatFileSizeOptional(1024)).toBe(formatFileSize(1024))
    expect(formatFileSizeOptional(50 * 1024 * 1024)).toBe(formatFileSize(50 * 1024 * 1024))
  })
})
