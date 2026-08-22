import { describe, expect, it } from 'vitest'
import { filterOpenTabsForBoundCodeRoot } from './filterOpenTabsForCodeRoot'

describe('filterOpenTabsForBoundCodeRoot', () => {
  it('未绑定根时原样返回（不过滤）', () => {
    const tabs = [
      { type: 'tabcode', id: 'aGVsbG8=', path: '/repo/other' },
      { type: 'tabdoc', id: 'doc-1' },
    ]
    expect(filterOpenTabsForBoundCodeRoot(tabs, null)).toBe(tabs)
    expect(filterOpenTabsForBoundCodeRoot(tabs, '')).toBe(tabs)
  })

  it('非 TabCode 的 tab 始终保留', () => {
    const tabs = [
      { type: 'tabdoc', id: 'doc-1' },
      { type: 'tabweb', id: 'https://example.com' },
    ]
    expect(filterOpenTabsForBoundCodeRoot(tabs, '/repo/bound')).toEqual(tabs)
  })

  it('非 active TabCode tab：按 path（项目根）匹配绑定根', () => {
    const tabs = [
      { type: 'tabcode', id: 'aGVsbG8=', path: '/repo/bound' },
      { type: 'tabcode', id: 'b3RoZXI=', path: '/repo/other-checkout' },
    ]
    expect(filterOpenTabsForBoundCodeRoot(tabs, '/repo/bound')).toEqual([
      { type: 'tabcode', id: 'aGVsbG8=', path: '/repo/bound' },
    ])
  })

  it('active + focusedSurface TabCode tab：id 是真实根路径，path 可能是聚焦文件', () => {
    const tabs = [
      { type: 'tabcode', id: '/repo/bound', path: '/repo/bound/src/index.ts' },
      { type: 'tabcode', id: '/repo/other-checkout', path: '/repo/other-checkout/src/index.ts' },
    ]
    expect(filterOpenTabsForBoundCodeRoot(tabs, '/repo/bound')).toEqual([
      { type: 'tabcode', id: '/repo/bound', path: '/repo/bound/src/index.ts' },
    ])
  })

  it('绑定根本身作为 tab（无聚焦文件）：id 与 path 均等于根，保留', () => {
    const tabs = [{ type: 'tabcode', id: '/repo/bound', path: '/repo/bound' }]
    expect(filterOpenTabsForBoundCodeRoot(tabs, '/repo/bound')).toEqual(tabs)
  })

  it('尾部斜杠 / 反斜杠差异不影响匹配', () => {
    const tabs = [{ type: 'tabcode', id: '/repo/bound', path: '/repo/bound' }]
    expect(filterOpenTabsForBoundCodeRoot(tabs, '/repo/bound/')).toEqual(tabs)
  })

  it('空数组直接返回', () => {
    expect(filterOpenTabsForBoundCodeRoot([], '/repo/bound')).toEqual([])
  })
})
