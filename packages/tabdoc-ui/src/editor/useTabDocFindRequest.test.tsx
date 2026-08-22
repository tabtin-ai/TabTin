import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestTabDocFind } from '../docFindRequest'
import { useTabDocFindRequest } from './useTabDocFindRequest'

describe('useTabDocFindRequest', () => {
  afterEach(() => cleanup())

  it('only opens find for the targeted active document', () => {
    const onRequest = vi.fn()
    const { rerender } = renderHook(
      ({ documentId, enabled }) => useTabDocFindRequest({ documentId, enabled, onRequest }),
      { initialProps: { documentId: 'doc-1', enabled: true } },
    )

    act(() => requestTabDocFind('doc-2'))
    expect(onRequest).not.toHaveBeenCalled()

    act(() => requestTabDocFind('doc-1'))
    expect(onRequest).toHaveBeenCalledOnce()

    rerender({ documentId: 'doc-1', enabled: false })
    act(() => requestTabDocFind('doc-1'))
    expect(onRequest).toHaveBeenCalledOnce()
  })

  it('uses the latest pane state without resubscribing the global listener', () => {
    const onRequest = vi.fn()
    const addEventListener = vi.spyOn(window, 'addEventListener')
    const { rerender } = renderHook(
      ({ enabled }) => useTabDocFindRequest({ documentId: 'doc-1', enabled, onRequest }),
      { initialProps: { enabled: false } },
    )

    rerender({ enabled: true })
    act(() => requestTabDocFind('doc-1'))

    expect(onRequest).toHaveBeenCalledOnce()
    expect(addEventListener.mock.calls.filter(([type]) => type === 'tabtin:tabdoc-find-request')).toHaveLength(1)
    addEventListener.mockRestore()
  })
})
