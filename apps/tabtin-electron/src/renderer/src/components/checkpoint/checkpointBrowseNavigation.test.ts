import { describe, expect, it } from 'vitest'
import {
  checkpointHasConversationTarget,
  filterCheckpointsWithConversationTarget,
  resolveCheckpointNavigateTarget,
} from './checkpointBrowseNavigation'

describe('checkpointBrowseNavigation ', () => {
  it('列表有 agent_run_id 时直接走 agent_run', () => {
    expect(resolveCheckpointNavigateTarget({
      agent_run_id: 'run-1',
      anchor_session_id: 'sess-ignored',
    })).toEqual({ kind: 'agent_run', agentRunId: 'run-1' })
  })

  it('手动快照仅有 session 锚点时可跳到会话', () => {
    const item = { agent_run_id: '', anchor_session_id: 'sess-manual' }
    expect(checkpointHasConversationTarget(item)).toBe(true)
    expect(resolveCheckpointNavigateTarget(item)).toEqual({
      kind: 'session',
      sessionId: 'sess-manual',
      messageId: undefined,
    })
  })

  it('decision-context 可补齐 agent_run 与 message', () => {
    expect(checkpointHasConversationTarget({ agent_run_id: '', anchor_session_id: '' })).toBe(false)
    expect(resolveCheckpointNavigateTarget(
      { agent_run_id: '', anchor_session_id: '' },
      {
        anchor_session_id: 'sess-1',
        anchor_message_id: 'msg-1',
        context: { agent_run_id: 'run-2' },
      },
    )).toEqual({
      kind: 'agent_run',
      agentRunId: 'run-2',
      sessionId: 'sess-1',
      messageId: 'msg-1',
    })
  })

  it('无任何锚点时不可跳且解析为 none（复现原静默失败）', () => {
    const item = { agent_run_id: '', anchor_session_id: '' }
    expect(checkpointHasConversationTarget(item)).toBe(false)
    expect(resolveCheckpointNavigateTarget(item, {
      anchor_session_id: null,
      anchor_message_id: null,
      context: { agent_run_id: null },
    })).toEqual({ kind: 'none' })
  })

  it('浏览列表隐藏无关联对话的快照', () => {
    const jumpableByRun = { agent_run_id: 'run-1', anchor_session_id: '' }
    const jumpableBySession = { agent_run_id: '', anchor_session_id: 'sess-1' }
    const unavailable = { agent_run_id: '', anchor_session_id: '' }

    expect(filterCheckpointsWithConversationTarget([
      jumpableByRun,
      unavailable,
      jumpableBySession,
    ])).toEqual([jumpableByRun, jumpableBySession])
  })
})
