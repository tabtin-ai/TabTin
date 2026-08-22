/**
 * 云盘「一级文件夹上传」过滤与白名单。
 *
 * - 只保留所选根目录下的直接文件（`根目录/文件名`），忽略子目录。
 * - 类型白名单为常用可预览办公 + 图片，不含音视频与代码/配置。
 */

import { TABFILES_IMPORT_MAX_SIZE_BYTES, fileExtension } from './resourceFileImportRouting'

/** 文件夹上传允许的扩展名（不含点、小写） */
export const CLOUD_FOLDER_UPLOAD_EXTENSIONS = [
  'doc',
  'docx',
  'pdf',
  'md',
  'markdown',
  'mark',
  'txt',
  'xlsx',
  'csv',
  'tsv',
  'pptx',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
] as const

const ALLOWED = new Set<string>(CLOUD_FOLDER_UPLOAD_EXTENSIONS)

export type CloudFolderUploadSkipReason =
  | 'nested'
  | 'unsupported_type'
  | 'duplicate'
  | 'empty'
  | 'too_large'

export interface CloudFolderUploadCandidate {
  file: File
  /** 展示用文件名（不含目录） */
  fileName: string
}

export interface CloudFolderUploadPlan {
  /** 所选本地根目录名，用于创建同名云盘文件夹 */
  folderName: string
  accepted: CloudFolderUploadCandidate[]
  skipped: Array<{ fileName: string; reason: CloudFolderUploadSkipReason }>
  skippedNestedCount: number
  skippedTypeCount: number
  skippedDuplicateCount: number
  skippedEmptyCount: number
  skippedTooLargeCount: number
}

function relativePathOf(file: File): string {
  const withRelative = file as File & { webkitRelativePath?: string }
  const relative = withRelative.webkitRelativePath?.trim()
  return relative || file.name
}

/**
 * 解析 webkitdirectory 选出的 FileList：
 * - `parts.length === 2` → 一级文件（`Root/name.ext`）
 * - `parts.length > 2` → 子目录，跳过
 * - `parts.length === 1` → 无相对路径时的兜底，按文件名接收（仍过白名单）
 */
export function planCloudFolderUpload(
  files: ArrayLike<File>,
  maxSizeBytes: number = TABFILES_IMPORT_MAX_SIZE_BYTES,
): CloudFolderUploadPlan {
  const list = Array.from(files)
  let folderName = ''
  const accepted: CloudFolderUploadCandidate[] = []
  const skipped: CloudFolderUploadPlan['skipped'] = []
  const seenFileNames = new Set<string>()
  let skippedNestedCount = 0
  let skippedTypeCount = 0
  let skippedDuplicateCount = 0
  let skippedEmptyCount = 0
  let skippedTooLargeCount = 0

  for (const file of list) {
    const relativePath = relativePathOf(file)
    const parts = relativePath.split(/[/\\]/).filter(Boolean)
    if (!folderName && parts.length >= 1) {
      folderName = parts[0]
    }

    const fileName = parts.length >= 2 ? parts[parts.length - 1] : file.name

    if (parts.length > 2) {
      skippedNestedCount += 1
      skipped.push({ fileName: relativePath, reason: 'nested' })
      continue
    }

    if (file.size === 0) {
      skippedEmptyCount += 1
      skipped.push({ fileName, reason: 'empty' })
      continue
    }

    if (file.size > maxSizeBytes) {
      skippedTooLargeCount += 1
      skipped.push({ fileName, reason: 'too_large' })
      continue
    }

    const ext = fileExtension(fileName)
    if (!ALLOWED.has(ext)) {
      skippedTypeCount += 1
      skipped.push({ fileName, reason: 'unsupported_type' })
      continue
    }

    // webkitdirectory 偶发同一一级文件出现两次；按文件名去重保留首个
    const dedupeKey = fileName.toLowerCase()
    if (seenFileNames.has(dedupeKey)) {
      skippedDuplicateCount += 1
      skipped.push({ fileName, reason: 'duplicate' })
      continue
    }
    seenFileNames.add(dedupeKey)

    accepted.push({ file, fileName })
  }

  return {
    folderName: folderName || 'Folder',
    accepted,
    skipped,
    skippedNestedCount,
    skippedTypeCount,
    skippedDuplicateCount,
    skippedEmptyCount,
    skippedTooLargeCount,
  }
}

export function formatCloudFolderUploadAccept(): string {
  return CLOUD_FOLDER_UPLOAD_EXTENSIONS.map(ext => `.${ext}`).join(',')
}
