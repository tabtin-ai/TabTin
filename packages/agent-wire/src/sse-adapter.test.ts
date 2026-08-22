import { describe, expect, it } from 'vitest'
import { mapWsEventToSse } from './sse-adapter'

describe('mapWsEventToSse', () => {
  // W4 (2026-05-11): ask 三件套合一为单 ask_user_required。
  it('保留 ask_user_required 的完整结构化载荷', () => {
    const result = mapWsEventToSse({
      type: 'agent.stream.ask_user_required',
      thread_id: 'chat-session-1',
      payload: {
        thread_id: 'chat-session-1',
        interrupt_id: 'ask-1',
        interaction_type: 'ask_user',
        blocking_policy: 'hard',
        tool_name: 'ask_user',
        tool_call_id: 'tool-1',
        title: '请补充参数',
        message: 'Agent 正在等待你的回答',
        questions: [{
          id: 'q1',
          prompt: '怎么处理？',
          options: [
            { id: 'a', label: 'A', description: '选 A。' },
            { id: 'b', label: 'B', description: '选 B。' },
          ],
        }],
      },
    })

    expect(result).toMatchObject({
      type: 'ask_user_required',
      ask_id: 'ask-1',
      thread_id: 'chat-session-1',
      interrupt_id: 'ask-1',
      interaction_type: 'ask_user',
      blocking_policy: 'hard',
      tool_name: 'ask_user',
      tool_call_id: 'tool-1',
      title: '请补充参数',
    })
    expect(result?.questions).toHaveLength(1)
  })

  it('保留 review_required 的阻塞语义与动作列表', () => {
    const result = mapWsEventToSse({
      type: 'agent.stream.review_required',
      thread_id: 'chat-session-1',
      payload: {
        thread_id: 'chat-session-1',
        interrupt_id: 'review-1',
        interaction_type: 'review',
        blocking_policy: 'hard',
        message: '需要你确认危险操作',
        action_requests: [{
          tool_name: 'Shell',
          tool_call_id: 'tool-1',
        }],
        review_configs: [{
          action_name: 'Shell',
          allowed_decisions: ['approve', 'reject'],
        }],
      },
    })

    expect(result).toMatchObject({
      type: 'review_required',
      review_id: 'review-1',
      interrupt_id: 'review-1',
      interaction_type: 'review',
      blocking_policy: 'hard',
      action_requests: [{
        tool_name: 'Shell',
        tool_call_id: 'tool-1',
      }],
      review_configs: [{
        action_name: 'Shell',
        allowed_decisions: ['approve', 'reject'],
      }],
    })
  })
})
