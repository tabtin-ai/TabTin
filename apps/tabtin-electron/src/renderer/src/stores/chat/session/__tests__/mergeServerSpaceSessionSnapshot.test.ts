import { describe, it, expect } from 'vitest'
import type { ChatSession, ChatSessionRunState } from '@tabtin/chat-client'
import { mergeServerSpaceSessionSnapshot } from '../mergeServerSpaceSessionSnapshot'

function makeSession(id: string, spaceId = 'space-1'): ChatSession {
  return { id, space_id: spaceId, title: id } as unknown as ChatSession
}

function makeRunState(
  runId: string,
  sequence: number,
  revision: number,
  status: ChatSessionRunState['status'],
): ChatSessionRunState {
  return {
    run_id: runId,
    sequence,
    revision,
    status,
    queue_depth: 0,
    started_at: null,
    state_changed_at: '2026-07-28T10:00:00Z',
    ended_at: null,
    stop_reason: null,
    error_class: null,
    waiting_interaction_id: null,
  }
}

describe('mergeServerSpaceSessionSnapshot', () => {
  it('服务端字段覆盖同 id 本地副本', () => {
    const local = makeSession('s1')
    local.title = 'local'
    const server = makeSession('s1')
    server.title = 'server'

    const { sessions, nextObservedServerIds } = mergeServerSpaceSessionSnapshot({
      serverSessions: [server],
      localSessions: [local],
      observedServerIds: new Set(),
      tombstoneIds: new Set(),
      overlaySessions: [],
    })

    expect(sessions).toHaveLength(1)
    expect(sessions[0].title).toBe('server')
    expect([...nextObservedServerIds]).toEqual(['s1'])
  })

  it('保留从未被 list 观察过的本地新建会话', () => {
    const localOnly = makeSession('local-new')
    const server = makeSession('s1')

    const { sessions } = mergeServerSpaceSessionSnapshot({
      serverSessions: [server],
      localSessions: [localOnly, server],
      observedServerIds: new Set(['s1']),
      tombstoneIds: new Set(),
      overlaySessions: [],
    })

    expect(sessions.map((s) => s.id).sort()).toEqual(['local-new', 's1'])
  })

  it('曾被服务端观察、本次 list 缺失 → 视为已移除', () => {
    const gone = makeSession('gone')
    const keep = makeSession('keep')

    const { sessions } = mergeServerSpaceSessionSnapshot({
      serverSessions: [keep],
      localSessions: [gone, keep],
      observedServerIds: new Set(['gone', 'keep']),
      tombstoneIds: new Set(),
      overlaySessions: [],
    })

    expect(sessions.map((s) => s.id)).toEqual(['keep'])
  })

  it('tombstone 过滤服务端与本地 id', () => {
    const archived = makeSession('archived')
    const active = makeSession('active')

    const { sessions, nextObservedServerIds } = mergeServerSpaceSessionSnapshot({
      serverSessions: [archived, active],
      localSessions: [archived, active],
      observedServerIds: new Set(),
      tombstoneIds: new Set(['archived']),
      overlaySessions: [],
    })

    expect(sessions.map((s) => s.id)).toEqual(['active'])
    expect([...nextObservedServerIds]).toEqual(['active'])
  })

  it('overlay 钉回归档查看会话', () => {
    const overlay = { ...makeSession('archived'), status: 'archived' } as ChatSession

    const { sessions } = mergeServerSpaceSessionSnapshot({
      serverSessions: [makeSession('active')],
      localSessions: [],
      observedServerIds: new Set(['active']),
      tombstoneIds: new Set(),
      overlaySessions: [overlay],
    })

    expect(sessions.map((s) => s.id).sort()).toEqual(['active', 'archived'])
    expect(sessions.find((s) => s.id === 'archived')?.status).toBe('archived')
  })

  it('本地已选 Codex 时 list 刷新不覆盖 current_model_id', () => {
    const local = makeSession('s1')
    local.current_model_id = 'gpt-5.6-sol'
    local.context_tier_id = null
    local.title = 'local'
    local.run_state = makeRunState('run-1', 1, 3, 'failed')
    const server = makeSession('s1')
    server.current_model_id = '9964a6dd-c8d8-44cf-bb6a-45b12cb03842'
    server.context_tier_id = 'tier-1'
    server.title = 'server'
    server.run_state = makeRunState('run-1', 1, 2, 'running')

    const { sessions } = mergeServerSpaceSessionSnapshot({
      serverSessions: [server],
      localSessions: [local],
      observedServerIds: new Set(['s1']),
      tombstoneIds: new Set(),
      overlaySessions: [],
    })

    expect(sessions).toHaveLength(1)
    expect(sessions[0].title).toBe('server')
    expect(sessions[0].current_model_id).toBe('gpt-5.6-sol')
    expect(sessions[0].context_tier_id).toBeNull()
    expect(sessions[0].run_state?.status).toBe('failed')
    expect(sessions[0].run_state?.revision).toBe(3)
  })

  it('旧 HTTP list 不覆盖已收到的更高 revision run_state 增量', () => {
    const local = {
      ...makeSession('s1'),
      run_state: makeRunState('run-1', 1, 3, 'failed'),
    }
    const staleServer = {
      ...makeSession('s1'),
      run_state: makeRunState('run-1', 1, 2, 'running'),
    }

    const { sessions } = mergeServerSpaceSessionSnapshot({
      serverSessions: [staleServer],
      localSessions: [local],
      observedServerIds: new Set(['s1']),
      tombstoneIds: new Set(),
      overlaySessions: [],
    })

    expect(sessions[0].run_state?.status).toBe('failed')
    expect(sessions[0].run_state?.revision).toBe(3)
  })

  it('新 run 的更高 sequence 可替换旧 run 终态', () => {
    const local = {
      ...makeSession('s1'),
      run_state: makeRunState('run-old', 4, 8, 'completed'),
    }
    const server = {
      ...makeSession('s1'),
      run_state: makeRunState('run-new', 5, 1, 'queued'),
    }

    const { sessions } = mergeServerSpaceSessionSnapshot({
      serverSessions: [server],
      localSessions: [local],
      observedServerIds: new Set(['s1']),
      tombstoneIds: new Set(),
      overlaySessions: [],
    })

    expect(sessions[0].run_state?.run_id).toBe('run-new')
    expect(sessions[0].run_state?.status).toBe('queued')
  })
})
