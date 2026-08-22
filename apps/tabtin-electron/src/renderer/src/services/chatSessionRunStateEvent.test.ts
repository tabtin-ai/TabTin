import { describe, expect, it } from 'vitest'
import type { ChatSessionRunState } from '@tabtin/chat-client'
import { parseChatSessionRunStateEvent } from './chatSessionRunStateEvent'

const RUN_STATE: ChatSessionRunState = {
  run_id: 'run-1',
  sequence: 1,
  revision: 1,
  status: 'running',
  queue_depth: 0,
  started_at: null,
  state_changed_at: '2026-07-28T10:00:00Z',
  ended_at: null,
  stop_reason: null,
  error_class: null,
  waiting_interaction_id: null,
}

function payload(organizationId = 'org-1') {
  return {
    session_id: 'session-1',
    organization_id: organizationId,
    run_state: RUN_STATE,
  }
}

describe('parseChatSessionRunStateEvent', () => {
  it('当前组织与缓存会话组织都一致时接纳', () => {
    expect(parseChatSessionRunStateEvent(payload(), {
      currentOrganizationId: 'org-1',
      cachedSession: { organization_id: 'org-1' },
    })).toMatchObject({
      sessionId: 'session-1',
      organizationId: 'org-1',
      runState: RUN_STATE,
    })
  })

  it('事件不属于当前组织时拒绝', () => {
    expect(parseChatSessionRunStateEvent(payload('org-other'), {
      currentOrganizationId: 'org-1',
    })).toBeNull()
  })

  it('事件与已缓存会话组织不一致时拒绝', () => {
    expect(parseChatSessionRunStateEvent(payload(), {
      currentOrganizationId: 'org-1',
      cachedSession: { organization_id: 'org-other' },
    })).toBeNull()
  })

  it('没有当前组织或 run_state 畸形时拒绝', () => {
    expect(parseChatSessionRunStateEvent(payload(), {
      currentOrganizationId: null,
    })).toBeNull()
    expect(parseChatSessionRunStateEvent({
      ...payload(),
      run_state: { ...RUN_STATE, revision: Number.MAX_SAFE_INTEGER + 1 },
    }, {
      currentOrganizationId: 'org-1',
    })).toBeNull()
  })
})
