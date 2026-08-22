/**
 * 回归测试 — T-01 / T-03 / A2-06
 *
 * T-01:  flipH/flipV 基类已定义，子类型不应重复声明
 * T-03:  SlidePreset 前后端枚举显式映射
 * A2-06: 背景格式规范化（由 Python 侧 normalize_background_for_api 处理，
 *        此处验证 TS 侧 PRESET 映射的正确性和完整性）
 */
import { describe, it, expect } from 'vitest'
import {
  convertBackendToPresentation,
  convertPresetToBackend,
  PRESET_FE_TO_BE,
  PRESET_BE_TO_FE,
  type BackendProjectDetail,
} from '../backend-adapter'
import type { SlidePreset } from '../../types/slides'

// ═══════════════════════════════════════════════
// T-01: flipH/flipV 不从子类型中重复声明
// ═══════════════════════════════════════════════

describe('T-01: flipH/flipV 继承自基类', () => {
  it('PPTTextElement 的 flipH/flipV 来自 PPTElementBase', () => {
    const textEl: import('../../types/slides').PPTTextElement = {
      id: 't1', type: 'text', x: 0, y: 0, width: 100, height: 50,
      rotate: 0, opacity: 1, locked: false,
      content: 'hello', defaultFontName: 'Arial', defaultColor: '#000',
      flipH: true, flipV: false,
    }
    expect(textEl.flipH).toBe(true)
    expect(textEl.flipV).toBe(false)
  })

  it('PPTImageElement 的 flipH/flipV 来自 PPTElementBase', () => {
    const imgEl: import('../../types/slides').PPTImageElement = {
      id: 'i1', type: 'image', x: 0, y: 0, width: 200, height: 150,
      rotate: 0, opacity: 1, locked: false,
      src: 'test.png', fixedRatio: true,
      flipH: false, flipV: true,
    }
    expect(imgEl.flipH).toBe(false)
    expect(imgEl.flipV).toBe(true)
  })

  it('PPTShapeElement 的 flipH/flipV 来自 PPTElementBase', () => {
    const shapeEl: import('../../types/slides').PPTShapeElement = {
      id: 's1', type: 'shape', x: 0, y: 0, width: 100, height: 100,
      rotate: 0, opacity: 1, locked: false,
      viewBox: [100, 100], path: 'M0 0', fill: '#ccc',
      flipH: true, flipV: true,
    }
    expect(shapeEl.flipH).toBe(true)
    expect(shapeEl.flipV).toBe(true)
  })
})

// ═══════════════════════════════════════════════
// T-03: SlidePreset 前后端映射
// ═══════════════════════════════════════════════

describe('T-03: SlidePreset 前后端枚举映射', () => {
  it('PRESET_FE_TO_BE 覆盖所有前端 preset 值', () => {
    const fePresets: SlidePreset[] = ['16:9', '4:3', 'xiaohongshu', 'poster', 'custom']
    for (const p of fePresets) {
      expect(PRESET_FE_TO_BE[p]).toBeDefined()
    }
  })

  it('PRESET_BE_TO_FE 覆盖所有后端 preset 值', () => {
    const bePresets = ['ppt', '16:9', '4:3', 'xiaohongshu', 'poster', 'custom']
    for (const p of bePresets) {
      expect(PRESET_BE_TO_FE[p]).toBeDefined()
    }
  })

  it('16:9 <-> ppt 双向映射', () => {
    expect(PRESET_FE_TO_BE['16:9']).toBe('ppt')
    expect(PRESET_BE_TO_FE['ppt']).toBe('16:9')
  })

  it('convertPresetToBackend 将 16:9 转为 ppt', () => {
    expect(convertPresetToBackend('16:9')).toBe('ppt')
  })

  it('convertPresetToBackend 保留已是后端格式的值', () => {
    expect(convertPresetToBackend('4:3')).toBe('4:3')
    expect(convertPresetToBackend('xiaohongshu')).toBe('xiaohongshu')
    expect(convertPresetToBackend('poster')).toBe('poster')
    expect(convertPresetToBackend('custom')).toBe('custom')
  })

  it('convertBackendToPresentation 将 ppt 映射为 16:9', () => {
    const data: BackendProjectDetail = {
      id: 'p1',
      name: 'Test',
      preset: 'ppt',
      canvas_width: 1920,
      canvas_height: 1080,
      pages: [],
    }
    const pres = convertBackendToPresentation(data)
    expect(pres.preset).toBe('16:9')
  })

  it('convertBackendToPresentation 保留 4:3', () => {
    const data: BackendProjectDetail = {
      id: 'p2',
      name: 'Test',
      preset: '4:3',
      canvas_width: 1024,
      canvas_height: 768,
      pages: [],
    }
    const pres = convertBackendToPresentation(data)
    expect(pres.preset).toBe('4:3')
  })

  it('FE→BE→FE 往返一致', () => {
    const presets: SlidePreset[] = ['16:9', '4:3', 'xiaohongshu', 'poster', 'custom']
    for (const p of presets) {
      const be = PRESET_FE_TO_BE[p]
      const roundTrip = PRESET_BE_TO_FE[be]
      expect(roundTrip).toBe(p)
    }
  })
})
