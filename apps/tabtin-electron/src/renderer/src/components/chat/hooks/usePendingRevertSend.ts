/**
 * 回退态下发消息前的确认门闩（ConfirmDialog 状态）。
 * 主对话在「简单回退」时可跳过；分屏一律确认。
 */

import { useCallback, useState } from 'react'
import type { ChatAttachment } from '../types'
import type { ChatInputSendOptions } from '../composer/ChatInput'

export type PendingRevertSend = {
  message: string
  attachments?: ChatAttachment[]
  contextBlocks?: Array<Record<string, unknown>>
  options?: ChatInputSendOptions
  continueAfterError?: boolean
}

export function usePendingRevertSend() {
  const [pending, setPending] = useState<PendingRevertSend | null>(null)

  const deferOrRun = useCallback(
    async (
      shouldConfirm: boolean,
      payload: PendingRevertSend,
      run: (payload: PendingRevertSend) => void | Promise<void>,
    ) => {
      if (shouldConfirm) {
        setPending(payload)
        return
      }
      await run(payload)
    },
    [],
  )

  const confirmPending = useCallback(
    async (run: (payload: PendingRevertSend) => void | Promise<void>) => {
      if (!pending) return
      const payload = pending
      setPending(null)
      await run(payload)
    },
    [pending],
  )

  const clearPending = useCallback(() => setPending(null), [])

  return {
    pending,
    deferOrRun,
    confirmPending,
    clearPending,
    dialogOpen: pending !== null,
  }
}
