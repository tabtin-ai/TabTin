/**
 * T2 单元测试：resolveSwitchTabIndex 纯函数的边界行为
 */
import { describe, expect, it } from 'vitest'

import {
  CONTEXT_SPACE_NUMERIC_TAB_ACTIONS,
  getNumericTabAction,
  isContextSpaceSwitchTabAction,
  resolveSwitchTabIndex,
} from './context-space-shortcuts'

describe('resolveSwitchTabIndex', () => {
  it('switch-tab-N 返回 N-1（N=1..8）', () => {
    for (let n = 1; n <= 8; n += 1) {
      expect(resolveSwitchTabIndex(`switch-tab-${n}` as never, 10)).toBe(n - 1)
    }
  })

  it('switch-tab-last 返回 visibleCount - 1', () => {
    expect(resolveSwitchTabIndex('switch-tab-last', 5)).toBe(4)
    expect(resolveSwitchTabIndex('switch-tab-last', 1)).toBe(0)
    expect(resolveSwitchTabIndex('switch-tab-last', 20)).toBe(19)
  })

  it('switch-tab-N 越过 visibleCount 时返回 null（静默）', () => {
    expect(resolveSwitchTabIndex('switch-tab-5', 3)).toBe(null)
    expect(resolveSwitchTabIndex('switch-tab-8', 0)).toBe(null)
    expect(resolveSwitchTabIndex('switch-tab-2', 1)).toBe(null)
  })

  it('switch-tab-N 正好等于 visibleCount 时仍然越界返回 null', () => {
    // N=3 表示"第 3 个"（index=2），visibleCount=3 应返回 index=2，合法
    expect(resolveSwitchTabIndex('switch-tab-3', 3)).toBe(2)
    // N=4 表示"第 4 个"（index=3），visibleCount=3 越界
    expect(resolveSwitchTabIndex('switch-tab-4', 3)).toBe(null)
  })

  it('visibleCount 为 0 时所有 action 都返回 null', () => {
    expect(resolveSwitchTabIndex('switch-tab-1', 0)).toBe(null)
    expect(resolveSwitchTabIndex('switch-tab-last', 0)).toBe(null)
  })

  it('visibleCount 为 NaN / 负数 / 浮点等异常值时防御式返回 null 或向下取整', () => {
    expect(resolveSwitchTabIndex('switch-tab-1', Number.NaN)).toBe(null)
    expect(resolveSwitchTabIndex('switch-tab-last', Number.NaN)).toBe(null)
    expect(resolveSwitchTabIndex('switch-tab-1', -3)).toBe(null)
    expect(resolveSwitchTabIndex('switch-tab-1', Number.POSITIVE_INFINITY)).toBe(null)
    // 浮点按下取整：3.7 → 3 个 tab，⌘1..⌘3 合法，⌘last = 第 3 个
    expect(resolveSwitchTabIndex('switch-tab-3', 3.7)).toBe(2)
    expect(resolveSwitchTabIndex('switch-tab-4', 3.7)).toBe(null)
    expect(resolveSwitchTabIndex('switch-tab-last', 3.7)).toBe(2)
  })
})

describe('CONTEXT_SPACE_NUMERIC_TAB_ACTIONS', () => {
  it('包含 1~9 九个映射，且 9 映射到 switch-tab-last', () => {
    expect(CONTEXT_SPACE_NUMERIC_TAB_ACTIONS['1']).toBe('switch-tab-1')
    expect(CONTEXT_SPACE_NUMERIC_TAB_ACTIONS['8']).toBe('switch-tab-8')
    expect(CONTEXT_SPACE_NUMERIC_TAB_ACTIONS['9']).toBe('switch-tab-last')
    expect(Object.keys(CONTEXT_SPACE_NUMERIC_TAB_ACTIONS)).toHaveLength(9)
  })

  it('不包含 0（⌘0 被保留给 zoom-reset）', () => {
    expect(CONTEXT_SPACE_NUMERIC_TAB_ACTIONS['0']).toBeUndefined()
  })
})

describe('isContextSpaceSwitchTabAction', () => {
  it('switch-tab-* 合法字面量返回 true', () => {
    expect(isContextSpaceSwitchTabAction('switch-tab-1')).toBe(true)
    expect(isContextSpaceSwitchTabAction('switch-tab-8')).toBe(true)
    expect(isContextSpaceSwitchTabAction('switch-tab-last')).toBe(true)
  })

  it('非 switch-tab 的 action 返回 false', () => {
    expect(isContextSpaceSwitchTabAction('refresh')).toBe(false)
    expect(isContextSpaceSwitchTabAction('close')).toBe(false)
    expect(isContextSpaceSwitchTabAction('zoom-reset')).toBe(false)
    expect(isContextSpaceSwitchTabAction('next-tab')).toBe(false)
  })

  it('前缀匹配但不在白名单的字符串返回 false（防御非法字面量）', () => {
    expect(isContextSpaceSwitchTabAction('switch-tab-9' as never)).toBe(false)
    expect(isContextSpaceSwitchTabAction('switch-tab-foo' as never)).toBe(false)
    expect(isContextSpaceSwitchTabAction('switch-tab-' as never)).toBe(false)
  })
})

describe('getNumericTabAction', () => {
  it('"1"~"9" 返回对应 action', () => {
    expect(getNumericTabAction('1')).toBe('switch-tab-1')
    expect(getNumericTabAction('8')).toBe('switch-tab-8')
    expect(getNumericTabAction('9')).toBe('switch-tab-last')
  })

  it('"0" 明确返回 null（保留给 zoom-reset）', () => {
    expect(getNumericTabAction('0')).toBe(null)
  })

  it('非数字键返回 null', () => {
    expect(getNumericTabAction('a')).toBe(null)
    expect(getNumericTabAction('')).toBe(null)
    expect(getNumericTabAction('11')).toBe(null)
  })
})
