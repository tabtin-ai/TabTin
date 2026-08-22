import { describe, expect, it } from 'vitest'

import { shouldAutoExpandActiveGroup } from './sidebar-collapse-state'

describe('侧栏父级收起状态 ', () => {
  it('只在路由切换到另一个父级时自动展开', () => {
    expect(shouldAutoExpandActiveGroup(undefined, 'system-monitoring')).toBe(true)
    expect(shouldAutoExpandActiveGroup('agent-config', 'system-monitoring')).toBe(true)
  })

  it('用户收起当前激活父级后不被立即反向展开', () => {
    expect(shouldAutoExpandActiveGroup('system-monitoring', 'system-monitoring')).toBe(false)
  })
})
