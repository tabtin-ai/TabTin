/**
 * UploadNotificationPanel — 全局上传通知面板
 *
 * 展示进行中 / 失败的上传任务。
 * 成功任务静默清理，底部浮动面板可折叠，用作上传进度入口。
 */

import React, { useEffect, useMemo } from 'react'
import { CheckCircle2, XCircle, Loader2, X, ChevronDown, ChevronUp, Upload, Zap, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { useUploadQueueStore, type UploadTask, type UploadTaskStatus } from '@/stores/useUploadQueueStore'
import { formatFileSize } from '@/constants/upload'

const statusConfig: Record<UploadTaskStatus, { icon: React.ReactNode; color: string }> = {
  queued: { icon: <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />, color: 'text-muted-foreground' },
  uploading: { icon: <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />, color: 'text-primary' },
  completed: { icon: <CheckCircle2 className="h-3.5 w-3.5 text-success" />, color: 'text-success' },
  failed: { icon: <XCircle className="h-3.5 w-3.5 text-destructive" />, color: 'text-destructive' },
  cancelled: { icon: <X className="h-3.5 w-3.5 text-muted-foreground" />, color: 'text-muted-foreground' },
}

function TaskRow({ task }: { task: UploadTask }) {
  const removeTask = useUploadQueueStore((s) => s.removeTask)
  const cancelTask = useUploadQueueStore((s) => s.cancelTask)
  const retryTask = useUploadQueueStore((s) => s.retryTask)
  const canRetryTask = useUploadQueueStore((s) => s.canRetryTask)
  const { t } = useTranslation()
  const cfg = statusConfig[task.status]
  const isActive = task.status === 'uploading' || task.status === 'queued'
  const isRetryable = task.status === 'failed' && canRetryTask(task.id)

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-body hover:bg-muted/10 transition-colors">
      {cfg.icon}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium">{task.fileName}</span>
          {task.instant && <span title="秒传"><Zap className="h-3 w-3 text-warning shrink-0" /></span>}
        </div>
        {task.status === 'uploading' && (
          <div className="mt-0.5 h-1 w-full rounded-full bg-muted/30 overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-300"
              style={{ width: `${Math.round(task.progress * 100)}%` }}
            />
          </div>
        )}
        {task.status === 'failed' && task.error && (
          <span className="text-destructive/80 truncate block">{task.error}</span>
        )}
      </div>
      <span className="text-muted-foreground shrink-0">
        {task.status === 'uploading'
          ? `${Math.round(task.progress * 100)}%`
          : formatFileSize(task.fileSize)}
      </span>
      {isActive && (
        <button
          type="button"
          className="rounded p-0.5 text-muted-foreground/60 hover:bg-destructive/20 hover:text-destructive transition-colors shrink-0"
          onClick={() => cancelTask(task.id)}
          aria-label={t('upload.cancel', { defaultValue: '取消上传' })}
          title={t('upload.cancel', { defaultValue: '取消上传' })}
        >
          <XCircle className="h-3.5 w-3.5" />
        </button>
      )}
      {task.status === 'failed' && (
        <button
          type="button"
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded border border-border/40 px-1.5 text-caption text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border/40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
          onClick={() => { void retryTask(task.id) }}
          disabled={!isRetryable}
          aria-label={t('retry', { defaultValue: '重试' })}
          title={isRetryable
            ? t('retry', { defaultValue: '重试' })
            : t('upload.retryUnavailable', { defaultValue: '请从原上传位置重试' })}
        >
          <RefreshCw className="h-3 w-3" />
          <span>{t('retry', { defaultValue: '重试' })}</span>
        </button>
      )}
      {(task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') && (
        <button
          type="button"
          className="rounded p-0.5 hover:bg-muted/30 shrink-0"
          onClick={() => removeTask(task.id)}
          aria-label={t('upload.dismiss', { defaultValue: '关闭' })}
          title={t('upload.dismiss', { defaultValue: '关闭' })}
        >
          <X className="h-3 w-3 text-muted-foreground" />
        </button>
      )}
    </div>
  )
}

export const UploadNotificationPanel: React.FC = () => {
  const { t } = useTranslation()
  const { tasks, isPanelOpen, togglePanel, removeTask, getActiveCount, getFailedCount } =
    useUploadQueueStore(
      useShallow((s) => ({
        tasks: s.tasks,
        isPanelOpen: s.isPanelOpen,
        togglePanel: s.togglePanel,
        removeTask: s.removeTask,
        getActiveCount: s.getActiveCount,
        getFailedCount: s.getFailedCount,
      }))
    )

  const activeCount = getActiveCount()
  const failedCount = getFailedCount()

  const visibleTasks = useMemo(
    () => tasks.filter((task) =>
      task.status === 'queued' || task.status === 'uploading' || task.status === 'failed',
    ).slice(0, 50),
    [tasks],
  )

  const completedTaskIds = useMemo(
    () => tasks
      .filter((task) => task.status === 'completed' || task.status === 'cancelled')
      .map((task) => task.id),
    [tasks],
  )

  useEffect(() => {
    if (completedTaskIds.length === 0) return undefined

    const timer = window.setTimeout(() => {
      completedTaskIds.forEach((id) => removeTask(id))
    }, 1000)

    return () => window.clearTimeout(timer)
  }, [completedTaskIds, removeTask])

  if (visibleTasks.length === 0) return null

  const headerText = activeCount > 0 && failedCount > 0
    ? t('upload.activeAndFailedCount', {
        active: activeCount,
        failed: failedCount,
        defaultValue: `${activeCount} 个文件上传中，${failedCount} 个失败`,
      })
    : activeCount > 0
      ? t('upload.activeCount', { count: activeCount, defaultValue: `${activeCount} 个文件上传中` })
      : t('upload.failedCount', { count: failedCount, defaultValue: `${failedCount} 个文件上传失败` })

  return (
    <div className="fixed bottom-4 right-4 z-toast w-80 rounded-lg border border-border/40 bg-background/95 backdrop-blur-sm shadow-xl overflow-hidden">
      {/* Header */}
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-body font-medium hover:bg-muted/10 transition-colors"
        onClick={togglePanel}
      >
        <Upload className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="flex-1 text-left">
          {headerText}
        </span>
        {isPanelOpen ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </button>

      {/* Task list */}
      {isPanelOpen && (
        <>
          <div className="max-h-60 overflow-y-auto border-t border-border/20">
            {visibleTasks.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
