import React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StorageOverviewSection } from '../StorageOverviewSection'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
}))

describe('StorageOverviewSection', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('后台重新计算时保持状态行和刷新按钮外观稳定', () => {
    const onRefresh = vi.fn()

    render(
      <StorageOverviewSection
        totalBytes={61 * 1024}
        totalItemCount={4}
        cacheBytes={0}
        cacheBucketCount={0}
        isLoading={false}
        isMeasuring={true}
        onCleanCache={vi.fn().mockResolvedValue(undefined)}
        onRefresh={onRefresh}
        refreshDisabled={true}
        isRefreshing={true}
      />,
    )

    expect(screen.queryByText('正在统计 TabTin 占用的空间…')).toBeNull()

    const refreshButton = screen.getByTestId('storage-refresh')
    expect((refreshButton as HTMLButtonElement).disabled).toBe(false)
    expect(refreshButton.getAttribute('aria-disabled')).toBe('true')

    fireEvent.click(refreshButton)
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('快速完成的重新计算也会让刷新图标连续转满一圈', () => {
    vi.useFakeTimers()
    const baseProps = {
      totalBytes: 61 * 1024,
      totalItemCount: 4,
      cacheBytes: 0,
      cacheBucketCount: 0,
      isLoading: false,
      isMeasuring: false,
      onCleanCache: vi.fn().mockResolvedValue(undefined),
      onRefresh: vi.fn(),
      refreshDisabled: false,
    }
    const { rerender } = render(
      <StorageOverviewSection {...baseProps} isRefreshing={true} />,
    )
    const refreshButton = screen.getByTestId('storage-refresh')
    const refreshIcon = refreshButton.querySelector('svg')

    expect(refreshIcon?.classList.contains('animate-spin')).toBe(true)

    rerender(<StorageOverviewSection {...baseProps} isRefreshing={false} />)
    expect(refreshIcon?.classList.contains('animate-spin')).toBe(true)

    act(() => {
      vi.advanceTimersByTime(999)
    })
    expect(refreshIcon?.classList.contains('animate-spin')).toBe(true)

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(refreshIcon?.classList.contains('animate-spin')).toBe(false)
  })
})
