import { describe, expect, it, vi } from 'vitest'
import { CellRegionType, CellType } from './interface'
import type { ILinkCell } from './interface'
import { linkCellRenderer } from './linkCellRenderer'

describe('linkCellRenderer.onClick ', () => {
  it('calls cell.onClick on first click when Preview region hit (isActive=false)', () => {
    const onClick = vi.fn()
    const cell: ILinkCell = {
      type: CellType.Link,
      data: [{ id: '1', title: 'https://example.com' }],
      onClick,
    }

    vi.spyOn(linkCellRenderer, 'checkRegion').mockReturnValue({
      type: CellRegionType.Preview,
      data: 'https://example.com',
    })

    linkCellRenderer.onClick?.(
      cell,
      {
        width: 200,
        height: 32,
        theme: { fontSizeSM: 12 } as never,
        hoverCellPosition: [40, 10],
        isActive: false,
      },
      vi.fn(),
    )

    expect(onClick).toHaveBeenCalledOnce()
    expect(onClick).toHaveBeenCalledWith('https://example.com')
    vi.restoreAllMocks()
  })

  it('does not open single-value URL on blank click (Feishu-style; blank only activates)', () => {
    const onClick = vi.fn()
    const cell: ILinkCell = {
      type: CellType.Link,
      data: [{ id: 'https://example.com', title: 'https://example.com' }],
      onClick,
    }

    vi.spyOn(linkCellRenderer, 'checkRegion').mockReturnValue({
      type: CellRegionType.Blank,
      data: null,
    })

    linkCellRenderer.onClick?.(
      cell,
      {
        width: 200,
        height: 32,
        theme: { fontSizeSM: 12 } as never,
        hoverCellPosition: [120, 10],
        isActive: false,
      },
      vi.fn(),
    )

    expect(onClick).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('does not open single-value URL on blank click even when active (no onExpand)', () => {
    const onClick = vi.fn()
    const cell: ILinkCell = {
      type: CellType.Link,
      data: [{ id: 'https://example.com', title: 'https://example.com' }],
      onClick,
    }

    vi.spyOn(linkCellRenderer, 'checkRegion').mockReturnValue({
      type: CellRegionType.Blank,
      data: null,
    })

    linkCellRenderer.onClick?.(
      cell,
      {
        width: 200,
        height: 32,
        theme: { fontSizeSM: 12 } as never,
        hoverCellPosition: [120, 10],
        isActive: true,
      },
      vi.fn(),
    )

    expect(onClick).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('does not open record link on blank click when onExpand is set', () => {
    const onClick = vi.fn()
    const onExpand = vi.fn()
    const cell: ILinkCell = {
      type: CellType.Link,
      data: [{ id: 'rec-1', title: 'Record A' }],
      onClick,
      onExpand,
    }

    vi.spyOn(linkCellRenderer, 'checkRegion').mockReturnValue({
      type: CellRegionType.Blank,
      data: null,
    })

    linkCellRenderer.onClick?.(
      cell,
      {
        width: 200,
        height: 32,
        theme: { fontSizeSM: 12 } as never,
        hoverCellPosition: [120, 10],
        isActive: false,
      },
      vi.fn(),
    )

    expect(onClick).not.toHaveBeenCalled()
    expect(onExpand).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})
