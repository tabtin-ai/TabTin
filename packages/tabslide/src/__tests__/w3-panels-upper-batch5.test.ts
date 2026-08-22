/**
 * Wave 3 — 面板工具栏(上) Batch 5 修复回归测试
 *
 * P1:
 *   D3-06 / D3-07 / D4-09: FillEditor 渐变停止点 findIndex 碰撞 — 使用 indexOf 引用查找
 *   D2-03 / D2-04: AnimationTab 切页状态重置
 *   D2-01 / D2-07: EditTab 死代码清理
 *   D2-02: versionHistory i18n key 补全
 *   D3-08: StyleEditor 图片上传走 resolveImageSrc
 * P2:
 *   D1-07: Virtuoso computeItemKey
 *   D2-08: LayerSidebar 切页拖拽状态重置
 *   D3-20: 表格边框宽度 NaN 防护
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const readSrc = (relativePath: string) =>
  fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf-8')

// ═══════════════════════════════════════════════════
// D3-06 / D3-07 / D4-09: 渐变停止点 findIndex 碰撞修复
// ═══════════════════════════════════════════════════

describe('D3-06/D3-07/D4-09: FillEditor 渐变停止点使用 indexOf 引用查找', () => {
  const src = readSrc('panels/right-sidebar/editors/FillEditor.tsx')

  it('addStop 不再使用 findIndex 按 pos+color 查找', () => {
    const addStopBlock = src.slice(
      src.indexOf('const addStop'),
      src.indexOf('const removeStop'),
    )
    expect(addStopBlock).not.toContain('findIndex')
    expect(addStopBlock).toContain('indexOf(newStop)')
  })

  it('addStop 创建独立引用对象 newStop', () => {
    const addStopBlock = src.slice(
      src.indexOf('const addStop'),
      src.indexOf('const removeStop'),
    )
    expect(addStopBlock).toMatch(/const newStop\s*=/)
  })

  it('渐变条 onClick 不再使用 findIndex 按 pos 查找', () => {
    const barClickMatch = src.match(/cursor-crosshair[\s\S]*?onClick=\{[\s\S]*?\}\n\s*>/)
    expect(barClickMatch).toBeTruthy()
    const block = barClickMatch![0]
    expect(block).not.toMatch(/findIndex\(/)
    expect(block).toContain('indexOf(newStop)')
  })

  it('渐变条 onClick 同样创建独立 newStop 引用', () => {
    const barClickMatch = src.match(/cursor-crosshair[\s\S]*?onClick=\{[\s\S]*?\}\n\s*>/)
    expect(barClickMatch).toBeTruthy()
    expect(barClickMatch![0]).toMatch(/const newStop\s*=/)
  })
})

// ═══════════════════════════════════════════════════
// D2-03 / D2-04: AnimationTab 切页状态重置
// ═══════════════════════════════════════════════════

describe('D2-03/D2-04: AnimationTab 切页状态重置', () => {
  const src = readSrc('panels/right-sidebar/AnimationTab.tsx')

  it('导入 useEffect', () => {
    expect(src).toMatch(/import.*useEffect.*from\s*['"]react['"]/)
  })

  it('监听 currentPageIndex 变化并重置 editingId', () => {
    expect(src).toMatch(/useEffect\(\(\)\s*=>\s*\{[\s\S]*?setEditingId\(null\)[\s\S]*?\},\s*\[currentPageIndex\]/)
  })

  it('监听 currentPageIndex 变化并重置 addMode', () => {
    expect(src).toMatch(/useEffect\(\(\)\s*=>\s*\{[\s\S]*?setAddMode\(false\)[\s\S]*?\},\s*\[currentPageIndex\]/)
  })

  it('监听 currentPageIndex 变化并重置 addType', () => {
    expect(src).toMatch(/useEffect\(\(\)\s*=>\s*\{[\s\S]*?setAddType\(['"]in['"]\)[\s\S]*?\},\s*\[currentPageIndex\]/)
  })
})

// ═══════════════════════════════════════════════════
// D2-01 / D2-07: EditTab 死代码清理
// ═══════════════════════════════════════════════════

describe('D2-01/D2-07: EditTab 死代码已移除', () => {
  it('EditTab.tsx 文件不再存在', () => {
    const exists = fs.existsSync(path.resolve(__dirname, '..', 'panels/right-sidebar/EditTab.tsx'))
    expect(exists).toBe(false)
  })

  it('right-sidebar/index.ts 不再导出 EditTab', () => {
    const indexSrc = readSrc('panels/right-sidebar/index.ts')
    expect(indexSrc).not.toContain('EditTab')
  })
})

// ═══════════════════════════════════════════════════
// D2-02: versionHistory i18n key 补全
// ═══════════════════════════════════════════════════

describe('D2-02: versionHistory i18n key 存在', () => {
  const enPath = path.resolve(__dirname, '../../../../apps/tabtin-electron/src/renderer/src/i18n/locales/en-US/tabslide.json')
  const zhPath = path.resolve(__dirname, '../../../../apps/tabtin-electron/src/renderer/src/i18n/locales/zh-CN/tabslide.json')

  it('en-US tabslide.json 包含 versionHistory key', () => {
    if (!fs.existsSync(enPath)) return
    const data = JSON.parse(fs.readFileSync(enPath, 'utf-8'))
    expect(data.versionHistory).toBe('Version History')
  })

  it('zh-CN tabslide.json 包含 versionHistory key', () => {
    if (!fs.existsSync(zhPath)) return
    const data = JSON.parse(fs.readFileSync(zhPath, 'utf-8'))
    expect(data.versionHistory).toBe('版本历史')
  })
})

// ═══════════════════════════════════════════════════
// D3-08: StyleEditor 图片上传走 resolveImageSrc
// ═══════════════════════════════════════════════════

describe('D3-08: StyleEditor 图片上传使用 resolveImageSrc', () => {
  const src = readSrc('panels/right-sidebar/editors/style-editor/index.tsx')

  it('导入 resolveImageSrc', () => {
    expect(src).toContain("import { resolveImageSrc } from '../../../../utils/image'")
  })

  it('不再直接使用 FileReader.readAsDataURL', () => {
    expect(src).not.toContain('readAsDataURL')
    expect(src).not.toContain('new FileReader')
  })

  it('调用 resolveImageSrc(file, onUploadImage)', () => {
    expect(src).toMatch(/resolveImageSrc\(file,\s*onUploadImage\)/)
  })
})

// ═══════════════════════════════════════════════════
// D1-07: Virtuoso computeItemKey
// ═══════════════════════════════════════════════════

describe('D1-07: PageList Virtuoso 添加 computeItemKey', () => {
  const src = readSrc('panels/PageList.tsx')

  it('Virtuoso 设置 computeItemKey 使用 page.id', () => {
    expect(src).toMatch(/computeItemKey=\{.*page.*=>.*page\.id/)
  })
})

// ═══════════════════════════════════════════════════
// D2-08: LayerSidebar 切页拖拽状态重置
// ═══════════════════════════════════════════════════

describe('D2-08: LayerSidebar key 包含 currentPageIndex', () => {
  const src = readSrc('panels/right-sidebar/LayerSidebar.tsx')

  it('LayerSidebar 订阅 currentPageIndex', () => {
    expect(src).toMatch(/const currentPageIndex\s*=\s*useSlideStore/)
  })

  it('LayerList key 包含 currentPageIndex 变量', () => {
    expect(src).toMatch(/key=\{`layer-sidebar-\$\{currentPageIndex\}`\}/)
  })
})

// ═══════════════════════════════════════════════════
// D3-20: 表格边框宽度 NaN 防护
// ═══════════════════════════════════════════════════

describe('D3-20: 表格边框宽度输入 NaN 防护', () => {
  const src = readSrc('panels/right-sidebar/editors/style-editor/index.tsx')

  it('边框宽度 onChange 使用 parseFloat 而非 +', () => {
    const borderWidthSection = src.match(/type="number"[^>]*min="0\.5"[^>]*max="10"[\s\S]*?onChange=\{([^}]+)\}/)
    expect(borderWidthSection).toBeTruthy()
    expect(borderWidthSection![1]).toContain('parseFloat')
  })

  it('边框宽度 onChange 包含 Number.isFinite 校验', () => {
    const borderWidthSection = src.match(/type="number"[^>]*min="0\.5"[^>]*max="10"[\s\S]*?onChange=\{([^}]+)\}/)
    expect(borderWidthSection).toBeTruthy()
    expect(borderWidthSection![1]).toContain('Number.isFinite')
  })
})
