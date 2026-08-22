import { describe, expect, it } from 'vitest'
import type { ChatSession } from '@tabtin/chat-client'
import {
  buildForkChildrenIndex,
  countForkTreeSessions,
  filterForkListRoots,
  forkCollapseKey,
} from '../nestForkSessions'
import { buildSessionListVirtualItems } from '../buildSessionListVirtualItems'
import type { GroupKey } from '@/utils/chat-session-sort'

function session(partial: Partial<ChatSession> & Pick<ChatSession, 'id'>): ChatSession {
  return {
    title: partial.title ?? partial.id,
    created_at: partial.created_at ?? '2026-07-20T10:00:00Z',
    updated_at: partial.updated_at ?? '2026-07-20T10:00:00Z',
    last_message_at: partial.last_message_at ?? partial.updated_at ?? '2026-07-20T10:00:00Z',
    status: 'active',
    ...partial,
  } as ChatSession
}

const groupLabels: Record<GroupKey, string> = {
  pinned: '置顶',
  trackerRuns: '自动化任务执行记录',
  today: '今天',
  yesterday: '昨天',
  recent7d: '近 7 天',
  recent30d: '近 30 天',
  older: '更早',
}

describe('nestForkSessions', () => {
  it('indexes only direct children whose parent is present', () => {
    const parent = session({ id: 'p', updated_at: '2026-07-23T12:00:00Z' })
    const child = session({
      id: 'c',
      forked_from_id: 'p',
      updated_at: '2026-07-23T13:00:00Z',
    })
    const orphan = session({
      id: 'o',
      forked_from_id: 'missing',
      updated_at: '2026-07-23T14:00:00Z',
    })
    const index = buildForkChildrenIndex([parent, child, orphan])
    expect([...index.nestedChildIds]).toEqual(['c'])
    expect(index.childrenByParentId.get('p')?.map((s) => s.id)).toEqual(['c'])
    expect(filterForkListRoots([parent, child, orphan], index.nestedChildIds).map((s) => s.id))
      .toEqual(['p', 'o'])
  })

  it('flattens all fork descendants under the list root at depth 1', () => {
    const a = session({ id: 'a', updated_at: '2026-07-23T12:00:00Z' })
    const b = session({
      id: 'b',
      forked_from_id: 'a',
      updated_at: '2026-07-23T13:00:00Z',
    })
    const c = session({
      id: 'c',
      forked_from_id: 'b',
      // 更早活动：若独立进时间桶会落别处；平铺挂根后应仍在 a 下
      updated_at: '2026-07-01T08:00:00Z',
      last_message_at: '2026-07-01T08:00:00Z',
    })
    const items = buildSessionListVirtualItems({
      sortedSessions: [a, b, c],
      groupLabels,
      collapsedGroups: new Set(),
      workspaceListSortMode: 'activity',
      getSessionSpaceId: () => 'space',
      getSessionSpaceLabel: () => 'Space',
      listContent: 'sessions',
    })
    const sessions = items.filter((item) => item.type === 'session')
    // 子行按活动时间：b 新于 c
    expect(sessions.map((item) => item.type === 'session' ? item.session.id : '')).toEqual(['a', 'b', 'c'])
    expect(sessions.map((item) => item.type === 'session' ? (item.forkDepth ?? 0) : -1)).toEqual([0, 1, 1])
    expect(sessions[0]).toMatchObject({
      type: 'session',
      forkBranch: { collapsed: false, childCount: 2 },
    })
    // 中间层 fork 不再作为折叠父节点
    expect(sessions[1]).toMatchObject({ type: 'session', session: { id: 'b' } })
    expect('forkBranch' in sessions[1] ? sessions[1].forkBranch : undefined).toBeUndefined()
  })

  it('hides fork children when parent branch is collapsed', () => {
    const parent = session({ id: 'p', updated_at: '2026-07-23T12:00:00Z' })
    const child = session({
      id: 'c',
      forked_from_id: 'p',
      updated_at: '2026-07-23T13:00:00Z',
    })
    const items = buildSessionListVirtualItems({
      sortedSessions: [parent, child],
      groupLabels,
      collapsedGroups: new Set([forkCollapseKey('p')]),
      workspaceListSortMode: 'activity',
      getSessionSpaceId: () => 'space',
      getSessionSpaceLabel: () => 'Space',
      listContent: 'sessions',
    })
    const sessions = items.filter((item) => item.type === 'session')
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      type: 'session',
      session: { id: 'p' },
      forkBranch: { collapsed: true, childCount: 1 },
    })
  })

  it('counts fork descendants in group header', () => {
    const parent = session({ id: 'p', updated_at: '2026-07-23T12:00:00Z' })
    const child = session({
      id: 'c',
      forked_from_id: 'p',
      updated_at: '2026-07-23T13:00:00Z',
    })
    const index = buildForkChildrenIndex([parent, child])
    expect(countForkTreeSessions([parent], index.childrenByParentId)).toBe(2)
  })

  it('indexes grandchild under list root, not mid parent', () => {
    const a = session({ id: 'a' })
    const b = session({ id: 'b', forked_from_id: 'a', updated_at: '2026-07-23T13:00:00Z' })
    const c = session({ id: 'c', forked_from_id: 'b', updated_at: '2026-07-23T12:00:00Z' })
    const index = buildForkChildrenIndex([a, b, c])
    expect(index.childrenByParentId.get('a')?.map((s) => s.id)).toEqual(['b', 'c'])
    expect(index.childrenByParentId.has('b')).toBe(false)
    expect([...index.nestedChildIds].sort()).toEqual(['b', 'c'])
  })

  it('pinned fork tree keeps children between parent and 工作空间 section', () => {
    const parent = session({
      id: 'p',
      title: '收到确认指令',
      updated_at: '2026-07-23T12:00:00Z',
      space_id: 'space-a',
    })
    const child = session({
      id: 'c',
      title: '收到确认指令 2',
      forked_from_id: 'p',
      updated_at: '2026-07-23T13:00:00Z',
      space_id: 'space-a',
    })
    const other = session({
      id: 'o',
      title: '其他对话',
      updated_at: '2026-07-23T11:00:00Z',
      space_id: 'space-b',
    })
    const items = buildSessionListVirtualItems({
      sortedSessions: [parent, child, other],
      pinnedSessionIds: new Set(['p']),
      groupLabels,
      collapsedGroups: new Set(),
      workspaceListSortMode: 'activity',
      spaceNameById: { 'space-a': 'pi查询今日天气', 'space-b': '其他' },
      spaceSectionKeyById: { 'space-a': 'workspace', 'space-b': 'workspace' },
      spaceSectionOrder: ['workspace'],
      getSessionSpaceId: (s) => s.space_id ?? 'space-a',
      getSessionSpaceLabel: (id) => (id === 'space-a' ? 'pi查询今日天气' : '其他'),
      listContent: 'sessions',
    })

    const typesAndIds = items.map((item) => {
      if (item.type === 'session') {
        return `session:${item.session.id}:d${item.forkDepth ?? 0}`
      }
      if (item.type === 'header') return `header:${item.key}`
      if (item.type === 'space_section_header') {
        return `section:${item.sectionKey ?? 'default'}`
      }
      return item.type
    })

    expect(typesAndIds).toEqual([
      'header:pinned',
      'session:p:d0',
      'session:c:d1',
      'section:workspace',
      'header:space:space-b',
      'session:o:d0',
      'header:space:space-a',
    ])
  })
})
