import { describe, expect, it, vi } from 'vitest'
import type { IMMessage } from '@/services/im/contracts'
import { buildPreview, notificationBody } from './imFormat'

vi.mock('@/constants/tabchat', () => ({
  MESSAGE_TYPE_FILE: 3,
  MESSAGE_TYPE_IMAGE: 4,
}))

function tableMessage(): IMMessage {
  return {
    id: 1,
    conversation_id: 'conversation-1',
    sender_id: 'user-1',
    sender_name: '童俊芳',
    content: '',
    message_type: 1,
    reply_to_id: null,
    has_attachment: false,
    metadata: { card: { type: 'table', name: '多维表' } },
    created_at: '2026-08-06T00:00:00Z',
  }
}

function codexSessionMessage(): IMMessage {
  return {
    id: 2,
    conversation_id: 'conversation-1',
    sender_id: 'user-1',
    sender_name: '童俊芳',
    content: '[Codex 会话] TabTin IM synthetic Codex session',
    message_type: 3,
    reply_to_id: null,
    has_attachment: true,
    metadata: {
      file_name: 'TabTin IM synthetic Codex session.codex-session.zip',
      card: {
        type: 'codex_session',
        schema_version: 1,
        codex_session_id: 'session-1',
        codex_session_name: 'TabTin IM synthetic Codex session',
      },
    },
    created_at: '2026-08-21T19:55:09Z',
  }
}

describe('buildPreview', () => {
  it.each([
    ['单聊', false, '[表格] 多维表'],
    ['群聊', true, '童俊芳: [表格] 多维表'],
  ])('%s表格摘要按会话类型展示发送者昵称', (_label, isGroup, expected) => {
    expect(buildPreview(tableMessage(), isGroup)).toBe(expected)
  })

  it('单聊通知仅在标题展示发送者，正文不重复昵称', () => {
    expect(notificationBody(tableMessage(), false)).toBe('[表格] 多维表')
    expect(notificationBody(tableMessage(), true)).toBe('童俊芳: [表格] 多维表')
  })

  it('Codex 会话文件卡用会话名称生成摘要', () => {
    expect(buildPreview(codexSessionMessage(), false)).toBe(
      '[Codex 会话] TabTin IM synthetic Codex session',
    )
  })
})
