import { describe, expect, it } from 'vitest'
import { UserEventPayloadSchema } from '../src/events.js'

describe('UserEventPayloadSchema sender identity', () => {
  it('preserves the optional sender_user_id through wire parsing', () => {
    const parsed = UserEventPayloadSchema.parse({
      client_event_id: 'message-1',
      content: '共享发言',
      sender_user_id: 'grantee-1',
    })

    expect(parsed.sender_user_id).toBe('grantee-1')
  })

  it('keeps old USER payloads valid when sender_user_id is absent', () => {
    expect(UserEventPayloadSchema.safeParse({
      client_event_id: 'message-1',
      content: '普通发言',
    }).success).toBe(true)
  })
})
