import { useCallback } from 'react'
import { useChatRuntimeStore } from '@/stores/useChatRuntimeStore'
import { useTodoTimeline } from '@stores/chat/presentation/useTodoTimeline'

export function useChatInputUploadState(sessionId: string | null | undefined) {
  const uploadProgress = useChatRuntimeStore(
    useCallback(
      (s: { uploadProgressBySessionId: Record<string, number> }) =>
        sessionId ? s.uploadProgressBySessionId[sessionId] : undefined,
      [sessionId],
    ),
  )
  const isUploadingAttachments = uploadProgress !== undefined

  const handleCancelUpload = useCallback(() => {
    if (sessionId) {
      useChatRuntimeStore.getState().abortUpload(sessionId)
    }
  }, [sessionId])

  const { activeTodos: sessionTodos } = useTodoTimeline(sessionId)

  return {
    uploadProgress,
    isUploadingAttachments,
    handleCancelUpload,
    sessionTodos,
  }
}
