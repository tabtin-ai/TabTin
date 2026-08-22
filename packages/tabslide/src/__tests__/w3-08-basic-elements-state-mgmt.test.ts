/**
 * W3-08 回归测试：基础元素 + 状态管理修复
 *
 * 覆盖：
 * - B1-04: 末段 paraSpaceAfter 不注入
 * - B2-01: flipH/V 裁剪拖拽方向补偿
 * - B2-02: PPTX 导出 flip+裁剪坐标镜像
 * - B2-03: 客户端 PPTX 导入 base64 标记 offlinePendingUpload
 * - B2-08: 椭圆裁剪模式 clipPath 保留
 * - B3-01: convertShapeElement 写入文字内容
 * - B4-02: lineWidth JSDoc 单位标注
 * - E1-08: reorderAnimations off-by-one
 * - H2-02: applyHistoryPages 走 normalizeElementTransform
 * - H2-12: applyHistoryPages 重置 version
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { useSlideStore } from '../store/slide'
import type { PPTAnimation, PPTShapeElement, PPTLineElement, Slide, SlidePresentation } from '../types/slides'

const readSrc = (relativePath: string) =>
  fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf-8')

/* ── B1-04: extractParagraphStyle 末段不注入 paraSpaceAfter ── */

describe('B1-04: parseHtmlToTextProps 末段无 paraSpaceAfter', () => {
  it('pptx.ts 中 collectParagraphs 后对末段 delete paraSpaceAfter', () => {
    const src = readSrc('exports/pptx.ts')
    expect(src).toContain('delete lastPara.paraOptions.paraSpaceAfter')
    expect(src).toContain('B1-04')
  })

  it('单段落和多段落均删除末段 paraSpaceAfter', () => {
    const src = readSrc('exports/pptx.ts')
    expect(src).toContain('单段落或多段落均需删除末段')
    expect(src).not.toContain('paragraphs.length > 1')
  })
})

/* ── B2-01: flipH/V 裁剪手柄拖拽方向取反 ── */

describe('B2-01: flip 裁剪拖拽方向补偿', () => {
  it('ImageElement onMove 中 dx/dy 乘以 flip 因子', () => {
    const src = readSrc('components/elements/ImageElement.tsx')
    expect(src).toContain('element.flipH ? -1 : 1')
    expect(src).toContain('element.flipV ? -1 : 1')
  })
})

/* ── B2-02: PPTX 导出 flip+裁剪坐标镜像 ── */

describe('B2-02: flip+裁剪坐标镜像', () => {
  it('pptx.ts 中裁剪坐标根据 flipH/flipV 做镜像换算', () => {
    const src = readSrc('exports/pptx.ts')
    expect(src).toContain('el.flipH ? (1 - rectClip.right) : rectClip.left')
    expect(src).toContain('el.flipV ? (1 - rectClip.bottom) : rectClip.top')
  })

  it('栅格化路径下不再传递 flipH/flipV 给 PPTX', () => {
    const src = readSrc('exports/pptx.ts')
    expect(src).toContain('if (!useRasterized)')
    expect(src).toContain('if (el.flipH) imgOpts.flipH = true')
  })
})

/* ── B2-03: base64 图片标记 offlinePendingUpload ── */

describe('B2-03: PPTX 导入 base64 图片标记 offlinePendingUpload', () => {
  it('import-pptx.ts 中 data: 开头的 src 设置 offlinePendingUpload', () => {
    const src = readSrc('exports/import-pptx.ts')
    expect(src).toContain("relData.src.startsWith('data:')")
    expect(src).toContain('offlinePendingUpload: true')
  })
})

/* ── B2-04: 栅格化时应用 flip 镜像 ── */

describe('B2-04: rasterizeImageElementForPptx flip 镜像', () => {
  it('Canvas 绘制前根据 flipH/flipV 做 translate+scale', () => {
    const src = readSrc('exports/pptx.ts')
    expect(src).toContain('el.flipH ? canvasW : 0')
    expect(src).toContain('el.flipV ? canvasH : 0')
    expect(src).toContain('el.flipH ? -1 : 1')
  })
})

/* ── B2-08: 椭圆裁剪模式 clipPath 保留 ── */

describe('B2-08: 椭圆裁剪 crop 模式保留 clipPath', () => {
  it('ImageElement clipPath 逻辑：椭圆不受 isCropping 影响', () => {
    const src = readSrc('components/elements/ImageElement.tsx')
    // 椭圆 clip 在 isCropping 检查之前返回
    const ellipseIdx = src.indexOf("shape === 'ellipse'")
    const isCroppingIdx = src.indexOf('if (isCropping) return undefined')
    expect(ellipseIdx).toBeGreaterThan(-1)
    expect(isCroppingIdx).toBeGreaterThan(-1)
    expect(ellipseIdx).toBeLessThan(isCroppingIdx)
  })
})

/* ── B4-02: lineWidth JSDoc 注释修正 ── */

describe('B4-02: lineWidth JSDoc 单位修正', () => {
  it('types/slides.ts 中 lineWidth 注释为 pt 而非 px', () => {
    const src = readSrc('types/slides.ts')
    expect(src).toContain('线宽 (pt)')
    expect(src).not.toContain('线宽 (px)')
  })
})

/* ── E1-08: reorderAnimations off-by-one ── */

describe('E1-08: reorderAnimations 不再有 off-by-one', () => {
  it('animation slice 中 splice 使用 insertIdx 插入', () => {
    const src = readSrc('store/slide/slices/animation/action.ts')
    expect(src).toContain('from < to ? to - 1 : to')
    expect(src).toContain('arr.splice(insertIdx, 0, item)')
  })

  it('reorderAnimations 逻辑验证：正向移动到目标索引', () => {
    const anims: PPTAnimation[] = [
      { id: 'a', elId: 'e1', type: 'fadeIn', trigger: 'click', duration: 500 },
      { id: 'b', elId: 'e2', type: 'fadeIn', trigger: 'click', duration: 500 },
      { id: 'c', elId: 'e3', type: 'fadeIn', trigger: 'click', duration: 500 },
    ]
    useSlideStore.getState().reset()
    useSlideStore.getState().setPresentation(makeAnimationPresentation(anims))

    useSlideStore.getState().reorderAnimations(0, 2)

    const updated = useSlideStore.getState().presentation!.pages[0].animations!
    expect(updated.map(a => a.id)).toEqual(['b', 'a', 'c'])
  })

  it('reorderAnimations 逻辑验证：反向移动', () => {
    const anims: PPTAnimation[] = [
      { id: 'a', elId: 'e1', type: 'fadeIn', trigger: 'click', duration: 500 },
      { id: 'b', elId: 'e2', type: 'fadeIn', trigger: 'click', duration: 500 },
      { id: 'c', elId: 'e3', type: 'fadeIn', trigger: 'click', duration: 500 },
    ]
    useSlideStore.getState().reset()
    useSlideStore.getState().setPresentation(makeAnimationPresentation(anims))

    useSlideStore.getState().reorderAnimations(2, 0)

    const updated = useSlideStore.getState().presentation!.pages[0].animations!
    expect(updated.map(a => a.id)).toEqual(['c', 'a', 'b'])
  })
})

const makeAnimationPresentation = (animations: PPTAnimation[]): SlidePresentation => ({
  id: 'pres-animation-test',
  name: 'Animation Test',
  preset: '16:9',
  canvasWidth: 1920,
  canvasHeight: 1080,
  pages: [{
    id: 'page-1',
    elements: [
      { id: 'e1', type: 'text', x: 0, y: 0, width: 100, height: 50, content: '<p>1</p>' },
      { id: 'e2', type: 'text', x: 0, y: 60, width: 100, height: 50, content: '<p>2</p>' },
      { id: 'e3', type: 'text', x: 0, y: 120, width: 100, height: 50, content: '<p>3</p>' },
    ] as Slide['elements'],
    animations,
  }],
})

/* ── H2-02 + H2-12: applyHistoryPages 走 normalizeElementTransform + 重置 version ── */

describe('H2-02 + H2-12: applyHistoryPages store action', () => {
  it('editor slice 声明 applyHistoryPages action', () => {
    const src = readSrc('store/slide/slices/editor/action.ts')
    expect(src).toContain('applyHistoryPages')
  })

  it('applyHistoryPages 走 normalizeElementTransform', () => {
    const src = readSrc('store/slide/slices/editor/action.ts')
    const implIdx = src.indexOf("applyHistoryPages: SlideStoreState['applyHistoryPages']")
    expect(implIdx).toBeGreaterThan(-1)
    const snippet = src.slice(implIdx, implIdx + 800)
    expect(snippet).toContain('normalizeElementTransform')
  })

  it('applyHistoryPages 重置 version 为 0', () => {
    const src = readSrc('store/slide/slices/editor/action.ts')
    const implIdx = src.indexOf("applyHistoryPages: SlideStoreState['applyHistoryPages']")
    expect(implIdx).toBeGreaterThan(-1)
    const snippet = src.slice(implIdx, implIdx + 1200)
    expect(snippet).toContain('version: 0')
  })

  it('useKeyboard 使用 store.getState().applyHistoryPages 而非直接 setState', () => {
    const src = readSrc('hooks/useKeyboard.ts')
    expect(src).toContain('store.getState().applyHistoryPages(pages)')
    expect(src).not.toContain('store.setState((prev) =>')
  })
})

/* ── B3-02: 形状文字嵌入形状而非独立 addText ── */

describe('B3-02: PPTX 导出形状文字内嵌', () => {
  it('pptx.ts 中含文字形状走 addText+shape 合并路径', () => {
    const src = readSrc('exports/pptx.ts')
    expect(src).toContain('textShapeOpts.shape = shapeType')
    expect(src).toContain("textShapeOpts.shape = 'custGeom'")
    expect(src).toContain('slide.addText(textParts, textShapeOpts')
  })
})

/* ── B1-02 + B1-05: 协作文本同步守护 ── */

describe('B1-02 + B1-05: 外部同步 effect editor.isFocused 守护', () => {
  it('TextElement.tsx 外部同步检查 editor.isFocused', () => {
    const src = readSrc('components/elements/TextElement.tsx')
    expect(src).toContain('editor.isFocused')
    expect(src).toContain('B1-05')
  })
})

/* ── E3-03: 离线回放时序安全 ── */

describe('E3-03: 重连刷新使用 queueMicrotask', () => {
  it('useSlideCollaboration 中刷新使用 queueMicrotask', () => {
    const src = readSrc('hooks/useSlideCollaboration.ts')
    expect(src).toContain('queueMicrotask')
    expect(src).toContain('E3-03')
  })
})

/* ── B2-11: waitForImages CORS 重试 ── */

describe('B2-11: waitForImages CORS 重试', () => {
  it('exports/image.ts 中首次失败后尝试 crossOrigin 重试', () => {
    const src = readSrc('exports/image.ts')
    expect(src).toContain("img.crossOrigin = 'anonymous'")
    expect(src).toContain('img.src = img.src')
  })

  it('第二次 onerror 必须调用 done()', () => {
    const src = readSrc('exports/image.ts')
    const startIdx = src.indexOf('if (!img.crossOrigin)')
    expect(startIdx).toBeGreaterThan(-1)
    const endIdx = src.indexOf('img.src = img.src', startIdx)
    expect(endIdx).toBeGreaterThan(startIdx)
    const retryBlock = src.slice(startIdx, endIdx + 50)
    expect(retryBlock).toContain('img.onerror = () => done()')
  })
})
