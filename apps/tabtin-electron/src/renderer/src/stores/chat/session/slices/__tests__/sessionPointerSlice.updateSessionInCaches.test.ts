/**
 * updateSessionInCaches upsert 语义。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ChatSession } from '@tabtin/chat-client'
import { createSessionPointerActions } from '../sessionPointerSlice'
import { __resetSpaceSessionListWriteGateForTest } from '../../spaceSessionListWriteGate'

vi.mock('@/utils/logger', () => ({
  logger: { log: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ log: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

vi.mock('../../actions/sessionPrefetchAction', () => ({
  resetDraftPrefetchMessage: vi.fn(),
}))

function makeSession(id: string, spaceId: string, extra: Partial<ChatSession> = {}): ChatSession {
  return { id, space_id: spaceId, title: id, ...extra } as unknown as ChatSession
}

describe('updateSessionInCaches（upsert）', () => {
  const SPACE = 'space-1'
  const OTHER = 'space-other'
  let activeSpaceId: string | null = SPACE
  let state: {
    sessions: ChatSession[]
    sessionsBySpaceId: Record<string, ChatSession[]>
    trackerRunSessionsBySpaceId: Record<string, ChatSession[]>
    currentSessionId: string | null
    currentSessionIdBySpaceId: Record<string, string | null>
    currentSessionIdByWorkspaceKey: Record<string, string | null>
    draftExecutionSpaceIdByWorkspaceKey: Record<string, string | null>
    draftSessionBySpaceId: Record<string, boolean>
  }

  beforeEach(() => {
    __resetSpaceSessionListWriteGateForTest()
    activeSpaceId = SPACE
    state = {
      sessions: [],
      sessionsBySpaceId: {},
      trackerRunSessionsBySpaceId: {},
      currentSessionId: null,
      currentSessionIdBySpaceId: {},
      currentSessionIdByWorkspaceKey: {},
      draftExecutionSpaceIdByWorkspaceKey: {},
      draftSessionBySpaceId: {},
    }
  })

  const makeActions = () => createSessionPointerActions(
    () => state,
    (partial) => {
      const patch = typeof partial === 'function' ? partial(state) : partial
      state = { ...state, ...patch }
    },
    { resolveActiveSpaceId: () => activeSpaceId },
  )

  it('已在桶内：仅 patch 字段', () => {
    const existing = makeSession('s1', SPACE, { message_count: 0 })
    state.sessionsBySpaceId[SPACE] = [existing]
    state.sessions = [existing]

    makeActions().updateSessionInCaches('s1', { message_count: 3, title: 'done' })

    expect(state.sessionsBySpaceId[SPACE]).toHaveLength(1)
    expect(state.sessionsBySpaceId[SPACE][0].message_count).toBe(3)
    expect(state.sessionsBySpaceId[SPACE][0].title).toBe('done')
  })

  it('桶内缺失且 patch 带 space_id：upsert 进桶，active space 同步 sessions 视图', () => {
    makeActions().updateSessionInCaches('s-new', {
      space_id: SPACE,
      title: 'fresh',
      message_count: 2,
    })

    expect(state.sessionsBySpaceId[SPACE]?.map((s) => s.id)).toEqual(['s-new'])
    expect(state.sessionsBySpaceId[SPACE][0].message_count).toBe(2)
    expect(state.sessions.map((s) => s.id)).toEqual(['s-new'])
  })

  it('#11321 activity upsert 保留 is_agent_mention_session', () => {
    makeActions().updateSessionInCaches('s-mention', {
      space_id: SPACE,
      title: '[私信@小Tin]',
      message_count: 1,
      is_agent_mention_session: true,
    })

    expect(state.sessionsBySpaceId[SPACE]?.[0]).toEqual(expect.objectContaining({
      id: 's-mention',
      is_agent_mention_session: true,
    }))
  })

  it('非 active space 且 sessions 为空：进目标桶，不污染当前 sessions 视图', () => {
    activeSpaceId = SPACE
    state.sessions = []

    makeActions().updateSessionInCaches('s-other', {
      space_id: OTHER,
      title: 'other-space',
      message_count: 1,
    })

    expect(state.sessionsBySpaceId[OTHER]?.map((s) => s.id)).toEqual(['s-other'])
    expect(state.sessions).toEqual([])
  })

  it('桶内缺失且无 space 作用域：不插入', () => {
    makeActions().updateSessionInCaches('orphan', { title: 'x' })
    expect(state.sessionsBySpaceId).toEqual({})
    expect(state.sessions).toEqual([])
  })

  it('Tracker Run 会话按 id 可查，且优先返回 Tracker 桶的完整快照', () => {
    const staleMain = makeSession('tracker-session', SPACE, { agent_id: null })
    const trackerSession = makeSession('tracker-session', SPACE, {
      agent_id: 'agent-1',
      tracker_run: {
        run_id: 'run-1',
        run_index: 1,
        run_status: 'running',
        tracker_id: 'tracker-1',
        tracker_name: '测试任务',
      },
    })
    state.sessions = [staleMain]
    state.sessionsBySpaceId[SPACE] = [staleMain]
    state.trackerRunSessionsBySpaceId[SPACE] = [trackerSession]

    expect(makeActions().getSessionById('tracker-session')).toBe(trackerSession)
  })

  it('patch Tracker Run 会话时不把它污染进普通会话桶', () => {
    const trackerSession = makeSession('tracker-session', SPACE, {
      agent_id: 'agent-1',
      tracker_run: {
        run_id: 'run-1',
        run_index: 1,
        run_status: 'running',
        tracker_id: 'tracker-1',
        tracker_name: '测试任务',
      },
    })
    state.trackerRunSessionsBySpaceId[SPACE] = [trackerSession]

    makeActions().updateSessionInCaches('tracker-session', { title: '已更新' })

    expect(state.trackerRunSessionsBySpaceId[SPACE][0].title).toBe('已更新')
    expect(state.sessionsBySpaceId).toEqual({})
    expect(state.sessions).toEqual([])
  })

  it('未知 Tracker Run 会话按完整 metadata upsert 到专用桶', () => {
    makeActions().updateSessionInCaches('tracker-session', {
      space_id: SPACE,
      agent_id: 'agent-1',
      tracker_run: {
        run_id: 'run-1',
        run_index: 1,
        run_status: 'running',
        tracker_id: 'tracker-1',
        tracker_name: '测试任务',
      },
    })

    expect(state.trackerRunSessionsBySpaceId[SPACE]).toHaveLength(1)
    expect(state.trackerRunSessionsBySpaceId[SPACE][0].id).toBe('tracker-session')
    expect(state.sessionsBySpaceId).toEqual({})
    expect(state.sessions).toEqual([])
  })

  it('普通桶已存在同 id 时，Tracker metadata 会迁移并自愈分桶', () => {
    const polluted = makeSession('tracker-session', SPACE, { agent_id: null })
    state.sessions = [polluted]
    state.sessionsBySpaceId[SPACE] = [polluted]

    makeActions().updateSessionInCaches('tracker-session', {
      space_id: SPACE,
      agent_id: 'agent-1',
      tracker_run: {
        run_id: 'run-1',
        run_index: 1,
        run_status: 'running',
        tracker_id: 'tracker-1',
        tracker_name: '测试任务',
      },
    })

    expect(state.sessions).toEqual([])
    expect(state.sessionsBySpaceId[SPACE]).toEqual([])
    expect(state.trackerRunSessionsBySpaceId[SPACE][0]).toMatchObject({
      id: 'tracker-session',
      agent_id: 'agent-1',
    })
  })
})
