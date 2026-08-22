/**
 * FileContextMenu - 文件右键菜单组件（TabFolder / TabCode 共用）
 */

import React from 'react'
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuDivider,
} from '@tabtin/smartsheet-ui'
import {
  Copy,
  ExternalLink,
  FileText,
  FolderOpen,
  Trash2,
  Edit3,
  FilePlus,
  FolderPlus,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { copyToClipboard } from './clipboard'

export interface FileContextMenuEntry {
  path: string
  name: string
  isDirectory: boolean
}

interface FileContextMenuProps {
  entry: FileContextMenuEntry
  children: React.ReactNode
  onRevealInFinder?: () => void
  onOpenWithDefault?: () => void
  onDelete?: () => void
  onRename?: () => void
  onNewFile?: () => void
  onNewFolder?: () => void
}

export const FileContextMenu: React.FC<FileContextMenuProps> = ({
  entry,
  children,
  onRevealInFinder,
  onOpenWithDefault,
  onDelete,
  onRename,
  onNewFile,
  onNewFolder,
}) => {
  const { t } = useTranslation('context')
  const [open, setOpen] = React.useState(false)
  const [anchorPosition, setAnchorPosition] = React.useState<{ x: number; y: number } | undefined>(
    undefined
  )
  const canCreateChildren = entry.isDirectory && (onNewFile || onNewFolder)

  const handleContextMenu = (event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setAnchorPosition({ x: event.clientX, y: event.clientY })
    setOpen(true)
  }

  const runAction = (action?: (() => void) | (() => Promise<void>)) => {
    return () => {
      if (!action) return
      void action()
    }
  }

  const handleCopyPath = async () => {
    await copyToClipboard(entry.path)
  }

  const handleCopyName = async () => {
    await copyToClipboard(entry.name)
  }

  return (
    <>
      <div onContextMenu={handleContextMenu}>{children}</div>
      <ContextMenu
        open={open}
        onClose={() => setOpen(false)}
        anchorPosition={anchorPosition}
        className="w-48"
      >
        {/* 打开/查看操作 */}
        {onOpenWithDefault && !entry.isDirectory && (
          <ContextMenuItem
            onClick={runAction(onOpenWithDefault)}
            icon={<FileText className="h-4 w-4" />}
            label={t('folder.labels.openWithDefault')}
          />
        )}

        {onRevealInFinder && (
          <ContextMenuItem
            onClick={runAction(onRevealInFinder)}
            icon={
              entry.isDirectory ? (
                <FolderOpen className="h-4 w-4" />
              ) : (
                <ExternalLink className="h-4 w-4" />
              )
            }
            label={t('folder.labels.revealInFinder')}
          />
        )}

        {canCreateChildren && (
          <>
            {onNewFile && (
              <ContextMenuItem
                onClick={runAction(onNewFile)}
                icon={<FilePlus className="h-4 w-4" />}
                label={t('fileOps.newFile', { defaultValue: '新建文件' })}
              />
            )}
            {onNewFolder && (
              <ContextMenuItem
                onClick={runAction(onNewFolder)}
                icon={<FolderPlus className="h-4 w-4" />}
                label={t('fileOps.newFolder', { defaultValue: '新建文件夹' })}
              />
            )}
          </>
        )}

        <ContextMenuDivider />

        {/* 复制操作 */}
        <ContextMenuItem
          onClick={runAction(handleCopyPath)}
          icon={<Copy className="h-4 w-4" />}
          label={t('folder.labels.copyPath')}
        />

        <ContextMenuItem
          onClick={runAction(handleCopyName)}
          icon={<Copy className="h-4 w-4" />}
          label={t('folder.labels.copyName')}
        />

        {/* 编辑操作 */}
        {(onRename || onDelete) && <ContextMenuDivider />}

        {onRename && (
          <ContextMenuItem
            onClick={runAction(onRename)}
            icon={<Edit3 className="h-4 w-4" />}
            label={t('folder.labels.rename')}
          />
        )}

        {onDelete && (
          <ContextMenuItem
            onClick={runAction(onDelete)}
            icon={<Trash2 className="h-4 w-4" />}
            label={t('folder.labels.delete')}
            danger
          />
        )}
      </ContextMenu>
    </>
  )
}

FileContextMenu.displayName = 'FileContextMenu'
