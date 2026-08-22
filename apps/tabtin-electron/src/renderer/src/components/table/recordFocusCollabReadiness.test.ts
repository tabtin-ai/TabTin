import { describe, expect, it } from 'vitest'
import { CollabStatus } from '@tabtin/collab-core'
import { isRecordFocusCollabBootstrapPending } from './recordFocusCollabReadiness'

describe('isRecordFocusCollabBootstrapPending', () => {
  it('waits for a deep-link intent while the collab provider is syncing', () => {
    expect(isRecordFocusCollabBootstrapPending({
      hasFocusIntent: true,
      syncMode: 'collab',
      status: CollabStatus.SYNCING,
    })).toBe(true)
    expect(isRecordFocusCollabBootstrapPending({
      hasFocusIntent: true,
      syncMode: 'collab',
      status: CollabStatus.SYNCED,
    })).toBe(false)
  })

  it('waits for the initial collab-unavailable fallback but not permanent legacy modes', () => {
    expect(isRecordFocusCollabBootstrapPending({
      hasFocusIntent: true,
      syncMode: 'legacy',
      status: CollabStatus.INITIAL,
      syncModeReason: 'collab_unavailable',
    })).toBe(true)
    expect(isRecordFocusCollabBootstrapPending({
      hasFocusIntent: true,
      syncMode: 'legacy',
      status: CollabStatus.INITIAL,
      syncModeReason: 'flag_disabled',
    })).toBe(false)
  })

  it('does not gate focus paths without a deep-link intent', () => {
    expect(isRecordFocusCollabBootstrapPending({
      hasFocusIntent: false,
      syncMode: 'collab',
      status: CollabStatus.CONNECTING,
    })).toBe(false)
  })
})
