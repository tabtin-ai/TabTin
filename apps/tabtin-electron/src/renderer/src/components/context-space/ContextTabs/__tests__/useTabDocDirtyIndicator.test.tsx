/**
 * useTabDocDirtyIndicator 回归测试
 *
 * 验证：
 *   - 非 tabdoc item → null（不显示指示符）
 *   - 未 register → null
 *   - register 后立即同步初值（无需等下次 emit）
 *   - register / unregister / notify 都能让组件 re-render
 *   - saveState 各档位正确派生 indicator status
 *   - 切换 documentId（同 hook 实例）→ 重订阅
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ContextItem } from '@components/context-space/registry'
import {
  registerTabDocDirtySource,
  notifyTabDocDirty,
  _resetTabDocDirtyRegistry,
  type TabDocDirtySnapshot,
} from '../../tabdoc/tabdocDirtyRegistry'
import {
  useTabDocDirtyIndicator,
  deriveTabDocIndicatorStatus,
} from '../hooks/useTabDocDirtyIndicator'

const makeTabDoc = (id: string): ContextItem => ({
  type: 'tabdoc',
  id,
  tabKey: `tabdoc:${id}` as ContextItem['tabKey'],
  title: `Doc ${id}`,
})

const makeWebTab = (id: string): ContextItem => ({
  type: 'tabweb',
  id,
  tabKey: `tabweb:${id}` as ContextItem['tabKey'],
})

const baseSnapshot = (overrides: Partial<TabDocDirtySnapshot> = {}): TabDocDirtySnapshot => ({
  saveState: 'idle',
  isDirty: false,
  isCollaborating: false,
  title: 'Doc',
  ...overrides,
})

beforeEach(() => {
  _resetTabDocDirtyRegistry()
})

afterEach(() => {
  _resetTabDocDirtyRegistry()
})

describe('deriveTabDocIndicatorStatus 派生函数', () => {
  it('null snapshot → idle', () => {
    expect(deriveTabDocIndicatorStatus(null)).toBe('idle')
  })

  it('saveState=error 优先级最高', () => {
    expect(deriveTabDocIndicatorStatus(baseSnapshot({ saveState: 'error', isDirty: true }))).toBe('error')
  })

  it('saveState=saving → saving（与 dirty 互斥）', () => {
    expect(deriveTabDocIndicatorStatus(baseSnapshot({ saveState: 'saving', isDirty: true }))).toBe('saving')
  })

  it('saveState=dirty → dirty', () => {
    expect(deriveTabDocIndicatorStatus(baseSnapshot({ saveState: 'dirty' }))).toBe('dirty')
  })

  it('saveState=idle + isDirty=true → dirty（兜底）', () => {
    expect(deriveTabDocIndicatorStatus(baseSnapshot({ saveState: 'idle', isDirty: true }))).toBe('dirty')
  })

  it('saveState=idle + 非 dirty → idle', () => {
    expect(deriveTabDocIndicatorStatus(baseSnapshot({ saveState: 'idle' }))).toBe('idle')
  })

  it('saveState=saved + 非 dirty → idle', () => {
    expect(deriveTabDocIndicatorStatus(baseSnapshot({ saveState: 'saved' }))).toBe('idle')
  })
})

describe('useTabDocDirtyIndicator hook', () => {
  it('非 tabdoc 类型 → 始终 null', () => {
    const item = makeWebTab('w1')
    registerTabDocDirtySource('w1', () => baseSnapshot({ saveState: 'dirty' }), async () => true)
    const { result } = renderHook(() => useTabDocDirtyIndicator(item))
    expect(result.current).toBeNull()
  })

  it('tabdoc + 未 register → null', () => {
    const { result } = renderHook(() => useTabDocDirtyIndicator(makeTabDoc('doc-1')))
    expect(result.current).toBeNull()
  })

  it('register 后 hook 立即同步初值（无需等待 emit）', () => {
    registerTabDocDirtySource('doc-1', () => baseSnapshot({ saveState: 'dirty' }), async () => true)
    const { result } = renderHook(() => useTabDocDirtyIndicator(makeTabDoc('doc-1')))
    expect(result.current).toEqual({ status: 'dirty', isCollaborating: false })
  })

  it('mount 后 register → 通过 emit 通知 hook', () => {
    const { result, rerender } = renderHook(() => useTabDocDirtyIndicator(makeTabDoc('doc-1')))
    expect(result.current).toBeNull()

    act(() => {
      registerTabDocDirtySource('doc-1', () => baseSnapshot({ saveState: 'dirty' }), async () => true)
    })

    rerender()
    expect(result.current).toEqual({ status: 'dirty', isCollaborating: false })
  })

  it('saveState 变化 + notifyTabDocDirty → indicator 更新', () => {
    let state: TabDocDirtySnapshot['saveState'] = 'idle'
    let isDirty = false
    registerTabDocDirtySource(
      'doc-1',
      () => baseSnapshot({ saveState: state, isDirty }),
      async () => true,
    )
    const { result, rerender } = renderHook(() => useTabDocDirtyIndicator(makeTabDoc('doc-1')))
    expect(result.current).toBeNull()  // idle + 非 dirty

    act(() => {
      state = 'dirty'
      isDirty = true
      notifyTabDocDirty('doc-1')
    })
    rerender()
    expect(result.current).toEqual({ status: 'dirty', isCollaborating: false })

    act(() => {
      state = 'saving'
      notifyTabDocDirty('doc-1')
    })
    rerender()
    expect(result.current).toEqual({ status: 'saving', isCollaborating: false })

    act(() => {
      state = 'error'
      notifyTabDocDirty('doc-1')
    })
    rerender()
    expect(result.current).toEqual({ status: 'error', isCollaborating: false })

    act(() => {
      state = 'saved'
      isDirty = false
      notifyTabDocDirty('doc-1')
    })
    rerender()
    expect(result.current).toBeNull()
  })

  it('协作模式 isCollaborating 透传到结果', () => {
    registerTabDocDirtySource(
      'doc-1',
      () => baseSnapshot({ saveState: 'dirty', isCollaborating: true }),
      async () => true,
    )
    const { result } = renderHook(() => useTabDocDirtyIndicator(makeTabDoc('doc-1')))
    expect(result.current).toEqual({ status: 'dirty', isCollaborating: true })
  })

  it('切换到不同 documentId（同 hook 实例）→ 重订阅 + 拿新值', () => {
    registerTabDocDirtySource('doc-1', () => baseSnapshot({ saveState: 'dirty' }), async () => true)
    registerTabDocDirtySource('doc-2', () => baseSnapshot({ saveState: 'error' }), async () => true)

    const { result, rerender } = renderHook(({ item }) => useTabDocDirtyIndicator(item), {
      initialProps: { item: makeTabDoc('doc-1') },
    })
    expect(result.current?.status).toBe('dirty')

    rerender({ item: makeTabDoc('doc-2') })
    expect(result.current?.status).toBe('error')
  })

  it('unregister 后 hook 重新返回 null', () => {
    const unregister = registerTabDocDirtySource(
      'doc-1',
      () => baseSnapshot({ saveState: 'dirty' }),
      async () => true,
    )
    const { result, rerender } = renderHook(() => useTabDocDirtyIndicator(makeTabDoc('doc-1')))
    expect(result.current?.status).toBe('dirty')

    act(() => {
      unregister()
    })
    rerender()
    expect(result.current).toBeNull()
  })
})
