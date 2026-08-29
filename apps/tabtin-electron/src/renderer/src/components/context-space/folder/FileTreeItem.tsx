/**
 * FileTreeItem - 文件树单项组件
 */

import React from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@utils/cn'
import { FileIcon } from '@components/shared/file-icon/FileIcon'
import type { FileEntry } from './types'
interface FileTreeItemProps {
  entry: FileEntry
  depth: number
  isExpanded: boolean
  isSelected: boolean
  isLoading?: boolean
  isDropTarget?: boolean
  isDragging?: boolean
  onToggle: (path: string) => void
  onSelect: (entry: FileEntry) => void
  onContextMenu?: (e: React.MouseEvent) => void
  dragHandlers?: {
    draggable: boolean
    onDragStart: (e: React.DragEvent) => void
    onDragEnd: () => void
  }
  dropHandlers?: {
    onDragOver: (e: React.DragEvent) => void
    onDragLeave: (e: React.DragEvent) => void
    onDrop: (e: React.DragEvent) => void
  }
}

export const FileTreeItem: React.FC<FileTreeItemProps> = React.memo(({
  entry,
  depth,
  isExpanded,
  isSelected,
  isLoading,
  isDropTarget,
  isDragging,
  onToggle,
  onSelect,
  onContextMenu,
  dragHandlers,
  dropHandlers,
}) => {
  const paddingLeft = depth * 12

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onSelect(entry)
    if (entry.isDirectory) {
      onToggle(entry.path)
    }
  }

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (entry.isDirectory) {
      onToggle(entry.path)
    }
  }

  return (
    <button
      type="button"
      className={cn(
        'flex items-center w-full text-left',
        'h-[26px] text-body leading-[18px]',
        'rounded-md mx-1 transition-colors duration-75 select-none',
        isSelected
          ? 'bg-primary/10 text-foreground ring-1 ring-inset ring-primary/20'
          : 'text-foreground/60 hover:bg-muted/30 hover:text-foreground',
        isDropTarget && 'ring-1 ring-primary/40 bg-primary/8',
        isDragging && 'opacity-40',
      )}
      // Keep the full row in the scrollable width. A fixed 100% width makes
      // deep nesting consume the available filename area permanently, even
      // when the tree itself is scrolled horizontally.
      style={{ paddingLeft, width: 'max-content', minWidth: 'calc(100% - 8px)' }}
      aria-pressed={isSelected}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={onContextMenu}
      {...dragHandlers}
      {...dropHandlers}
    >
      <span className="w-4 h-4 flex items-center justify-center flex-shrink-0">
        {entry.isDirectory ? (
          isLoading ? (
            <span className="w-3 h-3 border border-muted-foreground/40 border-t-transparent rounded-full animate-spin" />
          ) : isExpanded ? (
            <ChevronDown className="h-3 w-3 opacity-40" />
          ) : (
            <ChevronRight className="h-3 w-3 opacity-40" />
          )
        ) : null}
      </span>

      <FileIcon
        fileName={entry.name}
        isDirectory={entry.isDirectory}
        isOpen={entry.isDirectory && isExpanded}
        className="h-3.5 w-3.5 shrink-0 mr-1"
      />

      <span className="flex-1 whitespace-nowrap">{entry.name}</span>
    </button>
  )
})

FileTreeItem.displayName = 'FileTreeItem'
