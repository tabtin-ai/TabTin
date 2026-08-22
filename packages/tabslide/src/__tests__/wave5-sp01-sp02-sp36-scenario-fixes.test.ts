/**
 * Wave 5b 场景验证修复回归测试
 *
 * SP1-01: PPTImageElement.imageType 后端往返
 * SP1-02: buildBoxShadow 支持 shadow.opacity
 * SP1-04: fireAndForgetSave Web 环境 sendBeacon 降级
 * SP2-03: toBackendPreset 4:3 正确映射
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { convertPagesToBackend, convertBackendToPresentation, PRESET_FE_TO_BE } from '../exports/backend-adapter'
import type { Slide, PPTImageElement } from '../types/slides'

// ═══════════════════════════════════════════════════════════
// SP1-01: imageType 后端往返
// ═══════════════════════════════════════════════════════════

describe('SP1-01: PPTImageElement.imageType 后端往返', () => {
  const makeImagePage = (imageType?: PPTImageElement['imageType']): Slide => ({
    id: 'sp101_page',
    elements: [
      {
        id: 'img_1',
        type: 'image',
        x: 0,
        y: 0,
        width: 200,
        height: 200,
        rotate: 0,
        opacity: 1,
        src: 'https://example.com/test.png',
        fixedRatio: true,
        ...(imageType ? { imageType } : {}),
      } as PPTImageElement,
    ],
    background: { type: 'solid' as const, color: '#ffffff' },
  })

  it('imageType=pageFigure 写入后端 props', () => {
    const [backend] = convertPagesToBackend([makeImagePage('pageFigure')])
    const imgEl = backend.elements[0]
    expect(imgEl.props).toBeDefined()
    expect((imgEl.props as Record<string, unknown>).imageType).toBe('pageFigure')
  })

  it('imageType=itemFigure 写入后端 props', () => {
    const [backend] = convertPagesToBackend([makeImagePage('itemFigure')])
    const imgEl = backend.elements[0]
    expect((imgEl.props as Record<string, unknown>).imageType).toBe('itemFigure')
  })

  it('imageType=background 写入后端 props', () => {
    const [backend] = convertPagesToBackend([makeImagePage('background')])
    const imgEl = backend.elements[0]
    expect((imgEl.props as Record<string, unknown>).imageType).toBe('background')
  })

  it('imageType=icon 写入后端 props', () => {
    const [backend] = convertPagesToBackend([makeImagePage('icon')])
    const imgEl = backend.elements[0]
    expect((imgEl.props as Record<string, unknown>).imageType).toBe('icon')
  })

  it('无 imageType 时后端 props 中不包含该字段', () => {
    const [backend] = convertPagesToBackend([makeImagePage()])
    const imgEl = backend.elements[0]
    expect((imgEl.props as Record<string, unknown>).imageType).toBeUndefined()
  })

  it('后端→前端读取 imageType', () => {
    const backendData = {
      id: 'proj_test',
      name: 'test',
      preset: 'ppt',
      canvas_width: 960,
      canvas_height: 540,
      pages: [
        {
          id: 'p1',
          elements: [
            {
              id: 'img_1',
              type: 'image',
              x: 0, y: 0, width: 200, height: 200, rotate: 0,
              opacity: 1, z_index: 0,
              props: { src: 'https://example.com/test.png', imageType: 'pageFigure' },
            },
          ],
          background: { type: 'solid', color: '#ffffff' },
        },
      ],
    }
    const pres = convertBackendToPresentation(backendData as any)
    const imgEl = pres.pages[0].elements[0] as PPTImageElement
    expect(imgEl.imageType).toBe('pageFigure')
  })
})

// ═══════════════════════════════════════════════════════════
// SP1-04: fireAndForgetSave sendBeacon 降级
// ═══════════════════════════════════════════════════════════

describe('SP1-04: fireAndForgetSave Web 环境 keepalive fetch 降级', () => {
  const slideSavePath = path.resolve(
    __dirname,
    '../../../../apps/tabtin-electron/src/renderer/src/components/slide/slide-save.ts',
  )
  const slideSaveExists = fs.existsSync(slideSavePath)
  const slideSaveSrc = slideSaveExists ? fs.readFileSync(slideSavePath, 'utf-8') : ''

  it.skipIf(!slideSaveExists)('fireAndForgetSave 包含 keepalive fetch 分支', () => {
    expect(slideSaveSrc).toContain('keepalive: true')
  })

  it.skipIf(!slideSaveExists)('keepalive fetch 携带 credentials:include 用于 cookie 认证', () => {
    expect(slideSaveSrc).toContain("credentials: 'include'")
  })

  it.skipIf(!slideSaveExists)('keepalive 前检测 Electron 环境', () => {
    expect(slideSaveSrc).toContain('window.electron')
  })

  it.skipIf(!slideSaveExists)('keepalive fetch 失败后回退到 apiService.request', () => {
    const keepaliveIdx = slideSaveSrc.indexOf('keepalive: true')
    const apiRequestIdx = slideSaveSrc.indexOf('apiService.request', keepaliveIdx)
    expect(apiRequestIdx).toBeGreaterThan(keepaliveIdx)
  })
})

// ═══════════════════════════════════════════════════════════
// SP2-03: toBackendPreset 4:3 正确映射
// ═══════════════════════════════════════════════════════════

describe('SP2-03: toBackendPreset 4:3 映射', () => {
  const slideSavePath = path.resolve(
    __dirname,
    '../../../../apps/tabtin-electron/src/renderer/src/components/slide/slide-save.ts',
  )
  const slideSaveExists = fs.existsSync(slideSavePath)
  const slideSaveSrc = slideSaveExists ? fs.readFileSync(slideSavePath, 'utf-8') : ''

  it.skipIf(!slideSaveExists)('toBackendPreset 中 4:3 不与 custom 共享 case', () => {
    const funcBlock = slideSaveSrc.match(
      /function toBackendPreset[\s\S]*?^}/m,
    )
    expect(funcBlock).toBeTruthy()
    const body = funcBlock![0]
    const fourThreeCase = body.match(/case\s+'4:3'\s*:[\s\S]*?return\s+'([^']+)'/)
    expect(fourThreeCase).toBeTruthy()
    expect(fourThreeCase![1]).toBe('4:3')
  })

  it.skipIf(!slideSaveExists)('4:3 case 独立于 custom case', () => {
    const funcBlock = slideSaveSrc.match(
      /function toBackendPreset[\s\S]*?^}/m,
    )!
    const body = funcBlock[0]
    const fourThreeIdx = body.indexOf("case '4:3':")
    const customIdx = body.indexOf("case 'custom':")
    const fourThreeReturn = body.indexOf("return '4:3'", fourThreeIdx)
    expect(fourThreeReturn).toBeGreaterThan(fourThreeIdx)
    expect(fourThreeReturn).toBeLessThan(customIdx)
  })

  it('PRESET_FE_TO_BE 中 4:3 映射为 4:3', () => {
    expect(PRESET_FE_TO_BE['4:3']).toBe('4:3')
  })

  it('PRESET_FE_TO_BE 中 16:9 映射为 ppt', () => {
    expect(PRESET_FE_TO_BE['16:9']).toBe('ppt')
  })

  it('PRESET_FE_TO_BE 中 custom 映射为 custom', () => {
    expect(PRESET_FE_TO_BE['custom']).toBe('custom')
  })
})
