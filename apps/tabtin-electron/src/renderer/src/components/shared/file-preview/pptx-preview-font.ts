/**
 * 聊天 / 云文档 PPT 预览用的字体栈。
 *
 * 源文件常把西文写成 Arial/Calibri、中文写在 `<a:ea>`（微软雅黑）。
 * 预览若只套西文字体、不带 CJK fallback，中文会变成空心方框。
 */
export const PPTX_PREVIEW_CJK_FALLBACK =
  "'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans SC', sans-serif"

const THEME_TYPEFACE_PLACEHOLDER = /^\+(mn|mj)-(lt|ea|cs)$/i

export function buildPptxPreviewFontFamily(defaultFontName?: string): string {
  const name = defaultFontName?.trim()
  if (!name || THEME_TYPEFACE_PLACEHOLDER.test(name)) {
    return PPTX_PREVIEW_CJK_FALLBACK
  }
  const token = /['",]/.test(name) ? name : `'${name}'`
  return `${token}, ${PPTX_PREVIEW_CJK_FALLBACK}`
}
