import React from 'react'
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TablePanePortalProvider } from './TablePanePortalContext'
import { TablePanePortalHost } from './TablePanePortalHost'
import { TablePanePortalLayer } from './TablePanePortalLayer'

vi.mock('@components/table/TablePaneView', () => ({
  TablePaneView: ({ tableId }: { tableId: string }) => (
    <div data-testid={`table-pane-${tableId}`}>table content</div>
  ),
}))

vi.mock('@components/common/ListSkeletons', () => ({
  TablePreviewSkeleton: () => <div data-testid="table-preview-skeleton" />,
}))

const TABLE_ID = 'table-1'

const Harness = ({ showHost }: { showHost: boolean }) => (
  <TablePanePortalProvider>
    {showHost ? <TablePanePortalHost tableId={TABLE_ID} /> : null}
    <TablePanePortalLayer tableIds={[TABLE_ID]} />
  </TablePanePortalProvider>
)

describe('TablePanePortalLayer', () => {
  let rafId = 0
  let rafCallbacks: Map<number, FrameRequestCallback>

  beforeEach(() => {
    rafCallbacks = new Map()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      rafId += 1
      rafCallbacks.set(rafId, callback)
      return rafId
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      rafCallbacks.delete(id)
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const flushAnimationFrames = () => {
    const callbacks = Array.from(rafCallbacks.values())
    rafCallbacks.clear()
    callbacks.forEach(callback => callback(0))
  }

  it('moves a parked pane into a newly registered slot before the next animation frame', () => {
    const view = render(<Harness showHost />)

    act(flushAnimationFrames)
    const root = document.querySelector<HTMLElement>(`[data-table-pane-root="${TABLE_ID}"]`)
    const initialSlot = document.querySelector<HTMLElement>(`[data-table-pane-slot="${TABLE_ID}"]`)
    expect(root).not.toBeNull()
    expect(root?.parentElement).toBe(initialSlot)

    view.rerender(<Harness showHost={false} />)
    act(flushAnimationFrames)
    expect(root?.parentElement?.getAttribute('data-table-pane-parking')).toBe('true')
    expect(root?.style.contentVisibility).toBe('hidden')

    view.rerender(<Harness showHost />)
    const restoredSlot = document.querySelector<HTMLElement>(`[data-table-pane-slot="${TABLE_ID}"]`)

    expect(document.querySelector(`[data-table-pane-root="${TABLE_ID}"]`)).toBe(root)
    expect(root?.parentElement).toBe(restoredSlot)
    expect(root?.style.contentVisibility).toBe('visible')

    act(flushAnimationFrames)
    expect(root?.parentElement).toBe(restoredSlot)
  })
})
