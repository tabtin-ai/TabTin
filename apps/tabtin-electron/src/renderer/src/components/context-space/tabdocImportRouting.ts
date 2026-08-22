export const TABDOC_TEXT_IMPORT_EXTENSIONS = ['md', 'markdown', 'mark', 'txt'] as const
export const TABDOC_STRUCTURED_IMPORT_EXTENSIONS = ['doc', 'docx'] as const

export const TABDOC_IMPORT_EXTENSIONS = [
  ...TABDOC_TEXT_IMPORT_EXTENSIONS,
  ...TABDOC_STRUCTURED_IMPORT_EXTENSIONS,
] as const

export const TABDOC_IMPORT_ACCEPT = TABDOC_IMPORT_EXTENSIONS
  .map(ext => `.${ext}`)
  .join(',')

const TABDOC_FETCH_ENVELOPE_INSPECTION_EXTENSIONS = [
  ...TABDOC_TEXT_IMPORT_EXTENSIONS,
  'json',
  'html',
  'htm',
] as const

export const TABDOC_IMPORT_MAX_SIZE_BY_EXTENSION: Record<string, number> = {
  doc: 50 * 1024 * 1024,
  docx: 50 * 1024 * 1024,
}

export function isStructuredTabDocImportExtension(ext: string): boolean {
  return (TABDOC_STRUCTURED_IMPORT_EXTENSIONS as readonly string[]).includes(ext.toLowerCase())
}

export function shouldInspectTabDocImportForFetchEnvelope(ext: string): boolean {
  return (TABDOC_FETCH_ENVELOPE_INSPECTION_EXTENSIONS as readonly string[])
    .includes(ext.toLowerCase())
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 识别 `tabtin fetch` 写出的截断结果信封。
 *
 * 这类文件只包含前一段正文和本机完整内容路径；把它改名成 HTML/JSON 后导入
 * 只能得到截断摘要。导入侧应明确拒绝，避免用户误以为 TabDoc 丢了后半段。
 */
export function isTruncatedFetchResultEnvelope(text: string): boolean {
  if (!text.trimStart().startsWith('{')) return false

  try {
    const payload: unknown = JSON.parse(text)
    if (!isRecord(payload) || payload.ok !== true || !isRecord(payload.data)) return false

    const data = payload.data
    return typeof data.content === 'string'
      && typeof data.title === 'string'
      && isHttpUrl(data.url)
      && Number.isInteger(data.wordCount)
      && (data.wordCount as number) >= 0
      && isRecord(data.quality)
      && typeof data.quality.ok === 'boolean'
      && typeof data.fallback_used === 'string'
      && data.truncated === true
      && Number.isInteger(data.content_length)
      && (data.content_length as number) > data.content.length
      && typeof data.full_content_path === 'string'
      && data.full_content_path.trim().length > 0
  } catch {
    return false
  }
}
