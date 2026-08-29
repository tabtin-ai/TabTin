import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import {
  getAssistantAnchoredPushNotifications,
  getInlineSubagentPushNotification,
  isRenderableSystemMessage,
  shouldHidePushNotificationAtTopLevel,
} from '@stores/chat/presentation/messageBubble/timelineMessageVisibility'

function pushMessage(content: string, role: 'user' | 'system' = 'user'): ChatMessage {
  return {
    id: 'push-user-1',
    role,
    content,
    created_at: '2026-06-08T07:20:00.000Z',
    metadata: { triggered_by: 'push-notification' },
  } as ChatMessage
}

function assistantMessage(id: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: 'assistant reply',
    created_at: '2026-06-08T07:21:00.000Z',
  } as ChatMessage
}

function userMessage(id: string): ChatMessage {
  return {
    id,
    role: 'user',
    content: 'normal user',
    created_at: '2026-06-08T07:19:00.000Z',
  } as ChatMessage
}

function systemMessage(id: string): ChatMessage {
  return {
    id,
    role: 'system',
    content: 'system notice',
    created_at: '2026-06-08T07:20:30.000Z',
  } as ChatMessage
}

function subagentBlock(opts: {
  runId: string
  label: string
  parentToolCallId?: string
}): string {
  const lines = [
    '<task-notification kind="subagent-completed">',
    `<subagent-run-id>${opts.runId}</subagent-run-id>`,
    `<label>${opts.label}</label>`,
    '<status>completed</status>',
    '<duration-ms>2000</duration-ms>',
  ]
  if (opts.parentToolCallId) {
    lines.push(`<parent-tool-call-id>${opts.parentToolCallId}</parent-tool-call-id>`)
  }
  lines.push('<summary>done</summary>', '</task-notification>')
  return lines.join('\n')
}

describe('getInlineSubagentPushNotification', () => {
  it('持久化为 system 的 push notification 仍可识别', () => {
    const message = pushMessage(subagentBlock({
      runId: 'run-system',
      label: '系统通知任务',
      parentToolCallId: 'toolu-system',
    }), 'system')

    expect(getInlineSubagentPushNotification(message)?.tasks[0]).toMatchObject({
      kind: 'subagent',
      parentToolCallId: 'toolu-system',
    })
  })

  it('单个子 Agent 且带 parent-tool-call-id → 可 inline', () => {
    const message = pushMessage(subagentBlock({
      runId: 'run-1',
      label: '查看磁盘使用情况',
      parentToolCallId: 'toolu-df',
    }))

    expect(getInlineSubagentPushNotification(message)?.tasks[0]).toMatchObject({
      kind: 'subagent',
      parentToolCallId: 'toolu-df',
    })
  })

  it('runId-only 通知不 inline，避免顶层隐藏后因 runtime store 缺失漏渲染', () => {
    const message = pushMessage(subagentBlock({
      runId: 'run-1',
      label: '查看磁盘使用情况',
    }))

    expect(getInlineSubagentPushNotification(message)).toBeNull()
  })

  it('多子 Agent 批量通知不 inline，避免跨非连续 tool_use 时整条通知消失', () => {
    const message = pushMessage([
      subagentBlock({ runId: 'run-1', label: '任务 A', parentToolCallId: 'toolu-a' }),
      subagentBlock({ runId: 'run-2', label: '任务 B', parentToolCallId: 'toolu-b' }),
    ].join('\n\n'))

    expect(getInlineSubagentPushNotification(message)).toBeNull()
  })
})

describe('isRenderableSystemMessage', () => {
  it('plain system 默认不渲染', () => {
    expect(isRenderableSystemMessage(systemMessage('plain'))).toBe(false)
  })

  it.each([
    'browser_control_taken_over',
    'browser_control_handed_back',
  ])('%s 浏览器控制事实允许渲染', (systemFact) => {
    expect(isRenderableSystemMessage({
      ...systemMessage(systemFact),
      metadata: { system_fact: systemFact },
    })).toBe(true)
  })

  it('白名单 system_fact / push / proposal / external archive 允许渲染', () => {
    expect(isRenderableSystemMessage({
      id: 'status',
      role: 'system',
      content: '回退完成',
      created_at: '2026-06-08T07:20:30.000Z',
      metadata: { system_fact: 'checkpoint_rewind_summary' },
    } as ChatMessage)).toBe(true)
    expect(isRenderableSystemMessage(pushMessage(subagentBlock({
      runId: 'run-allow',
      label: '可见推送',
      parentToolCallId: 'toolu-allow',
    }), 'system'))).toBe(true)
    expect(isRenderableSystemMessage({
      id: 'plan-proposal',
      role: 'system',
      content: 'plan',
      created_at: '2026-06-08T07:20:30.000Z',
      metadata: {
        kind: 'plan_proposal',
        plan_proposal: {
          plan_ref: { type: 'document', id: 'plan-1' },
          plan_document_id: 'plan-1',
          plan_name: '计划',
          overview: '',
          description_markdown: '',
          todos: [],
        },
      },
    } as ChatMessage)).toBe(true)
    expect(isRenderableSystemMessage({
      id: 'archive-prefix',
      role: 'system',
      content: '【外部历史｜来源：GitHub｜原会话：旧会话｜原工作目录：/tmp】',
      created_at: '2026-06-08T07:20:30.000Z',
      metadata: { system_fact: 'external_archive_prefix' },
    } as ChatMessage)).toBe(true)
  })
})

describe('push notification assistant anchoring', () => {
  it('完成通知挂到后续第一条 assistant 消息开头，而不是回挂到任务开始处', () => {
    const push = pushMessage(subagentBlock({
      runId: 'run-1',
      label: '查看磁盘使用情况',
      parentToolCallId: 'toolu-df',
    }))
    const before = assistantMessage('assistant-start')
    const after = assistantMessage('assistant-after-push')
    const messages = [userMessage('user-1'), before, push, after]

    expect(getAssistantAnchoredPushNotifications(messages, before.id)).toEqual([])
    expect(getAssistantAnchoredPushNotifications(messages, after.id)).toEqual([push])
    expect(shouldHidePushNotificationAtTopLevel(messages, push.id)).toBe(true)
  })

  it('没有后续 assistant 承接时不隐藏顶层通知', () => {
    const push = pushMessage(subagentBlock({
      runId: 'run-1',
      label: '查看磁盘使用情况',
      parentToolCallId: 'toolu-df',
    }))
    const messages = [userMessage('user-1'), push]

    expect(shouldHidePushNotificationAtTopLevel(messages, push.id)).toBe(false)
  })

  it('普通用户消息打断时不把旧 push 挂到后续 assistant', () => {
    const push = pushMessage(subagentBlock({
      runId: 'run-1',
      label: '查看磁盘使用情况',
      parentToolCallId: 'toolu-df',
    }))
    const after = assistantMessage('assistant-after-user')
    const messages = [push, userMessage('user-2'), after]

    expect(getAssistantAnchoredPushNotifications(messages, after.id)).toEqual([])
    expect(shouldHidePushNotificationAtTopLevel(messages, push.id)).toBe(false)
  })

  it('system 消息打断时不隐藏顶层 push，避免隐藏条件和 assistant 承接条件不一致', () => {
    const push = pushMessage(subagentBlock({
      runId: 'run-1',
      label: '查看磁盘使用情况',
      parentToolCallId: 'toolu-df',
    }))
    const after = assistantMessage('assistant-after-system')
    const messages = [push, systemMessage('system-1'), after]

    expect(getAssistantAnchoredPushNotifications(messages, after.id)).toEqual([])
    expect(shouldHidePushNotificationAtTopLevel(messages, push.id)).toBe(false)
  })

})
