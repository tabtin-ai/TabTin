import { describe, expect, it } from 'vitest'
import { resolveNotificationTypeLabelKey } from '../resolveNotificationTypeLabel'

describe('resolveNotificationTypeLabelKey', () => {
  it('maps owner_reassigned_summary to member-removal label key', () => {
    expect(
      resolveNotificationTypeLabelKey('resource_shared', {
        action: 'owner_reassigned_summary',
      }),
    ).toBe('notification.types.owner_reassigned_summary')
  })

  it('falls back to type when action is absent or unrelated', () => {
    expect(resolveNotificationTypeLabelKey('resource_shared', null)).toBe(
      'notification.types.resource_shared',
    )
    expect(
      resolveNotificationTypeLabelKey('resource_shared', { action: 'invited' }),
    ).toBe('notification.types.resource_shared')
    expect(resolveNotificationTypeLabelKey('member_removed')).toBe(
      'notification.types.member_removed',
    )
  })
})
