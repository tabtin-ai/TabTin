import { describe, expect, it } from 'vitest'
import { resolveTablePaneLoadFailure } from './tablePaneLoadFailure'

describe('TabData initial permission denial', () => {
  it('authoritative per-table 403 does not depend on the fetchFailed timing latch', () => {
    expect(resolveTablePaneLoadFailure({
      fetchFailed: false,
      hasDisplayTable: false,
      errorCode: 'PERMISSION_DENIED',
      errorStatus: 403,
    })).toBe('permission_denied')
  })

  it('403 outranks a stale cached table and routes to the permission overlay', () => {
    expect(resolveTablePaneLoadFailure({
      fetchFailed: true,
      hasDisplayTable: true,
      errorCode: null,
      errorStatus: 403,
    })).toBe('permission_denied')
  })

  it('keeps a cached table available for a generic refresh failure', () => {
    expect(resolveTablePaneLoadFailure({
      fetchFailed: true,
      hasDisplayTable: true,
      errorCode: null,
      errorStatus: 503,
    })).toBeNull()
  })

  it('distinguishes embedded access verification failure from permission denial', () => {
    expect(resolveTablePaneLoadFailure({
      fetchFailed: true,
      hasDisplayTable: false,
      errorCode: 'EMBEDDED_ACCESS_UNAVAILABLE',
      errorStatus: 403,
    })).toBe('access_verification_unavailable')
  })

  it('routes a missing resource to a return-only unavailable state', () => {
    expect(resolveTablePaneLoadFailure({
      fetchFailed: true,
      hasDisplayTable: true,
      errorCode: 'RESOURCE_NOT_FOUND',
      errorStatus: 404,
    })).toBe('resource_unavailable')
  })
})
