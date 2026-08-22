import { describe, expect, it } from 'vitest'
import {
  convertBackendToPresentation,
  convertPagesToBackend,
  type BackendProjectDetail,
} from '../../../../../packages/tabslide/src/exports/backend-adapter'
import { resolveBackgroundColor } from '../../../../../packages/tabslide/src/utils/background'
import type { Slide } from '../../../../../packages/tabslide/src/types/slides'

function makeBackendProject(background: NonNullable<BackendProjectDetail['pages'][number]['background']>): BackendProjectDetail {
  return {
    id: 'ppt-1',
    name: 'background-theme-compat',
    canvas_width: 1920,
    canvas_height: 1080,
    pages: [
      {
        id: 'page-1',
        elements: [],
        background,
      },
    ],
  }
}

describe('TabSlide Background Theme Chain', () => {
  it('后端背景 theme key 数字别名应标准化为可编辑键', () => {
    const presentation = convertBackendToPresentation(
      makeBackendProject({
        type: 'color',
        theme: { key: '14' },
      }),
    )

    const bg = presentation.pages[0]?.background
    expect(bg?.type).toBe('theme')
    expect(bg?.theme?.key).toBe('bg1')
    expect((bg?.color || '').toLowerCase()).toBe('#ffffff')
  })

  it('theme key=13(文本1) 在缺失 value 时不应回落白底', () => {
    const presentation = convertBackendToPresentation(
      makeBackendProject({
        type: 'color',
        theme: { key: '13' },
      }),
    )

    const bg = presentation.pages[0]?.background
    expect(bg?.type).toBe('theme')
    expect(bg?.theme?.key).toBe('tx1')
    expect((bg?.color || '').toLowerCase()).toBe('#000000')
  })

  it('前端 theme 背景仅有旧数字键时，写回后端应产出正确 value', () => {
    const pages: Slide[] = [
      {
        id: 'page-1',
        elements: [],
        background: {
          type: 'theme',
          theme: { key: '15' },
        },
      },
    ]

    const backendPages = convertPagesToBackend(pages)
    const bg = backendPages[0]?.background
    const themeKey = (bg?.theme?.key as string | undefined) || ''
    expect(bg?.type).toBe('theme')
    expect((bg?.value || '').toLowerCase()).toBe('#44546a')
    expect(themeKey.toLowerCase()).toBe('tx2')
  })

  it('Canvas 解析 theme key 数字别名时应得到稳定颜色', () => {
    const color = resolveBackgroundColor(
      {
        type: 'theme',
        theme: { key: '15' },
      },
      {
        backgroundColor: '#ffffff',
        fontColor: '#222222',
        fontName: 'Arial',
        themeColors: ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47'],
      },
    )

    expect(color.toLowerCase()).toBe('#44546a')
  })

  it('后端 theme 背景缺失有效 key 时应降级为 solid，避免误回写默认主题色', () => {
    const presentation = convertBackendToPresentation(
      makeBackendProject({
        type: 'theme',
        value: '#123456',
      }),
    )

    const bg = presentation.pages[0]?.background
    expect(bg?.type).toBe('solid')
    expect((bg?.color || '').toLowerCase()).toBe('#123456')
  })

  it('后端图片背景 size 脏值应回落为 cover，避免 Canvas 样式异常', () => {
    const presentation = convertBackendToPresentation(
      makeBackendProject({
        type: 'image',
        image: {
          src: 'https://example.com/bg.png',
          size: 'invalid-size',
        },
      } as unknown as NonNullable<BackendProjectDetail['pages'][number]['background']>),
    )

    const bg = presentation.pages[0]?.background
    expect(bg?.type).toBe('image')
    expect(bg?.image?.size).toBe('cover')
  })
})
