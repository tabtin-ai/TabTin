import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiService } from '@/services/api'
import {
  buildFirstSlideFingerprint,
  buildSaveBaseline,
  diffIncrementalSave,
  ensureProjectId,
} from '@/components/slide/autosave-utils'
import {
  convertBackendToPresentation,
  convertPagesToBackend,
  type BackendProjectDetail,
} from '../../../../../packages/tabslide/src/exports/backend-adapter'
import type {
  PPTShapeElement,
  PPTTextElement,
  Slide,
  SlidePresentation,
} from '../../../../../packages/tabslide/src/types/slides'

const makeTextElement = (): PPTTextElement => ({
  id: 'text-1',
  type: 'text',
  x: 120,
  y: 80,
  width: 400,
  height: 120,
  rotate: 15,
  opacity: 0.76,
  locked: true,
  visible: false,
  groupId: 'group-1',
  groupName: '标题组',
  flipH: true,
  content: '<p>Hello Autosave</p>',
  defaultFontName: 'Arial',
  defaultColor: '#111111',
  link: {
    type: 'web',
    target: 'https://example.com',
  },
})

const makeShapeElement = (): PPTShapeElement => ({
  id: 'shape-1',
  type: 'shape',
  x: 640,
  y: 160,
  width: 240,
  height: 160,
  rotate: 5,
  opacity: 0.5,
  locked: false,
  groupId: 'group-1',
  groupName: '标题组',
  flipH: true,
  flipV: true,
  fill: '#ff8800',
  fixedRatio: false,
  viewBox: [240, 160],
  path: 'M 0 0 L 240 0 L 240 160 L 0 160 Z',
})

const makePresentation = (overrides?: Partial<SlidePresentation>): SlidePresentation => ({
  id: 'pres-1',
  name: 'autosave-test',
  preset: '16:9',
  canvasWidth: 1920,
  canvasHeight: 1080,
  theme: {
    backgroundColor: '#ffffff',
    themeColors: ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47'],
    fontColor: '#111111',
    fontName: 'Arial',
  },
  pages: [
    {
      id: 'page-1',
      background: { type: 'solid', color: '#ffffff' },
      remark: 'speaker notes A',
      elements: [makeTextElement(), makeShapeElement()],
    },
  ],
  ...overrides,
})

const mapPresetForTest = (preset: SlidePresentation['preset']) => (preset === '16:9' ? 'ppt' : 'custom')

const getContextForTest = () => ({ organizationId: 'ws-1', spaceId: 'agent-space-1' })

describe('TabSlide AutoSave & Persistence Chain', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    window.localStorage.clear()
  })

  it('第一张页指纹应稳定，键顺序变化与备注变化不应触发重复同步', () => {
    const baseline = makePresentation()

    const reordered = makePresentation({
      theme: {
        fontName: 'Arial',
        fontColor: '#111111',
        themeColors: ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47'],
        backgroundColor: '#ffffff',
      },
      pages: [
        {
          id: 'page-1',
          background: { color: '#ffffff', type: 'solid' },
          remark: 'speaker notes B',
          elements: [
            {
              defaultColor: '#111111',
              defaultFontName: 'Arial',
              content: '<p>Hello Autosave</p>',
              flipH: true,
              groupName: '标题组',
              groupId: 'group-1',
              visible: false,
              locked: true,
              opacity: 0.76,
              rotate: 15,
              height: 120,
              width: 400,
              y: 80,
              x: 120,
              type: 'text',
              id: 'text-1',
              link: {
                target: 'https://example.com',
                type: 'web',
              },
            } as PPTTextElement,
            {
              path: 'M 0 0 L 240 0 L 240 160 L 0 160 Z',
              viewBox: [240, 160],
              fixedRatio: false,
              fill: '#ff8800',
              flipV: true,
              flipH: true,
              groupName: '标题组',
              groupId: 'group-1',
              locked: false,
              opacity: 0.5,
              rotate: 5,
              height: 160,
              width: 240,
              y: 160,
              x: 640,
              type: 'shape',
              id: 'shape-1',
            } as PPTShapeElement,
          ],
        },
      ],
    })

    const baselineFingerprint = buildFirstSlideFingerprint(baseline)
    const reorderedFingerprint = buildFirstSlideFingerprint(reordered)
    expect(reorderedFingerprint).toBe(baselineFingerprint)

    const visualChanged = makePresentation({
      pages: [
        {
          ...baseline.pages[0]!,
          elements: [
            {
              ...makeTextElement(),
              x: 121,
            },
            makeShapeElement(),
          ],
        },
      ],
    })
    expect(buildFirstSlideFingerprint(visualChanged)).not.toBe(baselineFingerprint)
  })

  it('ensureProjectId 在同一 session 并发保存时应只创建一次项目', async () => {
    let resolveCreate: ((value: Record<string, unknown>) => void) | null = null
    const createResponse = new Promise<Record<string, unknown>>((resolve) => {
      resolveCreate = resolve
    })

    const requestSpy = vi
      .spyOn(apiService, 'request')
      .mockReturnValue(createResponse as unknown as ReturnType<typeof apiService.request>)

    const data = makePresentation()
    const serverIdRef = { current: null as string | null }
    const createProjectPromiseRef = { current: null as Promise<string | null> | null }
    const createProjectSessionRef = { current: null as number | null }
    const saveSessionRef = { current: 11 }

    const p1 = ensureProjectId(
      data,
      serverIdRef,
      createProjectPromiseRef,
      createProjectSessionRef,
      saveSessionRef,
      11,
      mapPresetForTest,
      getContextForTest,
    )
    const p2 = ensureProjectId(
      data,
      serverIdRef,
      createProjectPromiseRef,
      createProjectSessionRef,
      saveSessionRef,
      11,
      mapPresetForTest,
      getContextForTest,
    )

    expect(requestSpy).toHaveBeenCalledTimes(1)
    expect(resolveCreate).toBeTypeOf('function')
    resolveCreate!({ data: { id: 'ppt-11' } })

    await expect(p1).resolves.toBe('ppt-11')
    await expect(p2).resolves.toBe('ppt-11')
    expect(serverIdRef.current).toBe('ppt-11')
  })

  it('ensureProjectId 遇到旧 session 残留锁时应忽略旧 Promise 并为当前 session 重新创建', async () => {
    const requestSpy = vi
      .spyOn(apiService, 'request')
      .mockResolvedValue({ data: { id: 'ppt-new-session' } } as unknown as Record<string, unknown>)

    const data = makePresentation()
    const serverIdRef = { current: null as string | null }
    const createProjectPromiseRef = {
      current: new Promise<string | null>(() => {
        // 模拟旧 session 中已失效但未完成的创建请求
      }),
    }
    const createProjectSessionRef = { current: 7 as number | null }
    const saveSessionRef = { current: 8 }

    const projectId = await ensureProjectId(
      data,
      serverIdRef,
      createProjectPromiseRef,
      createProjectSessionRef,
      saveSessionRef,
      8,
      mapPresetForTest,
      getContextForTest,
    )

    expect(projectId).toBe('ppt-new-session')
    expect(serverIdRef.current).toBe('ppt-new-session')
    expect(requestSpy).toHaveBeenCalledTimes(1)
  })

  it('页面保存格式 roundtrip 后应保留关键字段，避免保存后重载丢数', () => {
    const sourcePages: Slide[] = [
      {
        id: 'page-1',
        background: { type: 'solid', color: '#ffffff' },
        remark: 'speaker notes A',
        elements: [makeTextElement(), makeShapeElement()],
      },
    ]

    const backendPages = convertPagesToBackend(sourcePages)

    expect(backendPages[0]?.notes).toBe('speaker notes A')
    expect(backendPages[0]?.elements.map((el) => el.zIndex)).toEqual([0, 1])
    expect(backendPages[0]?.elements[0]?.visible).toBe(false)
    expect(backendPages[0]?.elements[0]?.locked).toBe(true)
    expect(backendPages[0]?.elements[1]?.flipH).toBe(true)
    expect(backendPages[0]?.elements[1]?.flipV).toBe(true)

    const backendProject: BackendProjectDetail = {
      id: 'ppt-roundtrip-1',
      name: 'roundtrip',
      canvas_width: 1920,
      canvas_height: 1080,
      pages: backendPages,
      theme: {
        backgroundColor: '#ffffff',
        themeColors: ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47'],
        fontColor: '#111111',
        fontName: 'Arial',
      },
    }

    const restored = convertBackendToPresentation(backendProject)
    const restoredPage = restored.pages[0]!
    expect(restoredPage.remark).toBe('speaker notes A')
    expect(restoredPage.elements.map((el) => el.id)).toEqual(['text-1', 'shape-1'])

    const restoredText = restoredPage.elements.find((el) => el.id === 'text-1') as PPTTextElement
    expect(restoredText.x).toBe(120)
    expect(restoredText.y).toBe(80)
    expect(restoredText.width).toBe(400)
    expect(restoredText.height).toBe(120)
    expect(restoredText.rotate).toBe(15)
    expect(restoredText.opacity).toBe(0.76)
    expect(restoredText.visible).toBe(false)
    expect(restoredText.locked).toBe(true)
    expect(restoredText.groupId).toBe('group-1')
    expect(restoredText.groupName).toBe('标题组')
    expect(restoredText.flipH).toBe(true)
    expect(restoredText.link?.target).toBe('https://example.com')

    const restoredShape = restoredPage.elements.find((el) => el.id === 'shape-1') as PPTShapeElement
    expect(restoredShape.flipH).toBe(true)
    expect(restoredShape.flipV).toBe(true)
    expect(restoredShape.groupName).toBe('标题组')
  })

  it('增量 diff：应识别单页改动并忽略未变页面', () => {
    const baselinePresentation = makePresentation({
      pages: [
        {
          id: 'page-1',
          background: { type: 'solid', color: '#ffffff' },
          elements: [makeTextElement()],
        },
        {
          id: 'page-2',
          background: { type: 'solid', color: '#f6f6f6' },
          elements: [makeShapeElement()],
        },
      ],
    })
    const baseline = buildSaveBaseline(baselinePresentation)

    const edited = makePresentation({
      pages: [
        {
          id: 'page-1',
          background: { type: 'solid', color: '#ffffff' },
          elements: [{ ...makeTextElement(), x: 333 }],
        },
        {
          id: 'page-2',
          background: { type: 'solid', color: '#f6f6f6' },
          elements: [makeShapeElement()],
        },
      ],
    })

    const diff = diffIncrementalSave(edited, baseline)
    expect(diff.changedPageIds).toEqual(['page-1'])
    expect(diff.deletedPageIds).toEqual([])
    expect(diff.pageOrderChanged).toBe(false)
    expect(diff.hasPagePayload).toBe(true)
    expect(diff.themeChanged).toBe(false)
  })

  it('增量 diff：应识别删除与重排', () => {
    const baselinePresentation = makePresentation({
      pages: [
        {
          id: 'page-a',
          background: { type: 'solid', color: '#ffffff' },
          elements: [makeTextElement()],
        },
        {
          id: 'page-b',
          background: { type: 'solid', color: '#f6f6f6' },
          elements: [makeShapeElement()],
        },
      ],
    })
    const baseline = buildSaveBaseline(baselinePresentation)

    const reorderedAndDeleted = makePresentation({
      pages: [
        {
          id: 'page-b',
          background: { type: 'solid', color: '#f6f6f6' },
          elements: [makeShapeElement()],
        },
      ],
    })

    const diff = diffIncrementalSave(reorderedAndDeleted, baseline)
    expect(diff.changedPageIds).toEqual([])
    expect(diff.deletedPageIds).toEqual(['page-a'])
    expect(diff.pageOrderChanged).toBe(true)
    expect(diff.hasPagePayload).toBe(true)
    expect(diff.hasAnyPageChange).toBe(true)
  })

  it('增量 diff：纯重排时只标记顺序变化', () => {
    const pageA: Slide = {
      id: 'page-a',
      background: { type: 'solid', color: '#ffffff' },
      elements: [makeTextElement()],
    }
    const pageB: Slide = {
      id: 'page-b',
      background: { type: 'solid', color: '#f6f6f6' },
      elements: [makeShapeElement()],
    }

    const baselinePresentation = makePresentation({
      pages: [pageA, pageB],
    })
    const baseline = buildSaveBaseline(baselinePresentation)

    const reordered = makePresentation({
      pages: [pageB, pageA],
    })
    const diff = diffIncrementalSave(reordered, baseline)

    expect(diff.changedPageIds).toEqual([])
    expect(diff.deletedPageIds).toEqual([])
    expect(diff.pageOrderChanged).toBe(true)
    expect(diff.hasPagePayload).toBe(false)
    expect(diff.hasAnyPageChange).toBe(true)
  })

  it('增量 diff：与基线一致时应判定为无变化', () => {
    const presentation = makePresentation({
      pages: [
        {
          id: 'page-1',
          background: { type: 'solid', color: '#ffffff' },
          elements: [makeTextElement(), makeShapeElement()],
        },
      ],
    })
    const baseline = buildSaveBaseline(presentation)
    const diff = diffIncrementalSave(presentation, baseline)

    expect(diff.changedPageIds).toEqual([])
    expect(diff.deletedPageIds).toEqual([])
    expect(diff.pageOrderChanged).toBe(false)
    expect(diff.hasPagePayload).toBe(false)
    expect(diff.hasAnyPageChange).toBe(false)
    expect(diff.themeChanged).toBe(false)
  })

  it('增量 diff：主题变化应被识别并上抛', () => {
    const baselinePresentation = makePresentation()
    const baseline = buildSaveBaseline(baselinePresentation)
    const baselineTheme = baselinePresentation.theme!

    const themeChanged = makePresentation({
      theme: {
        ...baselineTheme,
        fontName: 'Calibri',
      },
    })

    const diff = diffIncrementalSave(themeChanged, baseline)
    expect(diff.themeChanged).toBe(true)
  })
})
