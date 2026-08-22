import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolveMobileDocAccess,
  resolveMobileEditorAvailableHeight,
} from './mobileDocPresentation'

test('compact documents open in reading mode until an editor explicitly starts editing', () => {
  assert.deepEqual(resolveMobileDocAccess({
    compact: true,
    canEdit: true,
    requestedMode: 'reading',
  }), {
    mode: 'reading',
    readOnly: true,
    canEnterEditMode: true,
  })

  assert.deepEqual(resolveMobileDocAccess({
    compact: true,
    canEdit: true,
    requestedMode: 'editing',
  }), {
    mode: 'editing',
    readOnly: false,
    canEnterEditMode: true,
  })
})

test('desktop documents keep their existing editing behavior and viewers remain read-only', () => {
  assert.equal(resolveMobileDocAccess({
    compact: false,
    canEdit: true,
    requestedMode: 'reading',
  }).readOnly, false)

  assert.deepEqual(resolveMobileDocAccess({
    compact: true,
    canEdit: false,
    requestedMode: 'editing',
  }), {
    mode: 'reading',
    readOnly: true,
    canEnterEditMode: false,
  })
})

test('tablet documents keep direct editing while preserving viewer permissions', () => {
  assert.deepEqual(resolveMobileDocAccess({
    compact: false,
    canEdit: true,
    requestedMode: 'reading',
  }), {
    mode: 'editing',
    readOnly: false,
    canEnterEditMode: true,
  })

  assert.deepEqual(resolveMobileDocAccess({
    compact: false,
    canEdit: false,
    requestedMode: 'editing',
  }), {
    mode: 'reading',
    readOnly: true,
    canEnterEditMode: false,
  })
})

test('mobile editor height stops above the on-screen keyboard', () => {
  assert.equal(resolveMobileEditorAvailableHeight({
    viewportOffsetTop: 0,
    viewportHeight: 460,
    containerTop: 72,
  }), 388)

  assert.equal(resolveMobileEditorAvailableHeight({
    viewportOffsetTop: 24,
    viewportHeight: 720,
    containerTop: 80,
  }), 664)

  assert.equal(resolveMobileEditorAvailableHeight({
    viewportOffsetTop: 0,
    viewportHeight: 0,
    containerTop: 80,
  }), null)
})
