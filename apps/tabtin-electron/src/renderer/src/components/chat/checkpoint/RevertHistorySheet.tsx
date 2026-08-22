/**
 * RevertHistorySheet — 回退操作历史面板
 *
 * 展示当前 session 的回退/撤销回退操作时间线。
 * 从 RevertBanner 或 RewindPreviewPanel 中触发打开。
 */

import React, { useEffect, useLayoutEffect, useState, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import type { RevertHistoryEntryView, RollbackApplyResult } from '@tabtin/chat-client'
import { X, History, Undo2, Package, RotateCcw, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import * as chatExtraApi from '../../../services/chatExtraApi'
import { DetailedRowListSkeleton } from '@components/common/ListSkeletons'
import { OVERLAY_SURFACE_CLASS } from '@components/ui'
import { useChatStore } from '../../../stores/chat/useChatStore'
import { useSpaceActivity } from '@components/layout/SpaceActivityContext'
import { cn } from '@utils/cn'
import {
  NATIVE_VIEW_OVERLAY_ATTRIBUTE,
  syncNativeViewOverlayCountFromDom,
} from '@/utils/native-view-overlays'
import {
  getRollbackResourceDetails,
  getRollbackResourceDetailsFromState,
  hasWorkspaceFilesFailure,
} from '../../../stores/chat/checkpoint/utils/rollbackResult'

interface RevertHistorySheetProps {
  sessionId: string
  onClose: () => void
}

const TYPE_CONFIG: Record<string, { icon: typeof History; labelKey: string; labelDefault: string; color: string }> = {
  rollback: { icon: RotateCcw, labelKey: 'revert.typeRollback', labelDefault: '回退', color: 'text-warning' },
  resource_rollback: { icon: Package, labelKey: 'revert.typeResourceRollback', labelDefault: '资源回退', color: 'text-info' },
  unrevert: { icon: Undo2, labelKey: 'revert.typeUnrevert', labelDefault: '撤销回退', color: 'text-success' },
}

export const RevertHistorySheet: React.FC<RevertHistorySheetProps> = ({ sessionId, onClose }) => {
  const { t, i18n } = useTranslation('chat')
  // 与 CheckpointDiffSheet 同款：本面板 portal 到 document.body，切走 hot Space
  // 时 portal 内容用 invisible / pointer-events-none / aria-hidden 三重不可见，
  // 但不 unmount（保留已加载历史 / 滚动位置）；仅前台 Space 监听 Esc。
  const { isForeground } = useSpaceActivity()
  const [history, setHistory] = useState<chatExtraApi.RevertHistoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [reapplyingKey, setReapplyingKey] = useState<string | null>(null)
  const rollbackToCheckpoint = useChatStore(s => s.rollbackToCheckpoint)
  const rollbackState = useChatStore(
    useCallback(
      (s) => s.sessions.find(session => session.id === sessionId)?.rollback_state ?? null,
      [sessionId],
    ),
  )

  const fetchHistory = useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      const result = await chatExtraApi.getRevertHistory(sessionId)
      setHistory(result)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => { fetchHistory() }, [fetchHistory])

  useEffect(() => {
    if (!isForeground) return
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handleEsc, true)
    return () => window.removeEventListener('keydown', handleEsc, true)
  }, [onClose, isForeground])

  // 浏览器 tab 使用原生 WebContentsView，DOM z-index 压不住——需标记 overlay
  // 让 EmbeddedCrawlView 在弹窗打开时 hide view（同 RewindPreviewPanel /
  // ChatResourcePreviewModal）。这样无论从 RewindPreviewPanel 还是 RevertBanner
  // 打开，回退历史都不会被网页遮挡。仅前台 Space 计数，避免后台 hot Space 误隐藏。
  const nativeViewOverlayProps = isForeground
    ? ({ [NATIVE_VIEW_OVERLAY_ATTRIBUTE]: 'true' } as const)
    : {}

  useLayoutEffect(() => {
    if (!isForeground) return
    syncNativeViewOverlayCountFromDom(document)
    return () => {
      queueMicrotask(() => syncNativeViewOverlayCountFromDom(document))
    }
  }, [isForeground])

  const reversedHistory = useMemo(() => [...history].reverse(), [history])
  const currentResourceDetails = useMemo(
    () => getRollbackResourceDetailsFromState(rollbackState),
    [rollbackState],
  )
  const currentHasFileFailure = hasWorkspaceFilesFailure(rollbackState?.partial_success_details)
  const currentRetryableCount = currentResourceDetails.retryableItems.length
  const currentStatus = rollbackState?.last_apply_result === 'failed'
    ? 'failed'
    : rollbackState?.last_apply_result === 'partial_success'
      || currentHasFileFailure
      || currentRetryableCount > 0
      || currentResourceDetails.failedCount > 0
      || rollbackState?.cleanup_status === 'pending_retry'
        ? 'partial_success'
        : rollbackState?.last_apply_result ?? null

  const formatTime = (iso: string) => {
    try {
      const d = new Date(iso)
      return d.toLocaleString(i18n.language || 'zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    } catch {
      return iso
    }
  }

  const statusBadge = (status: RollbackApplyResult | null | undefined) => {
    if (!status) return null
    // point-only：状态色退到边框 + 文字，容器保持中性，不做整片彩色面。
    const className = status === 'success'
      ? 'border-success/30 text-success'
      : status === 'partial_success'
        ? 'border-warning/30 text-warning'
        : 'border-destructive/30 text-destructive'
    const label = status === 'success'
      ? t('revert.statusSuccess', { defaultValue: '成功' })
      : status === 'partial_success'
        ? t('revert.statusPartial', { defaultValue: '部分成功' })
        : t('revert.statusFailed', { defaultValue: '失败' })

    return (
      <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-caption ${className}`}>
        {label}
      </span>
    )
  }

  const summarizeEntry = (entry: RevertHistoryEntryView) => {
    const resourceDetails = getRollbackResourceDetails(entry.partial_success_details)
    const inferredStatus: RollbackApplyResult | null = entry.apply_result
      ?? (hasWorkspaceFilesFailure(entry.partial_success_details)
        || resourceDetails.failedCount > 0
        || resourceDetails.retryableItems.length > 0
          ? 'partial_success'
          : 'success')
    const retryablePreview = resourceDetails.retryableItems
      .slice(0, 2)
      .map(item => `${item.resource_type}:${item.resource_id.slice(0, 8)}`)
      .join('、')

    return {
      status: inferredStatus,
      resourceDetails,
      hasFileFailure: hasWorkspaceFilesFailure(entry.partial_success_details),
      retryablePreview,
    }
  }

  const handleReapplyRollback = useCallback(async (entry: RevertHistoryEntryView, key: string) => {
    if (!entry.target_message_id || !entry.reapply_resource_items?.length || reapplyingKey) return

    const resourceRestorePlan: chatExtraApi.ResourceRestoreInfo[] = entry.reapply_resource_items
      .filter(item => item.action === 'restore_version' || item.action === 'trash')
      .map(item => ({
        resource_type: item.resource_type,
        resource_id: item.resource_id,
        resource_name: `${item.resource_type}:${item.resource_id.slice(0, 8)}`,
        action: item.action === 'trash' ? 'trash' : 'restore_version',
        action_label: item.action === 'trash'
          ? t('revert.reapplyTrashAction', { defaultValue: '移入回收站' })
          : t('revert.reapplyRestoreAction', { defaultValue: '恢复版本' }),
        can_restore: true,
        restore_to_version_id: item.restore_to_version_id ?? null,
        restore_to_version_time: null,
        change_count: 1,
      }))

    if (resourceRestorePlan.length === 0) return
    setReapplyingKey(key)
    try {
      await rollbackToCheckpoint(entry.target_message_id, sessionId, resourceRestorePlan)
      onClose()
    } finally {
      setReapplyingKey(null)
    }
  }, [onClose, reapplyingKey, rollbackToCheckpoint, sessionId, t])

  return createPortal(
    <div
      className={cn(
        'fixed inset-0 z-above-global flex items-center justify-center',
        !isForeground && 'invisible pointer-events-none',
      )}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="revert-history-title"
      aria-hidden={!isForeground || undefined}
      {...nativeViewOverlayProps}
    >
      <div className="absolute inset-0 overlay-backdrop-blur" />
      <div
        className={cn('relative z-sticky w-full max-w-md max-h-[70vh] rounded-xl flex flex-col', OVERLAY_SURFACE_CLASS)}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-muted-foreground" />
            <h3 id="revert-history-title" className="text-body font-semibold">
              {t('revert.historyTitle', { defaultValue: '回退操作历史' })}
            </h3>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1 hover:bg-muted transition-colors" aria-label={t('common.close', { defaultValue: '关闭' })}>
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {!loading && !error && rollbackState && (
            <div className="mb-4 rounded-lg border border-border/40 bg-muted/30 px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="text-body font-medium text-foreground">
                  {t('revert.currentStateTitle', { defaultValue: '当前状态' })}
                </span>
                {statusBadge(currentStatus)}
              </div>
              <p className="mt-1 text-body text-muted-foreground">
                {rollbackState.revert_active
                  ? rollbackState.can_unrevert
                    ? t('revert.currentStateCanUnrevert', {
                        defaultValue: '当前仍处于已回退状态，可撤销回退恢复对话（工作区文件不会自动还原）。',
                      })
                    : t('revert.currentStateRevertedLocked', {
                        defaultValue: '当前仍处于已回退状态，但已无法恢复原状。',
                      })
                  : currentStatus === 'partial_success'
                    ? t('revert.currentStateResolvedWithIssues', {
                        defaultValue: '当前不在回退状态，但最近一次操作仍有未完全处理的项目。',
                      })
                    : t('revert.currentStateNotReverted', {
                        defaultValue: '当前不在回退状态。',
                      })}
              </p>
              <div className="mt-2 space-y-1 text-caption text-muted-foreground">
                {currentHasFileFailure && (
                  <p>
                    {t('revert.currentFileFailure', {
                      defaultValue: '文件层上次未完全成功，建议手动检查工作区状态。',
                    })}
                  </p>
                )}
                {currentRetryableCount > 0 && (
                  <p>
                    {t('revert.currentRetryableCount', {
                      count: currentRetryableCount,
                      defaultValue: '仍有 {{count}} 个资源可重试回退。',
                    })}
                  </p>
                )}
                {rollbackState.cleanup_status === 'pending_retry' && (
                  <p>
                    {t('revert.currentCleanupPendingRetry', {
                      defaultValue: '消息整理尚未完成，系统会在下一次对话时自动重试。',
                    })}
                  </p>
                )}
                {rollbackState.cleanup_status === 'pending' && (
                  <p>
                    {t('revert.currentCleanupPending', {
                      defaultValue: '对话已回退，消息整理将在你发送下一条消息时自动完成。',
                    })}
                  </p>
                )}
              </div>
            </div>
          )}

          {loading && (
            <DetailedRowListSkeleton count={5} compact showPreview={false} />
          )}

          {error && (
            <div className="text-center py-8 space-y-2">
              <p className="text-body text-muted-foreground">
                {t('revert.historyLoadFailed', { defaultValue: '加载失败' })}
              </p>
              <button
                type="button"
                onClick={fetchHistory}
                className="text-body text-primary hover:underline"
              >
                {t('common.retry', { defaultValue: '重试' })}
              </button>
            </div>
          )}

          {!loading && !error && history.length === 0 && (
            <p className="text-center py-8 text-body text-muted-foreground">
              {t('revert.historyEmpty', { defaultValue: '暂无回退操作记录' })}
            </p>
          )}

          {!loading && !error && history.length > 0 && (
            <div className="relative">
              {/* Timeline line */}
              <div className="absolute left-[11px] top-2 bottom-2 w-px bg-border" />

              <div className="space-y-4">
                {reversedHistory.map((entry, idx) => {
                  const config = TYPE_CONFIG[entry.type] || TYPE_CONFIG.rollback
                  const Icon = config.icon
                  const summary = summarizeEntry(entry)
                  const entryKey = `${entry.created_at}-${entry.type}-${idx}`
                  const canReapplyRollback = entry.type === 'unrevert'
                    && !!entry.target_message_id
                    && (entry.reapply_resource_items?.length ?? 0) > 0

                  return (
                    <div key={entryKey} className="relative flex gap-3 pl-0">
                      <div className={`relative z-sticky mt-0.5 rounded-full border-2 border-background bg-background p-0.5 ${config.color}`}>
                        <Icon className="h-3.5 w-3.5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-body font-medium">{t(config.labelKey, { defaultValue: config.labelDefault })}</span>
                          {statusBadge(summary.status)}
                          <span className="text-caption text-muted-foreground/60">{formatTime(entry.created_at)}</span>
                        </div>
                        <div className="mt-0.5 text-caption text-muted-foreground space-y-0.5">
                          {entry.type === 'rollback' && (
                            <>
                              {entry.messages_removed != null && entry.messages_removed > 0 && (
                                <p>{t('revert.historyMsgsRemoved', { count: entry.messages_removed, defaultValue: '移除了 {{count}} 条消息' })}</p>
                              )}
                              {entry.snapshot_hash && (
                                <p>
                                  {summary.hasFileFailure
                                    ? t('revert.historyFilesRestoreFailed', { defaultValue: '文件层恢复失败，需要手动检查工作区状态' })
                                    : t('revert.historyFilesRestored', { defaultValue: '文件已恢复到检查点' })}
                                </p>
                              )}
                              {(summary.resourceDetails.restoredCount > 0 || summary.resourceDetails.failedCount > 0) && (
                                <p>
                                  {summary.resourceDetails.failedCount > 0
                                    ? t('revert.historyResourcesLayerPartial', {
                                        restored: summary.resourceDetails.restoredCount,
                                        failed: summary.resourceDetails.failedCount,
                                        defaultValue: '资源层：{{restored}} 个成功，{{failed}} 个失败',
                                      })
                                    : t('revert.historyResourcesLayerSuccess', {
                                        count: summary.resourceDetails.restoredCount,
                                        defaultValue: '资源层：{{count}} 个资源已恢复',
                                      })}
                                </p>
                              )}
                            </>
                          )}
                          {entry.type === 'resource_rollback' && (
                            <>
                              {entry.restored_count != null && entry.restored_count > 0 && (
                                <p>{t('revert.historyResourcesRestored', { count: entry.restored_count, defaultValue: '{{count}} 个资源已恢复' })}</p>
                              )}
                              {entry.failed_count != null && entry.failed_count > 0 && (
                                <p className="text-destructive/80">{t('revert.historyResourcesFailed', { count: entry.failed_count, defaultValue: '{{count}} 个资源恢复失败' })}</p>
                              )}
                            </>
                          )}
                          {entry.type === 'unrevert' && (
                            <>
                              <p>{t('revert.historyUnreverted', { defaultValue: '已撤销回退，对话已恢复' })}</p>
                              {entry.resource_count != null && entry.resource_count > 0 && (
                                <p>
                                  {t('revert.historyUnrevertResources', {
                                    count: entry.resource_count,
                                    defaultValue: '恢复了 {{count}} 个资源到回退前版本',
                                  })}
                                </p>
                              )}
                              {entry.snapshot_hash && (
                                <p>
                                  {summary.hasFileFailure
                                    ? t('revert.historyUnrevertFileFailed', { defaultValue: '文件未完全恢复，请手动同步' })
                                    : t('revert.historyUnrevertFilesRestored', { defaultValue: '文件已恢复到回退前快照' })}
                                </p>
                              )}
                              {canReapplyRollback && (
                                <button
                                  type="button"
                                  disabled={reapplyingKey != null}
                                  className="mt-1 inline-flex items-center gap-1 rounded-md border border-border/60 bg-background px-2 py-1 text-caption text-foreground/80 hover:bg-muted/40 disabled:opacity-50 disabled:pointer-events-none"
                                  onClick={() => void handleReapplyRollback(entry, entryKey)}
                                >
                                  {reapplyingKey === entryKey
                                    ? <Loader2 className="h-3 w-3 animate-spin" />
                                    : <RotateCcw className="h-3 w-3" />}
                                  {t('revert.reapplyRollback', { defaultValue: '再次执行这次资源回退' })}
                                </button>
                              )}
                            </>
                          )}
                          {summary.resourceDetails.retryableItems.length > 0 && (
                            <p className="text-warning">
                              {t('revert.historyRetryableResources', {
                                count: summary.resourceDetails.retryableItems.length,
                                defaultValue: '建议重试 {{count}} 个资源',
                              })}
                              {summary.retryablePreview
                                ? `: ${summary.retryablePreview}${summary.resourceDetails.retryableItems.length > 2 ? '...' : ''}`
                                : ''}
                            </p>
                          )}
                          {summary.resourceDetails.collabWarnings.length > 0 && (
                            <p className="text-warning">
                              {t('revert.historyCollabWarnings', {
                                count: summary.resourceDetails.collabWarnings.length,
                                defaultValue: '另有 {{count}} 项协作同步警告，建议通知在线协作者刷新。',
                              })}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
