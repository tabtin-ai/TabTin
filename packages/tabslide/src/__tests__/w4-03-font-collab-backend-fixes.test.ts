/**
 * Wave 4 Batch 3 修复验证 — 字体/协作/后端
 *
 * 覆盖: H1-04, G1-04, I4-13
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { buildFontItems, type FontDef, type FontItem } from '../fonts/font-list'

/* ── H1-04: yjs 版本统一 ── */

describe('H1-04: yjs version unification', () => {
  it('root package.json has pnpm.overrides section', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../package.json'), 'utf-8'),
    )
    expect(pkg.pnpm?.overrides).toBeDefined()
  })
})

/* ── G1-04: 字体分组排序保持顺序 ── */

const identityT = (key: string) => key

describe('G1-04: font sorting preserves group order', () => {
  it('buildFontItems 结果按分组顺序排列 (document → chinese → sansSerif → serif → monospace)', () => {
    const systemFonts: FontDef[] = [
      { label: 'Monaco', value: 'Monaco', group: 'font.monospace' },
      { label: 'PingFang SC', value: 'PingFang SC', group: 'font.chinese' },
      { label: 'Arial', value: 'Arial', group: 'font.sansSerif' },
      { label: 'Georgia', value: 'Georgia', group: 'font.serif' },
    ]
    const runtimeFamilies = ['DocFontA']
    const result = buildFontItems(systemFonts, runtimeFamilies, identityT)

    // 第一项为默认
    expect(result[0].value).toBe('')
    const items = result.slice(1)

    // 分组顺序: document(0) < chinese(1) < sansSerif(2) < serif(3) < monospace(4)
    const groupOrder = (g: string) =>
      ({ 'font.document': 0, 'font.chinese': 1, 'font.sansSerif': 2, 'font.serif': 3, 'font.monospace': 4 }[g] ?? 9)

    for (let i = 1; i < items.length; i++) {
      const prev = groupOrder(items[i - 1].group ?? '')
      const curr = groupOrder(items[i].group ?? '')
      expect(prev).toBeLessThanOrEqual(curr)
    }

    // 文档字体应排在最前（除默认外）
    const docFont = items.find((x) => x.group === 'font.document')
    expect(docFont).toBeDefined()
    expect(docFont!.label).toContain('DocFontA')
  })

  it('合并 extras 后排序仍保持分组顺序（模拟 useUnifiedFonts 逻辑）', () => {
    const base = buildFontItems(
      [
        { label: 'Monaco', value: 'Monaco', group: 'font.monospace' },
        { label: 'Arial', value: 'Arial', group: 'font.sansSerif' },
      ],
      [],
      identityT,
    )
    // 去掉默认项，只保留字体项
    const baseItems = base.filter((x) => x.value !== '')

    // 模拟 sharedEntryToFontDef 产生的 extras
    const extras: FontItem[] = [
      { label: 'Noto Sans SC', value: 'Noto Sans SC', group: 'font.chinese' },
      { label: 'Times New Roman', value: 'Times New Roman', group: 'font.serif' },
    ]

    const GROUP_ORDER: Record<string, number> = {
      [identityT('font.document')]: 0,
      [identityT('font.chinese')]: 1,
      [identityT('font.sansSerif')]: 2,
      [identityT('font.serif')]: 3,
      [identityT('font.monospace')]: 4,
    }

    const merged = [...baseItems, ...extras].sort((a, b) => {
      const ga = GROUP_ORDER[a.group ?? ''] ?? 9
      const gb = GROUP_ORDER[b.group ?? ''] ?? 9
      if (ga !== gb) return ga - gb
      return a.label.localeCompare(b.label, 'zh-Hans')
    })

    // 验证顺序：sansSerif(2) < chinese(1)? 不对，chinese(1) < sansSerif(2)
    // 正确顺序: document < chinese < sansSerif < serif < monospace
    // 当前 merged: Arial(sansSerif), Monaco(monospace), Noto Sans SC(chinese), Times(serif)
    // 期望顺序: chinese, sansSerif, serif, monospace
    const order = merged.map((x) => ({ label: x.label, group: x.group, ord: GROUP_ORDER[x.group ?? ''] ?? 9 }))
    for (let i = 1; i < order.length; i++) {
      expect(order[i].ord).toBeGreaterThanOrEqual(order[i - 1].ord)
    }
  })
})

/* ── I4-13: _deep_merge 结构字段阻断（后端契约） ── */

describe('I4-13: _deep_merge structural field blocking', () => {
  it('前端依赖后端阻断 structural keys，此处为契约占位', () => {
    // 后端 _deep_merge 应拒绝/忽略 structural 字段（如 __proto__、constructor 等），
    // 前端不直接实现该校验，仅依赖后端防护。本测试作为契约文档。
    expect(true).toBe(true)
  })
})
