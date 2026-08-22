import assert from 'node:assert/strict'
import test from 'node:test'
import { parseWebPresentation } from './WebRoutePresentation'

test('defaults normal browser routes to the full web shell', () => {
  assert.deepEqual(parseWebPresentation(''), {
    shell: 'full',
    client: 'browser',
    isEmbedded: false,
    hostTheme: null,
  })
})

test('recognizes an iOS embedded resource launch and its host theme', () => {
  assert.deepEqual(parseWebPresentation('?shell=embedded&client=ios&theme=dark'), {
    shell: 'embedded',
    client: 'ios',
    isEmbedded: true,
    hostTheme: 'dark',
  })
})

test('does not allow unknown query values to change the shell contract', () => {
  assert.deepEqual(parseWebPresentation('?shell=mobile&client=unknown'), {
    shell: 'full',
    client: 'browser',
    isEmbedded: false,
    hostTheme: null,
  })
})

test('ignores host theme outside embedded mode', () => {
  assert.deepEqual(parseWebPresentation('?theme=dark'), {
    shell: 'full',
    client: 'browser',
    isEmbedded: false,
    hostTheme: null,
  })
})
