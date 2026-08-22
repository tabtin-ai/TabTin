import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RollbackPreviewResult } from '../../../../services/chatExtraApi'
import * as fileHistoryIpc from '../../../../services/fileHistoryIpc'
import { resolveRecoveryFileAnchor } from '../../../../stores/chat/checkpoint/recoveryPlan'
import { resolveRewindAnchorId } from '../../../../stores/chat/checkpoint/utils/rewindAnchor'
import type { ChatMessage } from '@tabtin/chat-client'

interface UseRewindFileImpactOptions {
  mode: 'rollback' | 'editAndResend'
  sessionId: string
  targetMessageId: string
  sessionMessages: ChatMessage[] | undefined
  preview: RollbackPreviewResult | null
}

export function useRewindFileImpact({
  mode,
  sessionId,
  targetMessageId,
  sessionMessages,
  preview,
}: UseRewindFileImpactOptions) {
  const [localAffectedPaths, setLocalAffectedPaths] = useState<string[] | null>(null)
  const [localFilesPending, setLocalFilesPending] = useState(false)
  const [localFilePreviewFailed, setLocalFilePreviewFailed] = useState(false)
  const [localFilePreviewReason, setLocalFilePreviewReason] = useState<fileHistoryIpc.FileHistoryUnavailableReason | null>(null)
  const [localFilePreviewRevision, setLocalFilePreviewRevision] = useState<string | null>(null)
  const [localUnrestorableFiles, setLocalUnrestorableFiles] = useState<Array<{ path: string; reason: string }>>([])
  const [localFilePreviewAttempt, setLocalFilePreviewAttempt] = useState(0)

  const fileCheckpointHash = preview?.checkpoint_hash ?? null
  const fileHistoryAvailable = fileHistoryIpc.isAvailable()

  const cachedAnchorId = useMemo(() => {
    if (!sessionMessages || sessionMessages.length === 0) return null
    const targetIdx = sessionMessages.findIndex(m => m.id === targetMessageId)
    if (targetIdx < 0) return null
    return resolveRewindAnchorId(sessionMessages, targetIdx)
  }, [sessionMessages, targetMessageId])

  const recoveryFileAnchor = useMemo(
    () => resolveRecoveryFileAnchor(preview, cachedAnchorId),
    [preview, cachedAnchorId],
  )
  const localAnchorId = preview?.file_restore_host === 'daemon'
    ? null
    : recoveryFileAnchor.id

  useEffect(() => {
    if (
      !preview
      || preview.file_restore_host === 'daemon'
      || (mode === 'rollback' && (!fileHistoryAvailable || !localAnchorId))
    ) {
      setLocalAffectedPaths(null)
      setLocalFilesPending(false)
      setLocalFilePreviewFailed(false)
      setLocalFilePreviewReason(null)
      setLocalFilePreviewRevision(null)
      setLocalUnrestorableFiles([])
      return
    }
    let cancelled = false
    setLocalAffectedPaths(null)
    setLocalFilesPending(true)
    setLocalFilePreviewFailed(false)
    setLocalFilePreviewReason(null)
    setLocalFilePreviewRevision(null)
    setLocalUnrestorableFiles([])
    const previewPromise = !fileHistoryAvailable
        ? Promise.reject(new Error('File history preview API not available'))
        : fileHistoryIpc.getPreview(sessionId, localAnchorId)

    previewPromise
      .then(result => {
        if (cancelled) return
        setLocalFilePreviewRevision(result.revision)
        setLocalUnrestorableFiles(result.unrestorable.map(({ path, reason }) => ({ path, reason })))
        if (result.status === 'unavailable' || !result.success) {
          setLocalAffectedPaths(null)
          setLocalFilePreviewFailed(true)
          const reason = result.reason
          setLocalFilePreviewReason(
            reason === 'no_file_history'
              || reason === 'file_snapshot_missing'
              || reason === 'path_guard_denied'
              || reason === 'unrestorable_files'
              ? reason
              : 'local_file_preview_failed',
          )
          return
        }
        setLocalAffectedPaths(result.paths)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        // 缺少整份账本只能说明当前设备无法证明文件状态，不能等价成
        // “本轮没有文件变更”。保留稳定 reason，供显式“仅重写对话”授权。
        setLocalAffectedPaths(null)
        setLocalFilePreviewFailed(true)
        setLocalFilePreviewReason(fileHistoryIpc.classifyFileHistoryUnavailableReason(error))
        setLocalFilePreviewRevision(null)
        setLocalUnrestorableFiles([])
      })
      .finally(() => { if (!cancelled) setLocalFilesPending(false) })
    return () => { cancelled = true }
  }, [mode, sessionId, preview, localAnchorId, fileHistoryAvailable, localFilePreviewAttempt])

  const retryLocalFilePreview = useCallback(() => {
    setLocalFilePreviewAttempt(attempt => attempt + 1)
  }, [])

  return {
    localAnchorId,
    localAffectedPaths,
    localFilesPending,
    localFilePreviewFailed,
    localFilePreviewReason,
    localFilePreviewRevision,
    localUnrestorableFiles,
    recoveryFileAnchor,
    retryLocalFilePreview,
    fileCheckpointHash,
    fileHistoryAvailable,
  }
}
