import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const localesDir = dirname(fileURLToPath(import.meta.url))

type JsonObject = Record<string, unknown>

function readContext(locale: 'zh-CN' | 'en-US'): JsonObject {
  return JSON.parse(
    readFileSync(join(localesDir, locale, 'context.json'), 'utf8'),
  ) as JsonObject
}

function getPath(root: JsonObject, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as JsonObject)) {
      return (acc as JsonObject)[key]
    }
    return undefined
  }, root)
}

const KEYS = [
  'skills.agentSkills.subtitle',
  'skills.agentSkills.addButton',
  'skills.agentSkills.empty',
  'skills.agentSkills.previewEmpty',
  'skills.agentSkills.guideCapability',
  'skills.agentSkills.guideTrigger',
  'skills.agentSkills.pickerDescription',
  'skills.effectiveSources.entryButton',
  'skills.localChanges.badge',
] as const

/** SkillPanel / skillCategory 仍读取的 panel 键，禁止再被 merge 冲掉 */
const PANEL_KEYS = [
  'skills.panel.builtinLockedOn',
  'skills.panel.categoryGroup.data',
  'skills.panel.categoryGroup.docKnowledge',
  'skills.panel.categoryGroup.devRuntime',
  'skills.panel.categoryGroup.collabWorkflow',
  'skills.panel.categoryGroup.mediaDesign',
  'skills.panel.categoryGroup.productivityResearch',
  'skills.panel.categoryGroup.businessMisc',
] as const

describe('context agentSkills i18n ', () => {
  it('中英文都提供携带集文案，英文不是中文原文', () => {
    const zh = readContext('zh-CN')
    const en = readContext('en-US')
    for (const key of KEYS) {
      const zhValue = getPath(zh, key)
      const enValue = getPath(en, key)
      expect(typeof zhValue, key).toBe('string')
      expect(typeof enValue, key).toBe('string')
      expect(enValue, key).not.toBe(zhValue)
      expect(enValue as string, key).not.toMatch(/[\u4e00-\u9fff]/)
    }
    expect(getPath(zh, 'skills.agentSkills.addButton')).toBe('添加技能')
    expect(getPath(en, 'skills.agentSkills.addButton')).toBe('Add skill')
  })

  it('skills.panel.builtinLockedOn 与 categoryGroup.* 中英文均保留', () => {
    const zh = readContext('zh-CN')
    const en = readContext('en-US')
    for (const key of PANEL_KEYS) {
      const zhValue = getPath(zh, key)
      const enValue = getPath(en, key)
      expect(typeof zhValue, key).toBe('string')
      expect(typeof enValue, key).toBe('string')
      expect((zhValue as string).length, key).toBeGreaterThan(0)
      expect((enValue as string).length, key).toBeGreaterThan(0)
      expect(enValue, key).not.toBe(zhValue)
      expect(enValue as string, key).not.toMatch(/[\u4e00-\u9fff]/)
    }
    expect(getPath(zh, 'skills.panel.builtinLockedOn')).toBe(
      '内置 Skill 默认开启，暂不支持关闭',
    )
    expect(getPath(en, 'skills.panel.builtinLockedOn')).toBe(
      'Built-in skills stay on and cannot be turned off yet',
    )
  })
})
