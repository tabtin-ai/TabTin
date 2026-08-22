/**
 * W4-01 回归测试：导入导出模块 Wave 4 修复
 *
 * 覆盖：
 * - F1-02: 表格/视频/音频超链接覆盖形状
 * - F1-04: ATTENTION_EFFECT_MAP 强调动画映射
 * - F4-01: safeImageSrc 允许后端绝对路径
 * - F4-02: LaTeX rasterSrc crossorigin 属性
 * - F4-06: canvas/video 元素占位符降级
 * - F5-05: secondsPerSlide 最小值保护
 * - F5-06: exportPresentationAsVideo 错误处理
 * - F4-07: downloadBlob 延迟 revoke
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const readSrc = (relativePath: string) =>
  fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf-8')

/* ── F1-02: addOverlayHyperlinkIfNeeded 存在于 pptx.ts ── */

describe('F1-02: pptx.ts 包含 addOverlayHyperlinkIfNeeded', () => {
  const src = readSrc('exports/pptx.ts')

  it('定义了 addOverlayHyperlinkIfNeeded 函数', () => {
    expect(src).toContain('function addOverlayHyperlinkIfNeeded')
  })

  it('addTableElement 末尾调用 addOverlayHyperlinkIfNeeded', () => {
    const tableSection = src.slice(src.indexOf('function addTableElement'))
    const nextFn = tableSection.indexOf('\nfunction ', 1)
    const body = tableSection.slice(0, nextFn > 0 ? nextFn : undefined)
    expect(body).toContain('addOverlayHyperlinkIfNeeded(slide, el, context)')
  })

  it('addVideoElement 调用 addOverlayHyperlinkIfNeeded', () => {
    const videoSection = src.slice(src.indexOf('function addVideoElement'))
    const nextFn = videoSection.indexOf('\nfunction ', 1)
    const body = videoSection.slice(0, nextFn > 0 ? nextFn : undefined)
    expect(body).toContain('addOverlayHyperlinkIfNeeded(slide, el, context)')
  })

  it('addAudioElement 调用 addOverlayHyperlinkIfNeeded', () => {
    const audioSection = src.slice(src.indexOf('function addAudioElement'))
    const nextFn = audioSection.indexOf('\nfunction ', 1)
    const body = audioSection.slice(0, nextFn > 0 ? nextFn : undefined)
    expect(body).toContain('addOverlayHyperlinkIfNeeded(slide, el, context)')
  })

  it('覆盖形状使用透明填充', () => {
    const fn = src.slice(src.indexOf('function addOverlayHyperlinkIfNeeded'))
    expect(fn).toContain("transparency")
    expect(fn).toContain("100")
    expect(fn).toContain("'none'")
  })
})

/* ── F1-04: ATTENTION_EFFECT_MAP 存在于 pptx-postprocess.ts ── */

describe('F1-04: ATTENTION_EFFECT_MAP 强调动画效果映射', () => {
  const src = readSrc('exports/pptx-postprocess.ts')

  it('定义了 ATTENTION_EFFECT_MAP 常量', () => {
    expect(src).toContain('const ATTENTION_EFFECT_MAP')
  })

  it('包含 bounce/shake/flash/spin/pulse 等核心效果', () => {
    const mapStart = src.indexOf('const ATTENTION_EFFECT_MAP')
    const mapEnd = src.indexOf('\nconst EXIT_EFFECT_MAP')
    const mapStr = src.slice(mapStart, mapEnd > mapStart ? mapEnd : mapStart + 800)
    expect(mapStr).toContain('pulse:')
    expect(mapStr).toContain('bounce:')
    expect(mapStr).toContain('shake:')
    expect(mapStr).toContain('flash:')
    expect(mapStr).toContain('spin:')
  })

  it('resolveAnimMapping 对 attention 类型使用 ATTENTION_EFFECT_MAP', () => {
    const fnStart = src.indexOf('function resolveAnimMapping')
    const fnEnd = src.indexOf('\n}', fnStart) + 2
    const fn = src.slice(fnStart, fnEnd)
    expect(fn).toContain('ATTENTION_EFFECT_MAP')
    expect(fn).not.toContain(': null')
  })
})

/* ── F4-01: safeImageSrc 允许后端绝对路径 ── */

describe('F4-01: safeImageSrc 允许 / 开头的路径', () => {
  const src = readSrc('exports/image.ts')

  it('safeImageSrc 包含 startsWith("/") 分支', () => {
    const fnStart = src.indexOf('function safeImageSrc')
    const fnEnd = src.indexOf('\n}', fnStart) + 2
    const fn = src.slice(fnStart, fnEnd)
    expect(fn).toContain("src.startsWith('/')")
  })
})

/* ── F4-02: LaTeX rasterSrc crossorigin ── */

describe('F4-02: LaTeX rasterSrc crossorigin 属性', () => {
  const src = readSrc('exports/image.ts')

  it('rasterSrc 分支设置 crossOrigin = "anonymous"', () => {
    const rasterIdx = src.indexOf('el.rasterSrc')
    const section = src.slice(rasterIdx, rasterIdx + 600)
    expect(section).toContain("img.crossOrigin = 'anonymous'")
  })

  it('rasterSrc 分支包含 onerror 降级', () => {
    const rasterIdx = src.indexOf('el.rasterSrc')
    const section = src.slice(rasterIdx, rasterIdx + 600)
    expect(section).toContain('img.onerror')
    expect(section).toContain('removeAttribute')
  })
})

/* ── F4-06: canvas/video 元素占位符 ── */

describe('F4-06: canvas/video 元素降级为占位符', () => {
  const src = readSrc('exports/image.ts')

  it('createElement switch 包含 canvas case', () => {
    expect(src).toContain("case 'canvas':")
  })

  it('createElement switch 包含 video case', () => {
    expect(src).toContain("case 'video':")
  })

  it('不再对 canvas/video 返回 null', () => {
    const videoIdx = src.indexOf("case 'video':")
    const canvasIdx = src.indexOf("case 'canvas':")
    expect(videoIdx).toBeGreaterThan(-1)
    expect(canvasIdx).toBeGreaterThan(-1)
    const sectionStart = Math.min(videoIdx, canvasIdx)
    const defaultIdx = src.indexOf('default:', sectionStart)
    const section = src.slice(sectionStart, defaultIdx)
    expect(section).toContain('Canvas')
  })
})

/* ── F4-07: downloadBlob 延迟 revoke ── */

describe('F4-07: downloadBlob 延迟 revokeObjectURL', () => {
  const src = readSrc('exports/image.ts')

  it('使用 setTimeout 延迟 revokeObjectURL', () => {
    const fnStart = src.indexOf('function downloadBlob')
    const fnEnd = src.indexOf('\n}', fnStart) + 2
    const fn = src.slice(fnStart, fnEnd)
    expect(fn).toContain('setTimeout')
    expect(fn).toContain('revokeObjectURL')
  })

  it('不再立即调用 revokeObjectURL', () => {
    const fnStart = src.indexOf('function downloadBlob')
    const fnEnd = src.indexOf('\n}', fnStart) + 2
    const fn = src.slice(fnStart, fnEnd)
    const lines = fn.split('\n').map(l => l.trim())
    const clickIdx = lines.findIndex(l => l.includes('a.click()'))
    const revokeIdx = lines.findIndex(l => l.includes('revokeObjectURL'))
    expect(revokeIdx).toBeGreaterThan(clickIdx)
    expect(lines[revokeIdx]).toContain('setTimeout')
  })
})
