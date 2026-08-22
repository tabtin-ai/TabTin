import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  CrawlspaceToolbar,
  TOOLBAR_ACTIONS_OVERFLOW_MAX_WIDTH_PX,
  shouldOverflowToolbarActions,
} from '@tabtin/crawlspace-core'

describe('shouldOverflowToolbarActions', () => {
  it('is true strictly below 560', () => {
    expect(TOOLBAR_ACTIONS_OVERFLOW_MAX_WIDTH_PX).toBe(560)
    expect(shouldOverflowToolbarActions(559)).toBe(true)
    expect(shouldOverflowToolbarActions(560)).toBe(false)
    expect(shouldOverflowToolbarActions(800)).toBe(false)
  })
})

describe('CrawlspaceToolbar actions overflow', () => {
  it('wide layout explains resource and download actions on hover', async () => {
    render(
      <CrawlspaceToolbar
        currentUrl="https://example.com"
        actionsLayoutWidthPx={560}
        onToggleResources={vi.fn()}
        onOpenDownloads={vi.fn()}
      />,
    )

    fireEvent.pointerMove(
      screen.getByRole('button', { name: /资源中心|resources/i }),
      { pointerType: 'mouse' },
    )
    await waitFor(() => {
      expect(screen.getByRole('tooltip').textContent).toBe(
        '资源中心｜查看当前网页识别到的图片、视频等资源',
      )
    })

    fireEvent.pointerMove(
      screen.getByRole('button', { name: /下载管理|downloads/i }),
      { pointerType: 'mouse' },
    )
    await waitFor(() => {
      expect(screen.getByRole('tooltip').textContent).toBe(
        '下载管理｜查看浏览器下载任务',
      )
    })
  })

  it('wide layout keeps resource button outside the overflow menu', () => {
    render(
      <CrawlspaceToolbar
        currentUrl="https://example.com"
        actionsLayoutWidthPx={560}
        onToggleResources={vi.fn()}
        resourceCount={1}
      />,
    )
    expect(screen.queryByRole('button', { name: /更多工具|more browser tools/i })).toBeNull()
    expect(screen.getByRole('button', { name: /资源中心|resources/i })).toBeTruthy()
  })

  it('narrow layout shows ... and moves resources into the menu', async () => {
    const onToggleResources = vi.fn()
    render(
      <CrawlspaceToolbar
        currentUrl="https://example.com"
        actionsLayoutWidthPx={559}
        onToggleResources={onToggleResources}
        resourceCount={3}
        onOpenDownloads={vi.fn()}
        downloadCount={0}
        actions={<button type="button">zoom-slot</button>}
        actionsMenu={<div data-testid="actions-menu-slot">menu-slot</div>}
      />,
    )

    expect(screen.queryByRole('button', { name: /资源中心|resources/i })).toBeNull()
    expect(screen.queryByText('zoom-slot')).toBeNull()

    const more = screen.getByRole('button', { name: /更多工具|more browser tools/i })
    fireEvent.click(more)

    const menu = await screen.findByTestId('browser-toolbar-actions-overflow')
    expect(within(menu).getByRole('button', { name: /资源中心|resources/i })).toBeTruthy()
    expect(within(menu).getByRole('button', { name: /下载管理|downloads/i })).toBeTruthy()
    expect(within(menu).getByTestId('actions-menu-slot')).toBeTruthy()

    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb)
      return frames.length
    })
    fireEvent.click(within(menu).getByRole('button', { name: /资源中心|resources/i }))
    expect(onToggleResources).not.toHaveBeenCalled()
    frames[0]?.(0)
    frames[1]?.(0)
    expect(onToggleResources).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('narrow layout omits Tins row when onToggleTins is absent', async () => {
    render(
      <CrawlspaceToolbar
        currentUrl="https://example.com"
        actionsLayoutWidthPx={400}
        onToggleResources={vi.fn()}
        onOpenDownloads={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /更多工具|more browser tools/i }))
    const menu = await screen.findByTestId('browser-toolbar-actions-overflow')
    expect(within(menu).queryByRole('button', { name: /智能插件|tins/i })).toBeNull()
  })

  it('portals overflow menu to document.body', async () => {
    render(
      <CrawlspaceToolbar
        currentUrl="https://example.com"
        actionsLayoutWidthPx={400}
        onToggleResources={vi.fn()}
        onOpenDownloads={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /更多工具|more browser tools/i }))
    const menu = await screen.findByTestId('browser-toolbar-actions-overflow')
    expect(menu.closest('body')).toBe(document.body)
  })

  it('defers downloads handler until after overflow close frames', async () => {
    const onOpenDownloads = vi.fn()
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb)
      return frames.length
    })

    render(
      <CrawlspaceToolbar
        currentUrl="https://example.com"
        actionsLayoutWidthPx={400}
        onOpenDownloads={onOpenDownloads}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /更多工具|more browser tools/i }))
    const menu = await screen.findByTestId('browser-toolbar-actions-overflow')
    fireEvent.click(within(menu).getByRole('button', { name: /下载管理|downloads/i }))

    expect(onOpenDownloads).not.toHaveBeenCalled()
    expect(frames.length).toBeGreaterThanOrEqual(1)
    frames[0]?.(0)
    expect(onOpenDownloads).not.toHaveBeenCalled()
    frames[1]?.(0)
    expect(onOpenDownloads).toHaveBeenCalledTimes(1)

    vi.unstubAllGlobals()
  })
})
