import { describe, expect, it } from 'vitest'
import {
  isViewConfigMutationAllowed,
  isViewLocked,
  isViewLockToggleDisabled,
  isViewMutationMenuDisabled,
} from '../viewLock'

describe('isViewLocked', () => {
  it('normalizes persisted lock values', () => {
    expect(isViewLocked(true)).toBe(true)
    expect(isViewLocked(1)).toBe(true)
    expect(isViewLocked('1')).toBe(true)
    expect(isViewLocked('true')).toBe(true)

    expect(isViewLocked(false)).toBe(false)
    expect(isViewLocked(0)).toBe(false)
    expect(isViewLocked('0')).toBe(false)
    expect(isViewLocked('false')).toBe(false)
    expect(isViewLocked('')).toBe(false)
  })
})

describe('view context menu disable helpers', () => {
  it('view lock disables mutations but keeps unlock enabled', () => {
    expect(isViewMutationMenuDisabled(false, true)).toBe(true)
    expect(isViewLockToggleDisabled(false, false)).toBe(false)
  })

  it('table readonly disables unlock as well', () => {
    expect(isViewMutationMenuDisabled(true, true)).toBe(true)
    expect(isViewLockToggleDisabled(true, false)).toBe(true)
  })

  it('busy only disables lock toggle, not mutation policy itself', () => {
    expect(isViewLockToggleDisabled(false, true)).toBe(true)
    expect(isViewMutationMenuDisabled(false, false)).toBe(false)
  })
})

describe('isViewConfigMutationAllowed', () => {
  it('allows shared config writes when unlocked', () => {
    expect(isViewConfigMutationAllowed(false, false, false)).toBe(true)
  })

  it('blocks shared config writes when locked without personal view', () => {
    expect(isViewConfigMutationAllowed(false, true, false)).toBe(false)
  })

  it('allows personal-view local config when shared view is locked', () => {
    expect(isViewConfigMutationAllowed(false, true, true)).toBe(true)
  })

  it('table readonly always blocks config mutation', () => {
    expect(isViewConfigMutationAllowed(true, false, true)).toBe(false)
  })
})
