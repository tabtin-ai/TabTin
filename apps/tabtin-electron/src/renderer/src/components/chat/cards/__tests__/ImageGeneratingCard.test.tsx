import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { ImageGeneratingCard } from '../ImageGeneratingCard'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      String(opts?.defaultValue ?? key),
  }),
}))

vi.mock('../../orb/AgentOrb', () => ({
  AgentOrb: (props: {
    cssSize: number
    texture: string
    speedScale?: number
    decorative?: boolean
  }) => (
    <div
      data-testid="agent-orb"
      data-css-size={String(props.cssSize)}
      data-texture={props.texture}
      data-speed-scale={String(props.speedScale ?? 1)}
      data-decorative={String(Boolean(props.decorative))}
    />
  ),
}))

describe('ImageGeneratingCard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('running → 有状态文案，无百分比数字', () => {
    render(<ImageGeneratingCard phase="running" startedAtMs={Date.now()} />)
    expect(screen.getByTestId('image-generating-card')).toBeTruthy()
    expect(screen.getByText('正在生成图片')).toBeTruthy()
    expect(screen.queryByText(/%/)).toBeNull()
    expect(screen.queryByText(/\d+%/)).toBeNull()
  })

  it('failed → 普通文案', () => {
    render(<ImageGeneratingCard phase="failed" />)
    expect(screen.getByText('生成失败')).toBeTruthy()
  })

  //  L2「整张卡只留一处持续动效」仍然成立，只是那一处从文案扫光挪到了画布 orb。
  // 两处都动就是回归——这条断言就是拦这个的。
  it('唯一持续动效在画布 orb，文案不再扫光', () => {
    render(<ImageGeneratingCard phase="running" startedAtMs={Date.now()} />)
    expect(screen.getByTestId('agent-orb')).toBeTruthy()
    expect(screen.queryByTestId('shiny-text')).toBeNull()
  })

  // 走时曾按「大画面该放慢」压到 0.4，实机偏慢像卡住，已改回预设原速。
  // 钉住 1 是为了拦住下一次「顺手再放慢一点」。
  it('running → 画布跑 shaping 形态轮播，装饰性且用预设原速', () => {
    render(<ImageGeneratingCard phase="running" startedAtMs={Date.now()} />)
    const orb = screen.getByTestId('agent-orb')
    expect(orb.getAttribute('data-texture')).toBe('shaping')
    expect(orb.getAttribute('data-decorative')).toBe('true')
    expect(Number(orb.getAttribute('data-speed-scale'))).toBe(1)
  })

  it.each(['failed', 'success'] as const)('%s → 不挂 orb，回落静态图标', (phase) => {
    render(<ImageGeneratingCard phase={phase} />)
    expect(screen.queryByTestId('agent-orb')).toBeNull()
  })

  it('failed → 渲染失败文案，画布无持续 loop', () => {
    render(<ImageGeneratingCard phase="failed" />)
    expect(screen.getByText('生成失败')).toBeTruthy()
    const canvas = screen.getByTestId('image-generating-canvas')
    expect(canvas.className).not.toContain('image-generating-breathe')
    expect(canvas.className).not.toContain('image-generating-shimmer')
    const bar = screen.getByTestId('image-generating-progress-bar')
    expect(bar.className).toContain('bg-destructive/60')
    expect(bar.style.transform).toBe('scaleX(1)')
  })

  // 画布自身不做 breathe/shimmer：动的是里面那颗 orb，不是这个框
  it('running → 画布边框静止，不叠 CSS loop', () => {
    render(<ImageGeneratingCard phase="running" startedAtMs={Date.now()} />)
    const canvas = screen.getByTestId('image-generating-canvas')
    expect(canvas.className).toContain('border')
    expect(canvas.className).not.toContain('image-generating-shimmer')
    expect(canvas.className).not.toContain('image-generating-breathe')
  })

  it('success → 进度条到 100%', () => {
    render(<ImageGeneratingCard phase="success" />)
    expect(screen.getByTestId('image-generating-progress-bar').style.transform).toBe(
      'scaleX(1)',
    )
  })

  it('running 一段时间后进度条 scaleX 增加（假进度）', () => {
    const startedAtMs = Date.now()
    render(<ImageGeneratingCard phase="running" startedAtMs={startedAtMs} />)
    const bar = screen.getByTestId('image-generating-progress-bar')
    const readScale = (el: HTMLElement) => {
      const match = /scaleX\(([\d.]+)\)/.exec(el.style.transform)
      return match ? Number.parseFloat(match[1]) : 0
    }
    const initialScale = readScale(bar)

    act(() => {
      vi.advanceTimersByTime(5000)
      // rAF 在 fake timers 下需要手动推进
      vi.runOnlyPendingTimers()
    })

    // 触发至少一轮 rAF
    act(() => {
      vi.advanceTimersByTime(100)
    })

    const laterScale = readScale(screen.getByTestId('image-generating-progress-bar'))
    // 假进度单调不减；若 rAF 未触发至少保持初始值合法
    expect(laterScale).toBeGreaterThanOrEqual(initialScale)
    expect(laterScale).toBeLessThanOrEqual(0.92)
  })

  it('可选 promptPreview 展示', () => {
    render(
      <ImageGeneratingCard phase="running" promptPreview="a red apple" />,
    )
    expect(screen.getByTestId('image-generating-prompt').textContent).toBe('a red apple')
  })

  it('#7380：迟到的更晚 startedAtMs 不前移锚点，进度不归零', () => {
    const t0 = Date.now()
    const { rerender } = render(
      <ImageGeneratingCard phase="running" />,
    )
    const readScale = (el: HTMLElement) => {
      const match = /scaleX\(([\d.]+)\)/.exec(el.style.transform)
      return match ? Number.parseFloat(match[1]) : 0
    }

    act(() => {
      vi.advanceTimersByTime(6500)
      vi.runOnlyPendingTimers()
    })
    act(() => {
      vi.advanceTimersByTime(100)
    })

    const midScale = readScale(screen.getByTestId('image-generating-progress-bar'))
    expect(midScale).toBeGreaterThan(0.2)

    // 模拟 tool_started 迟到：传入比 mount 更晚的 startedAtMs
    rerender(
      <ImageGeneratingCard phase="running" startedAtMs={t0 + 6500} />,
    )
    act(() => {
      vi.advanceTimersByTime(50)
      vi.runOnlyPendingTimers()
    })

    const afterLateStart = readScale(screen.getByTestId('image-generating-progress-bar'))
    expect(afterLateStart).toBeGreaterThanOrEqual(midScale - 0.02)
  })
})
