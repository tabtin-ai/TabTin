import { describe, expect, it } from 'vitest'
import { depthForNewItem } from '../depthForNewItem'

describe('depthForNewItem', () => {
  const root = '/workspace/proj'

  it('sandbox root parent aligns with startDepth 0', () => {
    expect(depthForNewItem(root, root, true)).toBe(0)
    expect(depthForNewItem(`${root}/src`, root, true)).toBe(1)
  })

  it('workspace root parent aligns with startDepth 1', () => {
    expect(depthForNewItem(root, root, false)).toBe(1)
    expect(depthForNewItem(`${root}/src`, root, false)).toBe(2)
  })
})
