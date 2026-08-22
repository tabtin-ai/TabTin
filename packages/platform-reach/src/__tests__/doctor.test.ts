import { describe, expect, it } from 'vitest'
import { selectBackend, describeChoice, type PlatformProbe } from '../doctor'

function baseProbe(overrides: Partial<PlatformProbe> = {}): PlatformProbe {
  return {
    platform: 'xiaohongshu',
    adapterPresent: true,
    supportsRequestedVerb: true,
    runtimeAvailable: ['electron'],
    loggedIn: true,
    requiresLogin: true,
    proxyConfigured: false,
    ...overrides,
  }
}

describe('selectBackend', () => {
  it('unavailable when adapter missing', () => {
    const c = selectBackend(baseProbe({ adapterPresent: false }))
    expect(c.status).toBe('unavailable')
  })

  it('unavailable when verb unsupported', () => {
    const c = selectBackend(baseProbe({ supportsRequestedVerb: false }))
    expect(c.status).toBe('unavailable')
  })

  it('unavailable when no runtime is up', () => {
    const c = selectBackend(baseProbe({ runtimeAvailable: [] }))
    expect(c.status).toBe('unavailable')
  })

  it('prefers electron over daemon', () => {
    const c = selectBackend(baseProbe({ runtimeAvailable: ['daemon', 'electron'] }))
    expect(c.status).toBe('ready')
    if (c.status === 'ready') expect(c.runtime).toBe('electron')
  })

  it('falls back to daemon when electron absent', () => {
    const c = selectBackend(baseProbe({ runtimeAvailable: ['daemon'] }))
    expect(c.status).toBe('ready')
    if (c.status === 'ready') expect(c.runtime).toBe('daemon')
  })

  it('needs-login when login required but not logged in', () => {
    const c = selectBackend(baseProbe({ loggedIn: false, loginHint: 'go login' }))
    expect(c.status).toBe('needs-login')
    if (c.status === 'needs-login') expect(c.loginHint).toBe('go login')
  })

  it('ready anonymous when login not required (公开检索分流)', () => {
    const c = selectBackend(baseProbe({ requiresLogin: false, loggedIn: false }))
    expect(c.status).toBe('ready')
    if (c.status === 'ready') expect(c.authContext).toBe('anonymous')
  })

  it('ready logged-in when session present', () => {
    const c = selectBackend(baseProbe({ loggedIn: true }))
    expect(c.status).toBe('ready')
    if (c.status === 'ready') expect(c.authContext).toBe('logged-in')
  })

  it('describeChoice renders a one-liner', () => {
    const c = selectBackend(baseProbe())
    expect(describeChoice('xiaohongshu', 'search', c)).toContain('xiaohongshu')
  })
})
