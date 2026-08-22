import assert from 'node:assert/strict'
import test from 'node:test'
import {
  resolveTableRecordSurfacePolicy,
  resolveTableRecordSurfacePreference,
  selectTableRecordSurface,
} from './tableRecordSurfacePolicy.ts'

test('phone grid views default to cards and keep an explicit grid choice', () => {
  assert.deepEqual(resolveTableRecordSurfacePolicy({
    isGridView: true,
    isPhonePresentation: true,
    isTabletPresentation: false,
    layout: 'compact',
    orientation: 'portrait',
    preference: null,
  }), { surface: 'cards', showSwitcher: true })

  assert.deepEqual(resolveTableRecordSurfacePolicy({
    isGridView: true,
    isPhonePresentation: true,
    isTabletPresentation: false,
    layout: 'compact',
    orientation: 'portrait',
    preference: 'grid',
  }), { surface: 'grid', showSwitcher: true })
})

test('tablet portrait defaults to cards while tablet landscape defaults to grid', () => {
  assert.deepEqual(resolveTableRecordSurfacePolicy({
    isGridView: true,
    isPhonePresentation: false,
    isTabletPresentation: true,
    layout: 'medium',
    orientation: 'portrait',
    preference: null,
  }), { surface: 'cards', showSwitcher: true })

  assert.deepEqual(resolveTableRecordSurfacePolicy({
    isGridView: true,
    isPhonePresentation: false,
    isTabletPresentation: true,
    layout: 'expanded',
    orientation: 'landscape',
    preference: null,
  }), { surface: 'grid', showSwitcher: true })
})

test('tablet choice overrides the default inside its current layout', () => {
  assert.equal(resolveTableRecordSurfacePolicy({
    isGridView: true,
    isPhonePresentation: false,
    isTabletPresentation: true,
    layout: 'medium',
    orientation: 'portrait',
    preference: 'grid',
  }).surface, 'grid')

  assert.equal(resolveTableRecordSurfacePolicy({
    isGridView: true,
    isPhonePresentation: false,
    isTabletPresentation: true,
    layout: 'expanded',
    orientation: 'landscape',
    preference: 'cards',
  }).surface, 'cards')
})

test('a pointer-only narrow desktop stays on the grid without a switcher', () => {
  assert.deepEqual(resolveTableRecordSurfacePolicy({
    isGridView: true,
    isPhonePresentation: false,
    isTabletPresentation: false,
    layout: 'medium',
    orientation: 'portrait',
    preference: null,
  }), { surface: 'grid', showSwitcher: false })
})

test('non-grid views never expose the record surface switcher', () => {
  assert.deepEqual(resolveTableRecordSurfacePolicy({
    isGridView: false,
    isPhonePresentation: false,
    isTabletPresentation: true,
    layout: 'medium',
    orientation: 'portrait',
    preference: 'cards',
  }), { surface: 'grid', showSwitcher: false })
})

test('large tablets still use cards in portrait at expanded widths', () => {
  assert.deepEqual(resolveTableRecordSurfacePolicy({
    isGridView: true,
    isPhonePresentation: false,
    isTabletPresentation: true,
    layout: 'expanded',
    orientation: 'portrait',
    preference: null,
  }), { surface: 'cards', showSwitcher: true })
})

test('surface choice is stable per layout and resets when the view changes', () => {
  const portraitSelection = selectTableRecordSurface(null, 'view-a', 'medium', 'grid')
  const landscapeSelection = selectTableRecordSurface(
    portraitSelection,
    'view-a',
    'expanded',
    'cards',
  )

  assert.equal(resolveTableRecordSurfacePreference(landscapeSelection, 'view-a', 'medium'), 'grid')
  assert.equal(resolveTableRecordSurfacePreference(landscapeSelection, 'view-a', 'expanded'), 'cards')
  assert.equal(resolveTableRecordSurfacePreference(landscapeSelection, 'view-b', 'medium'), null)

  const nextViewSelection = selectTableRecordSurface(
    landscapeSelection,
    'view-b',
    'medium',
    'cards',
  )
  assert.equal(resolveTableRecordSurfacePreference(nextViewSelection, 'view-a', 'medium'), null)
})
