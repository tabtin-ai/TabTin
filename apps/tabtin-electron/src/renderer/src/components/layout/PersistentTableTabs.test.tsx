import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PersistentTableTabs } from './PersistentTableTabs'

const setUnloadedTableIds = vi.fn()

vi.mock('@components/table/portal/TablePanePortalContext', () => ({
  useTablePanePortal: () => ({
    setUnloadedTableIds,
  }),
}))

vi.mock('@components/table/portal/TablePanePortalHost', () => ({
  TablePanePortalHost: ({ tableId }: { tableId: string }) => (
    <div data-testid={`table-host-${tableId}`} data-table-tab-id={tableId} />
  ),
}))

describe('PersistentTableTabs', () => {
  beforeEach(() => {
    setUnloadedTableIds.mockClear()
  })

  it('does not render inactive unloaded placeholder while still publishing unload state', async () => {
    const tableIds = ['t1', 't2', 't3', 't4', 't5', 't6']

    render(
      <PersistentTableTabs
        tableIds={tableIds}
        activeTableId="t1"
      />,
    )

    expect(screen.getByTestId('table-host-t1')).toBeTruthy()
    expect(screen.queryByTestId('table-host-t6')).toBeNull()
    expect(document.querySelector('[data-table-unloaded="true"]')).toBeNull()
    await waitFor(() => {
      expect(setUnloadedTableIds).toHaveBeenCalledWith(expect.objectContaining({
        has: expect.any(Function),
      }))
    })
    const publishedSets = setUnloadedTableIds.mock.calls
      .map(([ids]) => ids)
      .filter((ids): ids is ReadonlySet<string> => ids instanceof Set)
    expect(publishedSets.some(ids => ids.has('t6'))).toBe(true)
  })
})
