import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import { describeTriggerFrequency } from './triggerFrequency'

const t = ((_key: string, options?: Record<string, unknown>) => {
  let result = String(options?.defaultValue ?? '')
  for (const [key, value] of Object.entries(options ?? {})) {
    result = result.replaceAll(`{{${key}}}`, String(value))
  }
  return result
}) as TFunction

describe('describeTriggerFrequency', () => {
  it('把列表返回的每日计划转换成用户可理解的时间', () => {
    const result = describeTriggerFrequency(
      'cron',
      { cron_expression: '0 9 * * *' },
      t,
    )

    expect(result.summary).toBe('每天 09:00 自动执行一次')
  })

  it('兼容存量 expression 字段', () => {
    const result = describeTriggerFrequency(
      'cron',
      { expression: '30 18 * * 1-5' },
      t,
    )

    expect(result.summary).toBe('每个工作日 18:30 自动执行一次')
  })

  it('自定义或缺失计划不再暴露 cron 技术术语', () => {
    const result = describeTriggerFrequency('cron', {}, t)

    expect(result.summary).toBe('按自定义计划自动执行')
    expect(result.summary.toLowerCase()).not.toContain('cron')
  })

  it('把定时一次的权威时间转换成明确的执行计划', () => {
    const result = describeTriggerFrequency(
      'at',
      { at: '2026-08-15T01:30:00.000Z' },
      t,
    )

    expect(result.summary).toMatch(/^2026-08-15 \d{2}:30 执行一次$/)
  })

  it('定时一次缺少合法时间时仍使用可理解的兜底文案', () => {
    const result = describeTriggerFrequency('at', {}, t)

    expect(result.summary).toBe('在设定时间执行一次')
  })
})
