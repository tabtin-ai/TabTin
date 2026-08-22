import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  getPreview: vi.fn(),
  listener: undefined as undefined | ((event: { type: string; resource_id: string }) => void),
}))

vi.mock('@/stores/useUnifiedResources', () => ({
  EMPTY_RESOURCES: [],
  useUnifiedResources: (selector: (state: { load: typeof mocks.load; getResources: () => [] }) => unknown) => selector({
    load: mocks.load,
    getResources: () => [],
  }),
  onResourceEvent: (
    _resourceType: string,
    listener: (event: { type: string; resource_id: string }) => void,
  ) => {
    mocks.listener = listener
    return () => {
      mocks.listener = undefined
    }
  },
}))

vi.mock('@/services/tabchatApi', () => ({
  getResourceCardPreview: mocks.getPreview,
}))

import { useResourceCardPreviewContext } from './useResourceCardPreview'

describe('useResourceCardPreviewContext permission changes', () => {
  beforeEach(() => {
    mocks.load.mockReset()
    mocks.getPreview.mockReset()
    mocks.listener = undefined
  })

  it('refetches the receiver role when resource access level changes', async () => {
    mocks.getPreview
      .mockResolvedValueOnce({ status: 'ok', data: { current_user_role: 'editor' } })
      .mockResolvedValueOnce({ status: 'ok', data: { current_user_role: 'viewer' } })
      .mockResolvedValueOnce({ status: 'ok', data: { current_user_role: 'editor' } })

    const { result } = renderHook(() => useResourceCardPreviewContext(
      'doc-1',
      'space-1',
      undefined,
      undefined,
      'document',
    ))

    await waitFor(() => {
      expect(result.current.currentUserRole).toBe('editor')
    })

    act(() => {
      mocks.listener?.({ type: 'resource_access_changed', resource_id: 'doc-1' })
    })

    await waitFor(() => {
      expect(result.current.currentUserRole).toBe('viewer')
    })

    act(() => {
      mocks.listener?.({ type: 'resource_access_changed', resource_id: 'doc-1' })
    })

    await waitFor(() => {
      expect(result.current.currentUserRole).toBe('editor')
    })
    expect(mocks.getPreview).toHaveBeenCalledTimes(3)
  })
})
