import { describe, expect, it } from 'vitest'
import type { ChatSession } from '@tabtin/chat-client'
import { filterSidebarSessions } from '../filterSidebarSessions'

function session(partial: Partial<ChatSession> & { id: string }): ChatSession {
  return {
    title: partial.title ?? null,
    message_count: partial.message_count ?? 0,
    space_id: partial.space_id ?? 'space-1',
    ...partial,
  } as ChatSession
}

describe('filterSidebarSessions', () => {
  it('keeps sessions that already have messages', () => {
    const sessions = [
      session({ id: 'a', title: '周报', message_count: 3 }),
      session({ id: 'b', title: null, message_count: 1 }),
    ]
    expect(filterSidebarSessions(sessions, null).map(s => s.id)).toEqual(['a', 'b'])
  })

  it('hides abandoned empty sessions so the sidebar does not pile up 「新任务」', () => {
    const sessions = [
      session({ id: 'empty-1', title: null, message_count: 0 }),
      session({ id: 'empty-2', title: '', message_count: 0 }),
      session({ id: 'real', title: '已有对话', message_count: 2 }),
    ]
    expect(filterSidebarSessions(sessions, null).map(s => s.id)).toEqual(['real'])
    expect(filterSidebarSessions(sessions, 'other').map(s => s.id)).toEqual(['real'])
  })

  it('hides the currently selected empty session — top「新任务」entry owns the draft', () => {
    const sessions = [
      session({ id: 'empty-current', message_count: 0 }),
      session({ id: 'empty-old', message_count: 0 }),
      session({ id: 'real', message_count: 4 }),
    ]
    expect(filterSidebarSessions(sessions, 'empty-current').map(s => s.id)).toEqual([
      'real',
    ])
  })

  it('keeps external-archive opened sessions even when message_count is 0', () => {
    const sessions = [
      session({ id: 'ext-opened', title: '导入会话', message_count: 0 }),
      session({ id: 'real', message_count: 2 }),
    ]
    expect(filterSidebarSessions(
      sessions,
      null,
      new Set(['ext-opened']),
    ).map(s => s.id)).toEqual(['ext-opened', 'real'])
  })

  it('keeps a failed task with a locally submitted user instruction after another session is selected', () => {
    const sessions = [
      session({ id: 'failed-after-submit', message_count: 0 }),
      session({ id: 'other-space-task', message_count: 2 }),
      session({ id: 'abandoned-prefetch', message_count: 0 }),
    ]

    expect(filterSidebarSessions(
      sessions,
      'other-space-task',
      new Set(['failed-after-submit']),
    ).map(s => s.id)).toEqual([
      'failed-after-submit',
      'other-space-task',
    ])
  })

  it('treats missing message_count as empty when there is no last_message_at', () => {
    const sessions = [
      session({ id: 'unknown', message_count: undefined as unknown as number }),
      session({ id: 'real', message_count: 1 }),
    ]
    // Spread above may still set 0 via default — force undefined
    const withUndefined = [
      { ...sessions[0], message_count: undefined, last_message_at: null } as ChatSession,
      sessions[1],
    ]
    expect(filterSidebarSessions(withUndefined, null).map(s => s.id)).toEqual(['real'])
  })

  it('keeps cross-device activity upserts that have last_message_at but missing message_count ', () => {
    const withActivityOnly = [
      {
        ...session({ id: 'from-mobile' }),
        message_count: undefined,
        last_message_at: '2026-08-03T09:00:00.000Z',
      } as ChatSession,
      session({ id: 'real', message_count: 2 }),
    ]
    expect(filterSidebarSessions(withActivityOnly, null).map(s => s.id)).toEqual([
      'from-mobile',
      'real',
    ])
  })

  it('keeps sessions with has_messages=true even when message_count is 0 ', () => {
    const sessions = [
      session({ id: 'flagged', message_count: 0, has_messages: true }),
      session({ id: 'empty', message_count: 0, has_messages: false }),
      session({ id: 'real', message_count: 2 }),
    ]
    expect(filterSidebarSessions(sessions, null).map(s => s.id)).toEqual([
      'flagged',
      'real',
    ])
  })

  it('does not let last_message_at override authoritative empty message_count', () => {
    const sessions = [
      session({
        id: 'empty-with-ts',
        message_count: 0,
        last_message_at: '2026-08-03T09:00:00.000Z',
      }),
      session({ id: 'real', message_count: 1 }),
    ]
    expect(filterSidebarSessions(sessions, null).map(s => s.id)).toEqual(['real'])
  })

  it('hides archived sessions unless currently selected ', () => {
    const sessions = [
      session({ id: 'archived-other', message_count: 2, status: 'archived' }),
      session({ id: 'archived-current', message_count: 3, status: 'archived' }),
      session({ id: 'active', message_count: 1, status: 'active' }),
    ]
    expect(filterSidebarSessions(sessions, null).map(s => s.id)).toEqual(['active'])
    expect(filterSidebarSessions(sessions, 'archived-current').map(s => s.id)).toEqual([
      'archived-current',
      'active',
    ])
  })
})
