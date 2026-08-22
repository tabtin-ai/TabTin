import { beforeEach, describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import {
  buildAgentTurnDiffSnapshot,
  useAgentTurnDiffStore,
} from '../agentTurnDiffSnapshots'

function makeMessage(partial: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    created_at: '2026-08-11T10:00:00.000Z',
    ...partial,
  } as ChatMessage
}

describe('agentTurnDiffSnapshots', () => {
  beforeEach(() => {
    useAgentTurnDiffStore.setState({
      byMessageId: {},
      rootSwitchedAtBySession: {},
    })
  })

  it('builds a frozen snapshot from diff_summary + context', () => {
    const snap = buildAgentTurnDiffSnapshot(
      'sess-1',
      makeMessage({
        id: 'm1',
        checkpoint_hash: 'abc123def',
        diff_summary: {
          changed: 2,
          insertions: 3,
          deletions: 1,
          files: [{ file: 'a.ts', changes: 2, insertions: 2, deletions: 0, binary: false }],
        },
      }),
      { codeRootPath: '/repo/wt-a', branch: 'feat/a' },
    )
    expect(snap).toMatchObject({
      messageId: 'm1',
      sessionId: 'sess-1',
      codeRootPath: '/repo/wt-a',
      branch: 'feat/a',
      baseCommit: 'abc123def',
    })
  })

  it('captures once and filters by code root after worktree switch', () => {
    const messages = [
      makeMessage({
        id: 'm1',
        diff_summary: { changed: 1, insertions: 1, deletions: 0, files: [] },
      }),
    ]
    useAgentTurnDiffStore.getState().captureFromMessages('sess-1', messages, {
      codeRootPath: '/repo/wt-a',
      branch: 'feat/a',
    })
    // 再次捕获不应改写已冻结的根
    useAgentTurnDiffStore.getState().captureFromMessages('sess-1', messages, {
      codeRootPath: '/repo/wt-b',
      branch: 'feat/b',
    })

    expect(useAgentTurnDiffStore.getState().listForSessionRoot('sess-1', '/repo/wt-a')).toHaveLength(1)
    expect(useAgentTurnDiffStore.getState().listForSessionRoot('sess-1', '/repo/wt-b')).toHaveLength(0)
    expect(useAgentTurnDiffStore.getState().byMessageId.m1.codeRootPath).toBe('/repo/wt-a')
    expect(useAgentTurnDiffStore.getState().byMessageId.m1.branch).toBe('feat/a')
  })

  it('ignores assistant messages that only have checkpoint_hash without usable diff_summary', () => {
    useAgentTurnDiffStore.getState().captureFromMessages(
      'sess-1',
      [
        makeMessage({
          id: 'hash-only',
          checkpoint_hash: 'abc123',
        }),
        makeMessage({
          id: 'zero-changed',
          diff_summary: { changed: 0, insertions: 0, deletions: 0, files: [] },
        }),
      ],
      { codeRootPath: '/repo/wt-a', branch: 'feat/a' },
    )

    expect(useAgentTurnDiffStore.getState().byMessageId['hash-only']).toBeUndefined()
    expect(useAgentTurnDiffStore.getState().byMessageId['zero-changed']).toBeUndefined()
    expect(useAgentTurnDiffStore.getState().listForSessionRoot('sess-1', '/repo/wt-a')).toHaveLength(0)
  })

  it('does not freeze pre-switch messages onto the new code root', () => {
    useAgentTurnDiffStore.getState().markCodeRootSwitched(
      'sess-1',
      '2026-08-11T12:00:00.000Z',
    )
    useAgentTurnDiffStore.getState().captureFromMessages(
      'sess-1',
      [
        makeMessage({
          id: 'old-turn',
          created_at: '2026-08-11T11:00:00.000Z',
          diff_summary: { changed: 1, insertions: 1, deletions: 0, files: [] },
        }),
        makeMessage({
          id: 'new-turn',
          created_at: '2026-08-11T12:30:00.000Z',
          diff_summary: { changed: 1, insertions: 2, deletions: 0, files: [] },
        }),
      ],
      { codeRootPath: '/repo/wt-b', branch: 'feat/b' },
    )

    expect(useAgentTurnDiffStore.getState().byMessageId['old-turn']).toBeUndefined()
    expect(useAgentTurnDiffStore.getState().byMessageId['new-turn']?.codeRootPath).toBe(
      '/repo/wt-b',
    )
  })
})
