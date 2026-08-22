import assert from 'node:assert/strict'

import {
  isTableCollabDocumentRuntimeActive,
  shouldRefreshViewRecordsViaRest,
  shouldUseCollabViewRuntime,
} from '../../src/renderer/src/stores/tableCollabRuntime.ts'

const usesDocumentRuntime = isTableCollabDocumentRuntimeActive({
  isOnline: true,
  isFallback: true,
})

assert.equal(
  usesDocumentRuntime,
  false,
  'an online table using the REST fallback must not route row-height updates to Y.Doc',
)

console.log('PASS: REST fallback routes row-height persistence away from Y.Doc')

assert.equal(
  shouldUseCollabViewRuntime({
    isDocumentRuntimeActive: true,
    targetViewId: 'rest-view',
    collabViews: [{ id: 'another-view' }],
  }),
  false,
  'a REST-rendered view must not route row-height updates to Y.Doc',
)

assert.equal(
  shouldRefreshViewRecordsViaRest({
    isDocumentRuntimeActive: true,
    targetViewId: 'rest-view',
    collabViews: [{ id: 'another-view' }],
    isTruncated: false,
  }),
  true,
  'a view missing from Y.Doc must still refresh records via REST after save',
)

console.log('PASS: a view missing from Y.Doc keeps row-height persistence on REST')

assert.equal(
  shouldUseCollabViewRuntime({
    isDocumentRuntimeActive: true,
    targetViewId: 'collab-view',
    collabViews: [{ id: 'collab-view' }],
  }),
  true,
  'a Y.Doc-owned view must keep row-height updates on the collaboration runtime',
)

assert.equal(
  shouldRefreshViewRecordsViaRest({
    isDocumentRuntimeActive: true,
    targetViewId: 'collab-view',
    collabViews: [{ id: 'collab-view' }],
    isTruncated: false,
  }),
  false,
  'a complete Y.Doc-owned view must not refresh records via REST after save',
)

console.log('PASS: a Y.Doc-owned view keeps row-height persistence on collaboration')
