import { describe, expect, it } from 'vitest'
import {
  formatAutomationRunTime,
  isAutomationListTrigger,
  isScheduledAutomationTrigger,
  toScheduledAutomationStatus,
} from './scheduledAutomation'

describe('scheduledAutomation', () => {
  it('只把 cron、interval、at 识别为桌面端定时任务', () => {
    expect(['cron', 'interval', 'at'].every(isScheduledAutomationTrigger)).toBe(true)
    expect(['manual', 'webhook', 'table_event', 'extension_event'].some(isScheduledAutomationTrigger))
      .toBe(false)
  })

  it('自动化列表展示手动和定时任务，隐藏事件触发任务', () => {
    expect(['manual', 'cron', 'interval', 'at'].every(isAutomationListTrigger)).toBe(true)
    expect(['webhook', 'table_event', 'extension_event'].some(isAutomationListTrigger)).toBe(false)
  })

  it('产品状态只暴露活动与暂停', () => {
    expect(toScheduledAutomationStatus('active')).toBe('active')
    expect(toScheduledAutomationStatus('paused')).toBe('paused')
    expect(toScheduledAutomationStatus('draft')).toBe('paused')
    expect(toScheduledAutomationStatus('disabled')).toBe('paused')
  })

  it('72 小时内显示相对时间，更早的 Run 显示绝对时间', () => {
    const now = new Date('2026-08-10T12:00:00.000Z')
    expect(formatAutomationRunTime('2026-08-10T10:00:00.000Z', now)).not.toMatch(/^2026-/)
    expect(formatAutomationRunTime('2026-08-01T12:00:00.000Z', now)).toMatch(/^2026-08-01 \d{2}:\d{2}$/)
  })
})
