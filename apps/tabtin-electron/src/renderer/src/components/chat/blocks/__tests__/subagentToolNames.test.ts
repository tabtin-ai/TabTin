import { describe, expect, it } from 'vitest'
import {
  classifySubagentToolInput,
  getSubagentCheckId,
  getSubagentWaitIds,
  isSubagentDispatchInput,
} from '../subagentToolNames'

describe('agent 工具意图分类', () => {
  it.each([
    [{ prompt: '执行任务' }, 'spawn', true],
    [{ prompt: '继续', resume_agent_id: 'child-1' }, 'resume', true],
    [{ check_agent_id: 'child-1' }, 'check', false],
    [{ wait_agent_ids: ['child-1', 'child-2'] }, 'wait', false],
    [{ prompt: '执行任务', wait_agent_ids: [] }, 'spawn', true],
    [{ prompt: '执行任务', wait_agent_ids: ['  '] }, 'spawn', true],
    [{ prompt: '执行任务', check_agent_id: '', resume_agent_id: '' }, 'spawn', true],
    [{}, 'unknown', false],
    [undefined, 'unknown', false],
  ] as const)('将 %j 分类为 %s', (input, intent, dispatch) => {
    expect(classifySubagentToolInput(input)).toBe(intent)
    expect(isSubagentDispatchInput(input)).toBe(dispatch)
  })

  it('优先级与 runtime 一致：wait 不会因同时存在其它字段而退化为派发', () => {
    const input = {
      wait_agent_ids: [' child-1 ', 'child-1', '', 'child-2'],
      check_agent_id: 'child-3',
      resume_agent_id: 'child-4',
      prompt: '不应派发',
    }

    expect(classifySubagentToolInput(input)).toBe('wait')
    expect(getSubagentWaitIds(input)).toEqual(['child-1', 'child-2'])
  })

  it('流式 JSON 尚未闭合时，看到首个有效 wait ID 后识别为等待', () => {
    const partialInput = '{"wait_agent_ids":["child-1"'

    expect(classifySubagentToolInput(partialInput)).toBe('wait')
    expect(isSubagentDispatchInput(partialInput)).toBe(false)
    expect(getSubagentWaitIds(partialInput)).toEqual([])
  })

  it('流式 JSON 在首个元素为空但后续非空时仍能识别为等待', () => {
    const partialInput = '{"wait_agent_ids":["","child-1"'

    expect(classifySubagentToolInput(partialInput)).toBe('wait')
    expect(isSubagentDispatchInput(partialInput)).toBe(false)
  })

  it('流式空控制字段不遮蔽后续有效 prompt', () => {
    const partialInput = '{"wait_agent_ids":[],"check_agent_id":"","prompt":"执行任务"'

    expect(classifySubagentToolInput(partialInput)).toBe('spawn')
    expect(isSubagentDispatchInput(partialInput)).toBe(true)
    expect(getSubagentWaitIds(partialInput)).toBeNull()
  })

  it('check_agent_id 只从完整对象提取 ID，流式阶段先保留查询语义', () => {
    expect(getSubagentCheckId({ check_agent_id: ' child-1 ' })).toBe('child-1')

    const partialInput = '{"check_agent_id":"child-1'
    expect(classifySubagentToolInput(partialInput)).toBe('check')
    expect(isSubagentDispatchInput(partialInput)).toBe(false)
    expect(getSubagentCheckId(partialInput)).toBeNull()
  })
})
