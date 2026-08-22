import { describe, expect, it } from 'vitest'
import { PromptCancelPayloadSchema } from '@tabtin/agent-wire'

describe('PromptCancelPayloadSchema', () => {
  it('accepts a session-only stop', () => {
    expect(PromptCancelPayloadSchema.parse({})).toEqual({})
  })

  it('preserves unanswered-turn withdrawal context', () => {
    const payload = {
      withdraw_unanswered: true,
      client_message_id: 'client-1',
      session_id: 'session-1',
      target_content: '发错了',
      space_id: 'workspace-1',
      organization_id: 'organization-1',
    }

    expect(PromptCancelPayloadSchema.parse(payload)).toEqual(payload)
  })
})
