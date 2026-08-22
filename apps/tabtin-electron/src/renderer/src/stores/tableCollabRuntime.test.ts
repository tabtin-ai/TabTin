import { describe, expect, it } from 'vitest'

import {
  isTableCollabDocumentRuntimeActive,
  shouldRefreshViewRecordsViaRest,
  shouldUseCollabViewRuntime,
} from './tableCollabRuntime'

describe('table collaboration document runtime', () => {
  it('does not use Y.Doc when an online table has fallen back to REST', () => {
    expect(
      isTableCollabDocumentRuntimeActive({
        isOnline: true,
        isFallback: true,
      }),
    ).toBe(false)
  })

  it('uses Y.Doc when the active document runtime owns the rendered view', () => {
    expect(
      shouldUseCollabViewRuntime({
        isDocumentRuntimeActive: true,
        targetViewId: 'collab-view',
        collabViews: [{ id: 'collab-view' }],
      }),
    ).toBe(true)
  })

  it('uses REST when Y.Doc does not own the rendered view', () => {
    expect(
      shouldUseCollabViewRuntime({
        isDocumentRuntimeActive: true,
        targetViewId: 'rest-view',
        collabViews: [{ id: 'another-view' }],
      }),
    ).toBe(false)
  })

  it('refreshes via REST when the document runtime is online but the target view is missing', () => {
    expect(
      shouldRefreshViewRecordsViaRest({
        isDocumentRuntimeActive: true,
        targetViewId: 'rest-view',
        collabViews: [{ id: 'another-view' }],
        isTruncated: false,
      }),
    ).toBe(true)
  })

  it('skips REST refresh only when Y.Doc owns the target view and the snapshot is complete', () => {
    expect(
      shouldRefreshViewRecordsViaRest({
        isDocumentRuntimeActive: true,
        targetViewId: 'collab-view',
        collabViews: [{ id: 'collab-view' }],
        isTruncated: false,
      }),
    ).toBe(false)

    expect(
      shouldRefreshViewRecordsViaRest({
        isDocumentRuntimeActive: true,
        targetViewId: 'collab-view',
        collabViews: [{ id: 'collab-view' }],
        isTruncated: true,
      }),
    ).toBe(true)
  })
})
