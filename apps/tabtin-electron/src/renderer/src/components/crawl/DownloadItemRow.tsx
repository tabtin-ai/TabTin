import React, { useMemo, useCallback } from 'react'
import { Pause, Play, X, FolderOpen, RotateCw, Trash2 } from 'lucide-react'
import type { DownloadItem } from '@stores/useDownloadStore'
import { useTranslation } from 'react-i18next'
import { formatFileSize } from '@/constants/upload'
import { extractDomain, getFileIcon, getStatusIcon, formatSpeed, formatRemainingTimeValue } from './utils/download-utils'
import { DownloadRowShell, ROW_BTN, DOT, storeActions } from './DownloadRowShared'

export const DownloadItemRow: React.FC<{
  item: DownloadItem
  onContextMenu: (e: React.MouseEvent, item: DownloadItem) => void
}> = React.memo(({ item, onContextMenu }) => {
  const { t } = useTranslation('crawl')
  const progress = item.size.total > 0 ? (item.size.received / item.size.total) * 100 : 0
  const isActive = item.status === 'progressing' || item.status === 'paused'
  const domain = useMemo(() => extractDomain(item.url), [item.url])
  // 已完成但磁盘文件已被移动/删除：打开/在文件夹显示/删除文件均会失败，仅允许移除记录。
  const fileMissing = item.status === 'completed' && item.fileAvailable === false

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    onContextMenu(e, item)
  }, [item, onContextMenu])

  return (
    <DownloadRowShell
      icon={getFileIcon(item.name, item.mimeType)}
      actionsAlwaysVisible={isActive}
      onContextMenu={handleContextMenu}
      actions={
        <>
          {item.status === 'progressing' && (
            <button className={`${ROW_BTN} hover:text-foreground`} onClick={() => storeActions.pause(item.id)} title={t('downloads.pauseAction', '暂停')}>
              <Pause className="w-3.5 h-3.5" />
            </button>
          )}
          {item.status === 'paused' && item.canResume && (
            <button className={`${ROW_BTN} hover:text-foreground`} onClick={() => storeActions.resume(item.id)} title={t('downloads.resumeAction', '恢复')}>
              <Play className="w-3.5 h-3.5" />
            </button>
          )}
          {isActive && (
            <button className={`${ROW_BTN} hover:text-destructive`} onClick={() => storeActions.cancel(item.id)} title={t('downloads.cancelAction', '取消')}>
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          {(item.status === 'interrupted' || item.status === 'cancelled') && (
            <button className={`${ROW_BTN} hover:text-foreground`} onClick={() => storeActions.retry(item.id)} title={t('downloads.retryAction', '重试')}>
              <RotateCw className="w-3.5 h-3.5" />
            </button>
          )}
          {item.status === 'completed' && !fileMissing && (
            <button className={`${ROW_BTN} hover:text-foreground`} onClick={() => storeActions.showInFolder(item.id)} title={t('downloads.showInFolderAction', '在文件夹中显示')}>
              <FolderOpen className="w-3.5 h-3.5" />
            </button>
          )}
          {item.status === 'completed' && !fileMissing && (
            <button className={`${ROW_BTN} hover:text-destructive`} onClick={() => storeActions.deleteFile(item.id)} title={t('downloads.deleteFileAction', '删除文件')}>
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
          {!isActive && (
            <button className={`${ROW_BTN} hover:text-foreground/60`} onClick={() => storeActions.removeItem(item.id)} title={t('downloads.removeAction', '移除')}>
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </>
      }
    >
      <div className="flex items-center gap-2">
        <span
          className={`text-body font-medium truncate transition-colors ${
            item.status === 'completed' && !fileMissing
              ? 'cursor-pointer hover:text-primary'
              : fileMissing
                ? 'cursor-default text-muted-foreground line-through'
                : 'cursor-default'
          }`}
          title={item.name}
          onClick={() => { if (item.status === 'completed' && !fileMissing) storeActions.open(item.id) }}
        >
          {item.name}
        </span>
        {getStatusIcon(item.status)}
        {fileMissing && (
          <span
            className="flex-shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-caption font-medium bg-muted text-muted-foreground"
            title={t('downloads.fileUnavailableHint', '文件已被移动或删除，仅可从列表移除记录')}
          >
            {t('downloads.fileUnavailable', '文件已失效')}
          </span>
        )}
      </div>

      {isActive && (
        <div className="mt-1.5 h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-300 ${item.status === 'paused' ? 'bg-warning' : 'bg-primary'}`}
            style={{ width: `${Math.min(progress, 100)}%` }}
          />
        </div>
      )}

      <div className="mt-1 flex items-center gap-2 text-body text-muted-foreground">
        {isActive ? (
          <>
            <span>{formatFileSize(item.size.received)}{item.size.total > 0 && ` / ${formatFileSize(item.size.total)}`}</span>
            {domain && <>{DOT}<span className="truncate max-w-[120px]" title={domain}>{domain}</span></>}
            {item.status === 'progressing' && item.speed > 0 && <>{DOT}<span className="text-primary/80">{formatSpeed(item.speed, formatFileSize)}</span></>}
            {item.status === 'progressing' && item.speed > 0 && item.size.total > 0 && (() => {
              const tv = formatRemainingTimeValue(item.size.received, item.size.total, item.speed)
              return tv ? <>{DOT}<span>{t('downloads.remaining', { time: tv })}</span></> : null
            })()}
            {item.status === 'paused' && <>{DOT}<span className="text-warning">{t('downloads.paused', '已暂停')}</span></>}
          </>
        ) : (
          <>
            <span>{formatFileSize(item.size.total || item.size.received)}</span>
            {domain && <>{DOT}<span className="truncate max-w-[120px]" title={domain}>{domain}</span></>}
            {item.status === 'cancelled' && <>{DOT}<span>{t('downloads.cancelled', '已取消')}</span></>}
            {item.status === 'interrupted' && <>{DOT}<span className="text-destructive">{t('downloads.failed', '下载失败')}</span></>}
            {item.status === 'completed' && item.savePath && (
              <>{DOT}
                <span
                  className={`truncate max-w-[200px] transition-colors ${
                    fileMissing ? 'cursor-default' : 'cursor-pointer hover:text-primary'
                  }`}
                  title={item.savePath}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (!fileMissing) storeActions.showPathInFolder(item.savePath)
                  }}
                >
                  {item.savePath}
                </span>
              </>
            )}
          </>
        )}
      </div>
    </DownloadRowShell>
  )
})

DownloadItemRow.displayName = 'DownloadItemRow'
