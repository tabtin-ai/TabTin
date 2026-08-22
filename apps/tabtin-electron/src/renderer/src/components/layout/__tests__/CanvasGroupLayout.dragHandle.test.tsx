import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import type { CanvasLayoutGroup } from '@stores/useCanvasLayoutStore'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN' },
  }),
}))

vi.mock('@stores/useCanvasLayoutStore', () => ({
  useCanvasLayoutStore: (
    selector: (state: {
      setActivePane: ReturnType<typeof vi.fn>
      setSplitSizes: ReturnType<typeof vi.fn>
    }) => unknown,
  ) => selector({
    setActivePane: vi.fn(),
    setSplitSizes: vi.fn(),
  }),
}))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: (
    selector: (state: { setActiveKey: ReturnType<typeof vi.fn> }) => unknown,
  ) => selector({ setActiveKey: vi.fn() }),
}))

vi.mock('@stores/useTableStore', () => ({
  useTableStore: (selector: (state: { tables: [] }) => unknown) =>
    selector({ tables: [] }),
}))

vi.mock('@stores/useCrawlTabStore', () => ({
  useCrawlTabStore: (
    selector: (state: { crawlspaceContextCache: Record<string, never> }) => unknown,
  ) => selector({ crawlspaceContextCache: {} }),
}))

vi.mock('../CanvasPaneContent', () => ({
  CanvasPaneContent: () => <div data-testid="pane-content" />,
}))

vi.mock('../resizable-v4', () => ({
  LayoutGroup: ({ children, className }: React.PropsWithChildren<{ className?: string }>) => (
    <div className={className}>{children}</div>
  ),
  LayoutPanel: ({ children, className }: React.PropsWithChildren<{ className?: string }>) => (
    <div className={className}>{children}</div>
  ),
  LayoutSeparator: ({ className }: { className?: string }) => (
    <div className={className} />
  ),
}))

vi.mock('@utils/layout/telemetry', () => ({
  startLayoutResizeTelemetry: () => ({
    cancel: vi.fn(),
    end: vi.fn(),
    persistSuccess: vi.fn(),
    persistFailed: vi.fn(),
  }),
  trackLayoutTelemetry: vi.fn(),
}))

vi.mock('@/utils/crawl-view-bounds', () => ({
  dispatchCrawlViewLayoutChange: vi.fn(),
}))

vi.mock('@components/context-space/registry', () => ({
  contextRegistry: {
    parseTabKey: (tabKey: string) => {
      const [type, id] = tabKey.split(':')
      return { type, id }
    },
  },
}))

import { CanvasGroupLayout } from '../CanvasGroupLayout'

const group: CanvasLayoutGroup = {
  id: 'group-1',
  spaceId: 'space-1',
  anchorTabKey: 'tabdoc:doc-1',
  activePaneId: 'pane-1',
  panes: [
    { id: 'pane-1', content: { tabKey: 'tabdoc:doc-1' } },
    { id: 'pane-2', content: { tabKey: 'tabdata:table-1' } },
  ],
  layout: {
    type: 'split',
    id: 'split-1',
    direction: 'horizontal',
    children: [
      { type: 'leaf', paneId: 'pane-1' },
      { type: 'leaf', paneId: 'pane-2' },
    ],
    sizes: [0.5, 0.5],
  },
  createdAt: 1,
  updatedAt: 1,
}

describe('CanvasGroupLayout · 分区拖拽手柄', () => {
  it('默认隐藏且不拦截内容，分区 hover / focus-within 时显示', () => {
    const { container } = render(<CanvasGroupLayout group={group} />)
    const handles = container.querySelectorAll<HTMLButtonElement>('[data-pane-drag-handle]')

    expect(handles).toHaveLength(2)
    handles.forEach(handle => {
      expect(handle.draggable).toBe(true)
      expect(handle.getAttribute('aria-label')).toBe('canvas.dragHandle')
      expect(handle.className).toContain('h-6')
      expect(handle.className).toContain('w-6')
      expect(handle.className).toContain('opacity-0')
      expect(handle.className).toContain('pointer-events-none')
      expect(handle.className).toContain('group-hover/pane:opacity-100')
      expect(handle.className).toContain('group-hover/pane:pointer-events-auto')
      expect(handle.className).toContain('group-focus-within/pane:opacity-100')
      expect(handle.className).toContain('group-focus-within/pane:pointer-events-auto')
      expect(handle.className).toContain('focus-visible:ring-2')
    })
  })
})
