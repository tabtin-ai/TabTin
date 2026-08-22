import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  SKILL_MARKET_CATEGORIES,
  SKILL_CONSUMER_CATEGORIES,
  SKILL_CAPABILITY_CATEGORIES,
  SKILL_CATEGORY_GROUPS,
  SKILL_LIST_DISPLAY_GROUPS,
  normalizeSkillCategory,
  skillCategoryLabelKey,
  skillCategoryLabelKeyWithFallback,
  resolveSkillListDisplayGroupId,
  groupSkillsByCategory,
  SKILL_UNCLASSIFIED_LABEL_KEY,
} from '../skillCategory'

const __dirname = dirname(fileURLToPath(import.meta.url))
const skillsDir = resolve(__dirname, '..')

function loadLocale(locale: 'en-US' | 'zh-CN'): any {
  return JSON.parse(
    readFileSync(resolve(skillsDir, `../../../i18n/locales/${locale}/context.json`), 'utf8'),
  )
}

const EXPECTED_27 = [
  'productivity', 'writing', 'research', 'analysis', 'project_management',
  'sales_crm', 'customer_support', 'education', 'finance', 'hr', 'legal',
  'marketing', 'design', 'developer', 'ai_media', 'lifestyle', 'other',
  'data', 'doc', 'web', 'media', 'device', 'collaboration', 'workflow',
  'knowledge', 'communication', 'automation',
]

describe('skillCategory 枚举', () => {
  it('总枚举 = 27 类（任务类型 17 + 能力域 10）', () => {
    expect([...SKILL_MARKET_CATEGORIES].sort()).toEqual([...EXPECTED_27].sort())
    expect(new Set(SKILL_MARKET_CATEGORIES).size).toBe(27)
  })

  it('任务类型 17 类 / 能力域 10 类，developer 仅在任务类型（不重复）', () => {
    expect(SKILL_CONSUMER_CATEGORIES).toContain('developer')
    expect(SKILL_CAPABILITY_CATEGORIES).not.toContain('developer')
    expect(SKILL_CONSUMER_CATEGORIES.length).toBe(17)
    expect(SKILL_CAPABILITY_CATEGORIES.length).toBe(10)
  })

  it('分组覆盖全部 27 类且无重复', () => {
    const flat = SKILL_CATEGORY_GROUPS.flatMap((g) => [...g.categories])
    expect(flat.sort()).toEqual([...EXPECTED_27].sort())
    expect(new Set(flat).size).toBe(27)
  })
})

describe('SKILL_LIST_DISPLAY_GROUPS 列表展示合并', () => {
  it('7 个展示分组覆盖全部 27 细分类且无重复', () => {
    const flat = SKILL_LIST_DISPLAY_GROUPS.flatMap((g) => [...g.categories])
    expect(flat.sort()).toEqual([...EXPECTED_27].sort())
    expect(new Set(flat).size).toBe(27)
  })

  it('groupSkillsByCategory 按展示分组合并（非逐细分类）', () => {
    const groups = groupSkillsByCategory([
      { category: 'data', skill_key: 'a' },
      { category: 'doc', skill_key: 'b' },
      { category: 'knowledge', skill_key: 'c' },
      { category: 'developer', skill_key: 'd' },
    ])
    expect(groups).toHaveLength(3)
    expect(groups[0].labelKey).toBe('skills.panel.categoryGroup.data')
    expect(groups[1].labelKey).toBe('skills.panel.categoryGroup.docKnowledge')
    expect(groups[1].skills).toHaveLength(2)
    expect(groups[2].labelKey).toBe('skills.panel.categoryGroup.devRuntime')
  })

  it.each(EXPECTED_27)('细分类 %s 可映射到展示分组', (cat) => {
    expect(resolveSkillListDisplayGroupId(cat)).not.toBeNull()
  })
})

describe('normalizeSkillCategory', () => {
  it.each(EXPECTED_27)('合法值 %s 归一化为自身（非 null）', (cat) => {
    expect(normalizeSkillCategory(cat)).toBe(cat)
  })

  it('大小写 / 空白归一化', () => {
    expect(normalizeSkillCategory(' Data ')).toBe('data')
    expect(normalizeSkillCategory('COLLABORATION')).toBe('collaboration')
  })

  it('非法 / 空值返回 null', () => {
    expect(normalizeSkillCategory('nonsense')).toBeNull()
    expect(normalizeSkillCategory('')).toBeNull()
    expect(normalizeSkillCategory(null)).toBeNull()
    expect(normalizeSkillCategory(undefined)).toBeNull()
  })

  it('skillCategoryLabelKey 映射到 skillMarket.category.*', () => {
    expect(skillCategoryLabelKey('media')).toBe('skillMarket.category.media')
    expect(skillCategoryLabelKey('nonsense')).toBeNull()
  })

  it('skillCategoryLabelKeyWithFallback：无分类/未知分类回退到未分类', () => {
    expect(skillCategoryLabelKeyWithFallback(undefined)).toBe(SKILL_UNCLASSIFIED_LABEL_KEY)
    expect(skillCategoryLabelKeyWithFallback('unknown')).toBe(SKILL_UNCLASSIFIED_LABEL_KEY)
    expect(skillCategoryLabelKeyWithFallback('data')).toBe('skillMarket.category.data')
  })
})

describe('skillCategory i18n 完整性', () => {
  const en = loadLocale('en-US')
  const zh = loadLocale('zh-CN')

  it.each(EXPECTED_27)('skillMarket.category.%s 在中英文都有标签', (cat) => {
    expect(typeof en.skillMarket.category[cat]).toBe('string')
    expect(en.skillMarket.category[cat].length).toBeGreaterThan(0)
    expect(typeof zh.skillMarket.category[cat]).toBe('string')
    expect(zh.skillMarket.category[cat].length).toBeGreaterThan(0)
  })

  it('skillMarket.category.unclassified 在中英文都有标签', () => {
    expect(typeof en.skillMarket.category.unclassified).toBe('string')
    expect(en.skillMarket.category.unclassified.length).toBeGreaterThan(0)
    expect(typeof zh.skillMarket.category.unclassified).toBe('string')
    expect(zh.skillMarket.category.unclassified.length).toBeGreaterThan(0)
  })

  it('新建对话框分组标签（能力域 / 通用）中英文都有', () => {
    for (const loc of [en, zh]) {
      expect(typeof loc.skills.createDialog.categoryGroup.capability).toBe('string')
      expect(typeof loc.skills.createDialog.categoryGroup.general).toBe('string')
    }
  })

  it('修改分类 Modal 文案中英文都有', () => {
    for (const loc of [en, zh]) {
      expect(typeof loc.skills.categoryDialog.menuItem).toBe('string')
      expect(typeof loc.skills.categoryDialog.title).toBe('string')
      expect(typeof loc.skills.categoryDialog.save).toBe('string')
    }
  })

  it('列表展示分组标签（7 组合并标题）中英文都有', () => {
    const keys = [
      'data', 'docKnowledge', 'devRuntime', 'collabWorkflow',
      'mediaDesign', 'productivityResearch', 'businessMisc',
    ] as const
    for (const loc of [en, zh]) {
      for (const key of keys) {
        expect(typeof loc.skills.panel.categoryGroup[key]).toBe('string')
        expect(loc.skills.panel.categoryGroup[key].length).toBeGreaterThan(0)
      }
    }
  })
})
