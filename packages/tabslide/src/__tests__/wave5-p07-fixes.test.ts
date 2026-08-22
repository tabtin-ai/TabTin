/**
 * Wave 5 P07 回归测试:
 * - B1-01: <mark> 标签在 sanitize 白名单中保留
 * - EI-003: fitToScreen 使用统一的 calculateFitZoom 和 CANVAS_FIT_PADDING
 * - EI-005: KeymapManager 优先级调度 + 各组件迁移
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

/* ══════════════════════════════════════════════════════
 * B1-01: <mark> 标签保留在 sanitize 白名单
 * ══════════════════════════════════════════════════════ */

describe('B1-01: sanitizeHtml preserves <mark> tags', () => {
  const sanitizeSrc = fs.readFileSync(
    path.resolve(__dirname, '../utils/sanitize.ts'),
    'utf-8',
  )

  it('ALLOWED_TAGS includes MARK', () => {
    expect(sanitizeSrc).toMatch(/'MARK'/)
  })

  it('ALLOWED_ATTRS includes MARK with data-color', () => {
    expect(sanitizeSrc).toMatch(/MARK:\s*new\s+Set\(\[.*'data-color'/)
  })

  it('regexFallbackSanitize allowlist includes MARK (via ALLOWED_TAG_RE)', () => {
    const tagSetMatch = sanitizeSrc.match(/const ALLOWED_TAGS = new Set\(\[([\s\S]*?)\]\)/)
    expect(tagSetMatch).toBeTruthy()
    expect(tagSetMatch![1]).toContain("'MARK'")
  })
})

/* ══════════════════════════════════════════════════════
 * EI-003: fitToScreen 统一计算逻辑
 * ══════════════════════════════════════════════════════ */

describe('EI-003: unified fitToScreen via calculateFitZoom', () => {
  const geometrySrc = fs.readFileSync(
    path.resolve(__dirname, '../utils/geometry.ts'),
    'utf-8',
  )
  const canvasSrc = fs.readFileSync(
    path.resolve(__dirname, '../components/Canvas.tsx'),
    'utf-8',
  )
  const editorSrc = fs.readFileSync(
    path.resolve(__dirname, '../components/SlideEditor.tsx'),
    'utf-8',
  )

  it('geometry.ts exports CANVAS_FIT_PADDING = 60', () => {
    expect(geometrySrc).toMatch(/export const CANVAS_FIT_PADDING\s*=\s*60/)
  })

  it('geometry.ts exports calculateFitZoom function', () => {
    expect(geometrySrc).toMatch(/export function calculateFitZoom/)
  })

  it('Canvas.tsx no longer has local FIT_PADDING constant', () => {
    expect(canvasSrc).not.toMatch(/^const FIT_PADDING\s*=/m)
  })

  it('SlideEditor.tsx no longer has local CANVAS_FIT_PADDING constant', () => {
    expect(editorSrc).not.toMatch(/^const CANVAS_FIT_PADDING\s*=/m)
  })

  it('Canvas.tsx imports calculateFitZoom', () => {
    expect(canvasSrc).toContain("import { calculateFitZoom } from '../utils/geometry'")
  })

  it('SlideEditor.tsx imports calculateFitZoom', () => {
    expect(editorSrc).toContain("import { calculateFitZoom } from '../utils/geometry'")
  })

  it('Canvas.tsx calls calculateFitZoom in fitToContainer', () => {
    expect(canvasSrc).toMatch(/calculateFitZoom\(rect\.width/)
  })

  it('SlideEditor.tsx calls calculateFitZoom in handleFitCanvas', () => {
    expect(editorSrc).toMatch(/calculateFitZoom\(viewportWidth/)
  })
})

describe('calculateFitZoom correctness', () => {
  // Dynamic import to test the actual function
  let calculateFitZoom: (cw: number, ch: number, pw: number, ph: number) => number

  it('loads the function', async () => {
    const mod = await import('../utils/geometry')
    calculateFitZoom = mod.calculateFitZoom
    expect(typeof calculateFitZoom).toBe('function')
  })

  it('returns zoom <= 1 for large containers', () => {
    const z = calculateFitZoom(3000, 2000, 1920, 1080)
    expect(z).toBeLessThanOrEqual(1)
  })

  it('returns correct zoom for a tight container', () => {
    // container 400x300, canvas 1920x1080, padding 60
    // scaleX = (400 - 120) / 1920 = 280/1920 ≈ 0.1458
    // scaleY = (300 - 120) / 1080 = 180/1080 ≈ 0.1667
    // min(scaleX, scaleY, 1) = scaleX
    const z = calculateFitZoom(400, 300, 1920, 1080)
    expect(z).toBeCloseTo(280 / 1920, 4)
  })

  it('returns 1 when container is empty', () => {
    expect(calculateFitZoom(0, 0, 1920, 1080)).toBe(1)
  })
})

/* ══════════════════════════════════════════════════════
 * EI-005: KeymapManager priority-based dispatch
 * ══════════════════════════════════════════════════════ */

describe('EI-005: KeymapManager exists and components use it', () => {
  const keymapSrc = fs.readFileSync(
    path.resolve(__dirname, '../utils/keymap-manager.ts'),
    'utf-8',
  )
  const useKeyboardSrc = fs.readFileSync(
    path.resolve(__dirname, '../hooks/useKeyboard.ts'),
    'utf-8',
  )
  const canvasSrc = fs.readFileSync(
    path.resolve(__dirname, '../components/Canvas.tsx'),
    'utf-8',
  )
  const ctxMenuSrc = fs.readFileSync(
    path.resolve(__dirname, '../components/ContextMenu.tsx'),
    'utf-8',
  )
  const zoomSrc = fs.readFileSync(
    path.resolve(__dirname, '../components/ZoomControls.tsx'),
    'utf-8',
  )

  it('KeymapManager exports keymapManager singleton', () => {
    expect(keymapSrc).toMatch(/export const keymapManager/)
  })

  it('KeymapManager exports KeyboardPriority enum', () => {
    expect(keymapSrc).toMatch(/export enum KeyboardPriority/)
    expect(keymapSrc).toContain('OVERLAY')
    expect(keymapSrc).toContain('GLOBAL')
    expect(keymapSrc).toContain('CANVAS')
  })

  it('useKeyboard uses keymapManager.register with GLOBAL priority', () => {
    expect(useKeyboardSrc).toContain('keymapManager.register(KeyboardPriority.GLOBAL')
  })

  it('useKeyboard no longer uses window.addEventListener for keydown', () => {
    expect(useKeyboardSrc).not.toMatch(/window\.addEventListener\(['"']keydown/)
  })

  it('Canvas.tsx uses keymapManager.register with CANVAS priority', () => {
    expect(canvasSrc).toContain('keymapManager.register(KeyboardPriority.CANVAS')
  })

  it('ContextMenu uses keymapManager.register with OVERLAY priority', () => {
    expect(ctxMenuSrc).toContain('keymapManager.register(KeyboardPriority.OVERLAY')
  })

  it('ContextMenu Escape handler calls e.preventDefault()', () => {
    expect(ctxMenuSrc).toMatch(/e\.preventDefault\(\)[\s\S]*?onClose\(\)/)
  })

  it('ZoomControls uses keymapManager.register with OVERLAY priority', () => {
    expect(zoomSrc).toContain('keymapManager.register(KeyboardPriority.OVERLAY')
  })

  it('ZoomControls Escape handler calls e.preventDefault()', () => {
    expect(zoomSrc).toMatch(/e\.preventDefault\(\)[\s\S]*?setPresetPanelOpen\(false\)/)
  })
})

describe('KeymapManager dispatch order', () => {
  it('higher priority handler fires first and can block lower', async () => {
    const { KeymapManager } = await import('../utils/keymap-manager').then((mod) => {
      // Access class for isolated testing
      return { KeymapManager: (mod as any).KeymapManager || mod }
    })

    // We test the exported singleton behavior via the module
    const mod = await import('../utils/keymap-manager')
    const manager = mod.keymapManager

    const calls: string[] = []

    const unregLow = manager.register(20, (_e: KeyboardEvent) => {
      calls.push('low')
    })

    const unregHigh = manager.register(80, (e: KeyboardEvent) => {
      calls.push('high')
      e.preventDefault()
      return true
    })

    // Simulate a keydown event
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    window.dispatchEvent(event)

    expect(calls).toEqual(['high'])

    unregLow()
    unregHigh()
  })
})
