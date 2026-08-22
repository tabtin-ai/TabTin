import { describe, expect, it } from 'vitest'
import { buildExternalArchiveChatMessages } from '../continueExternalArchiveChat'
import { buildExternalArchiveLlmBoundaryMessage } from '../externalArchivePromptBoundary'

const meta = {
  source: 'workbuddy',
  sourceSessionId: 'sess-1',
  title: '互相认识',
  cwd: '/tmp/wb',
  workspaceId: 'ws-1',
  importedAt: '2026-07-26T00:00:00.000Z',
  messageCount: 2,
  kind: 'external_archive' as const,
}

describe('buildExternalArchiveChatMessages', () => {
  it('外来消息在前，UI 横幅与 LLM 边界在后', () => {
    const built = buildExternalArchiveChatMessages(meta, [
      {
        id: 'm1',
        role: 'user',
        content_blocks: [{ type: 'text', text: '你是谁？' }],
        created_at: '2026-07-26T00:00:01.000Z',
      },
      {
        id: 'm2',
        role: 'assistant',
        content_blocks: [{ type: 'text', text: '我是 WorkBuddy' }],
        created_at: '2026-07-26T00:00:02.000Z',
      },
    ])

    expect(built.map((m) => m.role)).toEqual(['user', 'assistant', 'system', 'user'])
    expect(built[0]?.content).toBe('你是谁？')
    expect(built[1]?.content).toContain('WorkBuddy')
    expect(built[2]?.metadata).toMatchObject({ system_fact: 'external_archive_prefix' })
    expect(built[3]?.message_kind).toBe('external_archive_context')
    expect(built[3]?.content).toContain('type="external-archive"')
    expect(built[3]?.content).toContain('WorkBuddy')
    expect(built[3]?.content).toContain('以 TabTin 为准')
    expect(built[3]?.content).toContain('不要继承')
  })

  it('LLM 边界文案点明来源与能力边界', () => {
    const boundary = buildExternalArchiveLlmBoundaryMessage(meta)
    expect(boundary.role).toBe('user')
    expect(boundary.message_kind).toBe('external_archive_context')
    expect(boundary.content).toMatch(/以上消息来自 WorkBuddy/)
    expect(boundary.content).toMatch(/agent-profile|系统提示/)
    expect(boundary.content).toMatch(/不要假装仍是原工具/)
  })
})
