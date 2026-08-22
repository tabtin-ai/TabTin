import { describe, expect, it } from 'vitest'
import { classifyPageLoadError } from './page-load-error-kind'

describe('classifyPageLoadError', () => {
  it('maps DNS failures', () => {
    expect(classifyPageLoadError({ errorDescription: 'ERR_NAME_NOT_RESOLVED' })).toBe('dns')
    expect(classifyPageLoadError({ errorDescription: 'ERR_NAME_RESOLUTION_FAILED' })).toBe('dns')
    expect(classifyPageLoadError({ errorCode: -105 })).toBe('dns')
  })

  it('maps offline failures', () => {
    expect(classifyPageLoadError({ errorDescription: 'ERR_INTERNET_DISCONNECTED' })).toBe('offline')
    expect(classifyPageLoadError({ errorDescription: 'ERR_NETWORK_CHANGED' })).toBe('offline')
    expect(classifyPageLoadError({ errorDescription: 'ERR_NETWORK_ACCESS_DENIED' })).toBe('offline')
    expect(classifyPageLoadError({ errorDescription: 'ERR_ADDRESS_UNREACHABLE' })).toBe('offline')
  })

  it('maps connection failures', () => {
    for (const code of [
      'ERR_CONNECTION_REFUSED',
      'ERR_CONNECTION_RESET',
      'ERR_CONNECTION_CLOSED',
      'ERR_CONNECTION_TIMED_OUT',
      'ERR_CONNECTION_FAILED',
      'ERR_TIMED_OUT',
      'ERR_EMPTY_RESPONSE',
      'ERR_ADDRESS_INVALID',
      'ERR_CONNECTION_ABORTED',
    ]) {
      expect(classifyPageLoadError({ errorDescription: code })).toBe('connection')
    }
  })

  it('maps HTTP >=400 to server', () => {
    expect(classifyPageLoadError({ httpStatus: 404 })).toBe('server')
    expect(classifyPageLoadError({ httpStatus: 500 })).toBe('server')
    expect(classifyPageLoadError({ errorDescription: 'HTTP 404' })).toBe('server')
    expect(classifyPageLoadError({ errorDescription: 'HTTP 502' })).toBe('server')
  })

  it('falls back for cert/proxy/unknown and ignores aborted semantics at classifier layer', () => {
    expect(classifyPageLoadError({ errorDescription: 'ERR_CERT_AUTHORITY_INVALID' })).toBe('fallback')
    expect(classifyPageLoadError({ errorDescription: 'ERR_PROXY_CONNECTION_FAILED' })).toBe('fallback')
    expect(classifyPageLoadError({ errorDescription: 'ERR_ABORTED' })).toBe('fallback')
    expect(classifyPageLoadError({ errorDescription: 'Page failed to load' })).toBe('fallback')
    expect(classifyPageLoadError({})).toBe('fallback')
  })

  it('prefers httpStatus server over net description when both present', () => {
    expect(classifyPageLoadError({
      httpStatus: 503,
      errorDescription: 'ERR_CONNECTION_CLOSED',
    })).toBe('server')
  })
})
