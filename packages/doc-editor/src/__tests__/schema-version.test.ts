/**
 * DOC_SCHEMA_VERSION 回归测试
 *
 * 确保版本常量正确导出且为正整数。
 */
import { describe, it, expect } from 'vitest'

describe('DOC_SCHEMA_VERSION', () => {
  it('应为正整数', async () => {
    const { DOC_SCHEMA_VERSION } = await import('../schema/serverSchema.js')
    expect(typeof DOC_SCHEMA_VERSION).toBe('number')
    expect(DOC_SCHEMA_VERSION).toBeGreaterThanOrEqual(1)
    expect(Number.isInteger(DOC_SCHEMA_VERSION)).toBe(true)
  })

  it('应从包入口正确导出', async () => {
    const mod = await import('../index.js')
    expect(mod.DOC_SCHEMA_VERSION).toBeDefined()
    expect(typeof mod.DOC_SCHEMA_VERSION).toBe('number')
  })

  it('与 serverSchema 中的值一致', async () => {
    const { DOC_SCHEMA_VERSION: fromSchema } = await import('../schema/serverSchema.js')
    const { DOC_SCHEMA_VERSION: fromIndex } = await import('../index.js')
    expect(fromSchema).toBe(fromIndex)
  })
})
