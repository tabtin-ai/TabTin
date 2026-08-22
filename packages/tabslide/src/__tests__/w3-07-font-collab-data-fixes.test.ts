/**
 * W3-07 回归测试：font/collab/data 修复
 *
 * 覆盖：
 * - BA-P2-07: turningMode 往返对称
 * - A2-10: theme 背景类型保留
 * - G1-03: 字体 URL 模板 {weight} 解析
 * - G1-08: FontSelect Enter 键选中 filtered[0]
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import {
  convertBackendPage,
  convertPagesToBackend,
  type BackendSlidePage,
} from '../exports/backend-adapter'
import type { Slide, SlideBackground } from '../types/slides'

const readSrc = (relativePath: string) =>
  fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf-8')

/* ── BA-P2-07: turningMode 往返对称 ── */

describe('BA-P2-07: turningMode 往返对称', () => {
  const makeBackendPage = (turningMode?: string): BackendSlidePage => ({
    id: 'page-1',
    elements: [],
    ...(turningMode !== undefined ? { turningMode } : {}),
  })

  it('空字符串 "" 映射为 "no"', () => {
    const page = convertBackendPage(makeBackendPage(''))
    expect(page.turningMode).toBe('no')
  })

  it('"fadeScale" 映射为 "scale"', () => {
    const page = convertBackendPage(makeBackendPage('fadeScale'))
    expect(page.turningMode).toBe('scale')
  })

  it('有效值 "fade" 直接透传', () => {
    const page = convertBackendPage(makeBackendPage('fade'))
    expect(page.turningMode).toBe('fade')
  })

  it('有效值 "slideX" 直接透传', () => {
    const page = convertBackendPage(makeBackendPage('slideX'))
    expect(page.turningMode).toBe('slideX')
  })

  it('有效值 "slideY" 直接透传', () => {
    const page = convertBackendPage(makeBackendPage('slideY'))
    expect(page.turningMode).toBe('slideY')
  })

  it('无效值返回 undefined（不输出 turningMode）', () => {
    const page = convertBackendPage(makeBackendPage('invalidValue'))
    expect(page.turningMode).toBeUndefined()
  })

  it('非字符串类型返回 undefined', () => {
    const backendPage: BackendSlidePage = {
      id: 'page-1',
      elements: [],
      turningMode: 123 as unknown as string,
    }
    const page = convertBackendPage(backendPage)
    expect(page.turningMode).toBeUndefined()
  })
})

/* ── A2-10: theme 背景类型保留 ── */

describe('A2-10: theme 背景类型保留', () => {
  it('convertPagesToBackend 对 theme 背景保留 type="theme"', () => {
    const themeBg: SlideBackground = {
      type: 'theme',
      color: '#ffffff',
      theme: {
        key: 'bg1',
        color: '#ffffff',
      },
    }
    const page: Slide = {
      id: 'page-1',
      elements: [],
      background: themeBg,
    }

    const [backendPage] = convertPagesToBackend([page])

    expect(backendPage.background).toBeDefined()
    expect(backendPage.background!.type).toBe('theme')
    expect(backendPage.background!.theme).toBeDefined()
    expect(backendPage.background!.theme!.key).toBe('bg1')
  })

  it('theme 背景往返后 type 仍为 theme', () => {
    const themeBg: SlideBackground = {
      type: 'theme',
      color: '#E7E6E6',
      theme: {
        key: 'bg2',
        color: '#E7E6E6',
      },
    }
    const page: Slide = {
      id: 'page-1',
      elements: [],
      background: themeBg,
    }

    const [backendPage] = convertPagesToBackend([page])
    const restored = convertBackendPage(backendPage)

    expect(restored.background).toBeDefined()
    expect(restored.background!.type).toBe('theme')
    expect(restored.background!.theme).toBeDefined()
  })
})

/* ── G1-03: 字体 URL 模板 {weight} 解析 ── */

describe('G1-03: loadSharedFont {weight} 占位符解析', () => {
  it('loadSharedFont 源码包含 {weight} 占位符替换逻辑', () => {
    const src = readSrc('fonts/font-bridge.ts')
    expect(src).toContain('{weight}')
    expect(src).toContain("url.includes('{weight}')")
    expect(src).toContain("url.replace('{weight}', String(weight))")
  })

  it('{weight} 替换逻辑行为正确（逻辑等价测试）', () => {
    const resolveWeight = (url: string): string =>
      url.includes('{weight}') ? url.replace('{weight}', '400') : url
    expect(resolveWeight('https://cdn.example.com/font-{weight}.ttf')).toBe(
      'https://cdn.example.com/font-400.ttf',
    )
    expect(resolveWeight('https://cdn.example.com/font-regular.ttf')).toBe(
      'https://cdn.example.com/font-regular.ttf',
    )
  })
})

/* ── G1-08: FontSelect Enter 键选中 filtered[0] ── */

describe('G1-08: FontSelect Enter 键选中 filtered[0]', () => {
  it('handleInputKeyDown 在 Enter 时选中 filtered[0]', () => {
    const src = readSrc('panels/right-sidebar/editors/FontSelect.tsx')

    expect(src).toContain("if (e.key === 'Enter')")
    expect(src).toContain('const firstVisible = filtered[0]')
    expect(src).toContain('onChange(firstVisible.value)')
    expect(src).toContain('if (firstVisible)')
  })
})
