import { describe, expect, it } from 'vitest'
import { CollabConnectionStatus, CollabStatus } from '@tabtin/collab-core'
import { shouldShowTableCollabStatusBadge } from './tableCollabStatusBadgeVisibility'

describe('shouldShowTableCollabStatusBadge', () => {
  it('hides empty, initial, and expected first-connect states', () => {
    expect(shouldShowTableCollabStatusBadge(null, null)).toBe(false)
    expect(shouldShowTableCollabStatusBadge(CollabStatus.INITIAL, CollabConnectionStatus.IDLE)).toBe(false)
    expect(
      shouldShowTableCollabStatusBadge(CollabStatus.CONNECTING, CollabConnectionStatus.CONNECTING),
    ).toBe(false)
  })

  it('keeps visible states that need user awareness or stable presence', () => {
    expect(
      shouldShowTableCollabStatusBadge(CollabStatus.CONNECTING, CollabConnectionStatus.STUCK_CONNECTING),
    ).toBe(true)
    expect(
      shouldShowTableCollabStatusBadge(CollabStatus.CONNECTING, CollabConnectionStatus.RECONNECTING),
    ).toBe(true)
    expect(
      shouldShowTableCollabStatusBadge(CollabStatus.DISCONNECTED, CollabConnectionStatus.FAILED),
    ).toBe(true)
    expect(
      shouldShowTableCollabStatusBadge(CollabStatus.SYNCED, CollabConnectionStatus.CONNECTED),
    ).toBe(true)
  })
})
