/**
 * useCloseAnimation 关闭动画状态机回归测试
 *
 * 锁定的核心契约：
 *   1. requestClose 立即把 tabKey 加入 closing 集合 + 立即调用 performClose（业务流程）
 *   2. 业务流程通过（items 中该 tab 消失）→ phantom 接管 → durationMs 后真正 unmount
 *   3. 业务流程被 beforeClose 阻止（item 仍在 items）→ cancelTimeoutMs 后撤销 closing
 *   4. 多个 tab 快速连点 X → 各自独立的动画与定时器
 *   5. 同一 tabKey reopen → 从 phantom 移除，恢复 alive 状态
 *   6. cleanup（unmount）→ 所有定时器都被清掉，没有 leak
 *
 * 这些用例配合 NormalTab.tsx 的 className 切换共同保证关闭体验丝滑。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ContextItem } from '@components/context-space/registry'
import { useCloseAnimation } from '../hooks/useCloseAnimation'

const makeItem = (tabKey: string): ContextItem => {
  const idx = tabKey.indexOf(':')
  return {
    type: tabKey.slice(0, idx) as ContextItem['type'],
    id: tabKey.slice(idx + 1),
    tabKey: tabKey as ContextItem['tabKey'],
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useCloseAnimation · requestClose', () => {
  it('立即把 tabKey 加入 closing 集合', () => {
    const items = [makeItem('tabweb:a')]
    const { result, rerender } = renderHook(({ items }) => useCloseAnimation(items, { durationMs: 100 }), {
      initialProps: { items },
    })

    expect(result.current.isClosing('tabweb:a')).toBe(false)

    act(() => {
      result.current.requestClose(items[0], () => {})
    })

    expect(result.current.isClosing('tabweb:a')).toBe(true)
    rerender({ items })
  })

  it('立即触发 performClose（同步调用）', () => {
    const items = [makeItem('tabweb:a')]
    const performClose = vi.fn()
    const { result } = renderHook(() => useCloseAnimation(items, { durationMs: 100 }))

    act(() => {
      result.current.requestClose(items[0], performClose)
    })

    expect(performClose).toHaveBeenCalledTimes(1)
  })

  it('performClose 抛错时不传播给调用方（hook 容错）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const items = [makeItem('tabweb:a')]
    const { result } = renderHook(() => useCloseAnimation(items, { durationMs: 100 }))

    expect(() => {
      act(() => {
        result.current.requestClose(items[0], () => {
          throw new Error('biz fail')
        })
      })
    }).not.toThrow()
    expect(result.current.isClosing('tabweb:a')).toBe(true)  // 即便 performClose 失败，视觉仍然在 closing
    warn.mockRestore()
  })
})

describe('useCloseAnimation · items 自然消失（业务通过）', () => {
  it('items 中某 key 消失 → phantom 接管 + isClosing=true + 记录 lastIndex 与 predecessorTabKey', () => {
    const initial = [makeItem('tabweb:a'), makeItem('tabweb:b')]
    const { result, rerender } = renderHook(({ items }) => useCloseAnimation(items, { durationMs: 100 }), {
      initialProps: { items: initial },
    })

    // 先点击关闭 a
    act(() => {
      result.current.requestClose(initial[0], () => {})
    })

    // 业务通过：items 减少
    rerender({ items: [makeItem('tabweb:b')] })

    // a 应当出现在 phantomItems 里 + isClosing=true
    expect(result.current.phantomItems.map(p => p.item.tabKey)).toEqual(['tabweb:a'])
    expect(result.current.phantomItems[0]?.lastIndex).toBe(0)
    // a 在 items 第 0 位，无前邻居 → predecessorTabKey=null
    expect(result.current.phantomItems[0]?.predecessorTabKey).toBeNull()
    expect(result.current.isClosing('tabweb:a')).toBe(true)
  })

  it('predecessorTabKey 锚点：消失的 item 记录其前邻居 tabKey（用于 group 折叠场景精确插回）', () => {
    const initial = [makeItem('tabweb:a'), makeItem('tabweb:b'), makeItem('tabweb:c')]
    const { result, rerender } = renderHook(({ items }) => useCloseAnimation(items, { durationMs: 100 }), {
      initialProps: { items: initial },
    })

    // 关掉中间的 b
    rerender({ items: [makeItem('tabweb:a'), makeItem('tabweb:c')] })

    const phantom = result.current.phantomItems.find(p => p.item.tabKey === 'tabweb:b')
    expect(phantom).toBeDefined()
    expect(phantom?.lastIndex).toBe(1)
    expect(phantom?.predecessorTabKey).toBe('tabweb:a')
  })

  it('phantom 在 durationMs 后被 unmount（从 phantomItems 移除）', () => {
    const initial = [makeItem('tabweb:a'), makeItem('tabweb:b')]
    const { result, rerender } = renderHook(({ items }) => useCloseAnimation(items, { durationMs: 100 }), {
      initialProps: { items: initial },
    })
    act(() => {
      result.current.requestClose(initial[0], () => {})
    })
    rerender({ items: [makeItem('tabweb:b')] })

    expect(result.current.phantomItems.length).toBe(1)

    act(() => {
      vi.advanceTimersByTime(120)
    })

    expect(result.current.phantomItems.length).toBe(0)
    expect(result.current.isClosing('tabweb:a')).toBe(false)
  })

  it('外部直接关闭（无 requestClose 触发）也能播 leave 动画 —— 用户用 ⌘W / 中键时', () => {
    const initial = [makeItem('tabweb:a'), makeItem('tabweb:b')]
    const { result, rerender } = renderHook(({ items }) => useCloseAnimation(items, { durationMs: 100 }), {
      initialProps: { items: initial },
    })

    // 直接 rerender items 减少（不走 requestClose）
    rerender({ items: [makeItem('tabweb:b')] })

    // 仍应该有 phantom
    expect(result.current.phantomItems.map(p => p.item.tabKey)).toEqual(['tabweb:a'])
    expect(result.current.isClosing('tabweb:a')).toBe(true)
  })
})

describe('useCloseAnimation · beforeClose 阻止', () => {
  it('cancelTimeoutMs 后 item 仍在 items → 撤销 closing 标记（回弹）', () => {
    const initial = [makeItem('tabweb:a')]
    const { result, rerender } = renderHook(({ items }) => useCloseAnimation(items, { durationMs: 100, cancelTimeoutMs: 200 }), {
      initialProps: { items: initial },
    })

    act(() => {
      result.current.requestClose(initial[0], () => {})
    })
    expect(result.current.isClosing('tabweb:a')).toBe(true)

    // beforeClose 阻止 → items 不变
    rerender({ items: initial })

    // cancelTimeoutMs 还没到 → 仍在 closing
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(result.current.isClosing('tabweb:a')).toBe(true)

    // cancelTimeoutMs 到了 → 撤销
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(result.current.isClosing('tabweb:a')).toBe(false)
  })

  it('cancel 定时器到期前 item 已消失 → 不会误回弹（phantom 接管完整动画）', () => {
    const initial = [makeItem('tabweb:a')]
    const { result, rerender } = renderHook(({ items }) => useCloseAnimation(items, { durationMs: 100, cancelTimeoutMs: 500 }), {
      initialProps: { items: initial },
    })

    act(() => {
      result.current.requestClose(initial[0], () => {})
    })
    rerender({ items: [] })

    expect(result.current.isClosing('tabweb:a')).toBe(true)
    // phantom 在 durationMs 后 unmount
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(result.current.isClosing('tabweb:a')).toBe(false)

    // cancel 定时器之后到期 → 不应再触发任何状态变化（item 已不存在）
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(result.current.isClosing('tabweb:a')).toBe(false)
    expect(result.current.phantomItems.length).toBe(0)
  })
})

describe('useCloseAnimation · 并发 / 重复', () => {
  it('快速连点多个 X → 各自独立 closing + 各自 phantom', () => {
    const initial = [makeItem('tabweb:a'), makeItem('tabweb:b'), makeItem('tabweb:c')]
    const { result, rerender } = renderHook(({ items }) => useCloseAnimation(items, { durationMs: 100 }), {
      initialProps: { items: initial },
    })

    act(() => {
      result.current.requestClose(initial[0], () => {})
      result.current.requestClose(initial[1], () => {})
    })

    expect(result.current.isClosing('tabweb:a')).toBe(true)
    expect(result.current.isClosing('tabweb:b')).toBe(true)
    expect(result.current.isClosing('tabweb:c')).toBe(false)

    rerender({ items: [makeItem('tabweb:c')] })

    const phantomKeys = result.current.phantomItems.map(p => p.item.tabKey).sort()
    expect(phantomKeys).toEqual(['tabweb:a', 'tabweb:b'])
  })

  it('同一 tabKey 连点两次 X → 仍然只有一份 closing（不重复）', () => {
    const initial = [makeItem('tabweb:a')]
    const { result } = renderHook(() => useCloseAnimation(initial, { durationMs: 100 }))

    const performClose = vi.fn()
    act(() => {
      result.current.requestClose(initial[0], performClose)
      result.current.requestClose(initial[0], performClose)
    })

    expect(result.current.isClosing('tabweb:a')).toBe(true)
    // performClose 仍调用两次（业务由 useCloseHandlers 自己幂等保护）
    expect(performClose).toHaveBeenCalledTimes(2)
  })

  it('phantom 已在但 items 中又出现同 tabKey（reopen）→ phantom 撤销 + alive', () => {
    const initial = [makeItem('tabweb:a')]
    const { result, rerender } = renderHook(({ items }) => useCloseAnimation(items, { durationMs: 200 }), {
      initialProps: { items: initial },
    })

    act(() => {
      result.current.requestClose(initial[0], () => {})
    })
    rerender({ items: [] })  // 业务通过

    expect(result.current.phantomItems.length).toBe(1)

    // 立刻 reopen 同 tabKey（durationMs 还没到）
    rerender({ items: [makeItem('tabweb:a')] })

    expect(result.current.phantomItems.length).toBe(0)
    expect(result.current.isClosing('tabweb:a')).toBe(false)
  })
})

describe('useCloseAnimation · cleanup', () => {
  it('hook unmount 时清理所有定时器（不会在未来 fire）', () => {
    const initial = [makeItem('tabweb:a')]
    const { result, unmount, rerender } = renderHook(({ items }) => useCloseAnimation(items, { durationMs: 100 }), {
      initialProps: { items: initial },
    })

    act(() => {
      result.current.requestClose(initial[0], () => {})
    })
    rerender({ items: [] })  // 注册了 phantom timer
    rerender({ items: [makeItem('tabweb:a')] })  // reopen → 撤销 phantom timer

    // 再点关闭
    act(() => {
      result.current.requestClose(initial[0], () => {})
    })
    rerender({ items: [] })

    unmount()

    // 推进所有时间也不应触发任何 setState（已 unmount，无法验证 state，只断言不抛错）
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(10000)
      })
    }).not.toThrow()
  })
})
