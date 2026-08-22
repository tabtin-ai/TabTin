import { describe, expect, it } from 'vitest'
import { __TABSLIDE_POSTPROCESS_TESTING__ } from '../../../../../packages/tabslide/src/exports/pptx-postprocess'

describe('TabSlide Background Export Chain', () => {
  it('主题背景解析色与默认主题不一致时不应强制写 schemeClr', () => {
    const shouldPatch = __TABSLIDE_POSTPROCESS_TESTING__.shouldApplyThemeBackgroundPatch(
      'accent1',
      '#00FF00',
    )
    expect(shouldPatch).toBe(false)
  })

  it('主题背景解析色与默认主题一致时应保留 schemeClr 语义', () => {
    const shouldPatch = __TABSLIDE_POSTPROCESS_TESTING__.shouldApplyThemeBackgroundPatch(
      'accent1',
      '#4472C4',
    )
    expect(shouldPatch).toBe(true)
  })

  it('无解析色时应允许写入 schemeClr（主题语义优先）', () => {
    const shouldPatch = __TABSLIDE_POSTPROCESS_TESTING__.shouldApplyThemeBackgroundPatch(
      'accent1',
      undefined,
    )
    expect(shouldPatch).toBe(true)
  })
})
