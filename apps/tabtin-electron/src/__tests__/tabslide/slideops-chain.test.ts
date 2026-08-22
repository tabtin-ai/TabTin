import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSlideStore } from '../../../../../packages/tabslide/src/store/slide'
import {
  convertBackendToPresentation,
  convertPagesToBackend,
  type BackendProjectDetail,
} from '../../../../../packages/tabslide/src/exports/backend-adapter'
import type { Slide, SlidePresentation } from '../../../../../packages/tabslide/src/types/slides'

const makePage = (id: string, remark: string): Slide => ({
  id,
  elements: [],
  background: { type: 'solid', color: '#ffffff' },
  remark,
})

const makePresentation = (pages: Slide[]): SlidePresentation => ({
  id: 'pres-slideops',
  name: 'slideops-e2e',
  preset: '16:9',
  canvasWidth: 1920,
  canvasHeight: 1080,
  pages,
})

describe('TabSlide SlideOps Chain', () => {
  beforeEach(() => {
    useSlideStore.getState().reset()
  })

  it('新建/删除/复制/排序应保持页序、当前页与备注一致', () => {
    useSlideStore.getState().setPresentation(
      makePresentation([
        makePage('page-a', 'remark-a'),
        makePage('page-b', 'remark-b'),
        makePage('page-c', 'remark-c'),
      ]),
    )

    useSlideStore.getState().setCurrentPage(1)
    useSlideStore.getState().duplicatePage(1)

    let presentation = useSlideStore.getState().presentation
    expect(presentation?.pages.length).toBe(4)
    expect(useSlideStore.getState().currentPageIndex).toBe(2)
    expect(presentation?.pages[2]?.id).not.toBe('page-b')
    expect(presentation?.pages[2]?.remark).toBe('remark-b')

    useSlideStore.getState().reorderPages(2, 0)
    presentation = useSlideStore.getState().presentation
    expect(presentation?.pages.map((page) => page.remark || '')).toEqual([
      'remark-b',
      'remark-a',
      'remark-b',
      'remark-c',
    ])
    expect(useSlideStore.getState().currentPageIndex).toBe(0)

    useSlideStore.getState().deletePage(0)
    presentation = useSlideStore.getState().presentation
    expect(presentation?.pages.map((page) => page.remark || '')).toEqual([
      'remark-a',
      'remark-b',
      'remark-c',
    ])
    expect(useSlideStore.getState().currentPageIndex).toBe(0)

    useSlideStore.getState().addPage(1)
    presentation = useSlideStore.getState().presentation
    expect(presentation?.pages.length).toBe(4)
    expect(useSlideStore.getState().currentPageIndex).toBe(2)
    expect(presentation?.pages[2]?.elements).toEqual([])
    expect(useSlideStore.getState().isDirty).toBe(true)
  })

  it('复制页遇到历史 notes 字符串脏数据时不应崩溃', () => {
    const legacyPage = {
      ...makePage('legacy-page', 'speaker-note'),
      notes: 'legacy-string-notes',
    } as unknown as Slide

    useSlideStore.getState().setPresentation(makePresentation([legacyPage]))
    expect(() => useSlideStore.getState().duplicatePage(0)).not.toThrow()

    const pages = useSlideStore.getState().presentation?.pages || []
    expect(pages.length).toBe(2)
    expect(pages[1]?.remark).toBe('speaker-note')
    expect((pages[1] as { notes?: unknown }).notes).toBeUndefined()
  })

  it('演讲者备注在前后端转换中应映射为 notes 且顺序稳定', () => {
    const frontendPages: Slide[] = [
      makePage('page-1', 'note-1'),
      makePage('page-2', ''),
      makePage('page-3', 'note-3'),
    ]

    const reordered = [frontendPages[2]!, frontendPages[0]!, frontendPages[1]!]
    const backendPages = convertPagesToBackend(reordered)
    expect(backendPages.map((page) => page.notes || '')).toEqual(['note-3', 'note-1', ''])

    const backendProject: BackendProjectDetail = {
      id: 'ppt-1',
      name: 'slideops-backend',
      canvas_width: 1920,
      canvas_height: 1080,
      pages: backendPages,
    }
    const presentation = convertBackendToPresentation(backendProject)

    expect(presentation.pages.map((page) => page.remark || '')).toEqual([
      'note-3',
      'note-1',
      '',
    ])
  })

  it('roundRect 四角圆角 keypoints 在前后端适配转换中应保持一致', () => {
    const backendProject: BackendProjectDetail = {
      id: 'ppt-roundrect-1',
      name: 'roundrect-chain',
      canvas_width: 1920,
      canvas_height: 1080,
      pages: [
        {
          id: 'page-1',
          elements: [
            {
              id: 'shape-1',
              type: 'shape',
              x: 120,
              y: 80,
              width: 320,
              height: 180,
              rotate: 0,
              opacity: 1,
              locked: false,
              visible: true,
              props: {
                viewBox: [320, 180],
                path: 'M 20 0 L 300 0 Q 320 0 320 20 L 320 160 Q 320 180 300 180 L 20 180 Q 0 180 0 160 L 0 20 Q 0 0 20 0 Z',
                fill: '#55aaee',
                pptxShapeType: 'roundRect',
                pathFormula: 'roundRect',
                keypoints: [0.2, 0.05, 0.3, 0.1],
              },
            },
          ],
        },
      ],
    }

    const presentation = convertBackendToPresentation(backendProject)
    const shape = presentation.pages[0]?.elements[0]
    expect(shape?.type).toBe('shape')
    if (!shape || shape.type !== 'shape') return

    expect(shape.pathFormula).toBe('roundRect')
    expect(shape.keypoints).toEqual([0.2, 0.05, 0.3, 0.1])

    const backendPages = convertPagesToBackend(presentation.pages)
    const outShape = backendPages[0]?.elements?.[0]
    const outKeypoints = outShape?.props?.keypoints as number[] | undefined
    expect(outKeypoints).toEqual([0.2, 0.05, 0.3, 0.1])
  })

  it('后端未知动画 effect 应按类型降级并保留已知 effect', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const presentation = convertBackendToPresentation({
        id: 'ppt-animation-fallback',
        name: 'animation-fallback',
        canvas_width: 1920,
        canvas_height: 1080,
        pages: [
          {
            id: 'page-1',
            elements: [
              {
                id: 'el-1',
                type: 'text',
                x: 100,
                y: 80,
                width: 300,
                height: 80,
                props: {
                  content: '<p>动画元素</p>',
                  defaultFontName: 'Arial',
                  defaultColor: '#111111',
                },
              },
            ],
            animations: [
              {
                id: 'anim-in-unknown',
                elId: 'el-1',
                type: 'in',
                effect: 'unknownInEffect',
                duration: 300,
                trigger: 'click',
              },
              {
                id: 'anim-out-unknown',
                elId: 'el-1',
                type: 'out',
                effect: 'unknownOutEffect',
                duration: 300,
                trigger: 'click',
              },
              {
                id: 'anim-attention-unknown',
                elId: 'el-1',
                type: 'attention',
                effect: 'unknownAttentionEffect',
                duration: 300,
                trigger: 'click',
              },
              {
                id: 'anim-known',
                elId: 'el-1',
                type: 'in',
                effect: 'zoomIn',
                duration: 300,
                trigger: 'click',
              },
            ],
          },
        ],
      })

      const effects = presentation.pages[0]?.animations?.map((anim) => anim.effect) || []
      expect(effects).toEqual(['fadeIn', 'fadeOut', 'pulse', 'zoomIn'])
      expect(
        warnSpy.mock.calls.some(
          (call) =>
            typeof call[0] === 'string'
            && call[0].includes('[backend-adapter] 未知动画 effect "unknownInEffect"'),
        ),
      ).toBe(true)
      expect(
        warnSpy.mock.calls.some(
          (call) =>
            typeof call[0] === 'string'
            && call[0].includes('[backend-adapter] 未知动画 effect "unknownOutEffect"'),
        ),
      ).toBe(true)
      expect(
        warnSpy.mock.calls.some(
          (call) =>
            typeof call[0] === 'string'
            && call[0].includes('[backend-adapter] 未知动画 effect "unknownAttentionEffect"'),
        ),
      ).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
