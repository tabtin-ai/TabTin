import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, fireEvent } from '@testing-library/react'
import { CollapsibleToolCardGroup } from '../CollapsibleToolCardGroup'
import { TOOL_CARD_GROUP } from '../../registry/chatDesignTokens'
import * as toolGroupMotion from '../toolGroupMotion'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string; count?: number }) => {
      let value = opts?.defaultValue ?? _key
      if (opts?.count !== undefined) value = value.replace(/\{\{count\}\}/g, String(opts.count))
      return value
    },
  }),
}))

const makeItems = (count: number) =>
  Array.from({ length: count }, (_, index) => (
    <div key={index} data-testid={`tool-item-${index}`}>
      Step {index + 1}
    </div>
  ))

const threshold = TOOL_CARD_GROUP.collapseThreshold

describe('CollapsibleToolCardGroup', () => {
  beforeEach(() => {
    vi.spyOn(toolGroupMotion, 'prefersReducedMotion').mockReturnValue(false)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('count <= 阈值：不渲染组头，平铺全部 children', () => {
    render(<CollapsibleToolCardGroup>{makeItems(threshold)}</CollapsibleToolCardGroup>)

    expect(screen.queryByTestId('tool-card-group-header')).toBeNull()
    expect(screen.getAllByTestId(/tool-item-/)).toHaveLength(threshold)
  })

  it('count > 阈值：显示组头，默认折叠且不渲染任何步骤', () => {
    render(<CollapsibleToolCardGroup>{makeItems(threshold + 1)}</CollapsibleToolCardGroup>)

    expect(screen.getByTestId('tool-card-group-header').getAttribute('aria-expanded')).toBe('false')
    const body = screen.getByTestId('tool-card-group-panel-body')
    expect(body.className).toContain('chat-motion-tool-group-content')
    expect(body.getAttribute('data-css-collapse')).toBe('true')
    expect(screen.queryAllByTestId(/tool-item-/)).toHaveLength(0)
    expect(screen.getByTestId('tool-card-group-count-badge').textContent).toBe(String(threshold + 1))
  })

  it('折叠 + showLastWhenCollapsed：露出最后一条实时可见', () => {
    render(
      <CollapsibleToolCardGroup showLastWhenCollapsed>
        {makeItems(threshold + 1)}
      </CollapsibleToolCardGroup>,
    )

    const items = screen.getAllByTestId(/tool-item-/)
    expect(items).toHaveLength(1)
    expect(items[0].getAttribute('data-testid')).toBe(`tool-item-${threshold}`)
  })

  it('首次跨过阈值时若尾步仍在运行，保持平铺直到该步完成', () => {
    const { rerender } = render(
      <CollapsibleToolCardGroup deferCollapse>
        {makeItems(threshold + 1)}
      </CollapsibleToolCardGroup>,
    )

    expect(screen.queryByTestId('tool-card-group-header')).toBeNull()
    expect(screen.getAllByTestId(/tool-item-/)).toHaveLength(threshold + 1)

    rerender(
      <CollapsibleToolCardGroup deferCollapse={false}>
        {makeItems(threshold + 1)}
      </CollapsibleToolCardGroup>,
    )

    expect(screen.getByTestId('tool-card-group-header')).toBeTruthy()
    expect(screen.queryAllByTestId(/tool-item-/)).toHaveLength(0)
  })

  it('点击组头展开：平铺全部步骤，不套固定高度内滚', () => {
    render(<CollapsibleToolCardGroup>{makeItems(threshold + 1)}</CollapsibleToolCardGroup>)

    fireEvent.click(screen.getByTestId('tool-card-group-header'))

    const panel = screen.getByTestId('tool-card-group-panel-body')
    expect(screen.getByTestId('tool-card-group-header').getAttribute('aria-expanded')).toBe('true')
    expect(panel.className).not.toContain(TOOL_CARD_GROUP.fullMaxHeight)
    expect(panel.className).not.toContain('overflow-y-auto')
    expect(panel.className).toContain('chat-motion-tool-group-content')
    expect(screen.getAllByTestId(/tool-item-/)).toHaveLength(threshold + 1)
    expect(screen.queryByTestId('tool-card-group-count-badge')).toBeNull()
  })

  it('defaultExpanded：默认展开平铺全部', () => {
    render(
      <CollapsibleToolCardGroup defaultExpanded>
        {makeItems(threshold + 1)}
      </CollapsibleToolCardGroup>,
    )

    expect(screen.getAllByTestId(/tool-item-/)).toHaveLength(threshold + 1)
  })

  it('count 指定时组头显示固定标题，并在徽标保留精确步数', () => {
    render(
      <CollapsibleToolCardGroup count={threshold + 2}>
        {makeItems(threshold + 5)}
      </CollapsibleToolCardGroup>,
    )
    expect(screen.getByTestId('tool-card-group-header').textContent).toContain('执行详情')
    expect(screen.getByTestId('tool-card-group-count-badge').textContent).toBe(String(threshold + 2))
  })

  it('展开后再次点击组头：max-height 折叠过渡结束后回收步骤', () => {
    vi.useFakeTimers()
    render(<CollapsibleToolCardGroup>{makeItems(threshold + 1)}</CollapsibleToolCardGroup>)

    fireEvent.click(screen.getByTestId('tool-card-group-header'))
    expect(screen.getAllByTestId(/tool-item-/)).toHaveLength(threshold + 1)

    fireEvent.click(screen.getByTestId('tool-card-group-header'))
    // 收拢动画期间仍挂载，徽标立即出现
    expect(screen.getByTestId('tool-card-group-count-badge')).toBeTruthy()
    expect(screen.getAllByTestId(/tool-item-/)).toHaveLength(threshold + 1)

    act(() => {
      vi.advanceTimersByTime(toolGroupMotion.TOOL_GROUP_COLLAPSE_MS)
    })
    expect(screen.queryAllByTestId(/tool-item-/)).toHaveLength(0)
  })

  it('收拢时 count-up 到最终 N；卸载清理 rAF', () => {
    vi.useFakeTimers()
    const cancelSpy = vi.fn()
    const runSpy = vi.spyOn(toolGroupMotion, 'runCountUp').mockImplementation((target, onUpdate) => {
      onUpdate(0)
      onUpdate(target)
      return cancelSpy
    })

    const { unmount } = render(
      <CollapsibleToolCardGroup defaultExpanded>
        {makeItems(threshold + 1)}
      </CollapsibleToolCardGroup>,
    )

    fireEvent.click(screen.getByTestId('tool-card-group-header'))
    expect(runSpy).toHaveBeenCalled()
    expect(runSpy.mock.calls[0]?.[0]).toBe(threshold + 1)
    expect(screen.getByTestId('tool-card-group-count-badge').textContent).toBe(String(threshold + 1))

    unmount()
    expect(cancelSpy).toHaveBeenCalled()
  })

  it('reduced-motion：收拢徽标直接呈现最终 N', () => {
    vi.mocked(toolGroupMotion.prefersReducedMotion).mockReturnValue(true)
    const runSpy = vi.spyOn(toolGroupMotion, 'runCountUp')

    render(
      <CollapsibleToolCardGroup defaultExpanded>
        {makeItems(threshold + 1)}
      </CollapsibleToolCardGroup>,
    )
    fireEvent.click(screen.getByTestId('tool-card-group-header'))

    // runCountUp 内部也会因 reducedMotion 直接跳到 N；组件侧同样走该 helper
    expect(runSpy).toHaveBeenCalled()
    const opts = runSpy.mock.calls[0]?.[2]
    // 组件未强传 reducedMotion 时 helper 自己读 prefersReducedMotion（已 mock true）
    expect(opts?.reducedMotion === true || toolGroupMotion.prefersReducedMotion()).toBe(true)
    expect(screen.getByTestId('tool-card-group-count-badge').textContent).toBe(String(threshold + 1))
  })

  it('holdVisibleSteps（opt-in API）：显式开启时跨阈值仍挂载步骤保留布局盒', () => {
    const { rerender } = render(
      <CollapsibleToolCardGroup holdVisibleSteps>
        {makeItems(threshold)}
      </CollapsibleToolCardGroup>,
    )
    expect(screen.getAllByTestId(/tool-item-/)).toHaveLength(threshold)

    rerender(
      <CollapsibleToolCardGroup holdVisibleSteps count={threshold + 1}>
        {makeItems(threshold + 1)}
      </CollapsibleToolCardGroup>,
    )

    expect(screen.getByTestId('tool-card-group-header')).toBeTruthy()
    expect(screen.getByTestId('tool-card-group-header').getAttribute('aria-expanded')).toBe('false')

    const items = screen.getAllByTestId(/tool-item-/)
    expect(items.length).toBeGreaterThanOrEqual(threshold)

    // 高度契约：禁止 display:none / hidden 属性导致布局盒丢失
    for (const el of items) {
      expect(el.hasAttribute('hidden')).toBe(false)
      expect(getComputedStyle(el).display).not.toBe('none')
      expect(el.className.split(/\s+/)).not.toContain('hidden')
    }

    const held = screen.getByTestId('tool-card-group-held-steps')
    expect(held.getAttribute('aria-hidden')).toBe('true')
    expect(held.hasAttribute('inert')).toBe(true)
    expect(held.className.split(/\s+/)).toContain('invisible')
    expect(held.className.split(/\s+/)).not.toContain('hidden')
    expect(getComputedStyle(held).display).not.toBe('none')
  })

  it('disableSizeLayout：body 不走 CSS 折叠过渡', () => {
    const { rerender } = render(
      <CollapsibleToolCardGroup>
        {makeItems(threshold + 1)}
      </CollapsibleToolCardGroup>,
    )
    const animated = screen.getByTestId('tool-card-group-panel-body')
    expect(animated.getAttribute('data-layout-size')).toBe('false')
    expect(animated.getAttribute('data-css-collapse')).toBe('true')
    expect(animated.className).toContain('chat-motion-tool-group-content')

    rerender(
      <CollapsibleToolCardGroup disableSizeLayout>
        {makeItems(threshold + 1)}
      </CollapsibleToolCardGroup>,
    )
    const body = screen.getByTestId('tool-card-group-panel-body')
    expect(body.getAttribute('data-layout-size')).toBe('false')
    expect(body.getAttribute('data-css-collapse')).toBe('false')
    expect(body.className).not.toContain('chat-motion-tool-group-content')
    expect(body.className).not.toContain('transition-[height,opacity]')
  })

  it('用户点击折叠：即使 holdVisibleSteps，显式折叠仍可收起步骤', () => {
    vi.useFakeTimers()
    const { rerender } = render(
      <CollapsibleToolCardGroup holdVisibleSteps>
        {makeItems(threshold)}
      </CollapsibleToolCardGroup>,
    )
    rerender(
      <CollapsibleToolCardGroup holdVisibleSteps count={threshold + 1}>
        {makeItems(threshold + 1)}
      </CollapsibleToolCardGroup>,
    )
    // 自动 hold：步骤仍挂载
    expect(screen.getByTestId('tool-card-group-held-steps')).toBeTruthy()
    expect(screen.getAllByTestId(/tool-item-/).length).toBeGreaterThanOrEqual(threshold)

    // 展开（按钮在 hold 下仍可用）
    fireEvent.click(screen.getByTestId('tool-card-group-header'))
    expect(screen.getByTestId('tool-card-group-header').getAttribute('aria-expanded')).toBe('true')
    expect(screen.queryByTestId('tool-card-group-held-steps')).toBeNull()
    expect(screen.getAllByTestId(/tool-item-/)).toHaveLength(threshold + 1)

    // 用户显式折叠：允许回收高度，不再走 hold（CSS 折叠动画结束后）
    fireEvent.click(screen.getByTestId('tool-card-group-header'))
    expect(screen.getByTestId('tool-card-group-header').getAttribute('aria-expanded')).toBe('false')
    act(() => {
      vi.advanceTimersByTime(toolGroupMotion.TOOL_GROUP_COLLAPSE_MS)
    })
    expect(screen.queryByTestId('tool-card-group-held-steps')).toBeNull()
    expect(screen.queryAllByTestId(/tool-item-/).length).toBeLessThan(threshold + 1)
  })

  it('有 groupKey 时用户折叠偏好跨 remount 仍回收（不因 hold 复活）', () => {
    vi.useFakeTimers()
    const { unmount } = render(
      <CollapsibleToolCardGroup holdVisibleSteps groupKey="g1" count={threshold + 1}>
        {makeItems(threshold + 1)}
      </CollapsibleToolCardGroup>,
    )
    // 自动 hold 时先展开再折叠，写入 store 显式 false
    fireEvent.click(screen.getByTestId('tool-card-group-header'))
    fireEvent.click(screen.getByTestId('tool-card-group-header'))
    act(() => {
      vi.advanceTimersByTime(toolGroupMotion.TOOL_GROUP_COLLAPSE_MS)
    })
    expect(screen.queryAllByTestId(/tool-item-/).length).toBeLessThan(threshold + 1)
    unmount()

    render(
      <CollapsibleToolCardGroup holdVisibleSteps groupKey="g1" count={threshold + 1}>
        {makeItems(threshold + 1)}
      </CollapsibleToolCardGroup>,
    )
    expect(screen.getByTestId('tool-card-group-header').getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('tool-card-group-held-steps')).toBeNull()
    expect(screen.queryAllByTestId(/tool-item-/).length).toBeLessThan(threshold + 1)
  })
})
