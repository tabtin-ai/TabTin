import React from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useSlideStore } from '../../../../../packages/tabslide/src/store/slide'
import { SlideTab } from '../../../../../packages/tabslide/src/panels/right-sidebar/SlideTab'
import AlignToolbar from '../../../../../packages/tabslide/src/toolbar/AlignToolbar'
import SlideRenderer from '../../../../../packages/tabslide/src/components/SlideRenderer'
import type { PPTTextElement, SlidePresentation } from '../../../../../packages/tabslide/src/types/slides'

const makeText = (id: string): PPTTextElement => ({
  id,
  type: 'text',
  x: 120,
  y: 80,
  width: 200,
  height: 60,
  rotate: 0,
  opacity: 1,
  locked: false,
  content: `<p>${id}</p>`,
  defaultFontName: 'Arial',
  defaultColor: '#111111',
})

const makeTextPair = (): [PPTTextElement, PPTTextElement] => ([
  makeText('text-1'),
  {
    ...makeText('text-2'),
    x: 420,
    y: 220,
  },
])

const makePresentation = (elements: PPTTextElement[]): SlidePresentation => ({
  id: 'pres-canvas-assist',
  name: 'canvas-assist',
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

describe('TabSlide Canvas Assist Placement Chain', () => {
  beforeEach(() => {
    useSlideStore.getState().reset()
    useSlideStore.getState().resetEditorConfig()
  })

  it('应在 SlideTab 中提供三项画布辅助开关，并可直接更新 editorConfig', () => {
    useSlideStore.getState().setPresentation(makePresentation([]))
    render(<SlideTab />)

    const smartGuides = screen.getByLabelText('property.canvasAssist.snapToGuides') as HTMLInputElement
    const gridSnap = screen.getByLabelText('property.canvasAssist.snapToGrid') as HTMLInputElement
    const showGrid = screen.getByLabelText('property.canvasAssist.showGrid') as HTMLInputElement

    expect(smartGuides.checked).toBe(true)
    expect(gridSnap.checked).toBe(true)
    expect(showGrid.checked).toBe(false)

    fireEvent.click(smartGuides)
    fireEvent.click(gridSnap)
    fireEvent.click(showGrid)

    const cfg = useSlideStore.getState().editorConfig
    expect(cfg.snapToGuides).toBe(false)
    expect(cfg.snapToGrid).toBe(false)
    expect(cfg.showGrid).toBe(true)
  })

  it('顶栏 AlignToolbar 不应再渲染画布辅助开关，仅保留对齐能力', () => {
    const [textA, textB] = makeTextPair()
    useSlideStore.getState().setPresentation(makePresentation([textA, textB]))
    useSlideStore.getState().selectElements([textA.id, textB.id])

    render(<AlignToolbar />)

    expect(screen.getByTitle('align.left')).toBeTruthy()
    expect(screen.queryByTitle('align.enableSmartGuides')).toBeNull()
    expect(screen.queryByTitle('align.disableSmartGuides')).toBeNull()
    expect(screen.queryByTitle('align.enableGridSnap')).toBeNull()
    expect(screen.queryByTitle('align.disableGridSnap')).toBeNull()
    expect(screen.queryByTitle('align.showGrid')).toBeNull()
    expect(screen.queryByTitle('align.hideGrid')).toBeNull()
    expect(screen.queryByTitle('align.canvasCenter')).toBeNull()
    expect(screen.queryByTitle('align.canvasHCenter')).toBeNull()
    expect(screen.queryByTitle('align.canvasVCenter')).toBeNull()
  })

  it('SlideRenderer 开启 showGrid 时应渲染网格层，且网格尺寸与配置一致', () => {
    const presentation = makePresentation([])
    const page = presentation.pages[0]
    expect(page).toBeDefined()

    render(
      <SlideRenderer
        page={page!}
        canvasWidth={presentation.canvasWidth}
        canvasHeight={presentation.canvasHeight}
        showGrid
        gridSize={24}
      />,
    )

    const grid = screen.getByTestId('tabslide-grid-overlay')
    expect(grid).toBeTruthy()
    expect((grid as HTMLElement).style.backgroundSize).toBe('24px 24px')
  })
})
