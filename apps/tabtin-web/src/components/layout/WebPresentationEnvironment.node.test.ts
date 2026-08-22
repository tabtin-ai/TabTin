import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isPhoneWebPresentation,
  isTabletWebPresentation,
  parseMobileHostContext,
  resolveWebInput,
  resolveWebLayout,
  resolveWebOrientation,
  resolveWebPresentationEnvironment,
} from './WebPresentationEnvironment.ts'

const VALID_MOBILE_HOST = {
  version: 1,
  platform: 'ios',
  formFactor: 'tablet',
  capabilities: {
    filePicker: true,
    nativeFocus: true,
    fullEditor: false,
  },
} as const

test('layout uses compact, medium and expanded width bands at stable boundaries', () => {
  assert.equal(resolveWebLayout(0), 'compact')
  assert.equal(resolveWebLayout(599), 'compact')
  assert.equal(resolveWebLayout(600), 'medium')
  assert.equal(resolveWebLayout(1023), 'medium')
  assert.equal(resolveWebLayout(1024), 'expanded')
})

test('layout falls back to expanded when no usable browser width is available', () => {
  assert.equal(resolveWebLayout(undefined), 'expanded')
  assert.equal(resolveWebLayout(Number.NaN), 'expanded')
  assert.equal(resolveWebLayout(-1), 'expanded')
})

test('input distinguishes touch, pointer and hybrid devices', () => {
  assert.equal(
    resolveWebInput({ maxTouchPoints: 5, coarsePointer: true, finePointer: false }),
    'touch',
  )
  assert.equal(
    resolveWebInput({ maxTouchPoints: 0, coarsePointer: false, finePointer: true }),
    'pointer',
  )
  assert.equal(
    resolveWebInput({ maxTouchPoints: 5, coarsePointer: true, finePointer: true }),
    'hybrid',
  )
})

test('orientation follows the actual viewport axes instead of a width breakpoint', () => {
  assert.equal(resolveWebOrientation(1024, 1366), 'portrait')
  assert.equal(resolveWebOrientation(1366, 1024), 'landscape')
  assert.equal(resolveWebOrientation(undefined, 1024), 'unknown')
})

test('host context parser accepts the complete version 1 contract', () => {
  assert.deepEqual(parseMobileHostContext(VALID_MOBILE_HOST), VALID_MOBILE_HOST)
})

test('host context parser safely ignores unknown or incomplete values', () => {
  assert.equal(parseMobileHostContext(null), null)
  assert.equal(parseMobileHostContext({ ...VALID_MOBILE_HOST, version: 2 }), null)
  assert.equal(parseMobileHostContext({ ...VALID_MOBILE_HOST, platform: 'web' }), null)
  assert.equal(
    parseMobileHostContext({
      ...VALID_MOBILE_HOST,
      capabilities: { filePicker: true, nativeFocus: true },
    }),
    null,
  )
})

test('environment projection combines browser signals with an optional native host', () => {
  assert.deepEqual(
    resolveWebPresentationEnvironment({
      viewportWidth: 834,
      viewportHeight: 1194,
      maxTouchPoints: 5,
      coarsePointer: true,
      finePointer: true,
      mobileHost: VALID_MOBILE_HOST,
    }),
    {
      layout: 'medium',
      input: 'hybrid',
      orientation: 'portrait',
      mobileHost: VALID_MOBILE_HOST,
    },
  )
})

test('browser responsive mode can reproduce a touch tablet without native host injection', () => {
  assert.deepEqual(
    resolveWebPresentationEnvironment({
      viewportWidth: 834,
      viewportHeight: 1194,
      maxTouchPoints: 1,
      coarsePointer: true,
      finePointer: false,
    }),
    {
      layout: 'medium',
      input: 'touch',
      orientation: 'portrait',
      mobileHost: null,
    },
  )
})

test('layout width, input hardware and native form factor stay independent', () => {
  assert.deepEqual(
    resolveWebPresentationEnvironment({
      viewportWidth: 1024,
      viewportHeight: 1366,
      maxTouchPoints: 5,
      coarsePointer: true,
      finePointer: true,
      mobileHost: VALID_MOBILE_HOST,
    }),
    {
      layout: 'expanded',
      input: 'hybrid',
      orientation: 'portrait',
      mobileHost: VALID_MOBILE_HOST,
    },
  )

  assert.deepEqual(
    resolveWebPresentationEnvironment({
      viewportWidth: 834,
      viewportHeight: 1112,
      maxTouchPoints: 0,
      coarsePointer: false,
      finePointer: true,
    }),
    {
      layout: 'medium',
      input: 'pointer',
      orientation: 'portrait',
      mobileHost: null,
    },
  )
})

test('native phone identity preserves phone interactions after landscape rotation', () => {
  assert.equal(isPhoneWebPresentation({ layout: 'compact', mobileHost: null }), true)
  assert.equal(isPhoneWebPresentation({
    layout: 'medium',
    mobileHost: { ...VALID_MOBILE_HOST, formFactor: 'phone' },
  }), true)
  assert.equal(isPhoneWebPresentation({
    layout: 'medium',
    mobileHost: VALID_MOBILE_HOST,
  }), false)
})

test('native host form factor is authoritative for tablet presentation', () => {
  assert.equal(isTabletWebPresentation({
    layout: 'expanded',
    input: 'touch',
    mobileHost: { ...VALID_MOBILE_HOST, formFactor: 'phone' },
  }), false)
  assert.equal(isTabletWebPresentation({
    layout: 'compact',
    input: 'touch',
    mobileHost: VALID_MOBILE_HOST,
  }), true)
})

test('browser device emulation recognizes non-compact pure-touch tablets', () => {
  assert.equal(isTabletWebPresentation({
    layout: resolveWebLayout(834),
    input: 'touch',
    mobileHost: null,
  }), true)
  assert.equal(isTabletWebPresentation({
    layout: resolveWebLayout(1024),
    input: 'touch',
    mobileHost: null,
  }), true)
})

test('desktop pointer and hybrid presentations are not inferred as tablets', () => {
  assert.equal(isTabletWebPresentation({
    layout: 'medium',
    input: 'pointer',
    mobileHost: null,
  }), false)
  assert.equal(isTabletWebPresentation({
    layout: 'expanded',
    input: 'hybrid',
    mobileHost: null,
  }), false)
})

test('invalid native host data never contaminates the browser presentation snapshot', () => {
  assert.deepEqual(
    resolveWebPresentationEnvironment({
      viewportWidth: 390,
      viewportHeight: 844,
      maxTouchPoints: 5,
      coarsePointer: true,
      finePointer: false,
      mobileHost: { version: 1, platform: 'android' },
    }),
    {
      layout: 'compact',
      input: 'touch',
      orientation: 'portrait',
      mobileHost: null,
    },
  )
})
