import { describe, it, expect } from 'vitest'
import { DEFAULT_QUOTA } from '../RunSessionManager'

describe('DEFAULT_QUOTA', () => {
  it('maxTotalViews is 50', () => {
    expect(DEFAULT_QUOTA.maxTotalViews).toBe(50)
  })

  it('maxViewsPerRun stays 5', () => {
    expect(DEFAULT_QUOTA.maxViewsPerRun).toBe(5)
  })
})
