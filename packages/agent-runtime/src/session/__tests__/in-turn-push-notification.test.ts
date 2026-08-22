import { describe, expect, it } from 'vitest'
import { isInTurnPushNotificationUser } from '../in-turn-push-notification.js'

describe('isInTurnPushNotificationUser', () => {
  it('in-turn：message_id + triggered_by=push-notification → true', () => {
    expect(isInTurnPushNotificationUser({
      triggered_by: 'push-notification',
      message_id: 'msg-push-1',
    })).toBe(true)
  })

  it('idle drain：仅 client 侧无 message_id → false（勿重复双写）', () => {
    expect(isInTurnPushNotificationUser({
      triggered_by: 'push-notification',
    })).toBe(false)
    expect(isInTurnPushNotificationUser({
      triggered_by: 'push-notification',
      message_id: '',
    })).toBe(false)
  })

  it('非 push → false', () => {
    expect(isInTurnPushNotificationUser({
      triggered_by: 'user',
      message_id: 'msg-1',
    })).toBe(false)
    expect(isInTurnPushNotificationUser({
      message_id: 'msg-1',
    })).toBe(false)
  })
})
