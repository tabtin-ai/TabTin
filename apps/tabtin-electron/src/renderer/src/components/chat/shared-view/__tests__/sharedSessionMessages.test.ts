/**
 * sharedSessionMessages 纯函数单测（ 文档协同式共享）：
 * merge 合并去重排序 / 发言人名牌归因装饰 / shared-chat 发送结果分类。
 */

import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import {
  classifySharedChatSendResult,
  collectSharedSenderIds,
  decorateSharedSenderIdentity,
  filterSharedTimelineMessages,
  mergeSharedTimelineMessages,
  resolveSharedSenderId,
} from '../sharedSessionMessages'

function msg(partial: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    role: 'user',
    content: '',
    created_at: '2026-07-26T10:00:00Z',
    ...partial,
  } as ChatMessage
}

describe('mergeSharedTimelineMessages', () => {
  it('同 id 以 REST 为准，流侧独有消息补位', () => {
    const rest = [
      msg({ id: 'a', content: 'rest-a', created_at: '2026-07-26T10:00:00Z' }),
      msg({ id: 'b', content: 'rest-b', created_at: '2026-07-26T10:01:00Z' }),
    ]
    const live = [
      msg({ id: 'b', content: 'live-b', created_at: '2026-07-26T10:01:00Z' }),
      msg({ id: 'c', content: 'live-c', created_at: '2026-07-26T10:02:00Z' }),
    ]
    const merged = mergeSharedTimelineMessages(rest, live)
    expect(merged.map((m) => m.id)).toEqual(['a', 'b', 'c'])
    expect(merged[1].content).toBe('rest-b')
    expect(merged[2].content).toBe('live-c')
  })

  it('按 (created_at, id) 升序；时间相同时按 id 稳定排序', () => {
    const merged = mergeSharedTimelineMessages(
      [msg({ id: 'z', created_at: '2026-07-26T10:00:00Z' })],
      [msg({ id: 'a', created_at: '2026-07-26T10:00:00Z' })],
    )
    expect(merged.map((m) => m.id)).toEqual(['a', 'z'])
  })

  it('流切片为空时不建 Map，直接返回排序后的 REST 副本', () => {
    const rest = [
      msg({ id: 'b', created_at: '2026-07-26T10:01:00Z' }),
      msg({ id: 'a', created_at: '2026-07-26T10:00:00Z' }),
    ]
    const merged = mergeSharedTimelineMessages(rest, [])
    expect(merged.map((m) => m.id)).toEqual(['a', 'b'])
    // 不改入参
    expect(rest.map((m) => m.id)).toEqual(['b', 'a'])
  })
})

describe('resolveSharedSenderId', () => {
  it('metadata.shared_chat_by 优先于 sender_user_id', () => {
    const message = msg({
      id: 'a',
      sender_user_id: 'sender-1',
      metadata: { shared_chat: true, shared_chat_by: 'grantee-1' },
    })
    expect(resolveSharedSenderId(message, 'owner-1')).toBe('grantee-1')
  })

  it('无标记时回落 sender_user_id，再回落 owner', () => {
    expect(resolveSharedSenderId(msg({ id: 'a', sender_user_id: 'sender-1' }), 'owner-1')).toBe('sender-1')
    expect(resolveSharedSenderId(msg({ id: 'a' }), 'owner-1')).toBe('owner-1')
    expect(resolveSharedSenderId(msg({ id: 'a' }), null)).toBeNull()
  })

  it('assistant 消息不做名牌归因', () => {
    expect(resolveSharedSenderId(msg({ id: 'a', role: 'assistant' }), 'owner-1')).toBeNull()
  })
})

describe('decorateSharedSenderIdentity', () => {
  const ctx = {
    viewerUserId: 'grantee-1',
    ownerUserId: 'owner-1',
    namesById: { 'owner-1': '张三', 'grantee-2': '李四' },
  }

  it('他人 user 消息补 sender_user_id + 展示名（owner 无显式 sender 也归因）', () => {
    const [decorated] = decorateSharedSenderIdentity([msg({ id: 'a' })], ctx)
    expect(decorated.sender_user_id).toBe('owner-1')
    expect(decorated.sender_display_name).toBe('张三')
  })

  it('本人消息原样返回（右气泡、无名牌）', () => {
    const mine = msg({
      id: 'a',
      metadata: { shared_chat: true, shared_chat_by: 'grantee-1' },
    })
    const [decorated] = decorateSharedSenderIdentity([mine], ctx)
    expect(decorated).toBe(mine)
    expect(decorated.sender_display_name).toBeUndefined()
  })

  it('取不到展示名时不回落 uuid，仅写 sender_user_id', () => {
    const other = msg({
      id: 'a',
      metadata: { shared_chat: true, shared_chat_by: 'grantee-unknown' },
    })
    const [decorated] = decorateSharedSenderIdentity([other], ctx)
    expect(decorated.sender_user_id).toBe('grantee-unknown')
    expect(decorated.sender_display_name).toBeUndefined()
  })

  it('不改入参对象（浅拷贝装饰）', () => {
    const source = msg({ id: 'a' })
    decorateSharedSenderIdentity([source], ctx)
    expect(source.sender_user_id).toBeUndefined()
  })

  it('已装饰一致时复用原引用（memo 友好）', () => {
    const source = msg({ id: 'a', sender_user_id: 'owner-1', sender_display_name: '张三' })
    const [decorated] = decorateSharedSenderIdentity([source], ctx)
    expect(decorated).toBe(source)
  })
})

describe('collectSharedSenderIds', () => {
  it('聚合全部发送者 id（owner 归因 + shared_chat_by），assistant 不参与', () => {
    const ids = collectSharedSenderIds(
      [
        msg({ id: 'a' }),
        msg({ id: 'b', metadata: { shared_chat_by: 'grantee-1' } }),
        msg({ id: 'c', role: 'assistant' }),
      ],
      'owner-1',
    )
    expect(ids.sort()).toEqual(['grantee-1', 'owner-1'])
  })
})

describe('classifySharedChatSendResult', () => {
  it('无 error_category → ok', () => {
    expect(classifySharedChatSendResult({})).toBe('ok')
    expect(classifySharedChatSendResult({ error_category: null })).toBe('ok')
    expect(classifySharedChatSendResult({ error_category: '' })).toBe('ok')
  })

  it('device_offline → 离线提示（非失败）', () => {
    expect(classifySharedChatSendResult({ error_category: 'device_offline' })).toBe('device_offline')
  })

  it('其余分类 → error', () => {
    expect(classifySharedChatSendResult({ error_category: 'llm_error' })).toBe('error')
  })
})

describe('filterSharedTimelineMessages', () => {
  it('隐藏 device_offline error_envelope，保留普通消息', () => {
    const kept = msg({
      id: 'u1',
      content: '你好',
      message_kind: 'llm',
      created_at: '2026-07-27T00:00:00Z',
    })
    const hidden = msg({
      id: 'e1',
      role: 'assistant',
      content: '[device_offline] 无法转发消息到您的设备',
      message_kind: 'error_envelope',
      created_at: '2026-07-27T00:00:01Z',
      error_info_json: { category: 'device_offline', error_class: 'routing_error' },
    })
    const out = filterSharedTimelineMessages([kept, hidden])
    expect(out.map((m) => m.id)).toEqual(['u1'])
  })

  it('隐藏内部上下文 kind 与旧版 context wrapper，保留真实用户正文', () => {
    const visible = msg({ id: 'visible', content: '请继续处理任务', message_kind: 'llm' })
    const environment = msg({
      id: 'environment',
      role: 'system',
      content: '<context type="environment">current_model: secret</context>',
      message_kind: 'environment_context',
    })
    const agentProfile = msg({
      id: 'profile',
      role: 'system',
      content: '<context type="agent-profile">内部规则</context>',
      message_kind: 'agent_profile_context',
    })
    const legacy = msg({
      id: 'legacy',
      role: 'user',
      content: '<context type="environment">legacy snapshot</context>',
      message_kind: 'llm',
    })
    const compaction = msg({
      id: 'compaction',
      role: 'user',
      content: '内部压缩摘要',
      message_kind: 'compaction_summary',
    })

    const out = filterSharedTimelineMessages([
      environment,
      visible,
      agentProfile,
      legacy,
      compaction,
    ])
    expect(out.map((message) => message.id)).toEqual(['visible'])
  })
})
