/**
 * 云盘资源列表 / 宫格图标：
 * - 实例自定义 metadata.icon 优先
 * - 原生 App 资源沿用类型 displayEmoji（TabDoc 📄 / TabData 📊 …）
 * - 裸文件（file / tabfiles）按扩展名映射，不再统一显示 📁
 */

import { metaIcon, metaStr, resolveResourceEmoji } from './metaFieldUtils'

const DOC_EXTENSIONS = new Set([
  'doc', 'docx', 'pdf', 'md', 'markdown', 'mark', 'txt',
])
const TABLE_EXTENSIONS = new Set(['xlsx', 'csv', 'tsv', 'xls'])
const SLIDE_EXTENSIONS = new Set(['pptx', 'ppt'])
const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
])

/** 与 TabDoc / TabData / TabSlide displayEmoji 对齐的扩展名 → emoji */
export function resolveImportedFileEmoji(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? fileName
  const ext = base.includes('.')
    ? base.slice(base.lastIndexOf('.') + 1).toLowerCase()
    : ''
  if (TABLE_EXTENSIONS.has(ext)) return '📊'
  if (SLIDE_EXTENSIONS.has(ext)) return '📽️'
  if (IMAGE_EXTENSIONS.has(ext)) return '🖼️'
  if (DOC_EXTENSIONS.has(ext)) return '📄'
  return '📄'
}

type MetaRecord = Record<string, unknown> | undefined | null

/**
 * @param itemType 建议传入 normalize 后的类型
 * @param title 资源标题，裸文件常等于原始文件名
 */
export function resolveCloudResourceEmoji(
  itemType: string,
  metadata: MetaRecord,
  getTypeEmoji: (type: string) => string | undefined,
  title?: string,
): string {
  const custom = metaIcon(metadata)
  if (custom) return custom

  if (itemType === 'file' || itemType === 'tabfiles') {
    const fileName = metaStr(metadata, 'file_name')
      || metaStr(metadata, 'fileName')
      || title
      || ''
    return resolveImportedFileEmoji(fileName)
  }

  return resolveResourceEmoji(itemType, metadata, getTypeEmoji)
}
