import { describe, expect, it } from 'vitest'
import { CollabStatus } from '@tabtin/collab-core'

import {
  isCollabContentHydrated,
  resolveCollabEditorPresentation,
  shouldUseRealtimeCollabEditor,
} from './collabMode'

const ydoc = {} as never

describe('isCollabContentHydrated', () => {
  it('is true only when server SYNCED or local cache has content', () => {
    expect(isCollabContentHydrated({
      status: CollabStatus.SYNCED,
      isFallback: false,
    })).toBe(true)
    expect(isCollabContentHydrated({
      status: CollabStatus.CONNECTING,
      isFallback: false,
      isCacheReady: true,
      hasCachedContent: true,
    })).toBe(true)
    expect(isCollabContentHydrated({
      status: CollabStatus.CONNECTING,
      isFallback: false,
      isCacheReady: true,
      hasCachedContent: false,
    })).toBe(false)
    expect(isCollabContentHydrated({
      status: CollabStatus.CONNECTING,
      isFallback: false,
      isCacheReady: false,
      hasCachedContent: false,
    })).toBe(false)
  })
})

describe('resolveCollabEditorPresentation / shouldUseRealtimeCollabEditor', () => {
  it('does not mount Collaboration before cache/server hydrate ', () => {
    expect(resolveCollabEditorPresentation(ydoc, {
      status: CollabStatus.CONNECTING,
      isFallback: false,
    })).toBe('loading')
    expect(shouldUseRealtimeCollabEditor(ydoc, {
      status: CollabStatus.CONNECTING,
      isFallback: false,
    })).toBe(false)

    expect(resolveCollabEditorPresentation(ydoc, {
      status: CollabStatus.SYNCING,
      isFallback: false,
      isCacheReady: true,
      hasCachedContent: false,
    })).toBe('loading')
  })

  it('mounts Collaboration when server SYNCED or cache has content', () => {
    expect(shouldUseRealtimeCollabEditor(ydoc, {
      status: CollabStatus.SYNCED,
      isFallback: false,
    })).toBe(true)
    expect(shouldUseRealtimeCollabEditor(ydoc, {
      status: CollabStatus.CONNECTING,
      isFallback: false,
      isCacheReady: true,
      hasCachedContent: true,
    })).toBe(true)
  })

  it('keeps realtime after hydrate latch during recoverable disconnect / auth_failed', () => {
    expect(shouldUseRealtimeCollabEditor(ydoc, {
      status: CollabStatus.DISCONNECTED,
      isFallback: false,
      lastError: 'auth_failed',
    }, { hasHydratedLatch: true })).toBe(true)
    expect(shouldUseRealtimeCollabEditor(ydoc, {
      status: CollabStatus.DISCONNECTED,
      isFallback: false,
      lastError: null,
    }, { hasHydratedLatch: true })).toBe(true)
    // 无 latch 且未 hydrate：loading，不切 REST
    expect(resolveCollabEditorPresentation(ydoc, {
      status: CollabStatus.DISCONNECTED,
      isFallback: false,
      lastError: null,
    })).toBe('loading')
  })

  it('falls back to REST after force-close or missing collab token', () => {
    expect(resolveCollabEditorPresentation(ydoc, {
      status: CollabStatus.FORCE_CLOSED,
      isFallback: false,
    })).toBe('rest')
    expect(resolveCollabEditorPresentation(ydoc, {
      status: CollabStatus.DISCONNECTED,
      isFallback: false,
      lastError: 'missing_collab_token',
    })).toBe('rest')
    expect(shouldUseRealtimeCollabEditor(ydoc, {
      status: CollabStatus.FORCE_CLOSED,
      isFallback: false,
    })).toBe(false)
  })

  it('does not use realtime collaboration in legacy fallback mode', () => {
    expect(resolveCollabEditorPresentation(ydoc, {
      status: CollabStatus.SYNCED,
      isFallback: true,
    })).toBe('rest')
    expect(shouldUseRealtimeCollabEditor(ydoc, {
      status: CollabStatus.SYNCED,
      isFallback: true,
    })).toBe(false)
  })

  it('shows loading while waiting for ydoc before terminal rest', () => {
    expect(resolveCollabEditorPresentation(null, {
      status: CollabStatus.CONNECTING,
      isFallback: false,
    })).toBe('loading')
    expect(resolveCollabEditorPresentation(null, {
      status: CollabStatus.FORCE_CLOSED,
      isFallback: false,
    })).toBe('rest')
  })

  it('uses REST when collaborative state is absent', () => {
    expect(resolveCollabEditorPresentation(ydoc, null)).toBe('rest')
    expect(resolveCollabEditorPresentation(null, undefined)).toBe('rest')
  })
})
