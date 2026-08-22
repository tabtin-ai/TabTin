/**
 * Folder Context Types
 *
 * 文件夹浏览相关的类型定义
 */

export type FolderContextKind = 'user' | 'sandbox'
export type FolderSourceKind = 'spaceWorkingDir' | 'userFolder' | 'legacySpaceFolder'

export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modifiedAt: number | null
}

export type { FilePreviewData } from '@components/shared/file-preview/types'

export interface SpaceFolderState {
  rootPath: string
  kind: FolderContextKind
  title: string
  updatedAt: number
  refreshToken: number
  sourceKind?: FolderSourceKind
  scopeKey?: string
  sourceSpaceId?: string
  agentId?: string
  readOnly?: boolean
}

// 历史 WatchEventPayload 已被 @shared/fs-watch-types 的 FsWatchEvent 取代。
// 上层若需要 watch 事件类型，请从 @hooks/useFolderWatch 导入 FolderWatchEvent。
