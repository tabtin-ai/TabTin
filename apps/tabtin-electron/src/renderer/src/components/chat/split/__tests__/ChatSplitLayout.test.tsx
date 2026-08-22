import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChatSplitLayout } from '../ChatSplitLayout'
import type { LayoutNode } from '@/utils/split-layout'

vi.mock('@components/layout/resizable-v4', () => ({
  LayoutGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  LayoutPanel: ({
    children,
    id,
    minSize,
  }: {
    children: React.ReactNode
    id: string
    minSize?: string
  }) => (
    <div data-testid="layout-panel" data-panel-id={id} data-min-size={minSize}>
      {children}
    </div>
  ),
  LayoutSeparator: () => <div data-testid="layout-separator" />,
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

describe('ChatSplitLayout', () => {
  it('keeps five-pane splits resizable by lowering each pane minimum size', () => {
    const layout: LayoutNode = {
      type: 'split',
      id: 'split-root',
      direction: 'horizontal',
      sizes: [0.2, 0.2, 0.2, 0.2, 0.2],
      children: Array.from({ length: 5 }, (_, index) => ({
        type: 'leaf' as const,
        paneId: `pane-${index + 1}`,
      })),
    }

    render(
      <ChatSplitLayout
        layout={layout}
        activePaneId="pane-1"
        onSetSplitSizes={vi.fn()}
        renderPane={(paneId) => <div>{paneId}</div>}
      />,
    )

    expect(screen.getAllByTestId('layout-panel')).toHaveLength(5)
    expect(screen.getAllByTestId('layout-panel').map(panel => panel.getAttribute('data-min-size'))).toEqual([
      '12%',
      '12%',
      '12%',
      '12%',
      '12%',
    ])
  })
})
