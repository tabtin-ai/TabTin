import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  ShellColResizeHandle,
  ShellSidebarResizableSplit,
} from './ShellResizableSplits'

describe('ShellColResizeHandle', () => {
  it('手柄自身使用真实 12px 命中区，而不是不可点击的伪元素', () => {
    render(
      <div className="relative h-40 w-40">
        <ShellColResizeHandle
          width={320}
          onWidthChange={vi.fn()}
          minWidth={160}
          maxWidth={480}
          direction="panel-on-left"
          edge="right"
        />
      </div>,
    )

    const separator = screen.getByRole('separator')
    expect(separator.className).toContain('w-3')
    expect(separator.className).toContain('-right-1')
    expect(separator.className).not.toContain('before:')
  })

  it('拖拽起点用父列渲染宽，避免 JS width 被 CSS maxWidth 截断后拖不回来', () => {
    const onResizeStart = vi.fn()
    const onWidthChange = vi.fn()
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })

    render(
      <div className="relative h-40" style={{ width: 720, maxWidth: 720 }}>
        <ShellColResizeHandle
          width={2400}
          onWidthChange={onWidthChange}
          onResizeStart={onResizeStart}
          minWidth={360}
          maxWidth={Number.POSITIVE_INFINITY}
          direction="panel-on-right"
          edge="left"
        />
      </div>,
    )

    const separator = screen.getByRole('separator')
    const parent = separator.parentElement
    expect(parent).toBeTruthy()
    vi.spyOn(parent!, 'getBoundingClientRect').mockReturnValue({
      width: 720,
      height: 160,
      top: 0,
      left: 0,
      bottom: 160,
      right: 720,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })

    fireEvent.mouseDown(separator, { clientX: 400 })
    expect(onResizeStart).toHaveBeenCalledWith(720)

    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 450, bubbles: true }))
    // panel-on-right：鼠标右移 → 辅位变窄；起点必须是 720 而非虚高 2400
    expect(onWidthChange).toHaveBeenCalledWith(670)

    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    vi.unstubAllGlobals()
  })

  it('侧栏只裁切内容，不裁掉伸入应用侧的手柄命中区', () => {
    render(
      <ShellSidebarResizableSplit
        sidebarWidth={320}
        sidebar={<div>对话</div>}
        onSidebarWidthCommit={vi.fn()}
        onLayoutSync={vi.fn()}
      >
        <div>应用</div>
      </ShellSidebarResizableSplit>,
    )

    const separator = screen.getByRole('separator')
    expect(separator.parentElement?.className).toContain('overflow-visible')
    expect(screen.getByText('对话').parentElement?.className).toContain('overflow-hidden')
  })
})
