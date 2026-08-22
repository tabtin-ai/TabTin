import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TABDOC_FIND_REQUEST_EVENT,
  type TabDocFindRequestDetail,
} from '@tabtin/tabdoc-ui/find-request'
import type { ContextItem } from '../../registry/types'
import { useBrowserActions } from '../useBrowserActions'

vi.mock('../../registry', () => ({
  contextRegistry: { getHandler: vi.fn(() => undefined) },
}))

describe('useBrowserActions · find routing', () => {
  afterEach(() => cleanup())

  it('targets the active TabDoc document', () => {
    const listener = vi.fn<(event: Event) => void>()
    window.addEventListener(TABDOC_FIND_REQUEST_EVENT, listener)
    const { result } = renderHook(() => useBrowserActions())
    const item: ContextItem = {
      type: 'tabdoc',
      id: 'doc-1',
      tabKey: 'tabdoc:doc-1',
      title: '验收文档',
    }

    act(() => result.current.handleFindItem(item))

    expect(listener).toHaveBeenCalledOnce()
    expect((listener.mock.calls[0][0] as CustomEvent<TabDocFindRequestDetail>).detail).toEqual({
      documentId: 'doc-1',
    })
    window.removeEventListener(TABDOC_FIND_REQUEST_EVENT, listener)
  })
})
