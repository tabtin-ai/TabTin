import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ChatSession } from '@tabtin/chat-client'
import {
  buildSessionReferenceClipboardText,
  warmSpacePathCache,
} from './buildSessionReferenceClipboardText'

const baseSession: ChatSession = {
  id: 'sess-1',
  title: '测试对话',
  status: 'active',
  organization_id: 'wt-1',
  space_id: 'sp-1',
  created_at: '2026-05-01T00:00:00Z',
  updated_at: '2026-05-02T00:00:00Z',
  last_message_preview: 'hello',
  message_count: 3,
}

describe('buildSessionReferenceClipboardText', () => {
  beforeEach(() => {
    vi.stubGlobal('tabtin', {
      fileSystem: {
        ensureSpaceSandbox: vi.fn().mockResolvedValue({
          success: true,
          dataRoot: '/data/tabtin-data',
          userId: 'user-1',
          path: '/data/organizations/wt-1/spaces/sp-1',
        }),
      },
    })
  })

  it('预热缓存后输出带 archive 路径的引用块', async () => {
    warmSpacePathCache('sp-1', 'wt-1')
    await Promise.resolve()
    const text = buildSessionReferenceClipboardText(baseSession, {
      spaceId: 'sp-1',
      organizationId: 'wt-1',
    })
    expect(text).toContain('<conversation_reference>')
    expect(text).toContain('sess-1')
    expect(text).toContain('messages.jsonl')
    expect(text).toContain(
      '/data/tabtin-data/users/user-1/organizations/wt-1/workspaces/sp-1/conversations/sessions',
    )
    expect(text).not.toContain('_unscoped')
  })

  it('无缓存时仍输出会话元信息', () => {
    const text = buildSessionReferenceClipboardText(baseSession, {
      spaceId: 'sp-2',
      organizationId: 'wt-2',
    })
    expect(text).toContain('sess-1')
    expect(text).toContain('本地 archive 路径未能解析')
    expect(text).not.toContain('_unscoped')
  })

  it('缺 organizationId/spaceId 不拼 _unscoped 路径', async () => {
    warmSpacePathCache('sp-1', 'wt-1')
    await Promise.resolve()
    const text = buildSessionReferenceClipboardText(baseSession, {
      spaceId: '',
      organizationId: '',
    })
    expect(text).toContain('本地 archive 路径未能解析')
    expect(text).not.toContain('_unscoped')
  })
})
