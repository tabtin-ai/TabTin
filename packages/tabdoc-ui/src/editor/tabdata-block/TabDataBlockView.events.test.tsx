/** @vitest-environment jsdom */

import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockOpenResource } = vi.hoisted(() => ({
  mockOpenResource: vi.fn(),
}))

vi.mock('@tiptap/react', () => ({
  NodeViewWrapper: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key }),
}))

vi.mock('../../TabDocHostActionsContext', () => ({
  useTabDocHostActions: () => ({ openResource: mockOpenResource }),
}))

vi.mock('./useInViewport', () => ({ useInViewport: () => true }))

import { configureTabDataBlockView, TabDataBlockView } from './TabDataBlockView'

describe('TabDataBlockView 编辑事件边界', () => {
  beforeEach(() => {
    mockOpenResource.mockReset()
    mockOpenResource.mockResolvedValue(undefined)
    configureTabDataBlockView({
      renderTableEmbed: () => <input data-testid="embedded-cell" />,
    })
  })

  it.each(['Delete', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'])(
    '%s 留在嵌入表格内，不冒泡给父文档编辑器',
    (key) => {
      const onParentKeyDown = vi.fn()
      render(
        <div onKeyDown={onParentKeyDown}>
          <TabDataBlockView
            {...({
              node: { attrs: { tableId: 'table-1', title: '表格' } },
              deleteNode: vi.fn(),
              updateAttributes: vi.fn(),
              selected: false,
            } as never)}
          />
        </div>,
      )

      fireEvent.keyDown(screen.getByTestId('embedded-cell'), { key })
      expect(onParentKeyDown).not.toHaveBeenCalled()
    },
  )

  it('剪贴板与输入法组合事件不冒泡给父文档编辑器', () => {
    const onPaste = vi.fn()
    const onCopy = vi.fn()
    const onCut = vi.fn()
    const onCompositionStart = vi.fn()
    render(
      <div
        onPaste={onPaste}
        onCopy={onCopy}
        onCut={onCut}
        onCompositionStart={onCompositionStart}
      >
        <TabDataBlockView
          {...({
            node: { attrs: { tableId: 'table-1', title: '表格' } },
            deleteNode: vi.fn(),
            updateAttributes: vi.fn(),
            selected: false,
          } as never)}
        />
      </div>,
    )

    const cell = screen.getByTestId('embedded-cell')
    fireEvent.paste(cell)
    fireEvent.copy(cell)
    fireEvent.cut(cell)
    fireEvent.compositionStart(cell)

    expect(onPaste).not.toHaveBeenCalled()
    expect(onCopy).not.toHaveBeenCalled()
    expect(onCut).not.toHaveBeenCalled()
    expect(onCompositionStart).not.toHaveBeenCalled()
  })

  it('鼠标选择留在嵌入表格内，不触发父文档富文本工具栏', () => {
    const onMouseDown = vi.fn()
    const onClick = vi.fn()
    const onDoubleClick = vi.fn()
    const onContextMenu = vi.fn()
    render(
      <div
        onMouseDown={onMouseDown}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      >
        <TabDataBlockView
          {...({
            node: { attrs: { tableId: 'table-1', title: '表格' } },
            deleteNode: vi.fn(),
            updateAttributes: vi.fn(),
            selected: false,
          } as never)}
        />
      </div>,
    )

    const cell = screen.getByTestId('embedded-cell')
    fireEvent.mouseDown(cell)
    fireEvent.click(cell)
    fireEvent.doubleClick(cell)
    fireEvent.contextMenu(cell)

    expect(onMouseDown).not.toHaveBeenCalled()
    expect(onClick).not.toHaveBeenCalled()
    expect(onDoubleClick).not.toHaveBeenCalled()
    expect(onContextMenu).not.toHaveBeenCalled()
  })

  it('打开详情前先提交当前单元格的失焦编辑', async () => {
    configureTabDataBlockView({
      renderTableEmbed: ({ onOpenInTab }) => (
        <>
          <input data-testid="embedded-cell" />
          <button type="button" onClick={onOpenInTab}>详情</button>
        </>
      ),
    })
    render(
      <TabDataBlockView
        {...({
          node: { attrs: { tableId: 'table-1', title: '表格' } },
          deleteNode: vi.fn(),
          updateAttributes: vi.fn(),
          selected: false,
        } as never)}
      />,
    )

    const cell = screen.getByTestId('embedded-cell')
    cell.focus()
    expect(document.activeElement).toBe(cell)
    mockOpenResource.mockImplementation(async () => {
      expect(document.activeElement).not.toBe(cell)
    })

    fireEvent.click(screen.getByRole('button', { name: '详情' }))

    await vi.waitFor(() => expect(mockOpenResource).toHaveBeenCalledWith({
      resourceType: 'tabdata',
      resourceId: 'table-1',
      title: '表格',
    }))
  })
})
