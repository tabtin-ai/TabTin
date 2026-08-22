import { describe, expect, it } from 'vitest'
import {
  COMMENT_RAIL_BREAKPOINT_PX,
  COMMENT_RAIL_WIDTH_PX,
  resolveCommentRailLayout,
  shouldCollapseOutlineForComments,
} from './layout'

describe('resolveCommentRailLayout', () => {
  it('宽度 ≥1180 为右栏，否则抽屉', () => {
    expect(resolveCommentRailLayout(COMMENT_RAIL_BREAKPOINT_PX)).toBe('rail')
    expect(resolveCommentRailLayout(COMMENT_RAIL_BREAKPOINT_PX + 1)).toBe('rail')
    expect(resolveCommentRailLayout(COMMENT_RAIL_BREAKPOINT_PX - 1)).toBe('drawer')
    expect(COMMENT_RAIL_WIDTH_PX).toBe(360)
  })
})

describe('shouldCollapseOutlineForComments', () => {
  it('仅右栏打开时建议收起大纲', () => {
    expect(shouldCollapseOutlineForComments({ open: true, layout: 'rail' })).toBe(true)
    expect(shouldCollapseOutlineForComments({ open: false, layout: 'rail' })).toBe(false)
    expect(shouldCollapseOutlineForComments({ open: true, layout: 'drawer' })).toBe(false)
  })
})
