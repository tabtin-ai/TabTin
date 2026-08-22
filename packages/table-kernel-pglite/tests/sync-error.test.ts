import { describe, it, expect } from 'vitest'
import { isRetryableSyncError, toSyncErrorMessage } from '../src/sync-error.js'

describe('isRetryableSyncError', () => {
  it('treats network errors (no status) as retryable', () => {
    expect(isRetryableSyncError(new Error('fetch failed'))).toBe(true)
  })

  it('treats 5xx as retryable via status property', () => {
    expect(isRetryableSyncError({ status: 500, message: 'Internal Server Error' })).toBe(true)
    expect(isRetryableSyncError({ status: 502 })).toBe(true)
    expect(isRetryableSyncError({ status: 503 })).toBe(true)
  })

  it('treats 429 (Too Many Requests) as retryable', () => {
    expect(isRetryableSyncError({ status: 429 })).toBe(true)
  })

  it('treats 4xx (except 429) as NOT retryable', () => {
    expect(isRetryableSyncError({ status: 400 })).toBe(false)
    expect(isRetryableSyncError({ status: 401 })).toBe(false)
    expect(isRetryableSyncError({ status: 403 })).toBe(false)
    expect(isRetryableSyncError({ status: 404 })).toBe(false)
    expect(isRetryableSyncError({ status: 422 })).toBe(false)
  })

  it('parses status from Error message "API NNN ..."', () => {
    expect(isRetryableSyncError(new Error('API 500 Internal Server Error'))).toBe(true)
    expect(isRetryableSyncError(new Error('API 404 Not Found'))).toBe(false)
    expect(isRetryableSyncError(new Error('API 429 Too Many Requests'))).toBe(true)
  })

  it('treats non-Error non-object values as retryable', () => {
    expect(isRetryableSyncError('something')).toBe(true)
    expect(isRetryableSyncError(null)).toBe(true)
    expect(isRetryableSyncError(undefined)).toBe(true)
  })
})

describe('toSyncErrorMessage', () => {
  it('extracts message from Error instances', () => {
    expect(toSyncErrorMessage(new Error('network timeout'))).toBe('network timeout')
  })

  it('stringifies non-Error values', () => {
    expect(toSyncErrorMessage('raw string')).toBe('raw string')
    expect(toSyncErrorMessage(42)).toBe('42')
    expect(toSyncErrorMessage(null)).toBe('null')
  })
})
