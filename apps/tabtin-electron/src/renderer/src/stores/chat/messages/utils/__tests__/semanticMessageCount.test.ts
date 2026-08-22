import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import {
  countSemanticMessages,
  countSemanticUserMessages,
  isContextInjectionMessage,
  isRenderableUserMessage,
  isRegularUserMessage,
  isSyntheticUserMessage,
} from '../semanticMessageCount'

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, 'role'>): ChatMessage {
  return {
    id: partial.id ?? `msg-${Math.random()}`,
    content: partial.content ?? '',
    created_at: partial.created_at ?? new Date().toISOString(),
    ...partial,
  }
}

describe('semanticMessageCount', () => {
  it('excludes environment_context', () => {
    const messages = [
      msg({ role: 'user', content: 'hello' }),
      msg({
        role: 'user',
        message_kind: 'environment_context',
        content: '<context type="environment">\nx\n</context>',
      }),
      msg({ role: 'assistant', agent_run_id: 'run-1', content: 'reply' }),
    ]
    expect(countSemanticMessages(messages)).toBe(2)
  })

  it('counts assistant turn with tool_artifact as one', () => {
    const messages = [
      msg({ role: 'user', content: 'q' }),
      msg({ role: 'assistant', agent_run_id: 'run-1', content: 'part1' }),
      msg({ role: 'assistant', message_kind: 'tool_artifact', agent_run_id: 'run-1', content: 'widget' }),
      msg({ role: 'assistant', agent_run_id: 'run-1', content: 'part2' }),
    ]
    expect(countSemanticMessages(messages)).toBe(2)
  })

  it('detects legacy environment wrapper', () => {
    const message = msg({
      role: 'user',
      content: '<context type="environment">\ncurrent_datetime: 2026\n</context>',
    })
    expect(isContextInjectionMessage(message)).toBe(true)
  })

  it('excludes agent_profile_context and its legacy wrapper', () => {
    const typed = msg({
      role: 'user',
      message_kind: 'agent_profile_context',
      content: '<context type="agent-profile">\n你是小 Tin。\n</context>',
    })
    const legacy = msg({
      role: 'user',
      message_kind: 'llm',
      content: '<context type="agent-profile">\n你是小 Tin。\n</context>',
    })

    expect(isContextInjectionMessage(typed)).toBe(true)
    expect(isContextInjectionMessage(legacy)).toBe(true)
    expect(countSemanticMessages([typed, legacy])).toBe(0)
  })

  it('excludes system_prompt_context', () => {
    const message = msg({
      role: 'user',
      message_kind: 'system_prompt_context',
      content: '<identity>\nsystem rules\n</identity>',
    })
    expect(isContextInjectionMessage(message)).toBe(true)
    expect(countSemanticMessages([message, msg({ role: 'user', content: 'hello' })])).toBe(1)
  })

  it('excludes other injected scaffolding kinds', () => {
    const messages = [
      msg({ role: 'user', message_kind: 'memory_recall', content: '<memory_recall>m</memory_recall>' }),
      msg({ role: 'user', message_kind: 'project_rules', content: '<project_rules>r</project_rules>' }),
      msg({ role: 'user', message_kind: 'todo_completion_nudge', content: 'keep going' }),
      msg({ role: 'user', content: 'hello' }),
    ]

    expect(messages.slice(0, 3).every((message) => !isRegularUserMessage(message))).toBe(true)
    expect(countSemanticMessages(messages)).toBe(1)
  })

  it('detects legacy role=system context and identity wrappers', () => {
    const profile = msg({
      role: 'system',
      content: '<context type="agent-profile">\nprofile rules\n</context>',
    })
    const identity = msg({
      role: 'system',
      content: '<identity>\nsystem rules\n</identity>',
    })

    expect(isContextInjectionMessage(profile)).toBe(true)
    expect(isContextInjectionMessage(identity)).toBe(true)
    expect(countSemanticMessages([profile, identity, msg({ role: 'assistant', content: 'reply' })])).toBe(1)
  })

  it('does not treat referenced context as injection', () => {
    const message = msg({
      role: 'user',
      content: '<context type="referenced" stale_after_turn="x">\nschema\n</context>\n请分析',
    })
    expect(isContextInjectionMessage(message)).toBe(false)
    expect(countSemanticMessages([message])).toBe(1)
  })

  it('hides shared-fork / handoff briefing and contract (incl. legacy system)', () => {
    expect(
      isContextInjectionMessage(
        msg({
          role: 'user',
          message_kind: 'environment_context',
          content: '本会话由共享任务副本创建。',
          metadata: { share_briefing: true },
        }),
      ),
    ).toBe(true)
    expect(
      isContextInjectionMessage(
        msg({
          role: 'system',
          message_kind: 'llm',
          content: '<context type="session-share-fork">\n{}\n</context>',
          metadata: { share_contract: true },
        }),
      ),
    ).toBe(true)
    expect(
      countSemanticMessages([
        msg({
          role: 'system',
          content: 'briefing',
          metadata: { share_briefing: true },
        }),
        msg({ role: 'user', content: 'hello' }),
        msg({ role: 'assistant', content: 'reply' }),
      ]),
    ).toBe(2)
  })

  describe('isRegularUserMessage（ 正向分轮）', () => {
    it('真用户 / 缺省 kind → true', () => {
      expect(isRegularUserMessage(msg({ role: 'user', content: 'hello' }))).toBe(true)
      expect(
        isRegularUserMessage(msg({ role: 'user', message_kind: 'llm', content: 'hello' })),
      ).toBe(true)
    })

    it('专用 kind（含 compaction）→ false', () => {
      expect(
        isRegularUserMessage(
          msg({ role: 'user', message_kind: 'compaction_summary', content: '[对话摘要]' }),
        ),
      ).toBe(false)
      expect(
        isRegularUserMessage(
          msg({ role: 'user', message_kind: 'environment_context', content: '<context' }),
        ),
      ).toBe(false)
      expect(
        isRegularUserMessage(
          msg({ role: 'user', message_kind: 'agent_profile_context', content: '<context' }),
        ),
      ).toBe(false)
      expect(
        isRegularUserMessage(
          msg({ role: 'user', message_kind: 'system_prompt_context', content: '<identity>' }),
        ),
      ).toBe(false)
    })

    it('未知专用 kind 默认不作为可渲染用户消息', () => {
      const message = msg({
        role: 'user',
        message_kind: 'future_internal_context',
        content: 'internal',
      })

      expect(isRegularUserMessage(message)).toBe(false)
      expect(isRenderableUserMessage(message)).toBe(false)
    })

    it('push / skill_invoke → false；triggered_by=user 仍 true', () => {
      expect(
        isRegularUserMessage(
          msg({
            role: 'user',
            content: 'push',
            metadata: { triggered_by: 'push-notification' },
          }),
        ),
      ).toBe(false)
      expect(
        isRegularUserMessage(
          msg({
            role: 'user',
            content: 'skill',
            metadata: { source: 'skill_invoke' },
          }),
        ),
      ).toBe(false)
      expect(
        isRegularUserMessage(
          msg({
            role: 'user',
            content: 'hello',
            metadata: { triggered_by: 'user' },
          }),
        ),
      ).toBe(true)
    })

    it('附件 / 引用回复 / referenced / relay_events / widget 仍为用户轮', () => {
      expect(
        isRegularUserMessage(
          msg({
            role: 'user',
            content: '',
            attachments_json: [{ type: 'file', filename: 'a.pdf', mime_type: 'application/pdf', size: 1 }],
          }),
        ),
      ).toBe(true)
      expect(
        isRegularUserMessage(
          msg({
            role: 'user',
            content: '引用回复',
            reply_to_message_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            reply_to_preview: { role: 'assistant', author: 'Agent', text: 'prev' },
          }),
        ),
      ).toBe(true)
      expect(
        isRegularUserMessage(
          msg({
            role: 'user',
            content: '<context type="referenced">\nx\n</context>\n请分析',
          }),
        ),
      ).toBe(true)
      expect(
        isRegularUserMessage(
          msg({
            role: 'user',
            content: 'hello',
            metadata: { source: 'relay_events' },
          }),
        ),
      ).toBe(true)
      expect(
        isRegularUserMessage(
          msg({
            role: 'user',
            content: 'from widget',
            metadata: { source: 'widget' },
          }),
        ),
      ).toBe(true)
    })

    it('isSyntheticUserMessage 为正向谓词的薄反义', () => {
      expect(isSyntheticUserMessage(msg({ role: 'user', content: 'hello' }))).toBe(false)
      expect(
        isSyntheticUserMessage(
          msg({ role: 'user', message_kind: 'compaction_summary', content: 'x' }),
        ),
      ).toBe(true)
      expect(isSyntheticUserMessage(msg({ role: 'assistant', content: 'x' }))).toBe(false)
    })
  })

  it('countSemanticUserMessages 只计真实用户轮', () => {
    const messages = [
      msg({ role: 'user', content: 'hello' }),
      msg({
        role: 'user',
        message_kind: 'environment_context',
        content: '<context type="environment">\nx\n</context>',
      }),
      msg({
        role: 'user',
        message_kind: 'compaction_summary',
        content: '[对话摘要]',
      }),
      msg({
        role: 'user',
        content: 'invoke skill',
        metadata: { source: 'skill_invoke' },
      }),
      msg({
        role: 'user',
        content: 'push turn',
        metadata: { triggered_by: 'push-notification' },
      }),
      msg({ role: 'assistant', content: 'reply' }),
    ]
    expect(countSemanticUserMessages(messages)).toBe(1)
  })

  it('countSemanticUserMessages counts two real user turns', () => {
    const messages = [
      msg({ role: 'user', content: 'first' }),
      msg({ role: 'assistant', content: 'reply' }),
      msg({ role: 'user', content: 'second' }),
    ]
    expect(countSemanticUserMessages(messages)).toBe(2)
  })

  describe('countSemanticMessages 方案 A：仅真实用户 + Agent，相邻 Agent 合并', () => {
    it('相邻不同 agent_run_id 的 assistant 合并为 1', () => {
      expect(
        countSemanticMessages([
          msg({ role: 'assistant', agent_run_id: 'run-1', content: 'a1' }),
          msg({ role: 'assistant', agent_run_id: 'run-2', content: 'a2' }),
        ]),
      ).toBe(1)
    })

    it('user + 相邻多段 assistant（异 run / tool_artifact）计 2', () => {
      expect(
        countSemanticMessages([
          msg({ role: 'user', content: 'q' }),
          msg({ role: 'assistant', agent_run_id: 'run-1', content: 'part1' }),
          msg({ role: 'assistant', message_kind: 'tool_artifact', agent_run_id: 'run-1', content: 'widget' }),
          msg({ role: 'assistant', agent_run_id: 'run-2', content: 'part2' }),
        ]),
      ).toBe(2)
    })

    it('compaction / push / skill_invoke / system 不计', () => {
      expect(
        countSemanticMessages([
          msg({ role: 'user', message_kind: 'compaction_summary', content: '[摘要]' }),
          msg({ role: 'user', content: 'push', metadata: { triggered_by: 'push-notification' } }),
          msg({ role: 'user', content: 'skill', metadata: { source: 'skill_invoke' } }),
          msg({ role: 'system', content: 'noise' }),
          msg({ role: 'user', content: 'hello' }),
          msg({ role: 'assistant', content: 'reply' }),
        ]),
      ).toBe(2)
    })

    it('真实 user 打断相邻 agent 合并', () => {
      expect(
        countSemanticMessages([
          msg({ role: 'assistant', agent_run_id: 'run-1', content: 'a1' }),
          msg({ role: 'user', content: 'mid' }),
          msg({ role: 'assistant', agent_run_id: 'run-2', content: 'a2' }),
        ]),
      ).toBe(3)
    })

    it('error_envelope 并入相邻 agent 合并', () => {
      expect(
        countSemanticMessages([
          msg({ role: 'assistant', agent_run_id: 'run-1', content: 'part' }),
          msg({ role: 'assistant', message_kind: 'error_envelope', content: 'err' }),
          msg({ role: 'assistant', agent_run_id: 'run-2', content: 'more' }),
        ]),
      ).toBe(1)
    })

    it('仅透明 assistant / 注入行 → 0', () => {
      expect(
        countSemanticMessages([
          msg({ role: 'assistant', message_kind: 'tool_artifact', content: 'w' }),
          msg({
            role: 'user',
            message_kind: 'environment_context',
            content: '<context type="environment">\nx\n</context>',
          }),
        ]),
      ).toBe(0)
    })

    it('可展示的已回答 HITL 仍不新增语义消息或用户轮', () => {
      const hitl = msg({
        role: 'assistant',
        message_kind: 'hitl_interaction',
        metadata: {
          hitl: {
            kind: 'ask_choice',
            status: 'resolved',
            payload: {
              questions: [{
                id: 'q1',
                prompt: '选择主题',
                options: [{ id: 'a', label: '人工智能' }],
              }],
            },
            result: {
              outcome: 'answered',
              answers: [{ question_id: 'q1', selected_options: ['a'] }],
            },
          },
        },
      })

      expect(isRegularUserMessage(hitl)).toBe(false)
      expect(countSemanticMessages([
        msg({ role: 'assistant', content: 'before' }),
        hitl,
        msg({ role: 'assistant', content: 'after' }),
      ])).toBe(1)
    })
  })
})
