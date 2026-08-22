import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Pencil, RotateCcw, Trash2 } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from '@components/ui'
import type { ChatMessage } from '@tabtin/chat-client'
import {
  isProjectTaskEditAndResendBlocked,
  PROJECT_TASK_RUN_REQUIRED_MESSAGE,
} from '@/stores/chat/messages/product/delivery/projectTaskSendGate'
import type { MessageSendStatus } from '../../../../../stores/chat/shared/types'
import { useChatStore } from '../../../../../stores/chat/useChatStore'
import { useChatRuntimeStore } from '../../../../../stores/useChatRuntimeStore'
import { armFailedMessageEditResend } from '@/stores/chat/messages/actions/failedMessageEditResend'
import { isLocalPendingSessionId } from '@/stores/chat/session/actions/pendingFirstSend'
import { retryPendingFirstSend } from '@/stores/chat/session/actions/pendingFirstSendRetry'
import {
  buildSendRetryContextBlocks,
  mapAttachmentsForPrefill,
  mapBlocksForPrefill,
} from '@stores/chat/presentation/messageBubble/messageResendContext'

/**
 * 仅在发送失败时展示操作入口。
 * `sending` / `sent` 不再渲染时钟或对勾——状态仍由 store 维护，供同步与重试逻辑使用。
 */
export const SendStatusIndicator: React.FC<{
  sendStatus?: MessageSendStatus
  messageId: string
  messageContent: string
  sessionId: string | null
  attachmentsJson?: ChatMessage['attachments_json']
  blocksJson?: ChatMessage['content_blocks_json']
}> = React.memo(({ sendStatus, messageId, messageContent, sessionId, attachmentsJson, blocksJson }) => {
  const [popoverOpen, setPopoverOpen] = useState(false)
  const { t } = useTranslation('chat')

  if (sendStatus !== 'failed') return null

  // ：失败 Project Task 会话隐藏重试/重发，保留删除并提示任务页重跑。
  const projectTaskResendBlocked = isProjectTaskEditAndResendBlocked(sessionId)

  const removeFailedMessage = () => {
    if (!sessionId) return
    useChatStore.getState().removeMessages(sessionId, [messageId])
  }

  const handleRetry = () => {
    if (!sessionId || projectTaskResendBlocked) return
    const contextBlocks = buildSendRetryContextBlocks(attachmentsJson, blocksJson)

    // ：local-pending = 首发建会话失败，会话尚不存在。直接 sendMessage 是死路
    // （它从不建会话），必须路由回面板首发编排重新 ensure；adopt_owned 复用同一气泡。
    if (isLocalPendingSessionId(sessionId)) {
      const handled = retryPendingFirstSend(sessionId, {
        message: messageContent,
        contextBlocks,
      })
      if (!handled) {
        // episode 已取消 / 面板未挂载：降级为编辑重发——内容回 Composer，由用户确认发送
        armFailedMessageEditResend(sessionId, messageId)
        const attachments = mapAttachmentsForPrefill(attachmentsJson)
        const prefillBlocks = mapBlocksForPrefill(blocksJson)
        useChatRuntimeStore.getState().setPrefillForSession(
          sessionId,
          (attachments || prefillBlocks)
            ? { message: messageContent, attachments, contextBlocks: prefillBlocks }
            : messageContent,
        )
      }
      setPopoverOpen(false)
      return
    }

    // ：不先删气泡——sendMessage 前门禁若 episode commit 再失败，须保持 failed 可重试。
    // 成功路径由 sendMessage 复用 existingClientMessageId，不会叠第二条用户气泡。
    void useChatStore.getState().sendMessage(
      messageContent,
      true,
      undefined,
      contextBlocks,
      sessionId,
      { existingClientMessageId: messageId },
    )
    setPopoverOpen(false)
  }

  const handleEditAndResend = () => {
    if (!sessionId || projectTaskResendBlocked) return
    const attachments = mapAttachmentsForPrefill(attachmentsJson)
    const contextBlocks = mapBlocksForPrefill(blocksJson)
    const prefill = (attachments || contextBlocks)
      ? { message: messageContent, attachments, contextBlocks }
      : messageContent
    // ：成功前不删 failed 气泡；登记 messageId，Composer 发送走同一 existingClientMessageId。
    armFailedMessageEditResend(sessionId, messageId)
    useChatRuntimeStore.getState().setPrefillForSession(sessionId, prefill)
    setPopoverOpen(false)
  }

  const handleDelete = () => {
    removeFailedMessage()
    setPopoverOpen(false)
  }

  return (
    <div className="flex justify-end mt-0.5" data-testid="message-send-status">
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-destructive/80 transition-colors hover:bg-destructive/5"
          >
            <AlertCircle className="h-3.5 w-3.5" />
            <span className="text-caption">{t('sendStatus.sendFailed')}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[220px] p-1" align="end">
          {projectTaskResendBlocked ? (
            <p className="px-2 py-1.5 text-caption text-muted-foreground">
              {t('projectTask.runRequiredHint', {
                defaultValue: PROJECT_TASK_RUN_REQUIRED_MESSAGE,
              })}
            </p>
          ) : (
            <>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-body transition-colors hover:bg-accent/10"
                onClick={handleRetry}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t('sendStatus.retry')}
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-body transition-colors hover:bg-accent/10"
                onClick={handleEditAndResend}
              >
                <Pencil className="h-3.5 w-3.5" />
                {t('sendStatus.editAndResend')}
              </button>
            </>
          )}
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-body text-destructive/80 transition-colors hover:bg-destructive/5"
            onClick={handleDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('sendStatus.delete')}
          </button>
        </PopoverContent>
      </Popover>
    </div>
  )
})
SendStatusIndicator.displayName = 'SendStatusIndicator'
