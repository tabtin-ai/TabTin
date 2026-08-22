import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRef } from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}))

vi.mock('@stores/useBrowserTabLockStore', () => ({
  useBrowserTabLockStore: (selector: (state: { isLocked: (id: string) => boolean }) => unknown) =>
    selector({ isLocked: (id: string) => id === 'locked-tab' }),
}))

const chatState = vi.hoisted(() => ({
  currentSessionIdBySpaceId: { 'space-1': 'sess-1' } as Record<string, string | null>,
  sessions: [{ id: 'sess-1', title: 'Watcha 产品调研' }] as Array<{ id: string; title: string }>,
  sessionsBySpaceId: {} as Record<string, Array<{ id: string; title: string }>>,
}))

vi.mock('@stores/chat/useChatStore', () => ({
  useChatStore: (selector: (state: typeof chatState) => unknown) => selector(chatState),
}))

vi.mock('@/utils/browserContainerMode', () => ({
  isWebviewContainerEnabled: () => true,
}))

vi.mock('@/crawlspace/crawl-view-mouse-passthrough-depth', () => ({
  beginCrawlViewMousePassthrough: vi.fn(),
  endCrawlViewMousePassthrough: vi.fn(),
}))

import { AgentBrowserLockOverlay } from '../AgentBrowserLockOverlay'

function Harness({
  viewId,
  isActive,
  spaceId = 'space-1',
}: {
  viewId: string
  isActive: boolean
  spaceId?: string | null
}) {
  const paneRef = useRef<HTMLDivElement>(null)

  return (
    <div>
      <div ref={paneRef} data-testid="pane" />
      <AgentBrowserLockOverlay
        paneRef={paneRef}
        viewId={viewId}
        isActive={isActive}
        spaceId={spaceId}
      />
    </div>
  )
}

const PANE_SIZE = { width: 800, height: 600, top: 40, left: 80 }

let currentPane = { ...PANE_SIZE }

function mockClientRect(width: number, height: number, top = 0, left = 0): DOMRect {
  return {
    width,
    height,
    top,
    left,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  }
}

describe('AgentBrowserLockOverlay', () => {
  beforeEach(() => {
    document.body.querySelector('[data-testid="agent-browser-lock-overlay"]')?.remove()
    currentPane = { ...PANE_SIZE }
    chatState.currentSessionIdBySpaceId = { 'space-1': 'sess-1' }
    chatState.sessions = [{ id: 'sess-1', title: 'Watcha 产品调研' }]
    chatState.sessionsBySpaceId = {}
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      return setTimeout(() => cb(0), 0) as unknown as number
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      clearTimeout(id)
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if ((this as HTMLElement).dataset.testid === 'pane') {
        return mockClientRect(currentPane.width, currentPane.height, currentPane.top, currentPane.left)
      }
      return mockClientRect(0, 0)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders an overlay for the locked active tab', () => {
    render(<Harness viewId="locked-tab" isActive />)

    expect(screen.getByTestId('agent-browser-lock-overlay')).toBeTruthy()
  })

  it('hides the overlay for an unlocked tab', () => {
    render(<Harness viewId="other-tab" isActive />)

    expect(screen.queryByTestId('agent-browser-lock-overlay')).toBeNull()
    expect(screen.queryByTestId('agent-browser-lock-banner')).toBeNull()
  })

  it('hides the overlay when the locked tab is not active', () => {
    render(<Harness viewId="locked-tab" isActive={false} />)

    expect(screen.queryByTestId('agent-browser-lock-overlay')).toBeNull()
  })

  it('shows a flowing edge gradient without blurring the page', () => {
    render(<Harness viewId="locked-tab" isActive />)

    const overlay = screen.getByTestId('agent-browser-lock-overlay')
    const glow = screen.getByTestId('agent-browser-lock-overlay-glow')
    expect(overlay.className).toMatch(/overflow-hidden/)
    expect(overlay.className).not.toMatch(/backdrop-blur/)
    expect(glow.className).toMatch(/agent-lock-steam/)
    expect(glow.style.maskComposite).toBe('exclude')
  })

  it('keeps the overlay mounted while the pane is still 0×0 on first lock', async () => {
    currentPane = { width: 0, height: 0, top: 0, left: 0 }
    render(<Harness viewId="locked-tab" isActive />)

    expect(screen.getByTestId('agent-browser-lock-overlay')).toBeTruthy()

    currentPane = { ...PANE_SIZE }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(screen.getByTestId('agent-browser-lock-overlay').style.width).toBe('800px')
  })

  it('shows the overlay again after switching away and back through a 0-size pane', async () => {
    const { rerender } = render(<Harness viewId="locked-tab" isActive />)

    expect(screen.getByTestId('agent-browser-lock-overlay').style.width).toBe('800px')

    currentPane = { width: 0, height: 0, top: 0, left: 0 }
    rerender(<Harness viewId="locked-tab" isActive={false} />)
    expect(screen.queryByTestId('agent-browser-lock-overlay')).toBeNull()

    rerender(<Harness viewId="locked-tab" isActive />)
    currentPane = { ...PANE_SIZE }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const overlay = screen.getByTestId('agent-browser-lock-overlay')
    expect(overlay.style.width).toBe('800px')
    expect(overlay.style.height).toBe('600px')
  })

  it('shows the current conversation title and control status on the banner', () => {
    render(<Harness viewId="locked-tab" isActive />)

    expect(screen.getByTestId('agent-browser-lock-banner-title').textContent).toBe('Watcha 产品调研')
    expect(screen.getByTestId('agent-browser-lock-banner-status').textContent).toBe('Agent 正在控制')
    expect(screen.getByTestId('agent-browser-lock-banner-status').className).toMatch(/text-primary/)
    expect(screen.getByTestId('agent-browser-lock-banner').className).toMatch(/bg-background/)
    expect(screen.getByTestId('agent-browser-lock-overlay').getAttribute('aria-label')).toBe(
      'Watcha 产品调研，Agent 正在控制',
    )
  })

  it('falls back to 新任务 when spaceId is missing', () => {
    render(<Harness viewId="locked-tab" isActive spaceId={null} />)

    expect(screen.getByTestId('agent-browser-lock-banner-title').textContent).toBe('新任务')
  })

  it('falls back to 新任务 when the current session is missing', () => {
    chatState.currentSessionIdBySpaceId = {}
    render(<Harness viewId="locked-tab" isActive />)

    expect(screen.getByTestId('agent-browser-lock-banner-title').textContent).toBe('新任务')
  })

  it('reads the title from sessionsBySpaceId when it is not in sessions', () => {
    chatState.sessions = []
    chatState.sessionsBySpaceId = {
      'space-1': [{ id: 'sess-1', title: '从桶里来' }],
    }
    render(<Harness viewId="locked-tab" isActive />)

    expect(screen.getByTestId('agent-browser-lock-banner-title').textContent).toBe('从桶里来')
  })

  it('treats a blank title as 新任务', () => {
    chatState.sessions = [{ id: 'sess-1', title: '   ' }]
    render(<Harness viewId="locked-tab" isActive />)

    expect(screen.getByTestId('agent-browser-lock-banner-title').textContent).toBe('新任务')
  })

  it('truncates a long title without shrinking the status copy', () => {
    render(<Harness viewId="locked-tab" isActive />)

    expect(screen.getByTestId('agent-browser-lock-banner-title').className).toMatch(/truncate/)
    expect(screen.getByTestId('agent-browser-lock-banner-status').className).toMatch(/shrink-0/)
  })
})
