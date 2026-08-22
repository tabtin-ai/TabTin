/**
 * RewindPreviewPanel — 回退预览面板
 *
 * 在执行 rollbackToCheckpoint 或 restoreAndEdit 之前，
 * 展示影响范围，用户确认后才执行。
 */

import React, { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type * as chatExtraApi from '../../../services/chatExtraApi'
import {
  buildRecoveryPlanContract,
  type RecoveryPlanConfirmation,
} from '../../../stores/chat/checkpoint/recoveryPlan'
import { useChatStore } from '../../../stores/chat/useChatStore'
import { useSpaceActivity } from '@components/layout/SpaceActivityContext'
import { cn } from '@utils/cn'
import {
  NATIVE_VIEW_OVERLAY_ATTRIBUTE,
  syncNativeViewOverlayCountFromDom,
} from '@/utils/native-view-overlays'
import {
  deriveEditResendImpact,
  deriveFilteredRestorePlan,
  deriveRewindPreviewUi,
} from './rewind/deriveRewindPreviewUi'
import { useRewindPreviewFetch } from './rewind/useRewindPreviewFetch'
import { useRewindFileImpact } from './rewind/useRewindFileImpact'
import { RewindEditResendDialog } from './rewind/RewindEditResendDialog'
import { RewindPreviewSimpleDialog } from './rewind/RewindPreviewSimpleDialog'
import { RewindPreviewFullPanel } from './rewind/RewindPreviewFullPanel'

const RevertHistorySheetLazy = lazy(() => import('./RevertHistorySheet').then(m => ({ default: m.RevertHistorySheet })))

interface RewindPreviewPanelProps {
  sessionId: string
  targetMessageId: string
  mode: 'rollback' | 'editAndResend'
  resendIntent?: 'edit' | 'resend'
  onConfirm: (confirmation: RecoveryPlanConfirmation) => void
  onCancel: () => void
}

export const RewindPreviewPanel: React.FC<RewindPreviewPanelProps> = ({
  sessionId,
  targetMessageId,
  mode,
  resendIntent,
  onConfirm,
  onCancel,
}) => {
  const { t } = useTranslation('chat')
  const { isForeground } = useSpaceActivity()
  const rollbackReason = ''
  const [excludedResources, setExcludedResources] = useState<Set<string>>(new Set())
  const [showHistory, setShowHistory] = useState(false)

  const sessionMessages = useChatStore(s => s.messagesBySessionId[sessionId])
  const rollbackState = useChatStore(
    useCallback(
      (s) => s.sessions.find(session => session.id === sessionId)?.rollback_state ?? null,
      [sessionId],
    ),
  )

  const { preview, loading, error, fetchPreview } = useRewindPreviewFetch({
    sessionId,
    targetMessageId,
    isForeground,
    onCancel,
    t,
  })

  const fileImpact = useRewindFileImpact({
    mode,
    sessionId,
    targetMessageId,
    sessionMessages,
    preview,
  })
  const { retryLocalFilePreview } = fileImpact
  const recoveryPlan = useMemo(() => preview
    ? buildRecoveryPlanContract({
        preview,
        fileAnchor: fileImpact.recoveryFileAnchor,
        localFilePreviewRevision: fileImpact.localFilePreviewRevision,
      })
    : null, [preview, fileImpact.recoveryFileAnchor, fileImpact.localFilePreviewRevision])
  const revisionContractReason = recoveryPlan && recoveryPlan.version >= 2
    ? !recoveryPlan.previewRevision
      ? 'rollback_preview_revision_missing'
      : !recoveryPlan.filePreviewRevision
        ? 'file_preview_revision_missing'
        : null
    : null

  const ui = useMemo(() => deriveRewindPreviewUi({
    preview,
    loading,
    localAffectedPaths: fileImpact.localAffectedPaths,
    localFilesPending: fileImpact.localFilesPending,
    localAnchorId: fileImpact.localAnchorId,
    fileCheckpointHash: fileImpact.fileCheckpointHash,
    fileHistoryAvailable: fileImpact.fileHistoryAvailable,
    rollbackState,
    t,
  }), [
    preview,
    loading,
    fileImpact.localAffectedPaths,
    fileImpact.localFilesPending,
    fileImpact.localAnchorId,
    fileImpact.fileCheckpointHash,
    fileImpact.fileHistoryAvailable,
    rollbackState,
    t,
  ])

  const filteredRestorePlan = useMemo(
    () => deriveFilteredRestorePlan(preview, excludedResources),
    [preview, excludedResources],
  )

  const derivedEditResendImpact = useMemo(() => deriveEditResendImpact({
    preview,
    perFile: ui.perFile,
    localFilePreviewFailed: fileImpact.localFilePreviewFailed,
    localFilePreviewReason: fileImpact.localFilePreviewReason,
    localUnrestorableFiles: fileImpact.localUnrestorableFiles,
    localAnchorId: fileImpact.localAnchorId,
    fileHistoryAvailable: fileImpact.fileHistoryAvailable,
  }), [
    preview,
    ui.perFile,
    fileImpact.localFilePreviewFailed,
    fileImpact.localFilePreviewReason,
    fileImpact.localUnrestorableFiles,
    fileImpact.localAnchorId,
    fileImpact.fileHistoryAvailable,
  ])
  const editResendImpact = useMemo(() => {
    if (!derivedEditResendImpact || !revisionContractReason) return derivedEditResendImpact
    // v2 缺任一对话/文件修订都必须无条件阻断。即使文件层同时是
    // no_file_history 等原本可选“仅重写对话”的原因，也不能绕过并发校验。
    return {
      ...derivedEditResendImpact,
      files: {
        ...derivedEditResendImpact.files,
        status: 'unavailable' as const,
        affectedCount: null,
        // 缺 revision 始终阻断，但若本机已经能给出更具体的原因（IPC 断开、
        // 锚点不一致、无账本），优先把用户能采取行动的信息展示出来。
        reason: derivedEditResendImpact.files.status === 'unavailable'
          && derivedEditResendImpact.files.reason
          ? derivedEditResendImpact.files.reason
          : revisionContractReason,
        canContinueConversationOnly: false,
      },
    }
  }, [derivedEditResendImpact, revisionContractReason])

  // 编辑重发允许用户在已知不可恢复资源时显式选择“仅重写对话”。
  // 对执行链路传 skip，而不是把 can_restore=false 的条目继续伪装成恢复动作。
  const editResendRestorePlan = useMemo(() => filteredRestorePlan?.map(item => (
    item.can_restore ? item : { ...item, action: 'skip' as const, can_restore: false }
  )), [filteredRestorePlan])

  const handleEditResendConfirm = useCallback(() => {
    if (!recoveryPlan) return
    const approvedReason = editResendImpact.files.canContinueConversationOnly
      ? editResendImpact.files.reason
      : undefined
    onConfirm({
      resourceRestorePlan: editResendRestorePlan,
      approvedUnavailableFileReason: approvedReason ?? undefined,
      contract: recoveryPlan,
    })
  }, [
    editResendImpact.files,
    editResendRestorePlan,
    onConfirm,
    recoveryPlan,
  ])

  const handleFullConfirm = useCallback((
    resourceRestorePlan?: chatExtraApi.ResourceRestoreInfo[],
    reason?: string,
  ) => {
    if (!recoveryPlan) return
    onConfirm({
      resourceRestorePlan,
      rollbackReason: reason,
      contract: recoveryPlan,
    })
  }, [
    onConfirm,
    recoveryPlan,
  ])

  const toggleResource = useCallback((key: string) => {
    setExcludedResources(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  useEffect(() => {
    if (!isForeground) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCancel()
      }
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [onCancel, isForeground])

  const nativeViewOverlayProps: Record<string, string> = isForeground
    ? { [NATIVE_VIEW_OVERLAY_ATTRIBUTE]: 'true' }
    : {}

  useLayoutEffect(() => {
    if (!isForeground) return
    syncNativeViewOverlayCountFromDom(document)
    return () => {
      queueMicrotask(() => syncNativeViewOverlayCountFromDom(document))
    }
  }, [isForeground, preview, loading, error])

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onCancel()
  }, [onCancel])

  const handleRetryPreview = useCallback(() => {
    retryLocalFilePreview()
    fetchPreview()
  }, [retryLocalFilePreview, fetchPreview])

  // 编辑重发使用专用的紧凑确认，但内容必须来自 preview：对话、文件与资源
  // 分层说明；无法确认文件版本时 fail closed，不再用固定文案承诺全部回退。
  const showEditResendDialog = mode === 'editAndResend'
  const showSimpleDialog = !showEditResendDialog
    && !!preview
    && ui.isSimpleView
    && !ui.noImpact

  const panelContent = showEditResendDialog ? (
    <RewindEditResendDialog
      loading={loading || fileImpact.localFilesPending}
      error={error}
      noImpact={ui.noImpact}
      preview={preview}
      impact={editResendImpact}
      resendIntent={resendIntent}
      rollbackState={rollbackState}
      excludedResources={excludedResources}
      nativeViewOverlayProps={nativeViewOverlayProps}
      onToggleResource={toggleResource}
      onConfirm={handleEditResendConfirm}
      onCancel={onCancel}
      onRetryPreview={handleRetryPreview}
    />
  ) : showSimpleDialog ? (
    <RewindPreviewSimpleDialog
      mode={mode}
      resendIntent={resendIntent}
      rollbackState={rollbackState}
      nativeViewOverlayProps={nativeViewOverlayProps}
      onConfirm={() => recoveryPlan && onConfirm({ contract: recoveryPlan })}
      onCancel={onCancel}
      onBackdropClick={handleBackdropClick}
    />
  ) : (
    <RewindPreviewFullPanel
      mode={mode}
      resendIntent={resendIntent}
      preview={preview}
      loading={loading}
      error={error}
      noImpact={ui.noImpact}
      rollbackState={rollbackState}
      rollbackReason={rollbackReason}
      checkpointSemanticFeedback={ui.checkpointSemanticFeedback}
      hasLatestRollbackOpenIssues={ui.hasLatestRollbackOpenIssues}
      showFileImpact={ui.perFile.showFileImpact}
      excludedResources={excludedResources}
      nativeViewOverlayProps={nativeViewOverlayProps}
      onToggleResource={toggleResource}
      onShowHistory={() => setShowHistory(true)}
      onRetryPreview={handleRetryPreview}
      onConfirm={handleFullConfirm}
      onCancel={onCancel}
      onBackdropClick={handleBackdropClick}
    />
  )

  return (
    <>
      {createPortal(
        <div
          className={cn(!isForeground && 'invisible pointer-events-none')}
          aria-hidden={!isForeground || undefined}
        >
          {panelContent}
        </div>,
        document.body,
      )}
      {showHistory && (
        <Suspense fallback={null}>
          <RevertHistorySheetLazy
            sessionId={sessionId}
            onClose={() => setShowHistory(false)}
          />
        </Suspense>
      )}
    </>
  )
}
