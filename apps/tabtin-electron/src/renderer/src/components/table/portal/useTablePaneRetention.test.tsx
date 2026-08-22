import React, { StrictMode, type PropsWithChildren } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTablePaneRetention } from './useTablePaneRetention'

const StrictModeWrapper = ({ children }: PropsWithChildren) => (
  <StrictMode>{children}</StrictMode>
)

describe('useTablePaneRetention', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the committed deadline stable across StrictMode repeated renders', () => {
    const { result, rerender } = renderHook(
      ({ visible, open }: { visible: string[]; open: string[] }) =>
        useTablePaneRetention(visible, open, 1_000),
      {
        initialProps: { visible: ['table-a'], open: ['table-a', 'table-b'] },
        wrapper: StrictModeWrapper,
      },
    )

    rerender({ visible: ['table-b'], open: ['table-a', 'table-b'] })
    expect(result.current.retainedTableIds).toEqual(['table-a'])
    expect(result.current.retainedUntil.get('table-a')).toBe(2_000)

    rerender({ visible: ['table-b'], open: ['table-a', 'table-b'] })
    expect(result.current.retainedUntil.get('table-a')).toBe(2_000)

    act(() => vi.advanceTimersByTime(1_001))
    expect(result.current.retainedTableIds).toEqual([])
  })
})
