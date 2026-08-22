/**
 * React 19 + zustand 5：getSnapshot 必须在连续两次调用间 Object.is 相等。
 * 回归  引入的 NetworkConnectionIndicator 整页白屏
 * （Maximum update depth / getSnapshot should be cached）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import React, { useEffect } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}))

describe('useWsConnectionStatus snapshot stability contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('selector 内 map 出新对象会触发 React 19 getSnapshot 死循环', () => {
    type Slice = { status: string | null; isOnline: boolean }
    type State = { tables: Record<string, Slice> }

    const useStore = create<State>(() => ({
      tables: {
        t1: { status: 'synced', isOnline: true },
      },
    }))

    function Broken() {
      const statuses = useStore(
        useShallow((state) =>
          Object.values(state.tables).map(({ status, isOnline }) => ({ status, isOnline })),
        ),
      )
      return <div data-testid="count">{statuses.length}</div>
    }

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Broken />)).toThrow(/Maximum update depth exceeded|getSnapshot/i)
    spy.mockRestore()
  })

  it('订 tables 引用再 useMemo 派生可通过 React 19 getSnapshot 校验', () => {
    type Slice = { status: string | null; isOnline: boolean }
    type State = { tables: Record<string, Slice> }

    const useStore = create<State>(() => ({
      tables: {
        t1: { status: 'synced', isOnline: true },
        t2: { status: 'connecting', isOnline: false },
      },
    }))

    function Stable({ onReady }: { onReady: (n: number) => void }) {
      const tables = useStore((state) => state.tables)
      const statuses = React.useMemo(
        () => Object.values(tables).map(({ status, isOnline }) => ({ status, isOnline })),
        [tables],
      )
      useEffect(() => {
        onReady(statuses.length)
      }, [onReady, statuses.length])
      return <div data-testid="count">{statuses.length}</div>
    }

    const onReady = vi.fn()
    expect(() => render(<Stable onReady={onReady} />)).not.toThrow()
    expect(onReady).toHaveBeenCalledWith(2)
  })

  it('useShallow 结果里 `?? []` 会因每次新数组触发 getSnapshot 死循环', () => {
    type State = { loadedOrganizationIds?: string[] }
    const useStore = create<State>(() => ({
      // 模拟字段缺失 / 未水合
      loadedOrganizationIds: undefined,
    }))

    function Broken() {
      const { ids } = useStore(
        useShallow((state) => ({
          ids: state.loadedOrganizationIds ?? [],
        })),
      )
      return <div data-testid="len">{ids.length}</div>
    }

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Broken />)).toThrow(/Maximum update depth exceeded|getSnapshot/i)
    spy.mockRestore()
  })

  it('useShallow 结果里使用模块级 EMPTY 常量可通过校验', () => {
    const EMPTY: string[] = []
    type State = { loadedOrganizationIds?: string[] }
    const useStore = create<State>(() => ({
      loadedOrganizationIds: undefined,
    }))

    function Stable() {
      const { ids } = useStore(
        useShallow((state) => ({
          ids: state.loadedOrganizationIds ?? EMPTY,
        })),
      )
      return <div data-testid="len">{ids.length}</div>
    }

    expect(() => render(<Stable />)).not.toThrow()
  })
})
