/**
 * 文件树 CRUD / 校验 / 右键菜单 — TabFolder 与 TabCode 共用
 */

export { validateFileName, INVALID_FILE_NAME_CHARS } from './validateFileName'
export { copyToClipboard } from './clipboard'
export { useFileTreeActions } from './useFileTreeActions'
export type { FileTreeActionsI18nNamespace } from './useFileTreeActions'
export { RenameInput } from './RenameInput'
export type { RenameInputProps } from './RenameInput'
export { FileContextMenu } from './FileContextMenu'
export type { FileContextMenuEntry } from './FileContextMenu'
export { NewItemInput } from './NewItemInput'
export type { NewItemInputProps } from './NewItemInput'
export { depthForNewItem } from './depthForNewItem'
export { useFileTreeDragDrop } from './useFileTreeDragDrop'
export type { FileTreeNewItemMode, FileTreeNewItemState } from './fileTreeTypes'
