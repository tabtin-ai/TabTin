export const TEXT_IMPORT_MAX_BYTES = 5 * 1024 * 1024
export const DOCUMENT_IMPORT_MAX_BYTES = 50 * 1024 * 1024
/** Align with OSS IMAGE preset (20MB), not the legacy ImageParser 5MB cap. */
export const IMAGE_IMPORT_MAX_BYTES = 20 * 1024 * 1024

/** Editor toolbar「导入图片」：只允许图片（浏览器按 MIME 过滤）。 */
export const IMAGE_IMPORT_FILE_ACCEPT = 'image/*'

/** DocList 等文档导入入口：文本 / Word，不含图片。 */
export const IMPORT_FILE_ACCEPT = [
  '.md',
  '.markdown',
  '.mark',
  '.txt',
  '.doc',
  '.docx',
].join(',')

const TEXT_IMPORT_EXTENSION_RE = /\.(md|markdown|mark|txt)$/i
const DOCUMENT_IMPORT_EXTENSION_RE = /\.(doc|docx)$/i
const IMPORT_DOCUMENT_OR_TEXT_EXTENSION_RE =
  /\.(md|markdown|mark|txt|doc|docx)$/i
/** Keep in sync with Electron `IMAGE_FILE_EXTENSIONS` / OSS IMAGE extensions. */
const IMAGE_IMPORT_EXTENSION_RE =
  /\.(png|jpe?g|jfif|gif|webp|bmp|avif|apng|svgz?|heic|heif|tiff?)$/i

export type TabDocImportFileKind = 'text' | 'document' | 'image' | 'unsupported'

export function getTabDocImportFileKind(
  fileName: string,
  mimeType?: string | null,
): TabDocImportFileKind {
  if (TEXT_IMPORT_EXTENSION_RE.test(fileName)) return 'text'
  if (IMAGE_IMPORT_EXTENSION_RE.test(fileName)) return 'image'
  if (typeof mimeType === 'string' && mimeType.toLowerCase().startsWith('image/')) {
    return 'image'
  }
  if (DOCUMENT_IMPORT_EXTENSION_RE.test(fileName)) return 'document'
  return 'unsupported'
}

export function isSupportedTabDocImportFile(
  fileName: string,
  mimeType?: string | null,
): boolean {
  return getTabDocImportFileKind(fileName, mimeType) !== 'unsupported'
}

export function getTabDocImportMaxBytes(
  fileName: string,
  mimeType?: string | null,
): number {
  const importKind = getTabDocImportFileKind(fileName, mimeType)
  if (importKind === 'text') return TEXT_IMPORT_MAX_BYTES
  if (importKind === 'image') return IMAGE_IMPORT_MAX_BYTES
  return DOCUMENT_IMPORT_MAX_BYTES
}

export function stripTabDocImportExtension(fileName: string): string {
  return fileName
    .replace(IMPORT_DOCUMENT_OR_TEXT_EXTENSION_RE, '')
    .replace(IMAGE_IMPORT_EXTENSION_RE, '')
}

export function buildImportedImageMarkdown(fileName: string, url: string): string {
  const alt = stripTabDocImportExtension(fileName).trim() || 'image'
  const safeAlt = alt.replace(/[[\]]/g, '')
  return `![${safeAlt}](${url})`
}
