import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const localesDir = dirname(fileURLToPath(import.meta.url))

type JsonObject = Record<string, unknown>

function readOrganizationLocale(locale: 'zh-CN' | 'en-US'): JsonObject {
  return JSON.parse(
    readFileSync(join(localesDir, locale, 'organization.json'), 'utf8'),
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

const REQUIRED_LLM_KEYS = [
  'llm.defaultConfig.title',
  'llm.defaultConfig.subtitle',
  'llm.defaultConfig.configured',
  'llm.defaultConfig.notConfigured',
  'llm.defaultConfig.currentModel',
  'llm.defaultConfig.mainModel',
  'llm.defaultConfig.pickHint',
  'llm.defaultConfig.unavailableCurrent',
  'llm.defaultConfig.selectHelp',
  'llm.defaultConfig.deviceModelGroup',
  'llm.defaultConfig.currentDevice',
  'llm.defaultConfig.deviceModelDescription',
  'llm.defaultConfig.subagentPolicy',
  'llm.defaultConfig.subagentHelp',
  'llm.defaultConfig.subagentInherit',
  'llm.defaultConfig.subagentFixed',
  'llm.defaultConfig.subagentModel',
  'llm.defaultConfig.pickSubagentModel',
  'llm.presetSection.title',
  'llm.presetSection.subtitle',
  'llm.presetSection.collapse',
  'llm.presetSection.expandHint',
  'llm.models.statusReady',
  'llm.models.statusProviderDisabled',
  'llm.models.statusNotReady',
  'llm.providers.probeErrors.unauthorized',
  'llm.providers.probeErrors.forbidden',
  'llm.providers.probeErrors.notFound',
  'llm.providers.probeErrors.rateLimited',
  'llm.providers.probeErrors.serverError',
  'llm.providers.probeErrors.timeout',
  'llm.providers.probeErrors.network',
  'llm.providers.probeErrors.invalidRequest',
  'llm.providers.probeErrors.quotaExceeded',
  'llm.providers.probeErrors.generic',
  'llm.providers.probeErrors.withDetail',
] as const

describe('organization llm model settings i18n ', () => {
  it('中英文都提供 Model Settings 关键词条，且英文不是中文原文', () => {
    const zh = readOrganizationLocale('zh-CN')
    const en = readOrganizationLocale('en-US')

    for (const key of REQUIRED_LLM_KEYS) {
      const zhValue = getPath(zh, key)
      const enValue = getPath(en, key)
      expect(typeof zhValue, key).toBe('string')
      expect(typeof enValue, key).toBe('string')
      expect((zhValue as string).length, key).toBeGreaterThan(0)
      expect((enValue as string).length, key).toBeGreaterThan(0)
      expect(enValue, key).not.toBe(zhValue)
    }

    expect(getPath(zh, 'llm.defaultConfig.title')).toBe('默认模型配置')
    expect(getPath(en, 'llm.defaultConfig.title')).toBe('Default model configuration')
    expect(getPath(zh, 'llm.presetSection.expandHint')).toContain('{{count}}')
    expect(getPath(en, 'llm.presetSection.expandHint')).toContain('{{count}}')
    expect(getPath(en, 'llm.models.statusReady')).toBe('Ready')
    expect(getPath(zh, 'llm.providers.probeErrors.notFound')).toContain('模型')
    expect(getPath(en, 'llm.providers.probeErrors.notFound')).toMatch(/model|endpoint/i)
    expect(getPath(zh, 'llm.providers.probeErrors.serverError')).toContain('{{status}}')
    expect(getPath(en, 'llm.providers.probeErrors.serverError')).toContain('{{status}}')
  })
})
