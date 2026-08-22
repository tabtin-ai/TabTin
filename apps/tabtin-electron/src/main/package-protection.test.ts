import { describe, expect, it } from 'vitest'

import {
  resolveProtectedRuntimeProfile,
  shouldAllowBrowserDevTools,
  shouldAllowMainDevTools,
} from './package-protection'

describe('package-protection runtime policy', () => {
  it('resolves protected profiles from explicit runtime/build markers', () => {
    expect(resolveProtectedRuntimeProfile({ TABTIN_RUNTIME_PROFILE: 'preprod' })).toBe('preprod')
    expect(resolveProtectedRuntimeProfile({ TABTIN_BUILD_PROFILE: 'local' })).toBe('local')
    expect(resolveProtectedRuntimeProfile({ VITE_BUILD_PROFILE: 'production' })).toBe('production')
  })

  it('allows main DevTools in preprod packages but keeps production closed', () => {
    expect(shouldAllowMainDevTools({ isDev: false, env: { TABTIN_RUNTIME_PROFILE: 'preprod' } })).toBe(true)
    expect(shouldAllowMainDevTools({ isDev: false, env: { TABTIN_RUNTIME_PROFILE: 'production' } })).toBe(false)
  })

  it('allows main DevTools only for development/local or explicit override', () => {
    expect(shouldAllowMainDevTools({ isDev: true, env: { TABTIN_RUNTIME_PROFILE: 'production' } })).toBe(true)
    expect(shouldAllowMainDevTools({ isDev: false, env: { TABTIN_RUNTIME_PROFILE: 'local' } })).toBe(true)
    expect(shouldAllowMainDevTools({ isDev: false, env: { TABTIN_RUNTIME_PROFILE: 'production', TABTIN_ALLOW_MAIN_DEVTOOLS: '1' } })).toBe(true)
  })

  it('keeps Browser DevTools profile-gated and explicitly controllable', () => {
    expect(shouldAllowBrowserDevTools({ env: { TABTIN_RUNTIME_PROFILE: 'preprod' } })).toBe(false)
    expect(shouldAllowBrowserDevTools({ env: { TABTIN_RUNTIME_PROFILE: 'local' } })).toBe(true)
    expect(shouldAllowBrowserDevTools({ env: { TABTIN_RUNTIME_PROFILE: 'production', TABTIN_ALLOW_BROWSER_DEVTOOLS: '1' } })).toBe(true)
    expect(shouldAllowBrowserDevTools({ env: { TABTIN_RUNTIME_PROFILE: 'local', TABTIN_ALLOW_BROWSER_DEVTOOLS: '0' } })).toBe(false)
  })
})
