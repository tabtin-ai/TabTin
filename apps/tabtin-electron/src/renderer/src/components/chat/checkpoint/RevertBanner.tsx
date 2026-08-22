/**
 * RevertBanner — 回滚状态提示条
 *
 * 当 session 处于软回滚状态（rollbackToCheckpoint 完成后、用户未发新消息前），
 * 显示提示条允许用户撤销回滚（unrevert）。
 *
 * 支持两种 session 绑定方式：
 * 1. 传入 sessionId — 按指定 session 判断是否显示（分屏场景）
 * 2. 不传 sessionId — 按 currentSessionId 判断（主面板场景）
 *
 * placement：
 * - messageList — 渲染在 MessageList 末尾（默认推荐）
 * - composer — 保留旧版输入区外浮层边距（兼容）
 */

import React, { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../../stores/chat/useChatStore'
import { useSessionBusy } from '../../../stores/chat/execution/sessionRunProjection'
import {
  deriveRevertBannerViewModel,
  isRevertConsumedByNewTurn,
  REVERT_BANNER_COLLAPSE_MARKER_FALLBACK,
} from './deriveRevertBannerViewModel'
import { RevertBannerView } from './RevertBannerViews'

interface RevertBannerProps {
  sessionId?: string
  /** messageList = 消息列表末尾（默认）；composer = 输入区外浮层（遗留，勿再使用） */
  placement?: 'composer' | 'messageList'
}

export const RevertBanner: React.FC<RevertBannerProps> = ({ sessionId, placement = 'messageList' }) => {
  const currentSessionId = useChatStore(s => s.currentSessionId)
  const effectiveSessionId = sessionId ?? currentSessionId
  const rollbackState = useChatStore(
    useCallback(
      (s) => {
        if (!effectiveSessionId) return null
        return s.sessions.find(session => session.id === effectiveSessionId)?.rollback_state ?? null
      },
      [effectiveSessionId],
    ),
  )
  const messages = useChatStore(
    useCallback(
      (s) => (effectiveSessionId ? s.messagesBySessionId?.[effectiveSessionId] : undefined),
      [effectiveSessionId],
    ),
  )
  const restoringSessionId = useChatStore(s => s.restoringSessionId)
  const isStreaming = useSessionBusy(effectiveSessionId)
  const unrevertSession = useChatStore(s => s.unrevertSession)
  const retryFailedResourceRestore = useChatStore(s => s.retryFailedResourceRestore)
  const restoreInterruptedBySessionId = useChatStore(s => s.restoreInterruptedBySessionId)
  const isEditResendRevert = useChatStore(
    useCallback(
      (s) => (effectiveSessionId ? !!s.editResendRevertBySessionId[effectiveSessionId] : false),
      [effectiveSessionId],
    ),
  )
  const collapsedRevertBannerMarker = useChatStore(
    useCallback(
      (s) => (effectiveSessionId ? s.revertBannerCollapsedBySessionId[effectiveSessionId] : undefined),
      [effectiveSessionId],
    ),
  )
  const requestRewindPreview = useChatStore(s => s.requestRewindPreview)
  const { t } = useTranslation('chat')
  const [pending, setPending] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [showHistory, setShowHistory] = useState(false)

  const isRestoring = effectiveSessionId != null && restoringSessionId === effectiveSessionId
  const isInterrupted = effectiveSessionId != null && !!restoreInterruptedBySessionId[effectiveSessionId]
  const revertConsumedByNewTurn = useMemo(
    () => isRevertConsumedByNewTurn(rollbackState?.target_message_id, messages),
    [rollbackState?.target_message_id, messages],
  )
  const isReverted = !!rollbackState?.revert_active && !revertConsumedByNewTurn
  const revertBannerCollapseMarker = rollbackState?.updated_at
    ?? rollbackState?.safety_snapshot_ref
    ?? REVERT_BANNER_COLLAPSE_MARKER_FALLBACK

  const viewModel = useMemo(
    () => deriveRevertBannerViewModel({
      rollbackState,
      isInterrupted,
      isReverted,
      isRestoring,
      isEditResendRevert,
      collapsedRevertBannerMarker,
      pending,
      isStreaming,
      t,
    }),
    [
      rollbackState,
      isInterrupted,
      isReverted,
      isRestoring,
      isEditResendRevert,
      collapsedRevertBannerMarker,
      pending,
      isStreaming,
      t,
    ],
  )

  const handleUnrevert = useCallback(async () => {
    if (pending || !effectiveSessionId || !(rollbackState?.can_unrevert ?? false)) return
    setPending(true)
    try {
      await unrevertSession(effectiveSessionId)
    } catch (err) {
      console.error('unrevertSession failed:', err)
    } finally {
      setPending(false)
    }
  }, [effectiveSessionId, unrevertSession, pending, rollbackState?.can_unrevert])

  const handleRetry = useCallback(async () => {
    if (retrying || !retryFailedResourceRestore || !effectiveSessionId) return
    setRetrying(true)
    try {
      await retryFailedResourceRestore(effectiveSessionId)
    } catch (err) {
      console.error('retryFailedResourceRestore failed:', err)
    } finally {
      setRetrying(false)
    }
  }, [effectiveSessionId, retryFailedResourceRestore, retrying])

  const handleCollapseRevertBanner = useCallback(() => {
    if (!effectiveSessionId || !rollbackState?.revert_active) return
    useChatStore.setState(state => ({
      revertBannerCollapsedBySessionId: {
        ...state.revertBannerCollapsedBySessionId,
        [effectiveSessionId]: revertBannerCollapseMarker,
      },
    }))
  }, [effectiveSessionId, revertBannerCollapseMarker, rollbackState?.revert_active])

  const handleExpandRevertBanner = useCallback(() => {
    if (!effectiveSessionId) return
    useChatStore.setState(state => {
      const { [effectiveSessionId]: _, ...rest } = state.revertBannerCollapsedBySessionId
      return { revertBannerCollapsedBySessionId: rest }
    })
  }, [effectiveSessionId])

  const handleDismissInterrupted = useCallback(() => {
    if (!effectiveSessionId) return
    useChatStore.setState(state => {
      const { [effectiveSessionId]: _, ...rest } = state.restoreInterruptedBySessionId
      return { restoreInterruptedBySessionId: rest }
    })
  }, [effectiveSessionId])

  const handleRetriggerRevert = useCallback(() => {
    if (!effectiveSessionId) return
    useChatStore.setState(state => {
      const { [effectiveSessionId]: _, ...rest } = state.restoreInterruptedBySessionId
      return { restoreInterruptedBySessionId: rest }
    })
    const sessionMessages = useChatStore.getState().messagesBySessionId[effectiveSessionId]
    const lastAssistantMsg = sessionMessages?.filter(m => m.role === 'assistant').at(-1)
    if (lastAssistantMsg) {
      requestRewindPreview(effectiveSessionId, lastAssistantMsg.id, 'rollback')
    }
  }, [effectiveSessionId, requestRewindPreview])

  return (
    <RevertBannerView
      viewModel={viewModel}
      placement={placement}
      pending={pending}
      retrying={retrying}
      showHistory={showHistory}
      effectiveSessionId={effectiveSessionId}
      onCloseHistory={() => setShowHistory(false)}
      actions={{
        onRetriggerRevert: handleRetriggerRevert,
        onDismissInterrupted: handleDismissInterrupted,
        onExpandRevertBanner: handleExpandRevertBanner,
        onCollapseRevertBanner: handleCollapseRevertBanner,
        onUnrevert: handleUnrevert,
        onRetry: handleRetry,
        onShowHistory: () => setShowHistory(true),
      }}
    />
  )
}
