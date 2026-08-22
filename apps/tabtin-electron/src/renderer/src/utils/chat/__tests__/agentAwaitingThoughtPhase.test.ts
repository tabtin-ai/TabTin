import { describe, expect, it } from 'vitest'
import {
  hasStreamingThinkingContent,
  resolveAgentTurnTailActivity,
  resolveAgentAwaitingThoughtPhase,
} from '../agentAwaitingThoughtPhase'

describe('agentAwaitingThoughtPhase', () => {
  it('recognizes streaming thinking from the wire field and legacy text field', () => {
    expect(hasStreamingThinkingContent([
      { block: { type: 'thinking', thinking: '' }, finalized: false },
    ])).toBe(false)
    expect(hasStreamingThinkingContent([
      { block: { type: 'thinking', thinking: 'wire thinking' }, finalized: false },
    ])).toBe(true)
    expect(hasStreamingThinkingContent([
      { block: { type: 'thinking', text: 'legacy thinking' }, finalized: false },
    ])).toBe(true)
    expect(hasStreamingThinkingContent([
      { block: { type: 'thinking', thinking: 'finished' }, finalized: true },
    ])).toBe(false)
  })

  it('assigns every trailing block sequence to one activity owner', () => {
    expect(resolveAgentTurnTailActivity([])).toBe('none')
    expect(resolveAgentTurnTailActivity([
      { block: { type: 'thinking', thinking: 'planning' }, finalized: false },
    ])).toBe('thinking')
    expect(resolveAgentTurnTailActivity([
      { block: { type: 'text', text: 'answering' }, finalized: false },
    ])).toBe('text')
    expect(resolveAgentTurnTailActivity([
      { block: { type: 'tool_use', id: 'tu-1' }, finalized: false },
    ])).toBe('unsettledTool')
    expect(resolveAgentTurnTailActivity([
      { block: { type: 'tool_use', id: 'tu-1' }, finalized: true },
      { block: { type: 'tool_result', tool_use_id: 'tu-1' }, finalized: true },
      { block: { type: 'thinking', thinking: '' }, finalized: false },
    ])).toBe('settledTool')
    expect(resolveAgentTurnTailActivity([
      { block: { type: 'mcp_tool_use', id: 'mcp-1' }, finalized: true },
      { block: { type: 'mcp_tool_result', tool_use_id: 'mcp-1' }, finalized: true },
      { block: { type: 'thinking', thinking: '' }, finalized: false },
    ])).toBe('settledTool')
  })

  it('does not pair native and MCP results with the same id', () => {
    const blocks = [
      { block: { type: 'tool_use', id: 'shared-id' }, finalized: true },
      { block: { type: 'mcp_tool_use', id: 'shared-id' }, finalized: true },
      { block: { type: 'tool_result', tool_use_id: 'shared-id' }, finalized: true },
      { block: { type: 'thinking', thinking: '' }, finalized: false },
    ]

    // 尾部是 MCP 调用；原生结果和仅含 id 的 lifecycle 都不能把它误判完成。
    expect(resolveAgentTurnTailActivity(blocks)).toBe('unsettledTool')
    expect(resolveAgentTurnTailActivity(blocks, new Set(['shared-id']))).toBe('unsettledTool')
  })

  it('does not treat finalized thinking as the tool-after planning gap', () => {
    expect(resolveAgentTurnTailActivity([
      { block: { type: 'thinking', thinking: 'done thinking' }, finalized: true },
    ])).toBe('thinking')
  })

  it('shows planningNext only while a settled tool owns the tail', () => {
    const visible = (tailActivity: Parameters<typeof resolveAgentAwaitingThoughtPhase>[0]['tailActivity']) =>
      resolveAgentAwaitingThoughtPhase({
        sessionPulseVisible: true,
        isLastAssistantMsg: true,
        tailActivity,
      })

    expect(visible('none')).toBe('pending')
    expect(visible('settledTool')).toBe('planningNext')
    expect(visible('thinking')).toBe('hidden')
    expect(visible('text')).toBe('hidden')
    expect(visible('unsettledTool')).toBe('hidden')
    expect(visible('other')).toBe('hidden')

    expect(resolveAgentAwaitingThoughtPhase({
      sessionPulseVisible: false,
      isLastAssistantMsg: true,
      tailActivity: 'none',
    })).toBe('hidden')
    expect(resolveAgentAwaitingThoughtPhase({
      sessionPulseVisible: true,
      isLastAssistantMsg: false,
      tailActivity: 'settledTool',
    })).toBe('hidden')
  })
})
