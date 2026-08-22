import React, { useLayoutEffect, useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { StableSlot, useStablePortalHost } from '@/utils/portal-host'
import { ShellSpaceWorkspaceSplit } from './ShellResizableSplits'

vi.mock('@utils/layout/telemetry', () => ({
  startLayoutResizeTelemetry: () => ({
    cancel: vi.fn(),
    end: vi.fn(),
    persistSuccess: vi.fn(),
  }),
  trackLayoutTelemetry: vi.fn(),
}))

vi.mock('@/utils/crawl-view-bounds', () => ({
  dispatchCrawlViewLayoutChange: vi.fn(),
}))

const noop = () => {}

function renderTaskLayout(mode: 'chat-focus' | 'split' | 'app-focus') {
  const taskChat = <div data-testid="task-chat-content">chat</div>
  const taskCanvas = <div data-testid="task-canvas-content">canvas</div>
  const collapsedCanvasRail = <div data-testid="collapsed-canvas-content">rail</div>

  return (
    <ShellSpaceWorkspaceSplit
      chatPosition="middle"
      sidebarWidth={240}
      sidebar={<div>sidebar</div>}
      primary={mode === 'app-focus' ? taskCanvas : taskChat}
      primaryIsCanvas={mode === 'app-focus'}
      layoutTransitionScopeKey="space:space-1"
      taskViewMode={mode}
      taskChat={taskChat}
      taskCanvas={taskCanvas}
      taskCollapsedCanvasRail={collapsedCanvasRail}
      taskCanvasWidth={400}
      taskCollapsedCanvasRailWidth={48}
      secondary={mode === 'split' ? taskCanvas : mode === 'chat-focus' ? collapsedCanvasRail : undefined}
      secondaryWidth={mode === 'chat-focus' ? 48 : 400}
      secondaryResizable={mode !== 'chat-focus'}
      onSidebarWidthCommit={noop}
      onSecondaryWidthCommit={noop}
      onLayoutSync={noop}
    />
  )
}

function ResizableSplitHarness({
  onCommit,
}: {
  onCommit: (width: number) => void
}) {
  const [canvasWidth, setCanvasWidth] = useState(400)
  const taskChat = <div data-testid="task-chat-content">chat</div>
  const taskCanvas = <div data-testid="task-canvas-content">canvas</div>

  return (
    <ShellSpaceWorkspaceSplit
      chatPosition="middle"
      sidebarWidth={240}
      sidebar={<div>sidebar</div>}
      primary={taskChat}
      taskViewMode="split"
      taskChat={taskChat}
      taskCanvas={taskCanvas}
      taskCanvasWidth={canvasWidth}
      secondary={taskCanvas}
      secondaryWidth={canvasWidth}
      onSidebarWidthCommit={noop}
      onSecondaryWidthCommit={(width) => {
        setCanvasWidth(width)
        onCommit(width)
      }}
      onLayoutSync={noop}
    />
  )
}

describe('ShellSpaceWorkspaceSplit 可中断任务布局', () => {
  it('split⇄app-focus 快速往返时复用右侧画布宿主，且不播放列宽动画', () => {
    const view = render(renderTaskLayout('split'))
    const originalCanvas = screen.getByTestId('task-canvas-content')
    const canvasRail = screen.getByTestId('shell-stable-task-canvas-rail')

    expect(canvasRail.style.width).toBe('400px')
    expect(canvasRail.previousElementSibling?.getAttribute('data-testid')).toBe(
      'shell-stable-task-chat-rail',
    )

    view.rerender(renderTaskLayout('app-focus'))
    expect(screen.getByTestId('task-canvas-content')).toBe(originalCanvas)
    expect(screen.getByTestId('shell-stable-task-canvas-rail').style.width).toBe('100%')
    expect(screen.queryByTestId('task-chat-content')).toBeNull()
    expect(screen.getByTestId('shell-stable-task-canvas-rail').style.transition).toBe('none')

    // 不等待 420ms 过渡结束就反向，CSS 会从当前呈现宽度继续追新目标。
    view.rerender(renderTaskLayout('split'))
    expect(screen.getByTestId('task-canvas-content')).toBe(originalCanvas)
    expect(screen.getByTestId('shell-stable-task-canvas-rail').style.width).toBe('400px')
    expect(screen.getByTestId('task-chat-content')).not.toBeNull()
    expect(screen.getByTestId('shell-stable-task-canvas-rail').style.transition).toBe('none')

    view.rerender(renderTaskLayout('app-focus'))
    expect(screen.getByTestId('task-canvas-content')).toBe(originalCanvas)
    expect(screen.getByTestId('shell-stable-task-canvas-rail').style.width).toBe('100%')
    expect(screen.getByTestId('shell-stable-task-canvas-rail').style.transition).toBe('none')
  })

  it('chat-focus 只把稳定画布宿主收到 0，切回 split 仍复用同一 App DOM', () => {
    const view = render(renderTaskLayout('split'))
    const originalCanvas = screen.getByTestId('task-canvas-content')

    view.rerender(renderTaskLayout('chat-focus'))
    expect(screen.getByTestId('task-canvas-content')).toBe(originalCanvas)
    expect(screen.getByTestId('shell-stable-task-canvas-rail').style.width).toBe('0px')
    expect(screen.getByTestId('shell-stable-task-collapsed-rail').style.width).toBe('48px')
    expect(screen.getByTestId('shell-stable-task-canvas-rail').style.transition).toBe('none')
    expect(screen.getByTestId('shell-stable-task-collapsed-rail').style.transition).toBe('none')

    view.rerender(renderTaskLayout('split'))
    expect(screen.getByTestId('task-canvas-content')).toBe(originalCanvas)
    expect(screen.getByTestId('shell-stable-task-canvas-rail').style.width).toBe('400px')
    expect(screen.getByTestId('shell-stable-task-collapsed-rail').style.width).toBe('0px')
    expect(screen.getByTestId('shell-stable-task-canvas-rail').style.transition).toBe('none')
  })

  it('split 保留画布左边沿拖拽，并把最终宽度提交给持久化入口', () => {
    const onCommit = vi.fn()
    render(<ResizableSplitHarness onCommit={onCommit} />)

    const canvasRail = screen.getByTestId('shell-stable-task-canvas-rail')
    const resizeHandle = canvasRail.querySelector<HTMLElement>('[role="separator"]')
    expect(resizeHandle).not.toBeNull()

    Object.defineProperty(canvasRail, 'getBoundingClientRect', {
      configurable: true,
      value: () => new DOMRect(600, 0, 400, 600),
    })

    fireEvent.mouseDown(resizeHandle!, { clientX: 600 })
    fireEvent.mouseMove(document, { clientX: 500 })
    fireEvent.mouseUp(document, { clientX: 500 })

    expect(onCommit).toHaveBeenCalledWith(500)
    expect(screen.getByTestId('shell-stable-task-canvas-rail').style.width).toBe('500px')
  })

  it('任务三态任一状态退出到云文档一级域后，contentPortalHost 仍挂在唯一可见画布槽', () => {
    function CrossDomainHarness({
      mode,
    }: {
      mode: 'chat-focus' | 'split' | 'app-focus' | 'cloud-docs'
    }) {
      // 与 AppLayout 一致：整棵 shell 共用一个 contentPortalHost。
      const host = useStablePortalHost()
      useLayoutEffect(() => {
        host.dataset.testid = 'content-portal-host'
        host.textContent = 'content-area'
      }, [host])

      const owner = mode === 'cloud-docs' ? 'cloud-docs' : 'task'
      const canvas = (
        <div data-testid={`canvas-domain-${owner}`}>
          <StableSlot host={host} owner={owner} className="h-full w-full" />
        </div>
      )
      const taskMode = mode === 'cloud-docs' ? null : mode

      return (
        <ShellSpaceWorkspaceSplit
          chatPosition="middle"
          sidebarWidth={240}
          sidebar={<div>sidebar</div>}
          primary={
            taskMode === 'app-focus' || mode === 'cloud-docs'
              ? canvas
              : <div data-testid="task-chat-content">chat</div>
          }
          primaryIsCanvas={taskMode === 'app-focus' || mode === 'cloud-docs'}
          taskViewMode={taskMode}
          taskChat={taskMode ? <div data-testid="task-chat-content">chat</div> : undefined}
          taskCanvas={taskMode ? canvas : undefined}
          taskCollapsedCanvasRail={
            taskMode === 'chat-focus'
              ? <div data-testid="collapsed-canvas-content">rail</div>
              : undefined
          }
          taskCanvasWidth={400}
          taskCollapsedCanvasRailWidth={48}
          secondary={
            mode === 'cloud-docs' || taskMode === 'split'
              ? canvas
              : taskMode === 'chat-focus'
                ? <div data-testid="collapsed-canvas-content">rail</div>
                : undefined
          }
          secondaryWidth={taskMode === 'chat-focus' ? 48 : 400}
          secondaryResizable={taskMode !== 'chat-focus'}
          onSidebarWidthCommit={noop}
          onSecondaryWidthCommit={noop}
          onLayoutSync={noop}
        />
      )
    }

    for (const taskMode of ['chat-focus', 'split', 'app-focus'] as const) {
      const view = render(<CrossDomainHarness mode={taskMode} />)
      const host = document.querySelector('[data-testid="content-portal-host"]')
      expect(host).toBeTruthy()
      expect(document.contains(host)).toBe(true)

      view.rerender(<CrossDomainHarness mode="cloud-docs" />)
      expect(document.contains(host)).toBe(true)
      expect(host?.parentElement?.closest('[data-testid="canvas-domain-cloud-docs"]')).toBeTruthy()
      expect(host?.getAttribute('data-portal-owner')).toBe('cloud-docs')
      expect(screen.queryByTestId('shell-stable-task-canvas-rail')).toBeNull()
      view.unmount()
    }
  })

  it('从任务分屏进入一级全屏 App 时首帧直接全宽，不保留旧辅位退场列', () => {
    function CrossScopeHarness({ fullscreen }: { fullscreen: boolean }) {
      const taskChat = <div data-testid="cross-scope-task-chat">chat</div>
      const taskCanvas = <div data-testid="cross-scope-task-canvas">canvas</div>
      const fullscreenCanvas = <div data-testid="cross-scope-fullscreen-canvas">fullscreen</div>

      return (
        <ShellSpaceWorkspaceSplit
          chatPosition="middle"
          sidebarWidth={240}
          sidebar={<div>sidebar</div>}
          primary={fullscreen ? fullscreenCanvas : taskChat}
          primaryIsCanvas={fullscreen}
          layoutTransitionScopeKey={fullscreen ? 'app-page:skill' : 'space:space-1'}
          taskViewMode={fullscreen ? null : 'split'}
          taskChat={fullscreen ? undefined : taskChat}
          taskCanvas={fullscreen ? undefined : taskCanvas}
          taskCanvasWidth={400}
          secondary={fullscreen ? undefined : taskCanvas}
          secondaryWidth={400}
          onSidebarWidthCommit={noop}
          onSecondaryWidthCommit={noop}
          onLayoutSync={noop}
        />
      )
    }

    const view = render(<CrossScopeHarness fullscreen={false} />)
    expect(screen.getByTestId('shell-stable-task-canvas-rail')).toBeTruthy()

    view.rerender(<CrossScopeHarness fullscreen />)

    expect(screen.getByTestId('cross-scope-fullscreen-canvas')).toBeTruthy()
    expect(screen.queryByTestId('shell-workspace-secondary-rail')).toBeNull()
    expect(screen.queryByTestId('shell-stable-task-canvas-rail')).toBeNull()
  })
})
