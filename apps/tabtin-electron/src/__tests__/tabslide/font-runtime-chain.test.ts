import { beforeEach, describe, expect, it } from 'vitest'
import {
  getRuntimeFontFamilies,
  setRuntimeFontFamilies,
  subscribeRuntimeFontFamilies,
} from '../../../../../packages/tabslide/src/fonts/runtime-fonts'

describe('TabSlide Font Runtime Chain', () => {
  beforeEach(() => {
    setRuntimeFontFamilies([])
  })

  it('应提取主字体并过滤 generic/var 字体项', () => {
    setRuntimeFontFamilies([
      `"Segoe UI", Arial, sans-serif`,
      'inherit',
      "var(--tabslide-minor-font, 'Microsoft YaHei', sans-serif)",
      "'A, B', sans-serif",
      "D'Nealian, serif",
      'segoe ui',
    ])

    const fonts = getRuntimeFontFamilies()
    expect(fonts).toContain('Segoe UI')
    expect(fonts).toContain('A, B')
    expect(fonts).toContain("D'Nealian")
    expect(fonts.some((name) => name.toLowerCase() === 'inherit')).toBe(false)
    expect(fonts.some((name) => name.includes('var('))).toBe(false)
    expect(fonts.filter((name) => name.toLowerCase() === 'segoe ui')).toHaveLength(1)
  })

  it('运行时字体列表未变化时不应重复通知订阅者', () => {
    const updates: string[][] = []
    const unsubscribe = subscribeRuntimeFontFamilies((families) => {
      updates.push(families)
    })

    setRuntimeFontFamilies(['Arial'])
    setRuntimeFontFamilies(['Arial']) // 相同快照，不应触发
    setRuntimeFontFamilies(['Arial', 'Calibri'])
    unsubscribe()

    expect(updates).toHaveLength(2)
    expect(updates[0]).toEqual(['Arial'])
    expect(updates[1]).toEqual(['Arial', 'Calibri'])
  })
})
