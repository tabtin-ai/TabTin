import { describe, expect, it } from 'vitest'
import { displayFromRunStatus, isSuccessfulRunStatus } from './trackerRunStatus'

describe('displayFromRunStatus', () => {
  it('maps completed and success to success', () => {
    expect(displayFromRunStatus('completed')).toBe('success')
    expect(displayFromRunStatus('success')).toBe('success')
    expect(isSuccessfulRunStatus('completed')).toBe(true)
  })

  it('maps in-progress variants to running', () => {
    expect(displayFromRunStatus('running')).toBe('running')
    expect(displayFromRunStatus('in_progress')).toBe('running')
    expect(displayFromRunStatus('waiting_device')).toBe('running')
  })

  it('maps failure and cancel variants', () => {
    expect(displayFromRunStatus('failed')).toBe('failed')
    expect(displayFromRunStatus('error')).toBe('failed')
    expect(displayFromRunStatus('cancelled')).toBe('cancelled')
    expect(displayFromRunStatus('canceled')).toBe('cancelled')
  })

  it('falls back to pending', () => {
    expect(displayFromRunStatus('pending')).toBe('pending')
    expect(displayFromRunStatus(undefined)).toBe('pending')
    expect(displayFromRunStatus('')).toBe('pending')
  })
})
