import { fireEvent, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkdirPaneShell } from './WorkdirPaneShell'

const resizeSession = {
  cancel: vi.fn(),
  end: vi.fn(),
  persistSuccess: vi.fn(),
}

vi.mock('@utils/layout/telemetry', () => ({
  startLayoutResizeTelemetry: vi.fn(() => resizeSession),
  trackLayoutTelemetry: vi.fn(),
}))

describe('WorkdirPaneShell', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps a generated-width hit target and resizes the preserved sidebar', () => {
    const { container } = render(
      <WorkdirPaneShell
        layoutId="file-explorer-test"
        surface="file-explorer"
        header={<div>Header</div>}
        sidebar={<div>Sidebar</div>}
        preserveSidebarOnContentToggle
        sidebarDefaultWidth={280}
      >
        <div>Preview</div>
      </WorkdirPaneShell>,
    )

    const handle = container.querySelector<HTMLElement>('[class*="group/resize"]')
    expect(handle).not.toBeNull()
    expect(handle?.classList.contains('w-2')).toBe(true)
    // ：分割手柄不得用 z-dropdown/z-modal 等浮层层级，否则会盖住弹窗。
    expect(handle?.className).toContain('z-sticky')
    expect(handle?.className).not.toMatch(/z-(dropdown|modal|toast|global|overlay)/)

    const line = handle?.querySelector<HTMLElement>(':scope > div')
    expect(line?.className).toContain('bg-border/60')
    expect(line?.className).toContain('w-px')
    expect(line?.className).not.toContain('group-hover/resize:bg-muted-foreground')

    const sidebar = handle?.parentElement
    expect(sidebar?.className).toContain('bg-muted/20')
    expect(sidebar?.style.width).toBe('280px')

    fireEvent.mouseDown(handle!, { clientX: 280 })
    fireEvent.mouseMove(document, { clientX: 300 })
    fireEvent.mouseUp(document)

    expect(sidebar?.style.width).toBe(`${Math.round(300 * (window.devicePixelRatio || 1)) / (window.devicePixelRatio || 1)}px`)
    expect(resizeSession.end).toHaveBeenCalledWith({
      finalWidth: Math.round(Number.parseFloat(sidebar?.style.width || '0')),
      driver: 'workdir-flex-sidebar',
    })
  })

  it('keeps sidebar pixel width stable when parent width changes', () => {
    const { container, rerender } = render(
      <div style={{ width: 900 }}>
        <WorkdirPaneShell
          layoutId="tabcode-test"
          surface="tabcode"
          header={<div>Header</div>}
          sidebar={<div>Sidebar</div>}
          sidebarDefaultWidth={260}
        >
          <div>Preview</div>
        </WorkdirPaneShell>
      </div>,
    )

    const sidebar = container.querySelector<HTMLElement>('#workdir-pane-tree-tabcode-test')
    expect(sidebar?.style.width).toBe('260px')

    rerender(
      <div style={{ width: 620 }}>
        <WorkdirPaneShell
          layoutId="tabcode-test"
          surface="tabcode"
          header={<div>Header</div>}
          sidebar={<div>Sidebar</div>}
          sidebarDefaultWidth={260}
        >
          <div>Preview</div>
        </WorkdirPaneShell>
      </div>,
    )

    expect(sidebar?.style.width).toBe('260px')
  })

  it('hides the sidebar and keeps content when sidebarCollapsed', () => {
    const { container, rerender } = render(
      <WorkdirPaneShell
        layoutId="collapse-test"
        surface="tabcode"
        header={<div>Header</div>}
        sidebar={<div>Sidebar</div>}
        sidebarCollapsed={false}
      >
        <div>Preview</div>
      </WorkdirPaneShell>,
    )

    expect(container.querySelector('[data-testid="workdir-pane-sidebar"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="workdir-pane-content"]')?.className).not.toContain('hidden')

    rerender(
      <WorkdirPaneShell
        layoutId="collapse-test"
        surface="tabcode"
        header={<div>Header</div>}
        sidebar={<div>Sidebar</div>}
        sidebarCollapsed
        contentVisible={false}
      >
        <div>Preview</div>
      </WorkdirPaneShell>,
    )

    expect(container.querySelector('[data-testid="workdir-pane-sidebar"]')).toBeNull()
    expect(container.querySelector('[data-testid="workdir-pane-content"]')?.className).not.toContain('hidden')
  })
})
