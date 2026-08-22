import { beforeEach, describe, expect, it } from 'vitest'
import { waitFor } from '@testing-library/react'

import { handleCapabilityEvent } from '../capabilityEventHandler'
import type { AgentStreamMessage, HandlerContext } from '../streamHandlerTypes'
import { useChatRuntimeStore } from '../../../../useChatRuntimeStore'

const SESSION_ID = 'session-capability-event'

function makeCtx(): HandlerContext {
  return {
    sessionId: SESSION_ID,
    notifyPrefix: 'test',
    get: () => ({}) as never,
    set: () => undefined,
    addStreamingSession: () => undefined,
    removeStreamingSession: () => undefined,
    client: { sessions: { get: async () => ({}) as never } },
    updateSessionTokenUsageInCaches: () => undefined,
    onLifecycleEnd: () => undefined,
  }
}

beforeEach(() => {
  useChatRuntimeStore.getState().reset()
})

describe('capabilityEventHandler', () => {
  it('pushes capability banner and preserves downgrade identity fields', async () => {
    const message: AgentStreamMessage = {
      type: 'agent.stream.capability_event',
      payload: {
        kind: 'downgrade',
        feature: 'reasoning',
        fallback_to: 'omit_reasoning_param',
        message: '当前模型不支持 reasoning/thinking 参数，本轮已自动忽略；如需完整能力请换模型。',
        model: 'test-model',
        extras: { stage: 'reasoning' },
      },
    }

    handleCapabilityEvent(message, makeCtx())

    await waitFor(() => {
      const banners = useChatRuntimeStore.getState().capabilityBannersBySessionId[SESSION_ID]
      expect(banners).toHaveLength(1)
      expect(banners[0]).toMatchObject({
        kind: 'downgrade',
        feature: 'reasoning',
        fallback_to: 'omit_reasoning_param',
        model: 'test-model',
        extras: { stage: 'reasoning' },
      })
    })
  })

  it('normalizes runtime_profile stage/reason into extras', async () => {
    const message: AgentStreamMessage = {
      type: 'agent.stream.capability_event',
      payload: {
        kind: 'downgrade',
        feature: 'reasoning',
        fallback_to: 'medium',
        message: '当前模型不支持你选择的思考强度，本轮已按可用档执行。',
        stage: 'runtime_profile',
        reason: 'effort_level_unavailable',
        requested: 'deep',
        model_name: 'claude-x',
      },
    }

    handleCapabilityEvent(message, makeCtx())

    await waitFor(() => {
      const banners = useChatRuntimeStore.getState().capabilityBannersBySessionId[SESSION_ID]
      expect(banners).toHaveLength(1)
      expect(banners[0]).toMatchObject({
        feature: 'reasoning',
        model: 'claude-x',
        message: '当前模型不支持你选择的思考强度，本轮已按可用档执行。',
        extras: {
          stage: 'runtime_profile',
          reason: 'effort_level_unavailable',
          requested: 'deep',
          model_name: 'claude-x',
        },
      })
    })
  })
})
