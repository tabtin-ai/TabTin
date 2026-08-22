/**
 * /#7067：Project A + execution Workspace B —— 显式 draftScopeKey cancel/start。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSessionPointerActions } from '../sessionPointerSlice'
import {
  getDraftMessageByScopeKey,
  isDraftMessageActive,
  recordDraftModeIntent,
  recordDraftAgentIntent,
} from '../../draftMessage'
import {
  __resetDraftMessageSessionCoordinatorForTests,
  beginDraftMessageSession,
  syncDraftModelIntent,
} from '../../draftMessageSessionCoordinator'

vi.mock('../../actions/sessionPrefetchAction', () => ({
  resetDraftPrefetchMessage: vi.fn(),
}))

vi.mock('../../draftMessageLegacyAdapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../draftMessageLegacyAdapter')>()
  return actual
})

describe('sessionPointerSlice draftScope（Project A / exec B）', () => {
  const PROJECT_SCOPE = 'conversation:draft:project-a'
  const EXEC_B = 'exec-ws-b'

  let state: {
    currentSessionId: string | null
    currentSessionIdBySpaceId: Record<string, string | null>
    currentSessionIdByWorkspaceKey: Record<string, string | null>
    draftSessionBySpaceId: Record<string, boolean>
    draftExecutionSpaceIdByWorkspaceKey: Record<string, string | null>
    sessions: Array<{ id: string }>
    sessionsBySpaceId: Record<string, Array<{ id: string }>>
  }

  beforeEach(() => {
    __resetDraftMessageSessionCoordinatorForTests()
    state = {
      // 非幂等 no-op：已有会话指针时 startDraft 才会真正 begin episode
      currentSessionId: 'sess-prev',
      currentSessionIdBySpaceId: { [EXEC_B]: 'sess-prev' },
      currentSessionIdByWorkspaceKey: {},
      draftSessionBySpaceId: {},
      // 故意只映射 B——若用 B 反查会得到错误 scope；主链必须显式传 A
      draftExecutionSpaceIdByWorkspaceKey: {
        [PROJECT_SCOPE]: EXEC_B,
      },
      sessions: [],
      sessionsBySpaceId: {},
    }
  })

  function makeActions() {
    return createSessionPointerActions(
      () => state as never,
      (partial) => {
        const patch = typeof partial === 'function'
          ? (partial as unknown as (s: typeof state) => Partial<typeof state>)(state)
          : (partial as Partial<typeof state>)
        Object.assign(state, patch)
      },
      { resolveActiveSpaceId: () => EXEC_B },
    )
  }

  it('startDraft 显式 draftScopeKey=A：只开 A，不把 B 当领域主键', () => {
    const actions = makeActions()
    actions.startDraftSessionForSpace(EXEC_B, true, {
      draftScopeKey: PROJECT_SCOPE,
      organizationId: 'org-1',
      executionWorkspaceId: EXEC_B,
      projectId: 'project-a',
    })
    const ep = getDraftMessageByScopeKey(PROJECT_SCOPE)
    expect(ep?.draftScopeKey).toBe(PROJECT_SCOPE)
    expect(ep?.executionWorkspaceId).toBe(EXEC_B)
    expect(ep?.projectId).toBe('project-a')
    expect(state.draftSessionBySpaceId[EXEC_B]).toBe(true)
    expect(state.currentSessionId).toBeNull()
    // 不得误开 conversation:draft:exec-ws-b
    expect(getDraftMessageByScopeKey(`conversation:draft:${EXEC_B}`)).toBeUndefined()
  })

  it('#7324 startDraft(host) 同时清 execution 指针，避免二次新任务被 reconcile 拉回', () => {
    const PROJECT_A = 'project-a'
    state.currentSessionId = 'sess-sent'
    state.currentSessionIdBySpaceId = {
      [PROJECT_A]: 'sess-sent',
      [EXEC_B]: 'sess-sent',
    }
    state.draftSessionBySpaceId = {}
    const actions = makeActions()
    actions.startDraftSessionForSpace(PROJECT_A, true, {
      draftScopeKey: PROJECT_SCOPE,
      organizationId: 'org-1',
      executionWorkspaceId: EXEC_B,
      projectId: PROJECT_A,
    })
    expect(state.currentSessionId).toBeNull()
    expect(state.currentSessionIdBySpaceId[PROJECT_A]).toBeNull()
    expect(state.currentSessionIdBySpaceId[EXEC_B]).toBeNull()
    expect(state.draftSessionBySpaceId[PROJECT_A]).toBe(true)
    expect(state.draftSessionBySpaceId[EXEC_B]).toBeUndefined()
  })

  it('host 已 draft 但 execution 仍有指针：不得幂等 no-op', () => {
    const PROJECT_A = 'project-a'
    state.currentSessionId = null
    state.draftSessionBySpaceId = { [PROJECT_A]: true }
    state.currentSessionIdBySpaceId = {
      [PROJECT_A]: null,
      [EXEC_B]: 'sess-sent',
    }
    const actions = makeActions()
    actions.startDraftSessionForSpace(PROJECT_A, true, {
      draftScopeKey: PROJECT_SCOPE,
      executionWorkspaceId: EXEC_B,
    })
    expect(state.currentSessionIdBySpaceId[EXEC_B]).toBeNull()
    expect(state.draftSessionBySpaceId[PROJECT_A]).toBe(true)
  })

  it('#7868 preserveDraftMessageIntent：切执行 Workspace 保留 Mode/Agent/Model', () => {
    beginDraftMessageSession(PROJECT_SCOPE, {
      organizationId: 'org-1',
      projectId: 'project-a',
      executionWorkspaceId: EXEC_B,
      agentId: 'agent-draft',
    })
    recordDraftModeIntent(PROJECT_SCOPE, 'plan')
    recordDraftAgentIntent(PROJECT_SCOPE, 'agent-x')
    syncDraftModelIntent('model-doubao', {
      draftScopeKey: PROJECT_SCOPE,
      isUiDraft: true,
    }, { contextTierId: 'tier-long' })
    const beforeId = getDraftMessageByScopeKey(PROJECT_SCOPE)!.draftMessageId

    const EXEC_C = 'exec-ws-c'
    state.currentSessionId = null
    state.currentSessionIdBySpaceId = { [EXEC_B]: 'sess-hidden-b' }
    state.draftSessionBySpaceId = { [EXEC_B]: true }

    const actions = makeActions()
    actions.startDraftSessionForSpace(EXEC_C, true, {
      draftScopeKey: PROJECT_SCOPE,
      organizationId: 'org-1',
      executionWorkspaceId: EXEC_C,
      projectId: 'project-a',
      preserveDraftMessageIntent: true,
    })

    const ep = getDraftMessageByScopeKey(PROJECT_SCOPE)
    expect(ep?.draftMessageId).toBe(beforeId)
    expect(ep?.executionWorkspaceId).toBe(EXEC_C)
    expect(ep?.mode).toBe('plan')
    expect(ep?.agentId).toBe('agent-x')
    expect(ep?.modelId).toBe('model-doubao')
    expect(ep?.contextTierId).toBe('tier-long')
    expect(state.currentSessionIdBySpaceId[EXEC_C]).toBeNull()
    expect(state.draftSessionBySpaceId[EXEC_C]).toBe(true)
  })

  it('select 历史显式 cancel A；不得因 execution B 漏 cancel', () => {
    const ep = beginDraftMessageSession(PROJECT_SCOPE, {
      organizationId: 'org-1',
      projectId: 'project-a',
      executionWorkspaceId: EXEC_B,
    })
    expect(isDraftMessageActive(ep.draftMessageId)).toBe(true)

    const actions = makeActions()
    actions.setCurrentSessionForSpace(EXEC_B, 'sess-historical', true, {
      draftScopeKey: PROJECT_SCOPE,
    })

    expect(isDraftMessageActive(ep.draftMessageId)).toBe(false)
    expect(getDraftMessageByScopeKey(PROJECT_SCOPE)).toBeUndefined()
    expect(state.currentSessionId).toBe('sess-historical')
    expect(state.currentSessionIdBySpaceId[EXEC_B]).toBe('sess-historical')
    expect(state.draftSessionBySpaceId[EXEC_B]).toBeUndefined()
  })

  it('#7672 clearForegroundSessionSelection 只清全局指针，保留 per-Space 记忆', () => {
    state.currentSessionId = 'sess-org-a'
    state.currentSessionIdBySpaceId = {
      [EXEC_B]: 'sess-org-a',
      'space-other': 'sess-keep',
    }
    state.sessionsBySpaceId = {
      [EXEC_B]: [{ id: 'sess-org-a' }],
    }

    const actions = makeActions()
    actions.clearForegroundSessionSelection()

    expect(state.currentSessionId).toBeNull()
    expect(state.currentSessionIdBySpaceId[EXEC_B]).toBe('sess-org-a')
    expect(state.currentSessionIdBySpaceId['space-other']).toBe('sess-keep')
    expect(state.sessionsBySpaceId[EXEC_B]).toEqual([{ id: 'sess-org-a' }])
  })
})
