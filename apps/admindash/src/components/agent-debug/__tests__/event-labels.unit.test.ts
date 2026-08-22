import { describe, expect, it } from 'vitest'
import { getEventNameLabel, getEventPhaseLabel, getEventTypeLabel } from '../event-labels'

describe('event-labels', () => {
  it('翻译常见事件类型与名称', () => {
    expect(getEventTypeLabel('system_notice')).toBe('系统通知')
    expect(getEventTypeLabel('step')).toBe('步骤')
    expect(getEventNameLabel('thinking')).toBe('分析任务')
    expect(getEventNameLabel('llm_timing')).toBe('模型耗时')
    expect(getEventPhaseLabel('start')).toBe('开始')
    expect(getEventPhaseLabel('end')).toBe('结束')
  })

  it('未知值保留原文', () => {
    expect(getEventTypeLabel('custom_type_x')).toBe('custom_type_x')
    expect(getEventNameLabel('weird_name')).toBe('weird_name')
  })
})
