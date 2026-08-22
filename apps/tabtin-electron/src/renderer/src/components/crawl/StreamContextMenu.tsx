import React from 'react'
import {
  ExternalLink,
  FolderOpen,
  Link2,
  X,
  Trash2,
} from 'lucide-react'
import { ContextMenu, ContextMenuItem, ContextMenuDivider, toast } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import type { StreamDownloadItem } from '@stores/useDownloadStore'
import { storeActions } from './DownloadRowShared'
import { ensureLegacyOk } from '@/services/legacy-result'

interface StreamContextMenuProps {
  x: number
  y: number
  item: StreamDownloadItem
  onClose: () => void
}

export const StreamContextMenu: React.FC<StreamContextMenuProps> = ({ x, y, item, onClose }) => {
  const { t } = useTranslation('crawl')
  const { status, id, url, savePath } = item
  const isActive = status === 'resolving' || status === 'downloading' || status === 'merging'

  const handleDeleteFile = async () => {
    if (!savePath) return
    const fallbackError = t('downloads.deleteFileFailed', '删除文件失败')
    // contract W2-β: 走 window.tabtin.fileSystem.deleteFile（preload 已包装为
    // invokeIpc，享受 envelope ok:false 短路 + ring buffer 记录）；旧裸 IPC
    // invoke 路径已废弃。channel `fs:deleteFile` 在 LEGACY_HANDLERS
    // 内仍透传 raw `{success, error?}`，所以用 ensureLegacyOk 转 throw。
    const fsApi = window.tabtin?.fileSystem
    if (!fsApi?.deleteFile) {
      toast({ title: fallbackError, variant: 'destructive' })
      return
    }
    try {
      const delRes = await fsApi.deleteFile(savePath)
      ensureLegacyOk(delRes, 'fs:deleteFile')
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : fallbackError
      toast({ title: message, variant: 'destructive' })
      return
    }
    storeActions.removeStreamItem(id)
  }

  return (
    <ContextMenu open onClose={onClose} anchorPosition={{ x, y }}>
      {status === 'completed' && savePath && (
        <ContextMenuItem
          icon={<ExternalLink className="w-4 h-4" />}
          label={t('downloads.openFile', '打开文件')}
          onClick={() => storeActions.openPath(savePath)}
        />
      )}
      {status === 'completed' && savePath && (
        <ContextMenuItem
          icon={<FolderOpen className="w-4 h-4" />}
          label={t('downloads.showInFolderAction', '在文件夹中显示')}
          onClick={() => storeActions.showPathInFolder(savePath)}
        />
      )}
      {url && (
        <ContextMenuItem
          icon={<Link2 className="w-4 h-4" />}
          label={t('downloads.copyLink', '复制下载链接')}
          onClick={() => navigator.clipboard.writeText(url)}
        />
      )}
      {isActive && (
        <>
          <ContextMenuDivider />
          <ContextMenuItem
            icon={<X className="w-4 h-4" />}
            label={t('downloads.cancelAction', '取消下载')}
            danger
            onClick={() => storeActions.cancelStream(id)}
          />
        </>
      )}
      {!isActive && (
        <>
          <ContextMenuDivider />
          <ContextMenuItem
            icon={<X className="w-4 h-4" />}
            label={t('downloads.removeAction', '从列表移除')}
            onClick={() => storeActions.removeStreamItem(id)}
          />
        </>
      )}
      {status === 'completed' && savePath && (
        <ContextMenuItem
          icon={<Trash2 className="w-4 h-4" />}
          label={t('downloads.deleteFileAction', '删除文件')}
          danger
          onClick={handleDeleteFile}
        />
      )}
    </ContextMenu>
  )
}
