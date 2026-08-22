import { describe, expect, it } from 'vitest'
import { getIconOptimisticPatch } from './documentIconProperty'

describe('getIconOptimisticPatch', () => {
  it('returns null when icon is not in updates', () => {
    expect(getIconOptimisticPatch({ title: 'x' }, '📄')).toBeNull()
  })

  it('builds patch and rollback for icon updates', () => {
    expect(getIconOptimisticPatch({ icon: '🎯' }, '📄')).toEqual({
      patch: { icon: '🎯' },
      rollback: { icon: '📄' },
    })
  })

  it('normalizes missing current icon to empty rollback', () => {
    expect(getIconOptimisticPatch({ icon: '🎯' }, undefined)).toEqual({
      patch: { icon: '🎯' },
      rollback: { icon: '' },
    })
  })

  it('normalizes remove icon to empty string patch', () => {
    expect(getIconOptimisticPatch({ icon: '' }, '📄')).toEqual({
      patch: { icon: '' },
      rollback: { icon: '📄' },
    })
  })
})
