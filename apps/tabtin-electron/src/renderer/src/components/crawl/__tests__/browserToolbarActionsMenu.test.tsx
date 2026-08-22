import React from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  CrawlspaceToolbar,
  ToolbarOverflowCloseContext,
} from '@tabtin/crawlspace-core'

vi.mock('../BrowserZoomControls', () => ({
  BrowserZoomControls: ({ viewId }: { viewId: string }) => (
    <div role="group" aria-label="网页缩放" data-view-id={viewId} />
  ),
}))

import { BrowserToolbarActionsMenu } from '../BrowserToolbarActionsMenu'

function stubDoubleRaf() {
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb)
    return frames.length
  })
  return {
    flush() {
      const first = frames.shift()
      first?.(0)
      const second = frames.shift()
      second?.(0)
    },
    get pending() {
      return frames.length
    },
  }
}

describe('BrowserToolbarActionsMenu', () => {
  it('renders zoom group and labeled action rows', () => {
    render(
      <BrowserToolbarActionsMenu
        viewId="v1"
        browserAnnotationPicking={false}
        browserScreenshotPicking={false}
        currentUrlForBookmark="https://example.com"
        isCurrentBookmarked={false}
        onToggleAnnotation={() => {}}
        onCaptureScreenshot={() => {}}
        onToggleBookmark={() => {}}
      />,
    )
    expect(screen.getByRole('group', { name: /网页缩放/i })).toBeTruthy()
    expect(screen.getByTestId('browser-toolbar-actions-menu-zoom')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: /quoteSelection\.pickElementScreenshotAction|截取|截图/i }),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: /bookmarks\.addAction|收藏/i })).toBeTruthy()
  })

  it('omits bookmark row for blank urls', () => {
    render(
      <BrowserToolbarActionsMenu
        viewId="v1"
        browserAnnotationPicking={false}
        browserScreenshotPicking={false}
        currentUrlForBookmark="about:blank"
        isCurrentBookmarked={false}
        onToggleAnnotation={() => {}}
        onCaptureScreenshot={() => {}}
        onToggleBookmark={() => {}}
      />,
    )
    expect(screen.queryByRole('button', { name: /bookmarks\.addAction|收藏/i })).toBeNull()
  })

  it('invokes bookmark immediately via overflow run context', () => {
    const onToggleBookmark = vi.fn()
    const run = vi.fn((action?: () => void) => {
      action?.()
    })

    render(
      <ToolbarOverflowCloseContext.Provider value={run}>
        <BrowserToolbarActionsMenu
          viewId="v1"
          browserAnnotationPicking={false}
          browserScreenshotPicking={false}
          currentUrlForBookmark="https://example.com"
          isCurrentBookmarked={false}
          onToggleAnnotation={() => {}}
          onCaptureScreenshot={() => {}}
          onToggleBookmark={onToggleBookmark}
        />
      </ToolbarOverflowCloseContext.Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /bookmarks\.addAction|收藏/i }))
    expect(run).toHaveBeenCalledTimes(1)
    expect(onToggleBookmark).toHaveBeenCalledTimes(1)
  })

  it('defers screenshot through overflow run context', () => {
    const onCaptureScreenshot = vi.fn()
    const run = vi.fn((action?: () => void, options?: { defer?: boolean }) => {
      expect(options?.defer).toBe(true)
      action?.()
    })

    render(
      <ToolbarOverflowCloseContext.Provider value={run}>
        <BrowserToolbarActionsMenu
          viewId="v1"
          browserAnnotationPicking={false}
          browserScreenshotPicking={false}
          currentUrlForBookmark="https://example.com"
          isCurrentBookmarked={false}
          onToggleAnnotation={() => {}}
          onCaptureScreenshot={onCaptureScreenshot}
          onToggleBookmark={() => {}}
        />
      </ToolbarOverflowCloseContext.Provider>,
    )

    fireEvent.click(
      screen.getByRole('button', { name: /quoteSelection\.pickElementScreenshotAction|截取|截图/i }),
    )
    expect(run).toHaveBeenCalledTimes(1)
    expect(onCaptureScreenshot).toHaveBeenCalledTimes(1)
  })
})

describe('CrawlspaceToolbar + BrowserToolbarActionsMenu integration', () => {
  it('fires annotate / screenshot / bookmark from narrow overflow menu', () => {
    const onToggleAnnotation = vi.fn()
    const onCaptureScreenshot = vi.fn()
    const onToggleBookmark = vi.fn()
    const raf = stubDoubleRaf()

    render(
      <CrawlspaceToolbar
        currentUrl="https://example.com/page"
        actionsLayoutWidthPx={400}
        onToggleResources={vi.fn()}
        onOpenDownloads={vi.fn()}
        actionsMenu={
          <BrowserToolbarActionsMenu
            viewId="v1"
            browserAnnotationPicking={false}
            browserScreenshotPicking={false}
            currentUrlForBookmark="https://example.com/page"
            isCurrentBookmarked={false}
            onToggleAnnotation={onToggleAnnotation}
            onCaptureScreenshot={onCaptureScreenshot}
            onToggleBookmark={onToggleBookmark}
          />
        }
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /更多工具|more browser tools/i }))
    const menu = screen.getByTestId('browser-toolbar-actions-overflow')

    fireEvent.click(within(menu).getByRole('button', { name: /bookmarks\.addAction|收藏/i }))
    expect(onToggleBookmark).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('browser-toolbar-actions-overflow')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /更多工具|more browser tools/i }))
    const menu2 = screen.getByTestId('browser-toolbar-actions-overflow')
    fireEvent.click(
      within(menu2).getByRole('button', {
        name: /quoteSelection\.pickElementScreenshotAction|截取|截图/i,
      }),
    )
    expect(onCaptureScreenshot).not.toHaveBeenCalled()
    raf.flush()
    expect(onCaptureScreenshot).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: /更多工具|more browser tools/i }))
    const menu3 = screen.getByTestId('browser-toolbar-actions-overflow')
    fireEvent.click(
      within(menu3).getByRole('button', {
        name: /quoteSelection\.pickElementAction|网页注释|toolbarOverflow\.annotate/i,
      }),
    )
    expect(onToggleAnnotation).not.toHaveBeenCalled()
    raf.flush()
    expect(onToggleAnnotation).toHaveBeenCalledTimes(1)

    vi.unstubAllGlobals()
  })
})
