/**
 * ：本轮产物卡流式可见性 —— 发送下一条时不得误藏已完成轮次。
 */
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import {
  findLastTurnEndIndex,
  isOpenStreamingTurnEnd,
  isTurnEndSlot,
  shouldShowTurnArtifactsCard,
} from '../turnArtifacts'

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role' | 'content' | 'created_at'>): ChatMessage {
  return {
    message_kind: partial.role === 'assistant' ? 'llm' : undefined,
    ...partial,
  } as ChatMessage
}

const ARTIFACT_HREF = 'tabtin://resource/tabdoc/d-1'

function turnWithArtifact(ids: { user: string; assistant: string; run: string }): ChatMessage[] {
  return [
    msg({ id: ids.user, role: 'user', content: '做计划', created_at: '2026-01-01T00:00:00Z' }),
    msg({
      id: ids.assistant,
      role: 'assistant',
      content: `[计划](${ARTIFACT_HREF})`,
      created_at: '2026-01-01T00:00:01Z',
      agent_run_id: ids.run,
    }),
  ]
}

describe('isOpenStreamingTurnEnd ', () => {
  const idleAfterTurn1 = turnWithArtifact({ user: 'u1', assistant: 'a1', run: 'run-1' })
  const afterUserSentNext = [
    ...idleAfterTurn1,
    msg({ id: 'u2', role: 'user', content: '继续', created_at: '2026-01-01T00:00:02Z' }),
  ]
  const afterAssistant2Started = [
    ...afterUserSentNext,
    msg({
      id: 'a2',
      role: 'assistant',
      content: '思考中…',
      created_at: '2026-01-01T00:00:03Z',
      agent_run_id: 'run-2',
    }),
  ]

  it('idle 不是 open 流式末轮', () => {
    expect(isOpenStreamingTurnEnd(idleAfterTurn1, 1, false)).toBe(false)
  })

  it('当前轮流式、其后无 user → 是 open 流式末轮', () => {
    expect(findLastTurnEndIndex(idleAfterTurn1)).toBe(1)
    expect(isOpenStreamingTurnEnd(idleAfterTurn1, 1, true)).toBe(true)
  })

  it('发下一条后 busy、新 assistant 未到 → 上一轮不是 open 流式末轮', () => {
    expect(findLastTurnEndIndex(afterUserSentNext)).toBe(1)
    expect(isOpenStreamingTurnEnd(afterUserSentNext, 1, true)).toBe(false)
  })

  it('发送契约：busy 仅在 messages 已含后续 user 时成立 → 不误藏上一轮', () => {
    // sendMessageAction：updateSessionMessages 追加 user 后才进入 busy（run_sync / run_state）。
    // 错误顺序（busy 先于 user）会让本用例中 idleAfterTurn1+streaming 误藏。
    expect(isOpenStreamingTurnEnd(idleAfterTurn1, 1, true)).toBe(true)
    expect(shouldShowTurnArtifactsCard({
      sessionId: 's1',
      artifacts: [{
        id: 'art-1',
        kind: 'doc',
        title: '计划',
        href: ARTIFACT_HREF,
        subtitleKey: 'previewDoc',
      }],
      messages: afterUserSentNext,
      index: 1,
      isStreaming: true,
    })).toBe(true)
  })

  it('新 assistant 流式中 → 仅当前轮是 open 流式末轮', () => {
    expect(findLastTurnEndIndex(afterAssistant2Started)).toBe(3)
    expect(isOpenStreamingTurnEnd(afterAssistant2Started, 1, true)).toBe(false)
    expect(isOpenStreamingTurnEnd(afterAssistant2Started, 3, true)).toBe(true)
  })

  it('其后普通 user 关闭 open；push-notification 不关闭', () => {
    const withPush = [
      ...idleAfterTurn1,
      msg({
        id: 'push-1',
        role: 'user',
        content: '后台完成',
        created_at: '2026-01-01T00:00:02Z',
        metadata: { triggered_by: 'push-notification' },
      }),
    ]
    // ：push 不是轮末挂载点；末轮仍落在前一条 assistant，且 push 不关闭 open
    const pushTurnEnd = findLastTurnEndIndex(withPush)
    expect(pushTurnEnd).toBe(1)
    expect(isTurnEndSlot(withPush, 2)).toBe(false)
    expect(isOpenStreamingTurnEnd(withPush, pushTurnEnd, true)).toBe(true)
    expect(isOpenStreamingTurnEnd(afterUserSentNext, 1, true)).toBe(false)
  })
})

describe('shouldShowTurnArtifactsCard ', () => {
  const idleAfterTurn1 = turnWithArtifact({ user: 'u1', assistant: 'a1', run: 'run-1' })
  const artifacts = [{
    id: 'art-1',
    kind: 'doc' as const,
    title: '计划',
    href: ARTIFACT_HREF,
    subtitleKey: 'previewDoc' as const,
  }]

  it('idle → 可见', () => {
    expect(shouldShowTurnArtifactsCard({
      sessionId: 's1',
      artifacts,
      messages: idleAfterTurn1,
      index: 1,
      isStreaming: false,
    })).toBe(true)
  })

  it('发下一条后 busy、新 assistant 未到 → 上一轮仍可见', () => {
    const afterUserSentNext = [
      ...idleAfterTurn1,
      msg({ id: 'u2', role: 'user', content: '继续', created_at: '2026-01-01T00:00:02Z' }),
    ]
    expect(shouldShowTurnArtifactsCard({
      sessionId: 's1',
      artifacts,
      messages: afterUserSentNext,
      index: 1,
      isStreaming: true,
    })).toBe(true)
  })

  it('新 assistant 流式中 → 上一轮可见、当前轮有产物仍隐藏', () => {
    const afterAssistant2Started = [
      ...idleAfterTurn1,
      msg({ id: 'u2', role: 'user', content: '继续', created_at: '2026-01-01T00:00:02Z' }),
      msg({
        id: 'a2',
        role: 'assistant',
        content: `[续](${ARTIFACT_HREF})`,
        created_at: '2026-01-01T00:00:03Z',
        agent_run_id: 'run-2',
      }),
    ]
    const currentTurnArtifacts = [{
      id: 'art-2',
      kind: 'doc' as const,
      title: '续',
      href: ARTIFACT_HREF,
      subtitleKey: 'previewDoc' as const,
    }]
    expect(shouldShowTurnArtifactsCard({
      sessionId: 's1',
      artifacts,
      messages: afterAssistant2Started,
      index: 1,
      isStreaming: true,
    })).toBe(true)
    expect(shouldShowTurnArtifactsCard({
      sessionId: 's1',
      artifacts: currentTurnArtifacts,
      messages: afterAssistant2Started,
      index: 3,
      isStreaming: true,
    })).toBe(false)
  })

  it('无产物 / 无 session → 不可见', () => {
    expect(shouldShowTurnArtifactsCard({
      sessionId: null,
      artifacts,
      messages: idleAfterTurn1,
      index: 1,
      isStreaming: false,
    })).toBe(false)
    expect(shouldShowTurnArtifactsCard({
      sessionId: 's1',
      artifacts: [],
      messages: idleAfterTurn1,
      index: 1,
      isStreaming: false,
    })).toBe(false)
  })
})
