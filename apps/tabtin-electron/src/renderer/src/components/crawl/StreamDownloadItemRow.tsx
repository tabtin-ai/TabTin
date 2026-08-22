import React, { useMemo } from 'react'
import { Film, FolderOpen, Trash2, CheckCircle2, XCircle, X } from 'lucide-react'
import { type StreamDownloadItem, STREAM_CANCEL_SENTINEL } from '@stores/useDownloadStore'
import { useTranslation } from 'react-i18next'
import { formatFileSize } from '@/constants/upload'
import { extractDomain, formatSpeed } from './utils/download-utils'
import { DownloadRowShell, ROW_BTN, DOT, storeActions } from './DownloadRowShared'

interface StreamDownloadItemRowProps {
  item: StreamDownloadItem
  onContextMenu?: (e: React.MouseEvent, item: StreamDownloadItem) => void
}

export const StreamDownloadItemRow: React.FC<StreamDownloadItemRowProps> = React.memo(({ item, onContextMenu }) => {
  const { t } = useTranslation('crawl')
  const isActive = item.status === 'resolving' || item.status === 'downloading' || item.status === 'merging'
  const domain = useMemo(() => extractDomain(item.url), [item.url])

  const phaseLabel = (() => {
    switch (item.status) {
      case 'resolving': return t('downloads.streamResolving', '解析播放列表...')
      case 'downloading': return t('downloads.streamDownloading', '下载中')
      case 'merging': return t('downloads.streamMerging', '合并分片中...')
      case 'completed': return t('downloads.completed', '下载完成')
      case 'failed': return t('downloads.failed', '下载失败')
      default: return ''
    }
  })()

  return (
    <DownloadRowShell
      icon={<Film className="w-5 h-5 text-type-agent" />}
      actionsAlwaysVisible={false}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, item) : undefined}
      actions={
        <>
          {isActive && (
            <button
              className={`${ROW_BTN} hover:text-destructive`}
              onClick={() => storeActions.cancelStream(item.id)}
              title={t('downloads.cancelDownload', '取消下载')}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          {item.status === 'completed' && item.savePath && (
            <button
              className={`${ROW_BTN} hover:text-foreground`}
              onClick={() => storeActions.showPathInFolder(item.savePath)}
              title={t('downloads.showInFolderAction', '在文件夹中显示')}
            >
              <FolderOpen className="w-3.5 h-3.5" />
            </button>
          )}
          {(item.status === 'completed' || item.status === 'failed') && (
            <button
              className={`${ROW_BTN} hover:text-destructive`}
              onClick={() => storeActions.removeStreamItem(item.id)}
              title={t('downloads.removeAction', '移除')}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </>
      }
    >
      <div className="flex items-center gap-2">
        <span
          className={`text-body font-medium truncate ${item.status === 'completed' && item.savePath ? 'cursor-pointer hover:text-primary transition-colors' : ''}`}
          title={item.name}
          onClick={() => { if (item.status === 'completed' && item.savePath) storeActions.openPath(item.savePath) }}
        >
          {item.name}
        </span>
        {item.status === 'completed' && <CheckCircle2 className="w-4 h-4 text-success" />}
        {item.status === 'failed' && <XCircle className="w-4 h-4 text-destructive" />}
        {isActive && (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-caption font-medium bg-type-agent/10 text-type-agent">
            HLS
          </span>
        )}
      </div>

      {isActive && (
        <div className="mt-1.5 h-1.5 bg-muted rounded-full overflow-hidden">
          <div className="h-full rounded-full transition-all duration-300 bg-type-agent" style={{ width: `${Math.min(item.percent, 100)}%` }} />
        </div>
      )}

      <div className="mt-1 flex items-center gap-2 text-body text-muted-foreground">
        <span>{phaseLabel}</span>
        {domain && <>{DOT}<span className="truncate max-w-[150px]" title={domain}>{domain}</span></>}
        {item.status === 'downloading' && item.segments.total > 0 && (
          <>{DOT}<span>{item.segments.done}/{item.segments.total} {t('downloads.streamSegments', '分片')}</span></>
        )}
        {item.status === 'downloading' && item.speed > 0 && (
          <>{DOT}<span className="text-type-agent/80">{formatSpeed(item.speed, formatFileSize)}</span></>
        )}
        {item.status === 'completed' && item.size.received > 0 && <span>{formatFileSize(item.size.received)}</span>}
        {item.status === 'completed' && item.duration != null && item.duration > 0 && (
          <>{DOT}<span>{Math.round(item.duration)}{t('downloads.units.seconds', 's')}</span></>
        )}
        {item.status === 'completed' && item.savePath && (
          <>{DOT}
            <span
              className="truncate max-w-[200px] cursor-pointer hover:text-primary transition-colors"
              title={item.savePath}
              onClick={() => storeActions.showPathInFolder(item.savePath)}
            >
              {item.savePath}
            </span>
          </>
        )}
        {item.status === 'failed' && item.error && item.error !== STREAM_CANCEL_SENTINEL && (
          <span className="text-destructive truncate max-w-[240px]" title={item.error}>{item.error}</span>
        )}
        {item.status === 'failed' && item.error === STREAM_CANCEL_SENTINEL && (
          <span className="text-muted-foreground">{t('downloads.cancelled', '已取消')}</span>
        )}
      </div>
    </DownloadRowShell>
  )
})

StreamDownloadItemRow.displayName = 'StreamDownloadItemRow'
