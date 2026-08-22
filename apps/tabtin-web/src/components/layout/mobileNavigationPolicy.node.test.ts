import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldUseMobileNavigation } from './mobileNavigationPolicy.ts'

test('full web phone uses the collapsible mobile navigation', () => {
  assert.equal(shouldUseMobileNavigation({
    isEmbedded: false,
    layout: 'compact',
    input: 'touch',
    mobileHost: null,
  }), true)
})

test('embedded resources do not add a second navigation shell', () => {
  assert.equal(shouldUseMobileNavigation({
    isEmbedded: true,
    layout: 'compact',
    input: 'touch',
    mobileHost: null,
  }), false)
})

test('portrait tablets collapse navigation while landscape tablets keep the sidebar', () => {
  assert.equal(shouldUseMobileNavigation({
    isEmbedded: false,
    layout: 'medium',
    input: 'touch',
    mobileHost: {
      version: 1,
      platform: 'android',
      formFactor: 'tablet',
      capabilities: { filePicker: true, nativeFocus: true, fullEditor: true },
    },
  }), true)
  assert.equal(shouldUseMobileNavigation({
    isEmbedded: false,
    layout: 'expanded',
    input: 'touch',
    mobileHost: {
      version: 1,
      platform: 'ios',
      formFactor: 'tablet',
      capabilities: { filePicker: true, nativeFocus: true, fullEditor: true },
    },
  }), false)
})

test('a medium pointer window keeps desktop navigation', () => {
  assert.equal(shouldUseMobileNavigation({
    isEmbedded: false,
    layout: 'medium',
    input: 'pointer',
    mobileHost: null,
  }), false)
})

test('native phone keeps collapsible navigation in landscape', () => {
  assert.equal(shouldUseMobileNavigation({
    isEmbedded: false,
    layout: 'medium',
    input: 'touch',
    mobileHost: {
      version: 1,
      platform: 'ios',
      formFactor: 'phone',
      capabilities: { filePicker: true, nativeFocus: true, fullEditor: true },
    },
  }), true)
})
