/**
 * Regression tests for Wave 6 — 面板工具栏(上) P1 fixes (batch 2):
 * - P1-07: StyleEditor 超链接页面列表改用 useSlideStore 订阅 (非 getState 快照)
 * - P1-09: FontSelect handleInputKeyDown Enter 校验搜索词在字体列表中
 * - P1-10: FillEditor 渐变停止点 ColorSwatch 传入 showOpacity
 * - P1-11: ColorPickerPopover / ColorSwatch onChange 签名增加 themeKey 参数
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const readSrc = (relativePath: string) =>
  fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf-8')

// ═══════════════════════════════════════════════════
// P1-07: StyleEditor 超链接页面列表响应式订阅
// ═══════════════════════════════════════════════════

describe('P1-07: StyleEditor 超链接页面列表不再使用 getState 快照', () => {
  const src = readSrc('panels/right-sidebar/editors/style-editor/index.tsx')

  it('不通过 getState() 快照读取 pages', () => {
    expect(src).not.toContain('useSlideStore.getState().presentation?.pages')
  })

  it('通过 useSlideStore hook 订阅 linkPages', () => {
    expect(src).toMatch(/const linkPages\s*=\s*useSlideStore\(/)
  })

  it('linkPages 在组件顶层定义（非 IIFE 内部）', () => {
    const lines = src.split('\n')
    const linkPagesLine = lines.findIndex((l) => l.includes('const linkPages = useSlideStore('))
    const componentStart = lines.findIndex((l) => l.includes('export const StyleEditor'))
    const hasElementLinkIIFE = lines.findIndex((l, i) => i > linkPagesLine && l.includes('hasElementLink && (() =>'))
    expect(linkPagesLine).toBeGreaterThan(componentStart)
    expect(linkPagesLine).toBeLessThan(hasElementLinkIIFE)
  })
})

// ═══════════════════════════════════════════════════
// P1-09: FontSelect Enter 键提交校验
// ═══════════════════════════════════════════════════

describe('P1-09: FontSelect Enter 提交校验搜索词合法性', () => {
  const src = readSrc('panels/right-sidebar/editors/FontSelect.tsx')

  it('handleInputKeyDown 中包含字体匹配校验逻辑', () => {
    expect(src).toContain('handleInputKeyDown')
    expect(src).toContain("e.key === 'Enter'")
    expect(src).toContain('filtered[0]')
  })

  it('Enter 分支不直接提交裸搜索词', () => {
    const lines = src.split('\n')
    const enterIdx = lines.findIndex((l) => l.includes("e.key === 'Enter'"))
    expect(enterIdx).toBeGreaterThan(0)
    const block = lines.slice(enterIdx, enterIdx + 15).join('\n')
    expect(block).not.toMatch(/if\s*\(s\)\s*onChange\(s\)/)
  })

  it('匹配成功时提交 firstVisible.value', () => {
    const src2 = readSrc('panels/right-sidebar/editors/FontSelect.tsx')
    expect(src2).toContain('onChange(firstVisible.value)')
  })

  it('handleInputKeyDown 依赖数组包含 filtered', () => {
    expect(src).toMatch(/\[search,\s*onChange,\s*filtered/)
  })
})

// ═══════════════════════════════════════════════════
// P1-10: FillEditor 渐变停止点透明度
// ═══════════════════════════════════════════════════

describe('P1-10: FillEditor 渐变停止点 ColorSwatch 支持透明度', () => {
  const src = readSrc('panels/right-sidebar/editors/FillEditor.tsx')

  it('导入颜色工具函数 toColorInputHex / extractColorAlpha / colorWithAlpha', () => {
    expect(src).toContain('toColorInputHex')
    expect(src).toContain('extractColorAlpha')
    expect(src).toContain('colorWithAlpha')
  })

  it('渐变停止点 ColorSwatch 传入 showOpacity', () => {
    const lines = src.split('\n')
    const gradStopIdx = lines.findIndex((l) =>
      l.includes('gradient.colors[selectedStopIdx].color') && l.includes('toColorInputHex'),
    )
    expect(gradStopIdx).toBeGreaterThan(0)
    const block = lines.slice(gradStopIdx - 2, gradStopIdx + 10).join('\n')
    expect(block).toContain('showOpacity')
  })

  it('渐变停止点 ColorSwatch 传入 opacity (extractColorAlpha)', () => {
    const src2 = readSrc('panels/right-sidebar/editors/FillEditor.tsx')
    expect(src2).toMatch(/opacity=\{extractColorAlpha\(gradient\.colors\[selectedStopIdx\]\.color\)\}/)
  })

  it('onChange 回调中使用 colorWithAlpha 组装颜色', () => {
    expect(src).toMatch(/colorWithAlpha\(hex,\s*op\s*\?\?/)
  })
})

// ═══════════════════════════════════════════════════
// P1-11: themeKey 语义在颜色选择器保留
// ═══════════════════════════════════════════════════

describe('P1-11: ColorPickerPopover onChange 签名包含 themeKey', () => {
  const src = readSrc('panels/right-sidebar/shared/ColorPickerPopover.tsx')

  it('ColorPickerPopoverProps.onChange 签名包含 themeKey 参数', () => {
    expect(src).toMatch(/onChange:\s*\(hex:\s*string,\s*opacity\?:\s*number,\s*themeKey\?:\s*string\)\s*=>\s*void/)
  })

  it('commit 函数接受 themeKey 参数', () => {
    expect(src).toMatch(/const commit\s*=\s*useCallback\(\(hex:\s*string,\s*alpha:\s*number,\s*themeKey\?:\s*string\)/)
  })

  it('pickPreset 函数接受并传递 themeKey', () => {
    expect(src).toMatch(/const pickPreset\s*=\s*useCallback\(\(hex:\s*string,\s*themeKey\?:\s*string\)/)
    expect(src).toMatch(/commit\(n,\s*opacity,\s*themeKey\)/)
  })

  it('SwatchGrid onPick 签名包含 themeKey', () => {
    expect(src).toMatch(/onPick:\s*\(hex:\s*string,\s*themeKey\?:\s*string\)\s*=>\s*void/)
  })

  it('主题色 SwatchGrid 传入 colorKeyMap', () => {
    expect(src).toMatch(/colorKeyMap=\{themeColorKeyMap\}/)
  })

  it('standalone ColorSwatchProps.onChange 签名也包含 themeKey', () => {
    expect(src).toMatch(/onChange:\s*\(hex:\s*string,\s*opacity\?:\s*number,\s*themeKey\?:\s*string\)\s*=>\s*void/)
  })
})

describe('P1-11: components.tsx ColorSwatch wrapper 签名兼容 themeKey', () => {
  const src = readSrc('panels/right-sidebar/shared/components.tsx')

  it('ColorSwatchProps.onChange 签名包含可选 themeKey', () => {
    expect(src).toMatch(/onChange:\s*\(hex:\s*string,\s*opacity\?:\s*number,\s*themeKey\?:\s*string\)\s*=>\s*void/)
  })
})

describe('P1-11: usePresentationColors 返回 themeColorKeyMap', () => {
  const src = readSrc('panels/right-sidebar/shared/usePresentationColors.ts')

  it('PresentationColorSet 接口包含 themeColorKeyMap', () => {
    expect(src).toMatch(/themeColorKeyMap:\s*Map<string,\s*string>/)
  })

  it('导入 BG_THEME_KEYS 和 resolveBackgroundColor', () => {
    expect(src).toContain('BG_THEME_KEYS')
    expect(src).toContain('resolveBackgroundColor')
  })

  it('构建 themeColorKeyMap 映射', () => {
    expect(src).toContain('const themeColorKeyMap = new Map<string, string>()')
  })
})
