import React from 'react'
import {
  ExternalLink,
  FolderOpen,
  Link2,
  RotateCw,
  Pause,
  Play,
  X,
  Trash2,
} from 'lucide-react'
import { ContextMenu, ContextMenuItem, ContextMenuDivider } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import type { DownloadItem } from '@stores/useDownloadStore'
import { storeActions } from './DownloadRowShared'

interface DownloadContextMenuProps {
  x: number
  y: number
  item: DownloadItem
  onClose: () => void
}

export const DownloadContextMenu: React.FC<DownloadContextMenuProps> = ({ x, y, item, onClose }) => {
  const { t } = useTranslation('crawl')
  const { status, id, url, canResume } = item
  // 已完成但磁盘文件已失效：打开/在文件夹显示/删除文件均无意义，仅保留移除记录。
  const fileMissing = status === 'completed' && item.fileAvailable === false

  return (
    <ContextMenu open onClose={onClose} anchorPosition={{ x, y }}>
      {status === 'completed' && !fileMissing && (
        <ContextMenuItem
          icon={<ExternalLink className="w-4 h-4" />}
          label={t('downloads.openFile', '打开文件')}
          onClick={() => storeActions.open(id)}
        />
      )}
      {status === 'completed' && !fileMissing && (
        <ContextMenuItem
          icon={<FolderOpen className="w-4 h-4" />}
          label={t('downloads.showInFolderAction', '在文件夹中显示')}
          onClick={() => storeActions.showInFolder(id)}
        />
      )}
      <ContextMenuItem
        icon={<Link2 className="w-4 h-4" />}
        label={t('downloads.copyLink', '复制下载链接')}
        onClick={() => navigator.clipboard.writeText(url)}
      />
      {(status === 'interrupted' || status === 'cancelled' || status === 'progressing' || status === 'paused') && (
        <ContextMenuDivider />
      )}
      {(status === 'interrupted' || status === 'cancelled') && (
        <ContextMenuItem
          icon={<RotateCw className="w-4 h-4" />}
          label={t('downloads.retryAction', '重试')}
          onClick={() => storeActions.retry(id)}
        />
      )}
      {status === 'progressing' && (
        <ContextMenuItem
          icon={<Pause className="w-4 h-4" />}
          label={t('downloads.pauseAction', '暂停')}
          onClick={() => storeActions.pause(id)}
        />
      )}
      {status === 'paused' && canResume && (
        <ContextMenuItem
          icon={<Play className="w-4 h-4" />}
          label={t('downloads.resumeAction', '恢复')}
          onClick={() => storeActions.resume(id)}
        />
      )}
      {(status === 'progressing' || status === 'paused') && (
        <ContextMenuItem
          icon={<X className="w-4 h-4" />}
          label={t('downloads.cancelAction', '取消下载')}
          danger
          onClick={() => storeActions.cancel(id)}
        />
      )}
      <ContextMenuDivider />
      <ContextMenuItem
        icon={<X className="w-4 h-4" />}
        label={t('downloads.removeAction', '从列表移除')}
          onClick={() => storeActions.removeItem(id)}
      />
      {status === 'completed' && !fileMissing && (
        <ContextMenuItem
          icon={<Trash2 className="w-4 h-4" />}
          label={t('downloads.deleteFileAction', '删除文件')}
          danger
          onClick={() => storeActions.deleteFile(id)}
        />
      )}
    </ContextMenu>
  )
}
