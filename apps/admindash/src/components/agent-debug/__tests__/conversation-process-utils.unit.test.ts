import { describe, expect, it } from 'vitest'
import type { ThreadOverviewMessage } from '@/types/agent-debug'
import {
  buildMessageProcessView,
  collectContentBlocksForTrace,
  formatThinkingDuration,
  hasProcessContentBlocks,
} from '../conversation-process-utils'

describe('collectContentBlocksForTrace', () => {
  it('按 trace_id 汇总消息 content_blocks', () => {
    const messages = [
      {
        id: 'm1',
        trace_id: 'tr-a',
        content_blocks_json: [{ type: 'thinking', thinking: 'a' }],
      },
      {
        id: 'm2',
        trace_id: 'tr-a',
        content_blocks_json: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }],
      },
      {
        id: 'm3',
        trace_id: 'tr-b',
        content_blocks_json: [{ type: 'thinking', thinking: 'other' }],
      },
    ] as ThreadOverviewMessage[]

    expect(collectContentBlocksForTrace(messages, 'tr-a')).toEqual([
      { type: 'thinking', thinking: 'a' },
      { type: 'tool_use', id: 't1', name: 'x', input: {} },
    ])
    expect(collectContentBlocksForTrace(messages, 'missing')).toEqual([])
  })
})

describe('hasProcessContentBlocks', () => {
  it('识别思考与工具块', () => {
    expect(hasProcessContentBlocks([{ type: 'text', text: 'hi' }])).toBe(false)
    expect(hasProcessContentBlocks([{ type: 'thinking', thinking: '先规划' }])).toBe(true)
    expect(
      hasProcessContentBlocks([{ type: 'tool_use', id: 't1', name: 'skills.read', input: {} }])
    ).toBe(true)
  })
})

describe('buildMessageProcessView', () => {
  it('配对 tool_use 与 tool_result，并抽出思考与正文', () => {
    const view = buildMessageProcessView([
      {
        type: 'thinking',
        thinking: '用户想生成云文档',
        duration_ms: 5500,
      },
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'skills.read',
        input: { path: 'tabdoc-operator.md' },
      },
      {
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: '文件不存在',
        is_error: true,
      },
      {
        type: 'text',
        text: 'Agent 已执行生成文件任务',
      },
    ])

    expect(view.thinkingSteps).toEqual([
      {
        kind: 'thinking',
        text: '用户想生成云文档',
        durationMs: 5500,
      },
    ])
    expect(view.toolSteps).toEqual([
      {
        id: 'toolu_1',
        name: 'skills.read',
        input: { path: 'tabdoc-operator.md' },
        result: '文件不存在',
        isError: true,
      },
    ])
    expect(view.textFromBlocks).toBe('Agent 已执行生成文件任务')
  })

  it('兼容老 tool_call 与 thinking.content', () => {
    const view = buildMessageProcessView([
      { type: 'thinking', content: '旧字段思考' },
      {
        type: 'tool_call',
        id: 'legacy-1',
        name: 'bash',
        args: { command: 'ls' },
        output: 'ok',
      },
    ])
    expect(view.thinkingSteps[0]?.text).toBe('旧字段思考')
    expect(view.toolSteps[0]).toMatchObject({
      id: 'legacy-1',
      name: 'bash',
      result: 'ok',
    })
  })
})

describe('formatThinkingDuration', () => {
  it('格式化秒数', () => {
    expect(formatThinkingDuration(5500)).toBe('5.5 秒')
    expect(formatThinkingDuration(12000)).toBe('12 秒')
    expect(formatThinkingDuration(null)).toBeNull()
  })
})
