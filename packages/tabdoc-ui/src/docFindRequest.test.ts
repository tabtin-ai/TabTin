import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  requestTabDocFind,
  TABDOC_FIND_REQUEST_EVENT,
  type TabDocFindRequestDetail,
} from './docFindRequest'

describe('requestTabDocFind', () => {
  afterEach(() => vi.restoreAllMocks())

  it('dispatches a document-targeted find request', () => {
    const listener = vi.fn<(event: Event) => void>()
    window.addEventListener(TABDOC_FIND_REQUEST_EVENT, listener)

    requestTabDocFind('doc-1')

    expect(listener).toHaveBeenCalledOnce()
    expect((listener.mock.calls[0][0] as CustomEvent<TabDocFindRequestDetail>).detail).toEqual({
      documentId: 'doc-1',
    })
    window.removeEventListener(TABDOC_FIND_REQUEST_EVENT, listener)
  })

  it('ignores an empty document id', () => {
    const listener = vi.fn<(event: Event) => void>()
    window.addEventListener(TABDOC_FIND_REQUEST_EVENT, listener)

    requestTabDocFind('')

    expect(listener).not.toHaveBeenCalled()
    window.removeEventListener(TABDOC_FIND_REQUEST_EVENT, listener)
  })
})
