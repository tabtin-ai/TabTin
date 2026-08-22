import { describe, expect, it } from 'vitest'
import {
  PPTX_PREVIEW_CJK_FALLBACK,
  buildPptxPreviewFontFamily,
} from './pptx-preview-font'

describe('buildPptxPreviewFontFamily ', () => {
  it('西文字体后面跟上 CJK fallback，避免中文空心方框', () => {
    expect(buildPptxPreviewFontFamily('Arial')).toBe(
      `'Arial', ${PPTX_PREVIEW_CJK_FALLBACK}`,
    )
    expect(buildPptxPreviewFontFamily('Arial')).toContain('Microsoft YaHei')
    expect(buildPptxPreviewFontFamily('Arial')).toContain('PingFang SC')
  })

  it('主题占位符和空名都回落到 CJK 栈，不当 CSS 字体用', () => {
    expect(buildPptxPreviewFontFamily('+mn-lt')).toBe(PPTX_PREVIEW_CJK_FALLBACK)
    expect(buildPptxPreviewFontFamily(undefined)).toBe(PPTX_PREVIEW_CJK_FALLBACK)
    expect(buildPptxPreviewFontFamily('  ')).toBe(PPTX_PREVIEW_CJK_FALLBACK)
  })
})
