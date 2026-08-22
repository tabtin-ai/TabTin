/**
 * Regression tests for V2 panels-upper W2-06 fixes:
 * - D1-01: dragOverPosition 逻辑反转修复（!== null）
 * - D1-05: deleteConfirm 改用 pageId 替代 index，防止协作场景删错页
 * - D3-03/D3-04/D3-05: onFillChange/onGradientChange/onPatternChange 清除 fillThemeKey
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const readSrc = (relativePath: string) =>
  fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf-8')

// ═══════════════════════════════════════════════════
// D1-01: dragOverPosition 条件修复
// ═══════════════════════════════════════════════════

describe('D1-01: dragOverPosition 在拖拽中正确显示', () => {
  const src = readSrc('panels/PageList.tsx')

  it('使用 !== null 确保拖拽中才显示插入指示器', () => {
    expect(src).toContain('dragFromIndex !== null && dragOverState?.index === idx')
  })

  it('不存在旧的逻辑反转条件 === null', () => {
    expect(src).not.toContain('dragFromIndex === null && dragOverState?.index === idx')
  })
})

// ═══════════════════════════════════════════════════
// D1-05: deleteConfirm 使用 pageId 替代 index
// ═══════════════════════════════════════════════════

describe('D1-05: deleteConfirm 存储 pageId 防止协作场景删错页', () => {
  const src = readSrc('panels/PageList.tsx')

  it('deleteConfirm 状态类型包含 pageId', () => {
    expect(src).toMatch(/deleteConfirm.*pageId:\s*string/)
  })

  it('deleteConfirm 状态类型不再使用 index', () => {
    expect(src).not.toMatch(/deleteConfirm.*setDeleteConfirm.*useState<\{[^}]*\bindex:\s*number[^}]*\}>/)
  })

  it('设置 deleteConfirm 时传入 page.id', () => {
    expect(src).toContain('pageId: page.id')
  })

  it('执行删除时通过 findIndex 从 pageId 解析当前索引', () => {
    expect(src).toMatch(/pages\.findIndex\(\s*p\s*=>\s*p\.id\s*===\s*deleteConfirm\.pageId\s*\)/)
  })

  it('pageId 对应的页面已被协作方删除时不执行删除', () => {
    expect(src).toMatch(/resolvedIdx\s*>=\s*0.*handleDeletePage/)
    expect(src).toContain('else setDeleteConfirm(null)')
  })
})

// ═══════════════════════════════════════════════════
// D3-03/D3-04/D3-05: fillThemeKey 过期清除
// ═══════════════════════════════════════════════════

describe('D3-03/D3-04/D3-05: 手动改色/渐变/图案清除 fillThemeKey', () => {
  const src = readSrc('panels/right-sidebar/editors/style-editor/index.tsx')

  it('onFillChange 调用 up() 时包含 fillThemeKey: undefined', () => {
    const fillChangeMatch = src.match(/onFillChange=\{[^}]*\}[^}]*\}/s)
    expect(fillChangeMatch).toBeTruthy()
    expect(fillChangeMatch![0]).toContain('fillThemeKey: undefined')
  })

  it('onGradientChange 调用 up() 时包含 fillThemeKey: undefined', () => {
    const gradientMatch = src.match(/onGradientChange=\{[^}]*\}/s)
    expect(gradientMatch).toBeTruthy()
    expect(gradientMatch![0]).toContain('fillThemeKey: undefined')
  })

  it('onPatternChange 调用 up() 时包含 fillThemeKey: undefined', () => {
    const patternMatch = src.match(/onPatternChange=\{[^}]*\}/s)
    expect(patternMatch).toBeTruthy()
    expect(patternMatch![0]).toContain('fillThemeKey: undefined')
  })

  it('主题色快选仍然正确设置 fillThemeKey', () => {
    expect(src).toContain('fillThemeKey: item.key')
  })
})
