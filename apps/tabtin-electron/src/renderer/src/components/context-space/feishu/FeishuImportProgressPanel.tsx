/**
 * 飞书导入悬浮进度面板——挂 AppLayout 全局视口（右下角、可折叠）。
 * 订阅 useFeishuImportJobStore；支持多批次排队展示。
 */
import React from 'react'
import { useTranslation } from 'react-i18next'
import {
  CheckCircle2, ChevronDown, ChevronUp, Loader2, TriangleAlert, X, XCircle,
} from 'lucide-react'
import { cn } from '@utils/cn'
import { useFeishuImportJobStore } from './useFeishuImportJobStore'
import { IMPORT_FLOAT_PANEL_CLASS } from '../importFloatPanel'
import {
  resolveFeishuImportProgressHeader,
  type FeishuImportProgressItem,
} from './feishuImportPhase'

function ItemAction({ item }: { item: FeishuImportProgressItem }) {
  const { t } = useTranslation('context')
  const taskId = useFeishuImportJobStore((s) => s.taskId)
  const activeBatchId = useFeishuImportJobStore((s) => s.activeBatchId)
  const batches = useFeishuImportJobStore((s) => s.batches)
  const skipItem = useFeishuImportJobStore((s) => s.skipItem)
  const cancelItem = useFeishuImportJobStore((s) => s.cancelItem)

  const batch = batches.find((row) => row.id === item.batchId)
  const queued = batch?.status === 'queued'
  const isDocx = (item.itemKind ?? 'table') === 'docx'
  // 文档项后端暂无 skip/cancel action；排队中本地剔除仍可用取消
  const canSkip = !isDocx
    && item.status === 'running'
    && Boolean(taskId)
    && item.batchId === activeBatchId
  const canCancel = item.status === 'pending' && (
    queued || (!isDocx && Boolean(taskId) && item.batchId === activeBatchId)
  )

  if (item.status === 'done') {
    return (
      <button
        type="button"
        disabled
        className="shrink-0 text-caption text-muted-foreground/60"
      >
        {t('home.assetBrowser.feishuImportItemDone', { defaultValue: '已完成' })}
      </button>
    )
  }
  if (item.status === 'skipped') {
    return (
      <button
        type="button"
        disabled
        className="shrink-0 text-caption text-muted-foreground/60"
      >
        {t('home.assetBrowser.feishuImportItemSkipped', { defaultValue: '已跳过' })}
      </button>
    )
  }
  if (item.status === 'cancelled') {
    return (
      <button
        type="button"
        disabled
        className="shrink-0 text-caption text-muted-foreground/60"
      >
        {t('home.assetBrowser.feishuImportItemCancelled', { defaultValue: '已取消' })}
      </button>
    )
  }
  if (item.status === 'error') {
    return (
      <button
        type="button"
        disabled
        className="shrink-0 text-caption text-destructive/60"
      >
        {t('home.assetBrowser.feishuImportFailed', { defaultValue: '导入失败' })}
      </button>
    )
  }
  if (item.status === 'running') {
    if (isDocx) {
      return (
        <span className="shrink-0 text-caption text-muted-foreground/60">
          {t('home.assetBrowser.feishuImportItemRunning', { defaultValue: '导入中' })}
        </span>
      )
    }
    return (
      <button
        type="button"
        disabled={!canSkip}
        className={cn(
          'shrink-0 text-caption',
          canSkip ? 'text-primary hover:underline' : 'text-primary/40',
        )}
        onClick={() => { void skipItem(item.key) }}
      >
        {t('home.assetBrowser.feishuImportItemSkip', { defaultValue: '跳过' })}
      </button>
    )
  }
  if (isDocx && !queued) {
    return (
      <span className="shrink-0 text-caption text-muted-foreground/60">
        {t('home.assetBrowser.feishuImportItemPending', { defaultValue: '等待中' })}
      </span>
    )
  }
  return (
    <button
      type="button"
      disabled={!canCancel}
      className={cn(
        'shrink-0 text-caption',
        canCancel ? 'text-destructive hover:underline' : 'text-destructive/40',
      )}
      onClick={() => { void cancelItem(item.key) }}
    >
      {t('home.assetBrowser.feishuImportItemCancel', { defaultValue: '取消' })}
    </button>
  )
}

export const FeishuImportProgressPanel: React.FC = () => {
  const { t } = useTranslation('context')
  const status = useFeishuImportJobStore((s) => s.status)
  const items = useFeishuImportJobStore((s) => s.items)
  const batches = useFeishuImportJobStore((s) => s.batches)
  const taskPhase = useFeishuImportJobStore((s) => s.taskPhase)
  const errorMessage = useFeishuImportJobStore((s) => s.errorMessage)
  const collapsed = useFeishuImportJobStore((s) => s.collapsed)
  const toggleCollapsed = useFeishuImportJobStore((s) => s.toggleCollapsed)
  const dismiss = useFeishuImportJobStore((s) => s.dismiss)

  if (status === 'idle' || items.length === 0) return null

  const hasActiveItems = items.some((item) => (
    item.status === 'pending' || item.status === 'running'
  ))
  const canClose = status !== 'running' || !hasActiveItems
  const queuedCount = items.filter((item) => {
    const batch = batches.find((row) => row.id === item.batchId)
    return batch?.status === 'queued' && item.status === 'pending'
  }).length
  const running = status === 'running'
  const pollingTimedOut = running && Boolean(errorMessage)
  const header = resolveFeishuImportProgressHeader({
    status,
    items,
    queuedCount,
    taskPhase,
  })

  let headerText: string
  if (pollingTimedOut) {
    headerText = errorMessage ?? ''
  } else if (header.kind === 'success') {
    headerText = t('home.assetBrowser.feishuImportSuccess', { defaultValue: '导入成功' })
  } else if (header.kind === 'partial') {
    headerText = t('home.assetBrowser.feishuImportPartialSuccess', {
      defaultValue: '部分导入成功',
    })
  } else if (header.kind === 'error') {
    headerText = t('home.assetBrowser.feishuImportFailed', { defaultValue: '导入失败' })
  } else if (header.kind === 'docs') {
    headerText = header.queued > 0
      ? t('home.assetBrowser.feishuImportProgressDocsQueued', {
          done: header.done,
          total: header.total,
          queued: header.queued,
          defaultValue: '正在导入文档 {{done}}/{{total}}（排队 {{queued}}）',
        })
      : t('home.assetBrowser.feishuImportProgressDocs', {
          done: header.done,
          total: header.total,
          defaultValue: '正在导入文档 {{done}}/{{total}}',
        })
  } else if (header.kind === 'postprocess') {
    const stepText = header.step === 'links'
      ? t('home.assetBrowser.feishuImportProgressLinks', { defaultValue: '正在处理关联字段…' })
      : header.step === 'link_data'
        ? t('home.assetBrowser.feishuImportProgressLinkData', { defaultValue: '正在回填关联数据…' })
        : header.step === 'attachments'
          ? t('home.assetBrowser.feishuImportProgressAttachments', { defaultValue: '正在同步附件…' })
          : t('home.assetBrowser.feishuImportProgressPostprocess', {
              defaultValue: '正在处理关联与附件…',
            })
    headerText = header.queued > 0
      ? t('home.assetBrowser.feishuImportProgressPostprocessQueued', {
          step: stepText.replace(/…$/, ''),
          queued: header.queued,
          defaultValue: '{{step}}（排队 {{queued}}）',
        })
      : stepText
  } else if (header.queued > 0) {
    headerText = t('home.assetBrowser.feishuImportProgressQueued', {
      done: header.done,
      total: header.total,
      queued: header.queued,
      defaultValue: '正在导入 {{done}}/{{total}}（排队 {{queued}}）',
    })
  } else {
    headerText = t('home.assetBrowser.feishuImportProgressRunning', {
      done: header.done,
      total: header.total,
      defaultValue: '正在导入 {{done}}/{{total}}',
    })
  }

  return (
    // z-toast(60) > z-modal(50)；pointer-events-auto 对抗 Dialog 的 body pointer-events:none
    <div
      data-import-float-panel=""
      className={cn(
        IMPORT_FLOAT_PANEL_CLASS,
        'bottom-4 right-4 w-80 overflow-hidden rounded-lg border border-border/40 bg-background/95 shadow-xl backdrop-blur-sm',
      )}
    >
      <div className="flex items-center gap-1 border-b border-border/20">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-body font-medium transition-colors hover:bg-muted/10"
          onClick={toggleCollapsed}
        >
          {pollingTimedOut ? (
            <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-warning" />
          ) : running ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
          ) : header.kind === 'success' ? (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
          ) : header.kind === 'partial' ? (
            <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-warning" />
          ) : (
            <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
          )}
          <span className="min-w-0 flex-1 truncate text-left">{headerText}</span>
          {collapsed ? (
            <ChevronUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
        </button>
        {canClose ? (
          <button
            type="button"
            className="mr-1 rounded p-1 text-muted-foreground transition-colors hover:bg-muted/30"
            onClick={dismiss}
            aria-label={t('common.close', { defaultValue: '关闭' })}
            title={t('common.close', { defaultValue: '关闭' })}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      {!collapsed ? (
        <div className="max-h-[500px] space-y-0.5 overflow-y-auto px-1 py-1.5">
          {items.map((item) => (
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
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    'truncate',
                    (item.status === 'pending' || item.status === 'cancelled' || item.status === 'skipped')
                      && 'text-muted-foreground/60',
                    item.status === 'error' && 'text-destructive',
                  )}
                >
                  {item.name}
                </p>
                {item.status === 'error' && item.errorMessage ? (
                  <p className="truncate text-caption text-destructive/80" title={item.errorMessage}>
                    {item.errorMessage}
                  </p>
                ) : null}
              </div>
              <ItemAction item={item} />
            </div>
          ))}
          {status === 'error' && errorMessage ? (
            <p className="px-2 py-1 text-caption text-destructive/80">{errorMessage}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
