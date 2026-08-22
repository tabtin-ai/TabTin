/**
 * Folder Utils
 *
 * 文件夹浏览相关的工具函数。
 * 预览/路径通用函数已迁至 shared/file-utils，此处 re-export 保持向后兼容。
 */

import i18n from '@/i18n'
import {
  formatFileSizeOptional,
  isArchiveFile,
  isAudioFile,
  isCodeFile,
  isCsvFile,
  isDocxFile,
  isImageFile,
  isPdfFile,
  isPptxFile,
  isTextFile,
  isVideoFile,
  isWordFile,
  isXlsxFile,
} from '@components/shared/file-utils'

export {
  getBaseName,
  getExtension,
  buildTabtinFileUrl,
  getMonacoLanguage,
  isImageFile,
  isVideoFile,
  isAudioFile,
  isCodeFile,
  isCsvFile,
  isTextFile,
  isPdfFile,
  isWordFile,
  isDocxFile,
  isXlsxFile,
  isPptxFile,
  isMarkdownFile,
  isOfficeFile,
  isArchiveFile,
  checkFileSize,
  MAX_OFFICE_FILE_BYTES,
} from '@components/shared/file-utils'

/**
 * 格式化文件大小（支持 undefined → i18n fallback）
 */
export const formatFileSize = (bytes?: number): string =>
  formatFileSizeOptional(bytes, i18n.t('context:folder.meta.unknownSize'))

/**
 * 格式化时间
 */
export const formatTime = (value?: number | null): string => {
  if (!value) return i18n.t('context:folder.meta.unknownTime')
  return new Date(value).toLocaleString(i18n.language)
}

/**
 * 获取文件类型标签
 */
export const getFileTypeLabel = (filename: string, isDirectory: boolean): string => {
  if (isDirectory) return i18n.t('context:folder.fileTypes.folder')
  if (isImageFile(filename)) return i18n.t('context:folder.fileTypes.image')
  if (isVideoFile(filename)) return i18n.t('context:folder.fileTypes.video')
  if (isAudioFile(filename)) return i18n.t('context:folder.fileTypes.audio')
  if (isPdfFile(filename)) return i18n.t('context:folder.fileTypes.pdf')
  if (isDocxFile(filename)) return i18n.t('context:folder.fileTypes.word')
  if (isXlsxFile(filename)) return i18n.t('context:folder.fileTypes.excel')
  if (isPptxFile(filename)) return i18n.t('context:folder.fileTypes.ppt')
  if (isCsvFile(filename)) return i18n.t('context:folder.fileTypes.csv', { defaultValue: 'CSV' })
  if (isCodeFile(filename)) return i18n.t('context:folder.fileTypes.code')
  if (isTextFile(filename)) return i18n.t('context:folder.fileTypes.text')
  if (isWordFile(filename)) return i18n.t('context:folder.fileTypes.word')
  if (isArchiveFile(filename)) return i18n.t('context:folder.fileTypes.archive')
  return i18n.t('context:folder.fileTypes.file')
}

export { copyToClipboard } from '@components/shared/file-ops/clipboard'
