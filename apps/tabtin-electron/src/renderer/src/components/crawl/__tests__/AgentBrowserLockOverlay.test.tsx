import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRef } from 'react'

const mocks = vi.hoisted(() => ({
  lockedViewIds: ['locked-tab'] as string[],
  userControlledViewIds: [] as string[],
  beginMousePassthrough: vi.fn(),
  endMousePassthrough: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key === 'embedded.agentControlStatus'
      ? 'Agent 正在控制'
      : key,
  }),
}))

vi.mock('@stores/useBrowserTabLockStore', () => ({
  useBrowserTabLockStore: (
    selector: (state: {
      isLocked: (id: string) => boolean
      isUserControlling: (id: string) => boolean
    }) => unknown,
  ) => selector({
    isLocked: (id) => mocks.lockedViewIds.includes(id),
    isUserControlling: (id) => mocks.userControlledViewIds.includes(id),
  }),
}))

vi.mock('@/utils/browserContainerMode', () => ({
  isWebviewContainerEnabled: () => true,
}))

vi.mock('@/crawlspace/crawl-view-mouse-passthrough-depth', () => ({
  beginCrawlViewMousePassthrough: mocks.beginMousePassthrough,
  endCrawlViewMousePassthrough: mocks.endMousePassthrough,
}))

import { AgentBrowserLockOverlay } from '../AgentBrowserLockOverlay'

function Harness({
  viewId,
  isActive,
}: {
  viewId: string
  isActive: boolean
}) {
  const paneRef = useRef<HTMLDivElement>(null)

  return (
    <div>
      <div ref={paneRef} data-testid="pane" />
      <AgentBrowserLockOverlay
        paneRef={paneRef}
        viewId={viewId}
        isActive={isActive}
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
    mocks.lockedViewIds = ['locked-tab']
    mocks.userControlledViewIds = []
    mocks.beginMousePassthrough.mockReset()
    mocks.endMousePassthrough.mockReset()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      return setTimeout(() => cb(0), 0) as unknown as number
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      clearTimeout(id)
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === 'pane') {
        return mockClientRect(currentPane.width, currentPane.height, currentPane.top, currentPane.left)
      }
      return mockClientRect(0, 0)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('只为 Agent 锁定的活动标签渲染锁膜', () => {
    const { rerender } = render(<Harness viewId="locked-tab" isActive />)
    expect(screen.getByTestId('agent-browser-lock-overlay')).toBeTruthy()

    rerender(<Harness viewId="other-tab" isActive />)
    expect(screen.queryByTestId('agent-browser-lock-overlay')).toBeNull()

    rerender(<Harness viewId="locked-tab" isActive={false} />)
    expect(screen.queryByTestId('agent-browser-lock-overlay')).toBeNull()
  })

  it('用户接管时移除锁膜并恢复 webview pointer events', () => {
    const { rerender } = render(<Harness viewId="locked-tab" isActive />)
    expect(mocks.beginMousePassthrough).toHaveBeenCalledTimes(1)

    mocks.lockedViewIds = []
    mocks.userControlledViewIds = ['locked-tab']
    rerender(<Harness viewId="locked-tab" isActive />)

    expect(screen.queryByTestId('agent-browser-lock-overlay')).toBeNull()
    expect(mocks.endMousePassthrough).toHaveBeenCalledTimes(1)
  })

  it('只保留品牌环和轻遮罩，不再渲染胶囊或任务标题', () => {
    render(<Harness viewId="locked-tab" isActive />)

    expect(screen.getByTestId('agent-browser-lock-overlay-glow')).toBeTruthy()
    expect(screen.getByTestId('agent-browser-lock-overlay-fill')).toBeTruthy()
    expect(screen.queryByTestId('agent-browser-lock-banner')).toBeNull()
    expect(screen.queryByText('Agent 正在控制')).toBeNull()
    expect(screen.getByTestId('agent-browser-lock-overlay').getAttribute('aria-label'))
      .toBe('Agent 正在控制')
  })

  it('品牌流光保持 5px 环且不模糊网页', () => {
    render(<Harness viewId="locked-tab" isActive />)

    const overlay = screen.getByTestId('agent-browser-lock-overlay')
    const glow = screen.getByTestId('agent-browser-lock-overlay-glow')
    const style = glow.getAttribute('style') ?? ''
    expect(overlay.className).toMatch(/overflow-hidden/)
    expect(overlay.className).not.toMatch(/backdrop-blur/)
    expect(glow.className).toMatch(/agent-lock-steam/)
    expect(glow.style.padding).toBe('5px')
    expect(glow.style.maskComposite).toBe('exclude')
    expect(style).toContain('content-box')
    expect(style).toMatch(/linear-gradient\([^)]*(?:#000\b|#000000\b|\bblack\b|hsl\(\s*0\s+0%\s+0%\s*\)|rgb\(\s*0[,\s]+0[,\s]+0\s*\))/)
  })

  it('初次锁定面板为 0×0 时保持挂载并等待可用尺寸', async () => {
    currentPane = { width: 0, height: 0, top: 0, left: 0 }
    render(<Harness viewId="locked-tab" isActive />)
    expect(screen.getByTestId('agent-browser-lock-overlay')).toBeTruthy()

    currentPane = { ...PANE_SIZE }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(screen.getByTestId('agent-browser-lock-overlay').style.width).toBe('800px')
  })
})
