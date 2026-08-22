import { describe, expect, it, vi } from 'vitest'
import {
  applyExternalDocumentSaveReconcile,
  canForceReconnectAfterExternalSave,
  isHealthyCollabStatus,
  isMissingCollabTokenError,
  shouldReconcileExternalDocumentSave,
  shouldReconcileExternalDocumentSaveForMode,
} from '../externalDocumentSave'

describe('shouldReconcileExternalDocumentSave', () => {
  it('returns true when incoming version is newer', () => {
    expect(shouldReconcileExternalDocumentSave({
      incomingVersion: 5,
      localVersion: 4,
      saveState: 'idle',
    })).toBe(true)
  })

  it('returns false when version unchanged or stale', () => {
    expect(shouldReconcileExternalDocumentSave({
      incomingVersion: 4,
      localVersion: 4,
      saveState: 'idle',
    })).toBe(false)
    expect(shouldReconcileExternalDocumentSave({
      incomingVersion: 3,
      localVersion: 4,
      saveState: 'idle',
    })).toBe(false)
  })

  it('returns false while local save in flight', () => {
    expect(shouldReconcileExternalDocumentSave({
      incomingVersion: 5,
      localVersion: 4,
      saveState: 'saving',
    })).toBe(false)
  })
})

describe('shouldReconcileExternalDocumentSaveForMode', () => {
  const newer = {
    incomingVersion: 5,
    localVersion: 4,
    saveState: 'idle' as const,
  }

  it('reconciles in legacy mode regardless of collab status', () => {
    expect(shouldReconcileExternalDocumentSaveForMode({
      syncMode: 'legacy',
      ...newer,
      collabStatus: 'synced',
    })).toBe(true)
    expect(shouldReconcileExternalDocumentSaveForMode({
      syncMode: 'legacy',
      ...newer,
      collabStatus: 'disconnected',
    })).toBe(true)
  })

  it('skips REST reconcile when collab is healthy SYNCED/SYNCING', () => {
    expect(shouldReconcileExternalDocumentSaveForMode({
      syncMode: 'collab',
      ...newer,
      collabStatus: 'synced',
    })).toBe(false)
    expect(shouldReconcileExternalDocumentSaveForMode({
      syncMode: 'collab',
      ...newer,
      collabStatus: 'syncing',
    })).toBe(false)
  })

  it('reconciles when collab is DISCONNECTED and incoming version is newer', () => {
    expect(shouldReconcileExternalDocumentSaveForMode({
      syncMode: 'collab',
      ...newer,
      collabStatus: 'disconnected',
    })).toBe(true)
  })

  it('reconciles when collab reports missing auth token', () => {
    expect(shouldReconcileExternalDocumentSaveForMode({
      syncMode: 'collab',
      ...newer,
      collabStatus: 'disconnected',
      collabLastError: 'missing_collab_token',
    })).toBe(true)
    expect(shouldReconcileExternalDocumentSaveForMode({
      syncMode: 'collab',
      ...newer,
      collabStatus: 'connecting',
      collabLastError: 'Missing authentication token',
    })).toBe(true)
  })

  it('reconciles when collab is force-closed or still initial', () => {
    expect(shouldReconcileExternalDocumentSaveForMode({
      syncMode: 'collab',
      ...newer,
      collabStatus: 'force-closed',
    })).toBe(true)
    expect(shouldReconcileExternalDocumentSaveForMode({
      syncMode: 'collab',
      ...newer,
      collabStatus: 'initial',
    })).toBe(true)
  })

  it('still respects version and saving guards in disconnected collab', () => {
    expect(shouldReconcileExternalDocumentSaveForMode({
      syncMode: 'collab',
      incomingVersion: 4,
      localVersion: 4,
      saveState: 'idle',
      collabStatus: 'disconnected',
    })).toBe(false)
    expect(shouldReconcileExternalDocumentSaveForMode({
      syncMode: 'collab',
      incomingVersion: 5,
      localVersion: 4,
      saveState: 'saving',
      collabStatus: 'disconnected',
    })).toBe(false)
  })
})

describe('collab health helpers', () => {
  it('treats synced/syncing as healthy', () => {
    expect(isHealthyCollabStatus('synced')).toBe(true)
    expect(isHealthyCollabStatus('syncing')).toBe(true)
    expect(isHealthyCollabStatus('disconnected')).toBe(false)
  })

  it('detects missing token lastError variants', () => {
    expect(isMissingCollabTokenError('missing_collab_token')).toBe(true)
    expect(isMissingCollabTokenError('Missing authentication token')).toBe(true)
    expect(isMissingCollabTokenError('auth_failed')).toBe(false)
  })
})

describe('canForceReconnectAfterExternalSave', () => {
  it('allows reconnect for disconnected collab with a token', () => {
    expect(canForceReconnectAfterExternalSave({
      collabEnabled: true,
      isFallback: false,
      collabStatus: 'disconnected',
      collabLastError: null,
    })).toBe(true)
  })

  it('blocks reconnect when token is missing or force-closed', () => {
    expect(canForceReconnectAfterExternalSave({
      collabEnabled: true,
      isFallback: false,
      collabStatus: 'disconnected',
      collabLastError: 'missing_collab_token',
    })).toBe(false)
    expect(canForceReconnectAfterExternalSave({
      collabEnabled: true,
      isFallback: false,
      collabStatus: 'force-closed',
    })).toBe(false)
    expect(canForceReconnectAfterExternalSave({
      collabEnabled: true,
      isFallback: true,
      collabStatus: 'disconnected',
    })).toBe(false)
  })
})

describe('applyExternalDocumentSaveReconcile', () => {
  it('always retryLoad; forceReconnect only when reconnectable', () => {
    const retryLoad = vi.fn()
    const triggerForceReconnect = vi.fn()

    applyExternalDocumentSaveReconcile({
      retryLoad,
      triggerForceReconnect,
      collabEnabled: true,
      isFallback: false,
    })
    expect(retryLoad).toHaveBeenCalledOnce()
    expect(triggerForceReconnect).toHaveBeenCalledOnce()

    retryLoad.mockClear()
    triggerForceReconnect.mockClear()

    applyExternalDocumentSaveReconcile({
      retryLoad,
      triggerForceReconnect,
      collabEnabled: false,
      isFallback: true,
    })
    expect(retryLoad).toHaveBeenCalledOnce()
    expect(triggerForceReconnect).not.toHaveBeenCalled()
  })

  it('skips forceReconnect when canForceReconnect is false (e.g. FORCE_CLOSED)', () => {
    const retryLoad = vi.fn()
    const triggerForceReconnect = vi.fn()

    applyExternalDocumentSaveReconcile({
      retryLoad,
      triggerForceReconnect,
      collabEnabled: true,
      isFallback: false,
      canForceReconnect: false,
    })
    expect(retryLoad).toHaveBeenCalledOnce()
    expect(triggerForceReconnect).not.toHaveBeenCalled()
  })

  it('forceReconnects disconnected collab that is still reconnectable', () => {
    const retryLoad = vi.fn()
    const triggerForceReconnect = vi.fn()

    applyExternalDocumentSaveReconcile({
      retryLoad,
      triggerForceReconnect,
      collabEnabled: true,
      isFallback: false,
      canForceReconnect: true,
    })
    expect(retryLoad).toHaveBeenCalledOnce()
    expect(triggerForceReconnect).toHaveBeenCalledOnce()
  })
})
