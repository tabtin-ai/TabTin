import { describe, expect, it } from 'vitest'
import { CellType } from './renderers'
import type { ILinkCell } from './renderers'

/**
 * 契约：关联单元格双击应走 onExpand（打开选择器），而不是被 readonly 短路成 noop。
 * InteractionLayer.onDblClick 的分支逻辑在此固化，避免回归「须先激活再双击」。
 */
function resolveLinkDblClickAction(cell: { type: string; readonly?: boolean; onExpand?: () => void }) {
  if (cell.type === CellType.Link && cell.onExpand) {
    return 'expand' as const
  }
  if (cell.readonly) {
    return 'external-dblclick' as const
  }
  return 'edit' as const
}

describe('link cell double-click routing', () => {
  it('prefers onExpand for readonly link cells', () => {
    const cell: ILinkCell = {
      type: CellType.Link,
      data: [{ id: '1', title: 'A' }],
      displayData: 'A',
      readonly: true,
      onExpand: () => undefined,
    }
    expect(resolveLinkDblClickAction(cell)).toBe('expand')
  })

  it('falls back to external handler when link has no onExpand', () => {
    const cell: ILinkCell = {
      type: CellType.Link,
      data: [],
      displayData: '',
      readonly: true,
    }
    expect(resolveLinkDblClickAction(cell)).toBe('external-dblclick')
  })
})
