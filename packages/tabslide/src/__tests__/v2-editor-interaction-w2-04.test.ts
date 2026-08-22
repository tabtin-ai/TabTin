/**
 * V2 Editor Interaction W2-04 — P1 fixes regression tests
 *
 * C4-01: Text paste busyRef protection prevents double-paste
 * C4-02: constrainImageSize fallback for zero naturalWidth/Height (SVG)
 * C4-03: mimeToExtension maps image/svg+xml → svg (not svg+xml)
 * C1-02: Canvas auto-fit resets when presentation.id changes
 * C1-03: setPresentation resets zoom/panX/panY
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ═══════════════════════════════════════════════════════════
// C4-01: busyRef guards text paste path
// ═══════════════════════════════════════════════════════════

describe('C4-01: useClipboardPaste text busyRef protection', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../hooks/useClipboardPaste.ts'),
    'utf-8',
  )

  it('tryPasteClipboardText sets busyRef.current = true before clipboard read', () => {
    const fnBody = src.slice(
      src.indexOf('const tryPasteClipboardText'),
      src.indexOf(', [insertTextElement])'),
    )
    const busySetIdx = fnBody.indexOf('busyRef.current = true')
    const clipboardReadIdx = fnBody.indexOf('navigator.clipboard.read')
    expect(busySetIdx).toBeGreaterThan(-1)
    expect(clipboardReadIdx).toBeGreaterThan(-1)
    expect(busySetIdx).toBeLessThan(clipboardReadIdx)
  })

  it('tryPasteClipboardText resets busyRef in finally block', () => {
    const fnBody = src.slice(
      src.indexOf('const tryPasteClipboardText'),
      src.indexOf(', [insertTextElement])'),
    )
    expect(fnBody).toContain('finally')
    const finallyBlock = fnBody.slice(fnBody.indexOf('finally'))
    expect(finallyBlock).toContain('busyRef.current = false')
  })

  it('handlePaste text path checks busyRef before inserting text', () => {
    const handlePasteStart = src.indexOf('const handlePaste = async')
    const handlePasteBody = src.slice(handlePasteStart, src.indexOf("document.addEventListener('paste'"))
    const textSection = handlePasteBody.slice(handlePasteBody.indexOf('busyRef.current') )
    expect(textSection).toBeTruthy()
    expect(handlePasteBody).toMatch(/if\s*\(busyRef\.current\)\s*return/)
  })

  it('handlePaste text path also sets busyRef = true and resets in finally', () => {
    const handlePasteStart = src.indexOf('const handlePaste = async')
    const handlePasteBody = src.slice(handlePasteStart, src.indexOf("document.addEventListener('paste'"))
    const textGuardIdx = handlePasteBody.indexOf('// 富文本')
    const textBlock = handlePasteBody.slice(textGuardIdx)
    expect(textBlock).toContain('busyRef.current = true')
    expect(textBlock).toContain('finally')
    expect(textBlock).toContain('busyRef.current = false')
  })
})

// ═══════════════════════════════════════════════════════════
// C4-02: constrainImageSize fallback for 0×0
// ═══════════════════════════════════════════════════════════

describe('C4-02: constrainImageSize handles zero dimensions', () => {
  const imgSrc = fs.readFileSync(
    path.resolve(__dirname, '../utils/image.ts'),
    'utf-8',
  )

  it('constrainImageSize uses fallback values when naturalW/H is 0', () => {
    expect(imgSrc).toContain('SVG_FALLBACK_W')
    expect(imgSrc).toContain('SVG_FALLBACK_H')
  })

  it('constrainImageSize substitutes fallback when naturalW <= 0', () => {
    const fn = imgSrc.slice(
      imgSrc.indexOf('export function constrainImageSize'),
      imgSrc.indexOf('// ── 图片元素创建'),
    )
    expect(fn).toMatch(/naturalW\s*>\s*0\s*\?\s*naturalW\s*:\s*SVG_FALLBACK_W/)
    expect(fn).toMatch(/naturalH\s*>\s*0\s*\?\s*naturalH\s*:\s*SVG_FALLBACK_H/)
  })

  it('SVG_FALLBACK_W = 400 and SVG_FALLBACK_H = 300', () => {
    expect(imgSrc).toMatch(/SVG_FALLBACK_W\s*=\s*400/)
    expect(imgSrc).toMatch(/SVG_FALLBACK_H\s*=\s*300/)
  })
})

// ═══════════════════════════════════════════════════════════
// C4-03: mimeToExtension mapping
// ═══════════════════════════════════════════════════════════

describe('C4-03: mimeToExtension maps MIME types correctly', () => {
  const imgSrc = fs.readFileSync(
    path.resolve(__dirname, '../utils/image.ts'),
    'utf-8',
  )

  it('MIME_TO_EXT has entry for image/svg+xml → svg', () => {
    expect(imgSrc).toMatch(/'image\/svg\+xml'\s*:\s*'svg'/)
  })

  it('MIME_TO_EXT has entry for image/jpeg → jpg', () => {
    expect(imgSrc).toMatch(/'image\/jpeg'\s*:\s*'jpg'/)
  })

  it('mimeToExtension function exists and is exported', () => {
    expect(imgSrc).toContain('export function mimeToExtension')
  })

  it('extractImageFile uses mimeToExtension instead of split', () => {
    const extractFn = imgSrc.slice(
      imgSrc.indexOf('export function extractImageFile'),
      imgSrc.indexOf('export async function readClipboardImageFile'),
    )
    expect(extractFn).toContain('mimeToExtension')
    expect(extractFn).not.toMatch(/item\.type\.split\(['"]\/['"]\)/)
  })

  it('readClipboardImageFile uses mimeToExtension instead of split', () => {
    const readFn = imgSrc.slice(
      imgSrc.indexOf('export async function readClipboardImageFile'),
      imgSrc.indexOf('// ── 校验 ──'),
    )
    expect(readFn).toContain('mimeToExtension')
    expect(readFn).not.toMatch(/imageType\.split\(['"]\/['"]\)/)
  })
})

// ═══════════════════════════════════════════════════════════
// C1-02: Canvas auto-fit resets on presentation change
// ═══════════════════════════════════════════════════════════

describe('C1-02: Canvas auto-fit resets on presentation.id change', () => {
  const canvasSrc = fs.readFileSync(
    path.resolve(__dirname, '../components/Canvas.tsx'),
    'utf-8',
  )

  it('uses lastFittedPresentationIdRef instead of hasAutoFittedRef', () => {
    expect(canvasSrc).toContain('lastFittedPresentationIdRef')
    expect(canvasSrc).not.toContain('hasAutoFittedRef')
  })

  it('compares presentation.id to decide whether to re-fit', () => {
    expect(canvasSrc).toContain('presentation.id')
    expect(canvasSrc).toContain('lastFittedPresentationIdRef.current')
  })

  it('sets lastFittedPresentationIdRef after fitToContainer', () => {
    const effectBlock = canvasSrc.slice(
      canvasSrc.indexOf('if (!presentation) return'),
      canvasSrc.indexOf('}, [presentation, fitToContainer]'),
    )
    const fitIdx = effectBlock.indexOf('fitToContainer()')
    const setIdx = effectBlock.indexOf('lastFittedPresentationIdRef.current = pid')
    expect(fitIdx).toBeGreaterThan(-1)
    expect(setIdx).toBeGreaterThan(fitIdx)
  })
})

// ═══════════════════════════════════════════════════════════
// C1-03: setPresentation resets zoom/panX/panY
// ═══════════════════════════════════════════════════════════

describe('C1-03: setPresentation resets viewport state', () => {
  const storeSrc = fs.readFileSync(
    path.resolve(__dirname, '../store/slide/slices/project/action.ts'),
    'utf-8',
  )

  function getSetPresentationImpl() {
    const implStart = storeSrc.indexOf('setPresentation =')
    const implEnd = storeSrc.indexOf('updatePresentationMeta', implStart)
    return storeSrc.slice(implStart, implEnd)
  }

  it('setPresentation includes zoom: 1 in set() call', () => {
    expect(getSetPresentationImpl()).toContain('zoom: 1')
  })

  it('setPresentation includes panX: 0', () => {
    expect(getSetPresentationImpl()).toContain('panX: 0')
  })

  it('setPresentation includes panY: 0', () => {
    expect(getSetPresentationImpl()).toContain('panY: 0')
  })
})
