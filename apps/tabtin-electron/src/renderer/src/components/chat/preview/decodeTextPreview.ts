/** 与本地 TabFiles 文本预览对齐的截断上限 */
export const TEXT_PREVIEW_MAX_BYTES = 512 * 1024

export function decodeTextPreview(data: ArrayBuffer): { text: string; truncated: boolean } {
  const truncated = data.byteLength > TEXT_PREVIEW_MAX_BYTES
  const slice = truncated ? data.slice(0, TEXT_PREVIEW_MAX_BYTES) : data
  return { text: new TextDecoder().decode(slice), truncated }
}
