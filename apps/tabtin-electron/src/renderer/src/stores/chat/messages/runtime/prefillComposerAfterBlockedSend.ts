import type { ChatAttachment } from '../../../../components/chat/types'
import { useChatRuntimeStore } from '../../../useChatRuntimeStore'
import { toSerializableAttachments } from '../actions/sendDispatchInputs'

/** 发送失败 / 门禁拦截后回填 Composer，便于用户重试。 */
export function prefillComposerAfterBlockedSend(
  sessionId: string,
  visibleMessage: string,
  attachments: ChatAttachment[] | undefined,
  contextBlocks: Array<Record<string, unknown>> | undefined,
): void {
  if (!visibleMessage && !attachments?.length && !contextBlocks?.length) return
  useChatRuntimeStore.getState().setPrefillForSession(sessionId, {
    message: visibleMessage,
    attachments: toSerializableAttachments(attachments),
    contextBlocks: contextBlocks && contextBlocks.length > 0 ? contextBlocks : undefined,
  })
}
