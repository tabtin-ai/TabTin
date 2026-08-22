import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useChatSessionEventStream } from '../useChatSessionEventStream'

const { useGatewayTopic } = vi.hoisted(() => ({ useGatewayTopic: vi.fn() }))

vi.mock('../useGatewayTopic', () => ({ useGatewayTopic }))

describe('useChatSessionEventStream', () => {
  it('模型变更事件只触发权威会话重拉', () => {
    const onModelChanged = vi.fn()
    renderHook(() => useChatSessionEventStream({
      sessionId: 'session-1',
      onModelChanged,
    }))

    const subscription = useGatewayTopic.mock.calls.at(-1)?.[0]
    act(() => subscription.onEvent({
      type: 'agent.session.model_changed',
      payload: { session_id: 'session-1', current_model_id: 'untrusted-snapshot' },
    }))

    expect(onModelChanged).toHaveBeenCalledOnce()
  })
})
