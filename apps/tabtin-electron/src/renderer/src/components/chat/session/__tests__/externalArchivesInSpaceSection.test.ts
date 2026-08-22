import { describe, expect, it } from 'vitest'
import { buildSessionListVirtualItems } from '../buildSessionListVirtualItems'
import type { ChatSession } from '@tabtin/chat-client'

function session(id: string, spaceId: string): ChatSession {
  return {
    id,
    space_id: spaceId,
    title: id,
    updated_at: '2026-07-26T00:00:00.000Z',
  } as ChatSession
}

describe('工作空间下挂外部历史', () => {
  it('在对应 space 会话之后直接插入档案行（无「外部历史」子标题）', () => {
    const items = buildSessionListVirtualItems({
      sortedSessions: [session('s1', 'ws-1')],
      groupLabels: {
        pinned: '置顶',
        trackerRuns: '定时',
        today: '今天',
        yesterday: '昨天',
        recent7d: '近7天',
        recent30d: '近30天',
        older: '更早',
      },
      collapsedGroups: new Set(),
      spaceNameById: { 'ws-1': 'TabTin-deploy' },
      spaceSectionKeyById: { 'ws-1': 'workspace' },
      spaceSectionOrder: ['workspace'],
      workspaceListSortMode: 'name',
      getSessionSpaceId: (s) => s.space_id ?? '__unknown__',
      getSessionSpaceLabel: (id) => (id === 'ws-1' ? 'TabTin-deploy' : id),
      listContent: 'sessions',
      externalArchivesBySpaceId: {
        'ws-1': [{
          source: 'cursor',
          sourceSessionId: 'ext-1',
          title: '导入会话',
          messageCount: 4,
          cwd: '/tmp/x',
        }],
      },
    })

    expect(items.some((i) => i.type === 'header' && i.key === 'external:ws-1')).toBe(false)
    const archive = items.find((i) => i.type === 'external_archive')
    expect(archive).toMatchObject({
      type: 'external_archive',
      spaceId: 'ws-1',
      archive: { sourceSessionId: 'ext-1', title: '导入会话' },
    })
  })
})
