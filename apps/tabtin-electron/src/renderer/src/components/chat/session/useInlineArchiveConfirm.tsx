import { useCallback, useEffect, useRef, useState } from 'react'
import { ToastAction } from '@tabtin/smartsheet-ui'
import { toast } from '@components/ui'
import { useChatStore } from '@/stores/chat/useChatStore'
import { isSessionShareArchiveConflict } from '@/stores/chat/session/isSessionShareArchiveConflict'

export const ARCHIVE_INLINE_CONFIRM_COOLDOWN_MS = 200
export const ARCHIVE_INLINE_CONFIRM_TIMEOUT_MS = 3000

export function useInlineArchiveConfirm() {
  const [pendingArchiveSessionId, setPendingArchiveSessionId] = useState<string | null>(null)
  const confirmTimerRef = useRef<number | null>(null)
  const confirmReadyAtRef = useRef(0)

  const clearConfirmTimer = useCallback(() => {
    if (confirmTimerRef.current === null) return
    window.clearTimeout(confirmTimerRef.current)
    confirmTimerRef.current = null
  }, [])

  const resetArchiveConfirming = useCallback(() => {
    clearConfirmTimer()
    setPendingArchiveSessionId(null)
  }, [clearConfirmTimer])

  const requestInlineArchiveConfirm = useCallback((sessionId: string, onConfirmed: () => void) => {
    if (pendingArchiveSessionId === sessionId) {
      if (Date.now() < confirmReadyAtRef.current) return
      resetArchiveConfirming()
      onConfirmed()
      return
    }
    clearConfirmTimer()
    setPendingArchiveSessionId(sessionId)
    confirmReadyAtRef.current = Date.now() + ARCHIVE_INLINE_CONFIRM_COOLDOWN_MS
    confirmTimerRef.current = window.setTimeout(() => {
      setPendingArchiveSessionId(current => current === sessionId ? null : current)
      confirmTimerRef.current = null
    }, ARCHIVE_INLINE_CONFIRM_TIMEOUT_MS)
  }, [clearConfirmTimer, pendingArchiveSessionId, resetArchiveConfirming])

  useEffect(() => clearConfirmTimer, [clearConfirmTimer])

  return {
    pendingArchiveSessionId,
    requestInlineArchiveConfirm,
    resetArchiveConfirming,
  }
}

export function archiveSessionWithRestoreToast(input: {
  spaceId: string
  sessionId: string
  sessionTitle: string
  onDeleteSession: (sessionId: string) => void | Promise<void>
  onShareConflict?: (sessionId: string) => void
  t: (key: string, options: { defaultValue: string; title?: string }) => string
}) {
  const { spaceId, sessionId, sessionTitle, onDeleteSession, onShareConflict, t } = input
  const restore = () => {
    void useChatStore.getState().restoreSession(spaceId, sessionId).then(() => {
      toast({
        title: t('session.restoreSuccess', { defaultValue: '已恢复对话' }),
        duration: 3000,
      })
    }).catch(() => {
      toast({
        title: t('session.restoreFailed', { defaultValue: '恢复失败，请重试' }),
        variant: 'destructive',
      })
    })
  }

  void Promise.resolve(onDeleteSession(sessionId)).then(() => {
    toast({
      title: t('session.archiveSuccessToast', {
        defaultValue: '「{{title}}」已归档，可在工作空间设置中恢复或彻底删除',
        title: sessionTitle,
      }),
      action: (
        <ToastAction
          altText={t('session.restoreArchivedActionAlt', { defaultValue: '恢复对话' })}
          onClick={restore}
        >
          {t('session.restoreArchivedAction', { defaultValue: '恢复' })}
        </ToastAction>
      ),
      duration: 5000,
    })
  }).catch((error: unknown) => {
    if (isSessionShareArchiveConflict(error)) {
      onShareConflict?.(sessionId)
      return
    }
    toast({
      title: t('session.archiveFailed', { defaultValue: '归档失败，请重试' }),
      variant: 'destructive',
    })
  })
}
