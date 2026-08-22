/**
 * Folder Module - 文件夹浏览功能
 *
 * 文件树 + 预览
 */

// 主组件
export { FileExplorerPane } from './FileExplorerPane'
export type { FileExplorerPaneProps } from './FileExplorerPane'

// 子组件
export { FileTree } from './FileTree'
export { FileTreeItem } from './FileTreeItem'
export { FilePreview } from './FilePreview'
export { FolderHeader } from './FolderHeader'
export { FileContextMenu } from './FileContextMenu'
// 预览组件（CodeEditor / PdfViewer / Office viewers 等）已迁至 @components/shared/file-preview，不在此 barrel 导出

// Store
export {
  useFolderContextStore,
  useFolderContextSource
} from './useFolderStore'
export type {
  FolderContextSourceOptions,
  FolderContextSourceResult,
  OpenFolderResult
} from './useFolderStore'

// Types
export type {
  FolderContextKind,
  FileEntry,
  FilePreviewData,
  SpaceFolderState
} from './types'

// Utils
export {
  formatFileSize,
  formatTime,
  getBaseName,
  getMonacoLanguage,
  getExtension,
  isImageFile,
  isCodeFile,
  isTextFile,
  isPdfFile,
  copyToClipboard
} from './utils'
