/**
 * CheckpointBrowseSheet — Space 级快照浏览面板
 *
 * 数据源：后端 list_space_checkpoints API。
 * 支持手动创建快照、查看触发来源、跳转到关联对话。
 */

import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Camera, ExternalLink, Loader2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from '@tabtin/smartsheet-ui'
import * as chatExtraApi from '@/services/chatExtraApi'
import { fetchCheckpointDecisionContext } from '@/services/chatExtraApi'
import { useChatStore } from '@stores/chat/useChatStore'
import { useSpaceActivity } from '@components/layout/SpaceActivityContext'
import { DetailedRowListSkeleton } from '@components/common/ListSkeletons'
import { OVERLAY_SURFACE_CLASS } from '@components/ui'
import { cn } from '@utils/cn'
import {
  NATIVE_VIEW_OVERLAY_ATTRIBUTE,
  syncNativeViewOverlayCountFromDom,
} from '@/utils/native-view-overlays'
import { navigateToConversationFromVersionPanel } from '@components/collab/versionPanelConversationNavigation'
import { formatCheckpointTriggerLabel } from './checkpointBrowseLabels'
import {
  checkpointHasConversationTarget,
  filterCheckpointsWithConversationTarget,
  resolveCheckpointNavigateTarget,
} from './checkpointBrowseNavigation'

export interface CheckpointBrowseSheetProps {
  spaceId: string
  sessionId?: string | null
  onClose: () => void
}

const PAGE_SIZE = 20

export const CheckpointBrowseSheet: React.FC<CheckpointBrowseSheetProps> = ({
  spaceId,
  sessionId,
  onClose,
}) => {
  const { t, i18n } = useTranslation('chat')
  const { isForeground } = useSpaceActivity()
  const createManualCheckpoint = useChatStore(s => s.createManualCheckpoint)

  const [items, setItems] = useState<chatExtraApi.SpaceCheckpointListItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(false)
  const [creating, setCreating] = useState(false)
  const [navigatingId, setNavigatingId] = useState<string | null>(null)

  const fetchList = useCallback(async (offset = 0, append = false) => {
    if (offset === 0) {
      setLoading(true)
      setError(false)
    } else {
      setLoadingMore(true)
    }
    try {
      const result = await chatExtraApi.listSpaceCheckpoints(spaceId, {
        limit: PAGE_SIZE,
        offset,
      })
      setItems(prev => append ? [...prev, ...result.items] : result.items)
      setTotal(result.total)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [spaceId])

  useEffect(() => {
    void fetchList(0, false)
  }, [fetchList])

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

  const formatTime = (iso: string) => {
    try {
      const d = new Date(iso)
      return d.toLocaleString(i18n.language || 'zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    } catch {
      return iso
    }
  }

  const handleCreateManual = async () => {
    if (creating) return
    setCreating(true)
    try {
      await createManualCheckpoint(sessionId ?? null)
      await fetchList(0, false)
    } finally {
      setCreating(false)
    }
  }

  const notifyNoConversation = () => {
    toast({
      title: t('checkpoint.browseNoConversation', {
        defaultValue: '此快照无关联对话',
      }),
      variant: 'destructive',
    })
  }

  const notifyNavigateFailed = () => {
    toast({
      title: t('checkpoint.browseNavigateFailed', {
        defaultValue: '无法跳转到对话，请稍后重试',
      }),
      variant: 'destructive',
    })
  }

  const handleNavigate = async (item: chatExtraApi.SpaceCheckpointListItem) => {
    if (navigatingId) return

    setNavigatingId(item.id)
    try {
      let target = resolveCheckpointNavigateTarget(item)

      // 列表无线索时补拉 decision-context（兼容旧数据）；仅有 session 时尝试补消息锚点。
      if (target.kind === 'none' || (target.kind === 'session' && !target.messageId)) {
        const ctx = await fetchCheckpointDecisionContext(item.id)
        const refined = resolveCheckpointNavigateTarget(item, ctx)
        if (refined.kind !== 'none') target = refined
      }

      if (target.kind === 'agent_run') {
        await navigateToConversationFromVersionPanel(target.agentRunId, {
          sessionId: target.sessionId,
          messageId: target.messageId,
        })
        // navigateToConversationFromVersionPanel 失败时内部已 toast（回退隐藏）或 log；
        // 成功与「仅进会话」均关闭面板，避免遮挡对话。
        onClose()
        return
      }

      if (target.kind === 'session') {
        const { enterChatSession } = await import('@/services/chatSessionNavigation')
        const seq = await enterChatSession(spaceId, target.sessionId)
        if (!seq) {
          notifyNavigateFailed()
          return
        }
        if (target.messageId) {
          await useChatStore.getState().navigateToMessage(target.sessionId, target.messageId)
        }
        onClose()
        return
      }

      notifyNoConversation()
    } finally {
      setNavigatingId(null)
    }
  }

  const visibleItems = filterCheckpointsWithConversationTarget(items)
  const canLoadMore = items.length < total

  return createPortal(
    <div
      className={cn(
        'fixed inset-0 z-above-global flex items-center justify-center',
        !isForeground && 'invisible pointer-events-none',
      )}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="checkpoint-browse-title"
      aria-hidden={!isForeground || undefined}
      {...nativeViewOverlayProps}
    >
      <div className="absolute inset-0 overlay-backdrop-blur" />
      <div
        className={cn('relative z-sticky w-full max-w-lg max-h-[75vh] rounded-xl flex flex-col', OVERLAY_SURFACE_CLASS)}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
          <div className="flex items-center gap-2">
            <Camera className="h-4 w-4 text-muted-foreground" />
            <h3 id="checkpoint-browse-title" className="text-body font-semibold">
              {t('checkpoint.browseTitle', { defaultValue: '工作空间快照' })}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 hover:bg-muted transition-colors"
            aria-label={t('common.close', { defaultValue: '关闭' })}
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>

        <div className="px-5 py-3 border-b border-border/60">
          <button
            type="button"
            disabled={creating}
            onClick={() => void handleCreateManual()}
            className="inline-flex w-full items-center justify-center gap-2 rounded-interactive border border-border/60 bg-background px-3 py-2 text-body font-medium text-foreground hover:bg-muted/40 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
            {t('checkpoint.manualCreateBtn', { defaultValue: '立即快照' })}
          </button>
          <p className="mt-2 text-caption text-muted-foreground/80">
            {t('checkpoint.browseHint', {
              defaultValue: '保存当前工作空间下资源与文件的版本状态，Agent 任务完成后也会自动生成快照。',
            })}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3">
          {loading && (
            <DetailedRowListSkeleton count={5} compact showPreview={false} />
          )}

          {error && (
            <div className="text-center py-8 space-y-2">
              <p className="text-body text-muted-foreground">
                {t('checkpoint.browseLoadFailed', { defaultValue: '加载快照列表失败' })}
              </p>
              <button
                type="button"
                onClick={() => void fetchList(0, false)}
                className="text-body text-primary hover:underline"
              >
                {t('common.retry', { defaultValue: '重试' })}
              </button>
            </div>
          )}

          {!loading && !error && visibleItems.length === 0 && (
            <p className="text-center py-8 text-body text-muted-foreground">
              {t('checkpoint.browseNoConversationCheckpoints', {
                defaultValue: '暂无可跳转到对话的快照',
              })}
            </p>
          )}

          {!loading && !error && visibleItems.length > 0 && (
            <ul className="space-y-2">
              {visibleItems.map(item => {
                const isNavigating = navigatingId === item.id
                const canJump = checkpointHasConversationTarget(item)
                const displayName = item.name?.trim()
                  || formatCheckpointTriggerLabel(item.trigger)
                return (
                  <li
                    key={item.id}
                    className="rounded-lg border border-border/40 bg-muted/20 px-3 py-2.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-body font-medium text-foreground truncate">
                          {displayName}
                        </p>
                        <p className="mt-0.5 text-caption text-muted-foreground">
                          {formatTime(item.created_at)}
                          {' · '}
                          {formatCheckpointTriggerLabel(item.trigger)}
                          {item.resource_count > 0 && (
                            <>
                              {' · '}
                              {t('checkpoint.browseResourceCount', {
                                count: item.resource_count,
                                defaultValue: '{{count}} 个资源',
                              })}
                            </>
                          )}
                        </p>
                        {item.agent_run_id && (
                          <p className="mt-0.5 text-caption text-muted-foreground/70 font-mono truncate">
                            run: {item.agent_run_id.slice(0, 12)}
                          </p>
                        )}
                        {item.editor_name && (
                          <p className="mt-0.5 text-caption text-muted-foreground/60">
                            {item.editor_name}
                          </p>
                        )}
                      </div>
                      <button
                        type="button"
                        disabled={isNavigating}
                        onClick={() => void handleNavigate(item)}
                        className={cn(
                          'shrink-0 inline-flex items-center gap-1 rounded-md px-2 py-1 text-caption',
                          'border border-border/50 text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors',
                          'disabled:opacity-50 disabled:cursor-not-allowed',
                        )}
                        title={
                          canJump
                            ? t('checkpoint.browseGoConversation', { defaultValue: '跳转到对话' })
                            : t('checkpoint.browseTryConversation', { defaultValue: '尝试跳转到关联对话' })
                        }
                      >
                        {isNavigating ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <ExternalLink className="h-3 w-3" />
                        )}
                        <span>{t('checkpoint.browseGoConversationShort', { defaultValue: '跳转到对话' })}</span>
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}

          {!loading && !error && canLoadMore && (
            <div className="mt-3 text-center">
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => void fetchList(items.length, true)}
                className="text-body text-primary hover:underline disabled:opacity-50"
              >
                {loadingMore
                  ? t('checkpoint.browseLoadingMore', { defaultValue: '加载中…' })
                  : t('checkpoint.browseLoadMore', { defaultValue: '加载更多' })}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
