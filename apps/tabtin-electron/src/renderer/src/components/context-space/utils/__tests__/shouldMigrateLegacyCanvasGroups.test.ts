import { describe, expect, it } from 'vitest'
import { shouldMigrateLegacyCanvasGroups } from '../shouldMigrateLegacyCanvasGroups'

describe('shouldMigrateLegacyCanvasGroups ', () => {
  const legacy = [{ id: 'g1' }]

  it('独立 scope 从未初始化且有 legacy 画布 → 允许一次性迁移', () => {
    expect(shouldMigrateLegacyCanvasGroups({
      isSameScope: false,
      scopedCanvasGroups: undefined,
      legacyCanvasGroups: legacy,
    })).toBe(true)
  })

  it('用户关光后留下空数组 → 禁止再从 legacy 回灌（切组织 remount）', () => {
    expect(shouldMigrateLegacyCanvasGroups({
      isSameScope: false,
      scopedCanvasGroups: [],
      legacyCanvasGroups: legacy,
    })).toBe(false)
  })

  it('独立 scope 已有画布 → 不迁移', () => {
    expect(shouldMigrateLegacyCanvasGroups({
      isSameScope: false,
      scopedCanvasGroups: legacy,
      legacyCanvasGroups: legacy,
    })).toBe(false)
  })

  it('与执行 Space 同 scope → 不迁移', () => {
    expect(shouldMigrateLegacyCanvasGroups({
      isSameScope: true,
      scopedCanvasGroups: undefined,
      legacyCanvasGroups: legacy,
    })).toBe(false)
  })

  it('legacy 为空 → 不迁移', () => {
    expect(shouldMigrateLegacyCanvasGroups({
      isSameScope: false,
      scopedCanvasGroups: undefined,
      legacyCanvasGroups: [],
    })).toBe(false)
  })

  it('本会话已有显式关闭修订且 scoped 未落盘 → 禁止回灌', () => {
    expect(shouldMigrateLegacyCanvasGroups({
      isSameScope: false,
      scopedCanvasGroups: undefined,
      legacyCanvasGroups: legacy,
      explicitCloseRevision: 1,
    })).toBe(false)
  })
})
