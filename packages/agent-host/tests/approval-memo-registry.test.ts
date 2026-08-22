import { describe, expect, it, vi } from 'vitest'

import {
  ApprovalMemoRegistry,
  type ApprovalMemoStore,
} from '../src/interaction/approval-memo-registry.js'

function createStore(): ApprovalMemoStore {
  return {
    maybeRefetch: vi.fn(async () => true),
    bootstrap: vi.fn(async () => true),
  }
}

function createRegistry(onWorkspaceChanged = vi.fn()) {
  return {
    onWorkspaceChanged,
    registry: new ApprovalMemoRegistry({
      logger: {
        debug: vi.fn(),
        warn: vi.fn(),
      },
      onWorkspaceChanged,
    }),
  }
}

describe('ApprovalMemoRegistry', () => {
  it('routes one generation update to every session for the same workspace', async () => {
    const { registry, onWorkspaceChanged } = createRegistry()
    const first = createStore()
    const second = createStore()
    const other = createStore()
    registry.register('session-1', 'workspace-1', first)
    registry.register('session-2', 'workspace-1', second)
    registry.register('session-3', 'workspace-2', other)

    expect(registry.routeUpdate('workspace-1', 7)).toBe(2)
    await Promise.resolve()

    expect(first.maybeRefetch).toHaveBeenCalledWith(7)
    expect(second.maybeRefetch).toHaveBeenCalledWith(7)
    expect(other.maybeRefetch).not.toHaveBeenCalled()
    expect(onWorkspaceChanged).toHaveBeenCalledWith('workspace-1')
  })

  it('refreshes only matching stores and unregisters disposed sessions', async () => {
    const { registry } = createRegistry()
    const first = createStore()
    const second = createStore()
    registry.register('session-1', 'workspace-1', first)
    registry.register('session-2', 'workspace-2', second)
    registry.unregister('session-2')

    await registry.refresh('workspace-1')

    expect(first.bootstrap).toHaveBeenCalledOnce()
    expect(second.bootstrap).not.toHaveBeenCalled()
    expect(registry.get('session-2')).toBeUndefined()
  })

  it('rejects invalid registrations and ignores invalid updates', () => {
    const { registry, onWorkspaceChanged } = createRegistry()
    const store = createStore()

    expect(() => registry.register('', 'workspace-1', store)).toThrow()
    expect(registry.routeUpdate('', -1)).toBe(0)
    expect(onWorkspaceChanged).not.toHaveBeenCalled()
  })
})
