import { describe, expect, it } from 'vitest'
import {
  SIDEBAR_LAYOUT_MAX_WIDTH,
  clampSidebarLayoutWidth,
} from './sidebarLayoutConstants'

describe('sidebarLayoutConstants', () => {
  it('应用与对话侧栏可继续向右拖宽，并在 480px 封顶', () => {
    expect(SIDEBAR_LAYOUT_MAX_WIDTH).toBe(480)
    expect(clampSidebarLayoutWidth(420)).toBe(420)
    expect(clampSidebarLayoutWidth(999)).toBe(480)
  })
})
