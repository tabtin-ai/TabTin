import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from '@tabtin/smartsheet-ui'
import type { RollbackPreviewResult } from '../../../../services/chatExtraApi'
import * as chatExtraApi from '../../../../services/chatExtraApi'
import { useChatStore } from '../../../../stores/chat/useChatStore'
import { isMissingTargetError, PREVIEW_TIMEOUT_MS } from './deriveRewindPreviewUi'

interface UseRewindPreviewFetchOptions {
  sessionId: string
  targetMessageId: string
  isForeground: boolean
  onCancel: () => void
  t: (key: string, options?: Record<string, unknown> & { defaultValue?: string }) => string
}

export function useRewindPreviewFetch({
  sessionId,
  targetMessageId,
  isForeground,
  onCancel,
  t,
}: UseRewindPreviewFetchOptions) {
  const controllerRef = useRef<AbortController | null>(null)
  const [preview, setPreview] = useState<RollbackPreviewResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchPreview = useCallback(() => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller

    setLoading(true)
    setError(null)
    setPreview(null)

    let timedOut = false
    const timeoutId = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, PREVIEW_TIMEOUT_MS)

    chatExtraApi.rollbackPreview(sessionId, targetMessageId, controller.signal)
      .then((result) => {
        if (controllerRef.current !== controller) return
        if (!controller.signal.aborted) setPreview(result)
      })
      .catch((err) => {
        if (controllerRef.current !== controller) return
        if (controller.signal.aborted && !timedOut) return
        if (timedOut) {
          setError(t('rewind.previewTimeout', { defaultValue: '预览加载超时，请稍后重试' }))
        } else if (isMissingTargetError(err)) {
          void useChatStore.getState().resyncMessagesAfterMissingTarget(sessionId)
          toast({
            title: t('rewind.targetMissingResynced', {
              defaultValue: '该消息已无法回退（可能已被清理或与服务端不同步），已为你刷新对话',
            }),
          })
          onCancel()
        } else {
          setError(err.message || t('rewind.previewFailed', { defaultValue: '预览加载失败' }))
        }
      })
      .finally(() => {
        clearTimeout(timeoutId)
        if (controllerRef.current !== controller) return
        if (!controller.signal.aborted || timedOut) setLoading(false)
      })

    return () => {
      clearTimeout(timeoutId)
      controller.abort()
    }
  }, [sessionId, targetMessageId, t, onCancel])

  useEffect(() => {
    if (!isForeground) return
    const cleanup = fetchPreview()
    return cleanup
  }, [fetchPreview, isForeground])

  return { preview, loading, error, fetchPreview }
}
