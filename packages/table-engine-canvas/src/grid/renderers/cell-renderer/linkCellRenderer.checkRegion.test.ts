import { describe, expect, it } from 'vitest'
import { GRID_DEFAULT } from '../../configs'
import { CellRegionType, CellType } from './interface'
import type { ILinkCell } from './interface'
import { linkCellRenderer } from './linkCellRenderer'

const { cellHorizontalPadding } = GRID_DEFAULT

describe('linkCellRenderer.checkRegion ', () => {
  const cell: ILinkCell = {
    type: CellType.Link,
    data: [{ id: 'https://example.com', title: 'https://example.com' }],
    onClick: () => {},
  }

  const baseProps = {
    width: 240,
    height: 36,
    theme: {
      fontSizeSM: 12,
      fontFamily: 'sans-serif',
      fontWeight: '',
    } as never,
    isActive: false,
  }

  it('documents tree-indent hover offset: column-relative X misses tag when indent not subtracted', () => {
    const treeIndent = 40
    const region = linkCellRenderer.checkRegion?.(cell, {
      ...baseProps,
      hoverCellPosition: [treeIndent + cellHorizontalPadding + 40, 18],
    })

    expect(region?.type).toBe(CellRegionType.Blank)
  })
})
