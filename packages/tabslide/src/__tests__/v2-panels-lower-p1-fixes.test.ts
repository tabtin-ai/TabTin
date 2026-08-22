/**
 * V2 panels-lower P1 fixes:
 * - D5-01: PROP_MAP 补全 skewX/skewY/rotateX/rotateY，静默丢弃改 warn
 * - D6-01: layer-reorder overlap 改用成员集合判断
 * - D6-02: layer-reorder no-op 修正非连续组语义
 * - D8-01: LaTeX 插入 await 前固定 targetPageIndex
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { computeLayerDropToIndex } from '../utils/layer-reorder'
import { buildLayerItems } from '../utils/layer-items'
import type { PPTElement } from '../types/slides'

const readSrc = (relativePath: string) =>
  fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf-8')

// ═══════════════════════════════════════════════════
// D6-01: layer-reorder 非连续组 overlap 精准判断
// ═══════════════════════════════════════════════════

describe('D6-01: computeLayerDropToIndex non-contiguous group overlap', () => {
  it('非连续组 span 内的非成员元素可作为 drop target', () => {
    // 10 个元素，组成员在 [2, 5, 7]，目标在 4（非成员）
    const result = computeLayerDropToIndex({
      drag: { start: 2, end: 7 },
      target: { start: 4, end: 4 },
      placement: 'before',
      totalCount: 10,
      dragMemberCount: 3,
      dragMemberIndices: new Set([2, 5, 7]),
    })
    expect(result).not.toBeNull()
  })

  it('非连续组成员索引处的 target 仍返回 null', () => {
    const result = computeLayerDropToIndex({
      drag: { start: 2, end: 7 },
      target: { start: 5, end: 5 },
      placement: 'before',
      totalCount: 10,
      dragMemberCount: 3,
      dragMemberIndices: new Set([2, 5, 7]),
    })
    expect(result).toBeNull()
  })

  it('连续组 span 内 target 仍返回 null（向后兼容）', () => {
    const result = computeLayerDropToIndex({
      drag: { start: 2, end: 4 },
      target: { start: 3, end: 3 },
      placement: 'before',
      totalCount: 10,
    })
    expect(result).toBeNull()
  })

  it('target 在组范围外正常计算插入位置', () => {
    const result = computeLayerDropToIndex({
      drag: { start: 2, end: 7 },
      target: { start: 9, end: 9 },
      placement: 'before',
      totalCount: 10,
      dragMemberCount: 3,
      dragMemberIndices: new Set([2, 5, 7]),
    })
    expect(result).not.toBeNull()
    expect(result).toBeGreaterThanOrEqual(0)
  })
})

// ═══════════════════════════════════════════════════
// D6-02: layer-reorder 非连续组 no-op 修正
// ═══════════════════════════════════════════════════

describe('D6-02: computeLayerDropToIndex non-contiguous no-op fix', () => {
  it('非连续组拖到 span 外不被误判为 no-op', () => {
    const result = computeLayerDropToIndex({
      drag: { start: 1, end: 5 },
      target: { start: 8, end: 8 },
      placement: 'before',
      totalCount: 10,
      dragMemberCount: 3,
      dragMemberIndices: new Set([1, 3, 5]),
    })
    expect(result).not.toBeNull()
  })

  it('非连续组压缩到原位置附近不是 no-op（压缩本身改变数组）', () => {
    const result = computeLayerDropToIndex({
      drag: { start: 1, end: 5 },
      target: { start: 0, end: 0 },
      placement: 'after',
      totalCount: 10,
      dragMemberCount: 3,
      dragMemberIndices: new Set([1, 3, 5]),
    })
    expect(result).not.toBeNull()
  })

  it('非连续组 {1,3,5} 拖到任何合法目标总是非 no-op', () => {
    const indices = new Set([1, 3, 5])
    for (const targetIdx of [0, 6, 7, 8, 9]) {
      const result = computeLayerDropToIndex({
        drag: { start: 1, end: 5 },
        target: { start: targetIdx, end: targetIdx },
        placement: 'before',
        totalCount: 10,
        dragMemberCount: 3,
        dragMemberIndices: indices,
      })
      expect(result).not.toBeNull()
    }
  })

  it('连续组 {2,3,4} 拖回原位是 no-op', () => {
    const result = computeLayerDropToIndex({
      drag: { start: 2, end: 4 },
      target: { start: 1, end: 1 },
      placement: 'before',
      totalCount: 8,
      dragMemberCount: 3,
      dragMemberIndices: new Set([2, 3, 4]),
    })
    expect(result).toBeNull()
  })

  it('连续组 {2,3,4} 拖到新位置非 no-op', () => {
    const result = computeLayerDropToIndex({
      drag: { start: 2, end: 4 },
      target: { start: 6, end: 6 },
      placement: 'before',
      totalCount: 8,
      dragMemberCount: 3,
      dragMemberIndices: new Set([2, 3, 4]),
    })
    expect(result).not.toBeNull()
  })
})

// ═══════════════════════════════════════════════════
// D6-01 补充: buildLayerItems 暴露 memberIndices
// ═══════════════════════════════════════════════════

describe('D6-01: buildLayerItems exposes memberIndices for groups', () => {
  function makeEl(id: string, groupId?: string): PPTElement {
    return {
      id, type: 'shape', x: 0, y: 0, width: 100, height: 100,
      rotate: 0, opacity: 1, locked: false,
      viewBox: [100, 100], path: 'M0 0', fill: '#000',
      ...(groupId ? { groupId } : {}),
    } as any
  }

  it('非连续组 memberIndices 正确反映成员在元素数组中的位置', () => {
    const elements: PPTElement[] = [
      makeEl('a'),
      makeEl('b', 'g1'),
      makeEl('c'),
      makeEl('d'),
      makeEl('e', 'g1'),
      makeEl('f'),
      makeEl('g', 'g1'),
    ]
    const items = buildLayerItems(elements)
    const groupItem = items.find(i => i.kind === 'group' && i.groupId === 'g1')
    expect(groupItem).toBeDefined()
    expect(groupItem!.memberIndices).toEqual([1, 4, 6])
  })

  it('单元素 item 没有 memberIndices', () => {
    const elements: PPTElement[] = [makeEl('a'), makeEl('b')]
    const items = buildLayerItems(elements)
    expect(items[0].memberIndices).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════
// D8-01: LaTeX 插入 await 前固定 targetPageIndex
// ═══════════════════════════════════════════════════

describe('D8-01: insertLatex captures targetPageIndex before await', () => {
  const src = readSrc('toolbar/InsertToolbar.tsx')

  it('insertLatex 在 await 前通过 getState() 获取 currentPageIndex', () => {
    const fnMatch = src.match(/const insertLatex[\s\S]*?(?=\n  const \w|\n  return\b)/)
    expect(fnMatch).not.toBeNull()
    const fnBody = fnMatch![0]

    const pageIdxPos = fnBody.indexOf('currentPageIndex')
    const awaitPos = fnBody.indexOf('await')
    expect(pageIdxPos).toBeGreaterThan(-1)
    expect(awaitPos).toBeGreaterThan(-1)
    expect(pageIdxPos).toBeLessThan(awaitPos)
  })

  it('addElement 调用传入 targetPageIndex', () => {
    expect(src).toMatch(/addElement\(el,\s*targetPageIndex\)/)
  })
})
