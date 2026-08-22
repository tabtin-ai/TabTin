import React from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { useSlideStore } from '../../../../../packages/tabslide/src/store/slide'
import ElementRenderer from '../../../../../packages/tabslide/src/components/elements/ElementRenderer'
import { getShapePath } from '../../../../../packages/tabslide/src/configs/shapes'
import { shouldAppendSelection } from '../../../../../packages/tabslide/src/utils/modifier'
import type {
  PPTElement,
  PPTImageElement,
  PPTShapeElement,
  PPTTableElement,
  PPTTextElement,
  SlidePresentation,
} from '../../../../../packages/tabslide/src/types/slides'

const makeText = (id: string, x: number, y: number): PPTTextElement => ({
  id,
  type: 'text',
  x,
  y,
  width: 180,
  height: 60,
  rotate: 0,
  opacity: 1,
  locked: false,
  content: `<p>${id}</p>`,
  defaultFontName: 'Arial',
  defaultColor: '#111111',
})

const makeImage = (id: string): PPTImageElement => ({
  id,
  type: 'image',
  x: 120,
  y: 80,
  width: 320,
  height: 180,
  rotate: 0,
  opacity: 1,
  locked: false,
  src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
  fixedRatio: true,
})

const makeRoundRectShape = (id: string, width = 200, height = 100): PPTShapeElement => ({
  id,
  type: 'shape',
  x: 80,
  y: 120,
  width,
  height,
  rotate: 0,
  opacity: 1,
  locked: false,
  viewBox: [200, 150],
  pathFormula: 'roundRect',
  keypoints: [0.1],
  path: getShapePath('roundRect', '', width, height, [0.1]),
  fill: '#5b9bd5',
  fixedRatio: false,
  pptxShapeType: 'roundRect',
})

const makeTable = (id: string, locked = false): PPTTableElement => ({
  id,
  type: 'table',
  x: 160,
  y: 200,
  width: 420,
  height: 220,
  rotate: 0,
  opacity: 1,
  locked,
  data: [
    [
      { id: `${id}-r0c0`, text: 'A1', colspan: 1, rowspan: 1 },
      { id: `${id}-r0c1`, text: 'B1', colspan: 1, rowspan: 1 },
    ],
    [
      { id: `${id}-r1c0`, text: 'A2', colspan: 1, rowspan: 1 },
      { id: `${id}-r1c1`, text: 'B2', colspan: 1, rowspan: 1 },
    ],
  ],
  colWidths: [0.5, 0.5],
  cellMinHeight: 36,
  outline: { style: 'solid', width: 1, color: '#d0d0d0' },
})

const makePresentation = (elements: PPTElement[]): SlidePresentation => ({
  id: 'pres-interactive',
  name: 'interactive-moveable',
  preset: '16:9',
  canvasWidth: 1920,
  canvasHeight: 1080,
  pages: [
    {
      id: 'page-1',
      elements,
      background: { type: 'solid', color: '#ffffff' },
    },
  ],
})

describe('TabSlide Interactive / Moveable Chain', () => {
  beforeEach(() => {
    useSlideStore.getState().reset()
  })

  it('修饰键判定应支持 Win/Linux Ctrl 追加选择，且不污染 mac Ctrl+Click 语义', () => {
    expect(
      shouldAppendSelection(
        { shiftKey: false, metaKey: false, ctrlKey: true } as Pick<MouseEvent, 'shiftKey' | 'metaKey' | 'ctrlKey'>,
        'Win32',
      ),
    ).toBe(true)
    expect(
      shouldAppendSelection(
        { shiftKey: false, metaKey: false, ctrlKey: true } as Pick<MouseEvent, 'shiftKey' | 'metaKey' | 'ctrlKey'>,
        'MacIntel',
      ),
    ).toBe(false)
    expect(
      shouldAppendSelection(
        { shiftKey: false, metaKey: true, ctrlKey: false } as Pick<MouseEvent, 'shiftKey' | 'metaKey' | 'ctrlKey'>,
        'MacIntel',
      ),
    ).toBe(true)
  })

  it('图片元素双击应直接进入裁剪编辑模式（不依赖先选中再双击 Moveable）', () => {
    const image = makeImage('img-1')
    useSlideStore.getState().setPresentation(makePresentation([image]))

    const { container } = render(
      <ElementRenderer
        element={image}
        editingElementId={useSlideStore.getState().editingElementId}
      />,
    )

    const wrapper = container.querySelector('[data-element-id="img-1"]')
    expect(wrapper).not.toBeNull()
    fireEvent.doubleClick(wrapper as HTMLElement)

    const state = useSlideStore.getState()
    expect(state.isEditing).toBe(true)
    expect(state.editingElementId).toBe('img-1')
  })

  it('shape pathFormula 元素在尺寸更新后应同步重算 path，避免存储层 path 失真', () => {
    const shape = makeRoundRectShape('shape-1', 200, 100)
    useSlideStore.getState().setPresentation(makePresentation([shape]))

    useSlideStore.getState().updateElement('shape-1', {
      width: 320,
      height: 160,
    })

    const page = useSlideStore.getState().currentPage()
    const updated = page?.elements.find((el) => el.id === 'shape-1') as PPTShapeElement | undefined
    expect(updated).toBeDefined()
    expect(updated?.width).toBe(320)
    expect(updated?.height).toBe(160)
    expect(updated?.path).toBe(
      getShapePath('roundRect', shape.path, 320, 160, [0.1]),
    )
  })

  it('批量更新接口应在一次 store 提交内同步更新多元素', () => {
    const a = makeText('a', 20, 40)
    const b = makeText('b', 260, 380)
    useSlideStore.getState().setPresentation(makePresentation([a, b]))

    useSlideStore.getState().updateElements([
      { id: 'a', updates: { x: 120.1234, y: 220.5678 } },
      { id: 'b', updates: { x: 420.3333, y: 520.9999 } },
    ])

    const page = useSlideStore.getState().currentPage()
    expect(page?.elements.find((el) => el.id === 'a')?.x).toBe(120.123)
    expect(page?.elements.find((el) => el.id === 'a')?.y).toBe(220.568)
    expect(page?.elements.find((el) => el.id === 'b')?.x).toBe(420.333)
    expect(page?.elements.find((el) => el.id === 'b')?.y).toBe(521)
    expect(useSlideStore.getState().isDirty).toBe(true)
  })

  it('表格进入编辑态后应自动进入首个可编辑单元格，避免仅隐藏 Moveable 但无法输入', async () => {
    const table = makeTable('table-1')
    useSlideStore.getState().setPresentation(makePresentation([table]))
    useSlideStore.getState().setEditing('table-1')

    const { container } = render(
      <ElementRenderer
        element={table}
        editingElementId={useSlideStore.getState().editingElementId}
      />,
    )

    await waitFor(() => {
      expect(container.querySelector('[contenteditable="true"]')).not.toBeNull()
    })

    expect(useSlideStore.getState().editingElementId).toBe('table-1')
  })

  it('锁定元素不应进入编辑态（文本/表格）', async () => {
    const lockedText: PPTTextElement = { ...makeText('text-locked', 40, 80), locked: true }
    const lockedTable = makeTable('table-locked', true)
    useSlideStore.getState().setPresentation(makePresentation([lockedText, lockedTable]))

    const textRender = render(
      <ElementRenderer
        element={lockedText}
        editingElementId={useSlideStore.getState().editingElementId}
      />,
    )
    const textBody = textRender.container.querySelector(`#tabslide-text-${lockedText.id}`)
    expect(textBody).not.toBeNull()
    fireEvent.doubleClick(textBody as HTMLElement)

    expect(useSlideStore.getState().isEditing).toBe(false)
    expect(useSlideStore.getState().editingElementId).toBe(null)
    textRender.unmount()

    const tableRender = render(
      <ElementRenderer
        element={lockedTable}
        editingElementId={useSlideStore.getState().editingElementId}
      />,
    )
    const firstCell = tableRender.container.querySelector('td')
    expect(firstCell).not.toBeNull()
    fireEvent.doubleClick(firstCell as HTMLElement)

    await waitFor(() => {
      expect(tableRender.container.querySelector('[contenteditable="true"]')).toBeNull()
    })
    expect(useSlideStore.getState().isEditing).toBe(false)
    expect(useSlideStore.getState().editingElementId).toBe(null)
  })
})
