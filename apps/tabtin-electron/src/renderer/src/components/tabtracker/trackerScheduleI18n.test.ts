import { describe, expect, it } from 'vitest'
import zhCN from '../../i18n/locales/zh-CN/tabtracker.json'
import enUS from '../../i18n/locales/en-US/tabtracker.json'

const REQUIRED_KEYS = [
  'prevWeek',
  'nextWeek',
  'prevMonth',
  'nextMonth',
  'today',
  'weekView',
  'monthView',
  'scopeOrganization',
  'scopeSpace',
  'scopeOrganizationShort',
  'scopeSpaceShort',
  'manage',
  'truncatedHint',
  'loadError',
  'emptyTitle',
  'emptyDescription',
  'narrowList',
  'pending',
  'weekGrid',
  'monthGrid',
  'moreCount',
  'moreAriaLabel',
] as const

describe('Tracker schedule i18n', () => {
  it.each([
    ['zh-CN', zhCN],
    ['en-US', enUS],
  ])('%s 包含日历模块实际使用的 schedule 文案', (_locale, resource) => {
    const schedule = (resource as { schedule?: Record<string, string> }).schedule
    expect(schedule).toBeTruthy()
    for (const key of REQUIRED_KEYS) {
      expect(schedule?.[key], key).toBeTypeOf('string')
      expect(schedule?.[key].trim(), key).not.toBe('')
    }
  })
})
