/**
 * split-layout.ts 纯函数单元测试
 *
 * 覆盖：
 *  - buildSizes / normalizeSizes
 *  - findLeafPath / getNodeAtPath / updateNodeAtPath
 *  - insertLeafAtPath (同方向合并 & 跨方向嵌套)
 *  - removeLeafFromTree (剪枝 & 提升)
 *  - collectLeafIds / sideToDirection
 */

import { describe, it, expect } from 'vitest'
import {
  type LayoutNode,
  buildSizes,
  normalizeSizes,
  findLeafPath,
  getNodeAtPath,
  updateNodeAtPath,
  insertLeafAtPath,
  removeLeafFromTree,
  collectLeafIds,
  sideToDirection,
  createSplitId,
} from '@/utils/split-layout'

// ─── helpers ───

const leaf = (id: string): LayoutNode => ({ type: 'leaf', paneId: id })

const hSplit = (children: LayoutNode[], sizes?: number[]): LayoutNode => ({
  type: 'split',
  id: 'hs',
  direction: 'horizontal',
  children,
  sizes: sizes ?? buildSizes(children.length),
})

const vSplit = (children: LayoutNode[], sizes?: number[]): LayoutNode => ({
  type: 'split',
  id: 'vs',
  direction: 'vertical',
  children,
  sizes: sizes ?? buildSizes(children.length),
})

// ─── buildSizes ───

describe('buildSizes', () => {
  it('returns empty for count 0', () => {
    expect(buildSizes(0)).toEqual([])
  })

  it('returns equal ratios', () => {
    expect(buildSizes(3)).toEqual([1 / 3, 1 / 3, 1 / 3])
  })

  it('sums to 1', () => {
    const s = buildSizes(5)
    expect(s.reduce((a, b) => a + b, 0)).toBeCloseTo(1)
  })
})

// ─── normalizeSizes ───

describe('normalizeSizes', () => {
  it('normalizes proportionally', () => {
    const result = normalizeSizes([2, 3], 2)
    expect(result[0]).toBeCloseTo(0.4)
    expect(result[1]).toBeCloseTo(0.6)
  })

  it('falls back to equal when sizes have wrong length', () => {
    expect(normalizeSizes([1], 3)).toEqual(buildSizes(3))
  })

  it('falls back when any size is <= 0', () => {
    expect(normalizeSizes([0.5, -0.1], 2)).toEqual(buildSizes(2))
  })

  it('falls back when sum is 0', () => {
    expect(normalizeSizes([0, 0], 2)).toEqual(buildSizes(2))
  })

  it('returns empty for count 0', () => {
    expect(normalizeSizes([1, 2], 0)).toEqual([])
  })
})

// ─── findLeafPath ───

describe('findLeafPath', () => {
  it('returns [] for matching root leaf', () => {
    expect(findLeafPath(leaf('a'), 'a')).toEqual([])
  })

  it('returns null for non-matching root leaf', () => {
    expect(findLeafPath(leaf('a'), 'b')).toBeNull()
  })

  it('finds nested leaf', () => {
    const tree = hSplit([leaf('a'), vSplit([leaf('b'), leaf('c')])])
    expect(findLeafPath(tree, 'c')).toEqual([1, 1])
  })

  it('returns null for missing leaf in tree', () => {
    const tree = hSplit([leaf('a'), leaf('b')])
    expect(findLeafPath(tree, 'z')).toBeNull()
  })
})

// ─── getNodeAtPath ───

describe('getNodeAtPath', () => {
  const tree = hSplit([leaf('a'), vSplit([leaf('b'), leaf('c')])])

  it('returns root at empty path', () => {
    expect(getNodeAtPath(tree, [])).toBe(tree)
  })

  it('returns child at [0]', () => {
    expect(getNodeAtPath(tree, [0])).toEqual(leaf('a'))
  })

  it('returns deep child at [1, 1]', () => {
    expect(getNodeAtPath(tree, [1, 1])).toEqual(leaf('c'))
  })

  it('returns null for invalid path', () => {
    expect(getNodeAtPath(tree, [5])).toBeNull()
  })

  it('returns null for path through leaf', () => {
    expect(getNodeAtPath(leaf('x'), [0])).toBeNull()
  })
})

// ─── updateNodeAtPath ───

describe('updateNodeAtPath', () => {
  it('replaces root', () => {
    const result = updateNodeAtPath(leaf('a'), [], () => leaf('z'))
    expect(result).toEqual(leaf('z'))
  })

  it('replaces nested child immutably', () => {
    const tree = hSplit([leaf('a'), leaf('b')])
    const result = updateNodeAtPath(tree, [1], () => leaf('c'))

    expect(result.type).toBe('split')
    if (result.type === 'split') {
      expect(result.children[0]).toEqual(leaf('a'))
      expect(result.children[1]).toEqual(leaf('c'))
    }
    // original untouched
    if (tree.type === 'split') {
      expect(tree.children[1]).toEqual(leaf('b'))
    }
  })

  it('returns same reference if updater returns same node', () => {
    const tree = hSplit([leaf('a'), leaf('b')])
    const result = updateNodeAtPath(tree, [0], n => n)
    expect(result).toBe(tree)
  })
})

// ─── insertLeafAtPath ───

describe('insertLeafAtPath', () => {
  describe('root leaf → becomes split', () => {
    it('inserts right', () => {
      const result = insertLeafAtPath(leaf('a'), [], 'b', 'horizontal', 'right')
      expect(result.type).toBe('split')
      if (result.type === 'split') {
        expect(result.direction).toBe('horizontal')
        expect(result.children).toHaveLength(2)
        expect(result.children[0]).toEqual(leaf('a'))
        expect(result.children[1]).toEqual(leaf('b'))
      }
    })

    it('inserts left', () => {
      const result = insertLeafAtPath(leaf('a'), [], 'b', 'horizontal', 'left')
      expect(result.type).toBe('split')
      if (result.type === 'split') {
        expect(result.children[0]).toEqual(leaf('b'))
        expect(result.children[1]).toEqual(leaf('a'))
      }
    })

    it('inserts top (vertical)', () => {
      const result = insertLeafAtPath(leaf('a'), [], 'b', 'vertical', 'top')
      expect(result.type).toBe('split')
      if (result.type === 'split') {
        expect(result.direction).toBe('vertical')
        expect(result.children[0]).toEqual(leaf('b'))
        expect(result.children[1]).toEqual(leaf('a'))
      }
    })
  })

  describe('same-direction merge', () => {
    it('adds to existing horizontal split', () => {
      const tree = hSplit([leaf('a'), leaf('b')])
      const result = insertLeafAtPath(tree, [1], 'c', 'horizontal', 'right')
      expect(result.type).toBe('split')
      if (result.type === 'split') {
        expect(result.children).toHaveLength(3)
        expect(result.children.map(c => c.type === 'leaf' ? c.paneId : null))
          .toEqual(['a', 'b', 'c'])
      }
    })

    it('inserts before in same-direction split', () => {
      const tree = hSplit([leaf('a'), leaf('b')])
      const result = insertLeafAtPath(tree, [0], 'c', 'horizontal', 'left')
      expect(result.type).toBe('split')
      if (result.type === 'split') {
        expect(result.children).toHaveLength(3)
        expect(result.children.map(c => c.type === 'leaf' ? c.paneId : null))
          .toEqual(['c', 'a', 'b'])
      }
    })
  })

  describe('cross-direction nesting', () => {
    it('creates nested split for different direction', () => {
      const tree = hSplit([leaf('a'), leaf('b')])
      const result = insertLeafAtPath(tree, [1], 'c', 'vertical', 'bottom')
      expect(result.type).toBe('split')
      if (result.type === 'split') {
        expect(result.children).toHaveLength(2)
        const nested = result.children[1]
        expect(nested.type).toBe('split')
        if (nested.type === 'split') {
          expect(nested.direction).toBe('vertical')
          expect(nested.children).toHaveLength(2)
          expect(nested.children[0]).toEqual(leaf('b'))
          expect(nested.children[1]).toEqual(leaf('c'))
        }
      }
    })
  })
})

// ─── removeLeafFromTree ───

describe('removeLeafFromTree', () => {
  it('returns self when removing non-existent leaf', () => {
    const tree = leaf('a')
    expect(removeLeafFromTree(tree, 'z')).toBe(tree)
  })

  it('returns self when pruning root leaf (last one)', () => {
    const tree = leaf('a')
    expect(removeLeafFromTree(tree, 'a')).toBe(tree)
  })

  it('collapses 2-child split to remaining leaf', () => {
    const tree = hSplit([leaf('a'), leaf('b')])
    const result = removeLeafFromTree(tree, 'a')
    expect(result).toEqual(leaf('b'))
  })

  it('shrinks 3-child split to 2-child split', () => {
    const tree = hSplit([leaf('a'), leaf('b'), leaf('c')])
    const result = removeLeafFromTree(tree, 'b')
    expect(result.type).toBe('split')
    if (result.type === 'split') {
      expect(result.children).toHaveLength(2)
      expect(collectLeafIds(result)).toEqual(['a', 'c'])
    }
  })

  it('handles deeply nested removal with collapse', () => {
    const tree = hSplit([
      leaf('a'),
      vSplit([leaf('b'), leaf('c')]),
    ])
    const result = removeLeafFromTree(tree, 'b')
    expect(result.type).toBe('split')
    if (result.type === 'split') {
      expect(result.children).toHaveLength(2)
      expect(result.children[0]).toEqual(leaf('a'))
      expect(result.children[1]).toEqual(leaf('c'))
    }
  })
})

// ─── collectLeafIds ───

describe('collectLeafIds', () => {
  it('single leaf', () => {
    expect(collectLeafIds(leaf('a'))).toEqual(['a'])
  })

  it('flat split', () => {
    expect(collectLeafIds(hSplit([leaf('a'), leaf('b')]))).toEqual(['a', 'b'])
  })

  it('nested tree', () => {
    const tree = hSplit([
      leaf('a'),
      vSplit([leaf('b'), leaf('c')]),
      leaf('d'),
    ])
    expect(collectLeafIds(tree)).toEqual(['a', 'b', 'c', 'd'])
  })
})

// ─── sideToDirection ───

describe('sideToDirection', () => {
  it('top → vertical', () => expect(sideToDirection('top')).toBe('vertical'))
  it('bottom → vertical', () => expect(sideToDirection('bottom')).toBe('vertical'))
  it('left → horizontal', () => expect(sideToDirection('left')).toBe('horizontal'))
  it('right → horizontal', () => expect(sideToDirection('right')).toBe('horizontal'))
})

// ─── createSplitId ───

describe('createSplitId', () => {
  it('starts with prefix', () => {
    expect(createSplitId('test')).toMatch(/^test-/)
  })

  it('generates unique ids', () => {
    const a = createSplitId('x')
    const b = createSplitId('x')
    expect(a).not.toBe(b)
  })
})
