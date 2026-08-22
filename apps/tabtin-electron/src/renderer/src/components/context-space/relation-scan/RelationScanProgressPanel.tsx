/**
 * 第三方源关联扫描进度——多任务右下角折叠卡片。
 * 各 source / 各次分析彼此独立；条目可跳过（running）或取消（pending）。
 */
import React from 'react'
import { useTranslation } from 'react-i18next'
import {
  CheckCircle2, ChevronDown, ChevronUp, Loader2, X, XCircle,
} from 'lucide-react'
import { cn } from '@utils/cn'
import { useFeishuImportJobStore } from '../feishu/useFeishuImportJobStore'
import { IMPORT_FLOAT_PANEL_CLASS } from '../importFloatPanel'
import {
  isExcludedFromScanResult,
  type RelationScanItem,
  type RelationScanTask,
} from './relationScanTypes'
import { useRelationScanJobStore } from './useRelationScanJobStore'

function ItemAction({
  taskId,
  item,
}: {
  taskId: string
  item: RelationScanItem
}) {
  const { t } = useTranslation('context')
  const skipItem = useRelationScanJobStore((s) => s.skipItem)
  const cancelItem = useRelationScanJobStore((s) => s.cancelItem)
  const task = useRelationScanJobStore((s) => s.tasks.find((row) => row.id === taskId))
  const scanning = task?.status === 'scanning'

  if (item.status === 'done') {
    return (
      <span className="shrink-0 text-caption text-muted-foreground/50">
        {t('home.assetBrowser.relationScanItemDone', { defaultValue: '已完成' })}
      </span>
    )
  }
  if (item.status === 'skipped') {
    return (
      <span className="shrink-0 text-caption text-muted-foreground/50">
        {t('home.assetBrowser.relationScanItemSkipped', { defaultValue: '已跳过' })}
      </span>
    )
  }
  if (item.status === 'cancelled') {
    return (
      <span className="shrink-0 text-caption text-muted-foreground/50">
        {t('home.assetBrowser.relationScanItemCancelled', { defaultValue: '已取消' })}
      </span>
    )
  }
  if (item.status === 'error') {
    return (
      <span className="shrink-0 text-caption text-destructive/60">
        {t('home.assetBrowser.relationScanItemError', { defaultValue: '失败' })}
      </span>
    )
  }
  if (item.status === 'running') {
    return (
      <button
        type="button"
        disabled={!scanning}
        className={cn(
          'shrink-0 text-caption',
          scanning ? 'text-primary hover:underline' : 'text-primary/40',
        )}
        onClick={() => skipItem(taskId, item.key)}
      >
        {t('home.assetBrowser.relationScanItemSkip', { defaultValue: '跳过' })}
      </button>
    )
  }
  return (
    <button
      type="button"
      disabled={!scanning}
      className={cn(
        'shrink-0 text-caption',
        scanning ? 'text-destructive hover:underline' : 'text-destructive/40',
      )}
      onClick={() => cancelItem(taskId, item.key)}
    >
      {t('home.assetBrowser.relationScanItemCancel', { defaultValue: '取消' })}
    </button>
  )
}

function TaskCard({ task }: { task: RelationScanTask }) {
  const { t } = useTranslation('context')
  const toggleCollapsed = useRelationScanJobStore((s) => s.toggleCollapsed)
  const dismissTask = useRelationScanJobStore((s) => s.dismissTask)

  const scanning = task.status === 'scanning'
  const activeCount = task.items.filter((item) => !isExcludedFromScanResult(item.status)).length
  const settledCount = task.items.filter((item) => (
    item.status === 'done' || isExcludedFromScanResult(item.status)
  )).length
  const headerText = task.status === 'done'
    ? t('home.assetBrowser.relationScanDone', {
        title: task.title,
        defaultValue: '{{title}} · 完成',
      })
    : task.status === 'error'
      ? t('home.assetBrowser.relationScanFailed', {
          title: task.title,
          defaultValue: '{{title}} · 失败',
        })
      : t('home.assetBrowser.relationScanRunning', {
          title: task.title,
          settled: settledCount,
          total: task.items.length,
          active: activeCount,
          defaultValue: '{{title}} {{settled}}/{{total}}',
        })

  return (
    <div className="w-80 overflow-hidden rounded-lg border border-border/40 bg-background/95 shadow-xl backdrop-blur-sm">
      <div className="flex items-center gap-1 border-b border-border/20">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-body font-medium transition-colors hover:bg-muted/10"
          onClick={() => toggleCollapsed(task.id)}
        >
          {scanning ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
          ) : task.status === 'done' ? (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
          ) : (
            <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
          )}
          <span className="min-w-0 flex-1 truncate text-left">{headerText}</span>
          {task.collapsed ? (
            <ChevronUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
        </button>
        {!scanning ? (
          <button
            type="button"
            className="mr-1 rounded p-1 text-muted-foreground transition-colors hover:bg-muted/30"
            onClick={() => dismissTask(task.id)}
            aria-label={t('common.close', { defaultValue: '关闭' })}
            title={t('common.close', { defaultValue: '关闭' })}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      {!task.collapsed ? (
        <div className="max-h-[320px] space-y-0.5 overflow-y-auto px-1 py-1.5">
          <p className="px-2 py-1 text-caption text-muted-foreground/70">
            {t('home.assetBrowser.relationScanHint', {
              defaultValue: '正在扫描表格字段以识别关联；可跳过或取消单表',
            })}
          </p>
          {task.items.map((item) => (
            <div
              key={item.key}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-body"
            >
              {item.status === 'running' ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
              ) : item.status === 'done' ? (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
              ) : item.status === 'error' ? (
                <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
              ) : item.status === 'skipped' || item.status === 'cancelled' ? (
                <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-border/40 bg-muted/20" />
              ) : (
                <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-border/60" />
              )}
              <span
                className={cn(
                  'min-w-0 flex-1 truncate',
                  (item.status === 'pending' || item.status === 'cancelled' || item.status === 'skipped')
                    && 'text-muted-foreground/70',
                  item.status === 'error' && 'text-destructive',
                )}
              >
                {item.name}
              </span>
              <ItemAction taskId={task.id} item={item} />
            </div>
          ))}
          {task.status === 'error' && task.errorMessage ? (
            <p className="px-2 py-1 text-caption text-destructive/80">{task.errorMessage}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export const RelationScanProgressPanel: React.FC = () => {
  const tasks = useRelationScanJobStore((s) => s.tasks)
  const importJobVisible = useFeishuImportJobStore(
    (s) => s.status !== 'idle' && s.items.length > 0,
  )

  if (tasks.length === 0) return null

  // z-toast 盖过 Dialog mask；pointer-events-auto 避免 Dialog 锁 body 后点击穿透
  return (
    <div
      data-import-float-panel=""
      className={cn(
        IMPORT_FLOAT_PANEL_CLASS,
        'right-4 flex flex-col-reverse gap-2',
        importJobVisible ? 'bottom-28' : 'bottom-4',
      )}
    >
      {tasks.map((task) => (
        <TaskCard key={task.id} task={task} />
      ))}
    </div>
  )
}
