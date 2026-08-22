/**
 * 回归测试 — DF-01 / DF-02
 *
 * DF-01: SlideNote[] 批注在 convertPagesToBackend / convertBackendPage 往返中不丢失
 * DF-02: sectionTag / slideType 在 convertPagesToBackend / convertBackendPage 往返中不丢失
 */
import { describe, it, expect } from 'vitest'
import {
  convertBackendPage,
  convertPagesToBackend,
  type BackendSlidePage,
} from '../backend-adapter'
import type { Slide, SlideNote, SectionTag, SlideType } from '../../types/slides'

// ═══════════════════════════════════════════════
// DF-01: SlideNote[] 批注保存 / 加载往返
// ═══════════════════════════════════════════════

describe('DF-01: SlideNote[] 批注往返', () => {
  const sampleNotes: SlideNote[] = [
    { id: 'note-1', content: '这里需要修改配色' },
    { id: 'note-2', content: '字号偏小', elId: 'el_abc12345' },
    { id: 'note-3', content: '第三条批注', elId: 'el_xyz99999', createdAt: '2026-03-15T10:00:00Z' },
  ]

  it('convertPagesToBackend 应将 Slide.notes 序列化为 slide_notes', () => {
    const page: Slide = {
      id: 'page-1',
      elements: [],
      notes: sampleNotes,
    }

    const [backendPage] = convertPagesToBackend([page])

    expect(backendPage.slide_notes).toBeDefined()
    expect(backendPage.slide_notes).toHaveLength(3)
    expect(backendPage.slide_notes![0]).toEqual({
      id: 'note-1',
      content: '这里需要修改配色',
    })
    expect(backendPage.slide_notes![1]).toEqual({
      id: 'note-2',
      content: '字号偏小',
      elId: 'el_abc12345',
    })
    expect(backendPage.slide_notes![2]).toEqual({
      id: 'note-3',
      content: '第三条批注',
      elId: 'el_xyz99999',
      createdAt: '2026-03-15T10:00:00Z',
    })
  })

  it('convertBackendPage 应将 slide_notes 反序列化为 Slide.notes', () => {
    const backendPage: BackendSlidePage = {
      id: 'page-1',
      elements: [],
      notes: '演讲备注文字',
      slide_notes: [
        { id: 'note-1', content: '批注内容A' },
        { id: 'note-2', content: '批注内容B', elId: 'el_001' },
      ],
    }

    const slide = convertBackendPage(backendPage)

    expect(slide.remark).toBe('演讲备注文字')
    expect(slide.notes).toBeDefined()
    expect(slide.notes).toHaveLength(2)
    expect(slide.notes![0]).toEqual({ id: 'note-1', content: '批注内容A' })
    expect(slide.notes![1]).toEqual({ id: 'note-2', content: '批注内容B', elId: 'el_001' })
  })

  it('notes 和 remark(演讲备注) 互不影响', () => {
    const page: Slide = {
      id: 'page-1',
      elements: [],
      remark: '演讲者看到的文字',
      notes: [{ id: 'n1', content: '审阅批注' }],
    }

    const [backendPage] = convertPagesToBackend([page])
    expect(backendPage.notes).toBe('演讲者看到的文字')
    expect(backendPage.slide_notes).toHaveLength(1)
    expect(backendPage.slide_notes![0].content).toBe('审阅批注')

    const roundtripped = convertBackendPage(backendPage)
    expect(roundtripped.remark).toBe('演讲者看到的文字')
    expect(roundtripped.notes).toHaveLength(1)
    expect(roundtripped.notes![0].content).toBe('审阅批注')
  })

  it('空批注数组时不输出 slide_notes 字段', () => {
    const page: Slide = {
      id: 'page-1',
      elements: [],
      notes: [],
    }

    const [backendPage] = convertPagesToBackend([page])
    expect(backendPage.slide_notes).toBeUndefined()
  })

  it('无 slide_notes 字段时 Slide.notes 不出现', () => {
    const backendPage: BackendSlidePage = {
      id: 'page-1',
      elements: [],
    }

    const slide = convertBackendPage(backendPage)
    expect(slide.notes).toBeUndefined()
  })

  it('过滤无效批注条目', () => {
    const backendPage: BackendSlidePage = {
      id: 'page-1',
      elements: [],
      slide_notes: [
        { id: 'ok-1', content: '有效批注' },
        { id: '', content: '无效：空 id' },
        null as unknown as { id: string; content: string },
        { id: 'ok-2', content: '另一条有效批注' },
      ],
    }

    const slide = convertBackendPage(backendPage)
    expect(slide.notes).toHaveLength(2)
    expect(slide.notes![0].id).toBe('ok-1')
    expect(slide.notes![1].id).toBe('ok-2')
  })

  it('完整往返保真度测试', () => {
    const original: Slide = {
      id: 'page-rt',
      elements: [],
      notes: sampleNotes,
      remark: '备注文字',
    }

    const [backend] = convertPagesToBackend([original])
    const restored = convertBackendPage(backend)

    expect(restored.notes).toEqual(sampleNotes)
    expect(restored.remark).toBe('备注文字')
  })
})

// ═══════════════════════════════════════════════
// DF-02: sectionTag / slideType 保存 / 加载往返
// ═══════════════════════════════════════════════

describe('DF-02: sectionTag/slideType 往返', () => {
  it('convertPagesToBackend 应序列化 sectionTag', () => {
    const page: Slide = {
      id: 'page-1',
      elements: [],
      sectionTag: { id: 'sec-intro', title: '引言' },
    }

    const [backendPage] = convertPagesToBackend([page])
    expect(backendPage.section_tag).toEqual({ id: 'sec-intro', title: '引言' })
  })

  it('convertPagesToBackend 应序列化 slideType', () => {
    const page: Slide = {
      id: 'page-1',
      elements: [],
      slideType: 'cover',
    }

    const [backendPage] = convertPagesToBackend([page])
    expect(backendPage.slide_type).toBe('cover')
  })

  it('convertBackendPage 应反序列化 section_tag 为 sectionTag', () => {
    const backendPage: BackendSlidePage = {
      id: 'page-1',
      elements: [],
      section_tag: { id: 'sec-body', title: '正文' },
    }

    const slide = convertBackendPage(backendPage)
    expect(slide.sectionTag).toEqual({ id: 'sec-body', title: '正文' })
  })

  it('convertBackendPage 应反序列化 slide_type 为 slideType', () => {
    const backendPage: BackendSlidePage = {
      id: 'page-1',
      elements: [],
      slide_type: 'end',
    }

    const slide = convertBackendPage(backendPage)
    expect(slide.slideType).toBe('end')
  })

  it('无 sectionTag/slideType 时字段不出现', () => {
    const page: Slide = {
      id: 'page-1',
      elements: [],
    }

    const [backendPage] = convertPagesToBackend([page])
    expect(backendPage.section_tag).toBeUndefined()
    expect(backendPage.slide_type).toBeUndefined()

    const restored = convertBackendPage(backendPage)
    expect(restored.sectionTag).toBeUndefined()
    expect(restored.slideType).toBeUndefined()
  })

  it('过滤非法 slideType 值', () => {
    const backendPage: BackendSlidePage = {
      id: 'page-1',
      elements: [],
      slide_type: 'invalid_type',
    }

    const slide = convertBackendPage(backendPage)
    expect(slide.slideType).toBeUndefined()
  })

  it('过滤空 id 的 sectionTag', () => {
    const backendPage: BackendSlidePage = {
      id: 'page-1',
      elements: [],
      section_tag: { id: '  ', title: '空白id' },
    }

    const slide = convertBackendPage(backendPage)
    expect(slide.sectionTag).toBeUndefined()
  })

  it('所有合法 slideType 枚举值均可往返', () => {
    const validTypes: SlideType[] = ['cover', 'contents', 'transition', 'content', 'end']

    for (const slideType of validTypes) {
      const page: Slide = { id: `page-${slideType}`, elements: [], slideType }
      const [backend] = convertPagesToBackend([page])
      const restored = convertBackendPage(backend)
      expect(restored.slideType).toBe(slideType)
    }
  })

  it('sectionTag + slideType + notes 完整往返', () => {
    const page: Slide = {
      id: 'page-full',
      elements: [],
      sectionTag: { id: 'sec-demo', title: '演示章节' },
      slideType: 'content',
      notes: [{ id: 'n1', content: '批注' }],
      remark: '备注',
    }

    const [backend] = convertPagesToBackend([page])
    const restored = convertBackendPage(backend)

    expect(restored.sectionTag).toEqual({ id: 'sec-demo', title: '演示章节' })
    expect(restored.slideType).toBe('content')
    expect(restored.notes).toHaveLength(1)
    expect(restored.remark).toBe('备注')
  })
})
