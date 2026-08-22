import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ChatSession } from '@tabtin/chat-client'
import {
  ARCHIVE_INLINE_CONFIRM_COOLDOWN_MS,
  ARCHIVE_INLINE_CONFIRM_TIMEOUT_MS,
} from '../useInlineArchiveConfirm'
import { useSessionSwitcherActions } from '../useSessionSwitcherActions'

vi.mock('@/hooks/useResolvedOrganizationId', () => ({
  useResolvedOrganizationId: () => 'org-1',
}))

vi.mock('@/stores/useSpaceStore', () => ({
  useSpaceStore: { getState: () => ({ spaces: [] }) },
}))

vi.mock('@/stores/useOrganizationStore', () => ({
  useOrganizationStore: { getState: () => ({ organizations: [], selectedOrganization: null }) },
}))

vi.mock('@components/shared/file-ops/clipboard', () => ({
  copyToClipboard: vi.fn(),
}))

vi.mock('@/utils/buildSessionReferenceClipboardText', () => ({
  buildSessionReferenceClipboardText: () => 'ref',
  warmSpacePathCache: vi.fn(),
}))

const mocks = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  listSessionSharesBySession: vi.fn(),
  beginOptimisticArchive: vi.fn(),
  rollbackOptimisticArchive: vi.fn(),
  restoreSession: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@components/ui', () => ({
  toast: mocks.toast,
}))

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      restoreSession: mocks.restoreSession,
      beginOptimisticArchive: mocks.beginOptimisticArchive,
      rollbackOptimisticArchive: mocks.rollbackOptimisticArchive,
    }),
  },
}))

vi.mock('@/services/tabchatApi', () => ({
  listSessionSharesBySession: mocks.listSessionSharesBySession,
}))

const session = {
  id: 'chat-ext-1',
  title: '外来历史',
  status: 'active',
  space_id: 'space-1',
} as ChatSession

describe('useSessionSwitcherActions external archive', () => {
  beforeEach(() => {
    mocks.listSessionSharesBySession.mockReset()
    mocks.listSessionSharesBySession.mockResolvedValue([])
    mocks.beginOptimisticArchive.mockReset()
    mocks.rollbackOptimisticArchive.mockReset()
    mocks.restoreSession.mockReset()
    mocks.restoreSession.mockResolvedValue(undefined)
  })

  it('uses two-click inline confirm for ordinary agent conversation archive', async () => {
    vi.useFakeTimers()
    const onDeleteSession = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useSessionSwitcherActions({
      sessions: [session],
      onDeleteSession,
      t: (_key, opts) => (typeof opts?.defaultValue === 'string' ? opts.defaultValue : _key),
    }))

    act(() => {
      result.current.handleArchiveRequest(session.id)
    })
    expect(result.current.pendingArchiveSessionId).toBe(session.id)
    expect(result.current.archiveTarget).toBeNull()
    expect(onDeleteSession).not.toHaveBeenCalled()

    act(() => {
      result.current.handleArchiveRequest(session.id)
    })
    expect(onDeleteSession).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(ARCHIVE_INLINE_CONFIRM_COOLDOWN_MS - 1)
      result.current.handleArchiveRequest(session.id)
    })
    expect(onDeleteSession).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(1)
      result.current.handleArchiveRequest(session.id)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(mocks.beginOptimisticArchive).toHaveBeenCalledWith('space-1', session.id)
    expect(onDeleteSession).toHaveBeenCalledWith(session.id)
    expect(result.current.archiveTarget).toBeNull()
    expect(result.current.pendingArchiveSessionId).toBeNull()
    vi.useRealTimers()
  })

  it('removes the session from the sidebar before share lookup resolves', async () => {
    vi.useFakeTimers()
    let resolveShares: (value: unknown[]) => void = () => {}
    mocks.listSessionSharesBySession.mockImplementation(
      () => new Promise((resolve) => { resolveShares = resolve }),
    )
    const onDeleteSession = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useSessionSwitcherActions({
      sessions: [session],
      onDeleteSession,
      t: (_key, opts) => (typeof opts?.defaultValue === 'string' ? opts.defaultValue : _key),
    }))

    act(() => {
      result.current.handleArchiveRequest(session.id)
    })
    act(() => {
      vi.advanceTimersByTime(ARCHIVE_INLINE_CONFIRM_COOLDOWN_MS)
      result.current.handleArchiveRequest(session.id)
    })
    expect(mocks.beginOptimisticArchive).toHaveBeenCalledWith('space-1', session.id)
    expect(onDeleteSession).not.toHaveBeenCalled()

    await act(async () => {
      resolveShares([])
      await Promise.resolve()
    })
    expect(onDeleteSession).toHaveBeenCalledWith(session.id)
    vi.useRealTimers()
  })

  it('clears inline confirm after the timeout without archiving', () => {
    vi.useFakeTimers()
    const onDeleteSession = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useSessionSwitcherActions({
      sessions: [session],
      onDeleteSession,
      t: (_key, opts) => (typeof opts?.defaultValue === 'string' ? opts.defaultValue : _key),
    }))

    act(() => {
      result.current.handleArchiveRequest(session.id)
    })
    act(() => {
      vi.advanceTimersByTime(ARCHIVE_INLINE_CONFIRM_TIMEOUT_MS)
    })
    expect(result.current.pendingArchiveSessionId).toBeNull()
    expect(onDeleteSession).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('opens the shared-archive dialog instead of deleting when the session is shared', async () => {
    vi.useFakeTimers()
    mocks.listSessionSharesBySession.mockResolvedValue([
      { id: 'share-1', status: 'active' },
    ])
    const onDeleteSession = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useSessionSwitcherActions({
      sessions: [session],
      onDeleteSession,
      t: (_key, opts) => (typeof opts?.defaultValue === 'string' ? opts.defaultValue : _key),
    }))

    act(() => {
      result.current.handleArchiveRequest(session.id)
    })
    act(() => {
      vi.advanceTimersByTime(ARCHIVE_INLINE_CONFIRM_COOLDOWN_MS)
      result.current.handleArchiveRequest(session.id)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(mocks.beginOptimisticArchive).toHaveBeenCalledWith('space-1', session.id)
    expect(mocks.rollbackOptimisticArchive).toHaveBeenCalledWith('space-1', session.id)
    expect(onDeleteSession).not.toHaveBeenCalled()
    expect(result.current.archiveTarget).toBe(session.id)
    vi.useRealTimers()
  })

  it('routes archive request of opened external session to delete dialog', () => {
    const resolve = vi.fn(() => ({
      source: 'cursor',
      sourceSessionId: 'src-1',
      title: '外来历史',
      openedSessionId: 'chat-ext-1',
    }))
    const { result } = renderHook(() => useSessionSwitcherActions({
      sessions: [session],
      externalOpenedSessionIds: new Set(['chat-ext-1']),
      resolveExternalArchiveByOpenedSessionId: resolve,
      t: (_key, opts) => (typeof opts?.defaultValue === 'string' ? opts.defaultValue : _key),
    }))

    act(() => {
      result.current.handleArchiveRequest('chat-ext-1')
    })

    expect(resolve).toHaveBeenCalledWith('chat-ext-1')
    expect(result.current.externalArchiveDeleteTarget).toEqual({
      source: 'cursor',
      sourceSessionId: 'src-1',
      title: '外来历史',
      openedSessionId: 'chat-ext-1',
    })
    expect(result.current.archiveTarget).toBeNull()
    expect(result.current.isExternalOpenedSession('chat-ext-1')).toBe(true)
  })
})
