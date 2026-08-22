/**
 * 文件预览共享类型
 *
 * 供 TabFolder / TabCode / Chat 预览等场景共用。
 */

export interface FilePreviewData {
  kind: 'text' | 'image' | 'pdf' | 'doc' | 'docx' | 'xlsx' | 'pptx' | 'video' | 'audio' | 'binary'
  content?: string
  path?: string
  size?: number
  truncated?: boolean
  mime?: string
}

export type FilePreviewKind = FilePreviewData['kind']
