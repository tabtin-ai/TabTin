import type { ChatMessage } from '@tabtin/chat-client'
import {
  buildCheckpointSemanticFeedback,
  type CheckpointSemanticFeedback,
} from '@utils/chat/checkpointFeedback'

type Translate = (key: string, options?: Record<string, unknown>) => string

export interface CheckpointFooterMeta {
  checkpointSemanticFeedback: CheckpointSemanticFeedback | null
  checkpointBadgeTitle: string
}

export function buildCheckpointFooterMeta(
  message: ChatMessage,
  isUser: boolean,
  t: Translate,
): CheckpointFooterMeta {
  if (isUser || !message.checkpoint_record) {
    return { checkpointSemanticFeedback: null, checkpointBadgeTitle: '' }
  }
  const checkpointSemanticFeedback = buildCheckpointSemanticFeedback({
    checkpointRecord: message.checkpoint_record,
  }, t)
  const checkpointBadgeTitle = [
    checkpointSemanticFeedback.title,
    checkpointSemanticFeedback.summary,
    ...checkpointSemanticFeedback.reasons.map(reason => reason.text),
  ].join('\n')
  return { checkpointSemanticFeedback, checkpointBadgeTitle }
}
