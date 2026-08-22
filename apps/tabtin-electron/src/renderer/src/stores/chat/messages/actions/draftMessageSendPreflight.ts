/**
 * ：sendMessage 统一 DraftMessage 前门禁。
 * 从 sendMessageAction 抽出以便单测覆盖 fail-closed / 重试路径，不拖整条 stream。
 */

import i18n from '@/i18n'
import { toast } from '@tabtin/smartsheet-ui/toast'
import { getClientMessageId } from '@/stores/chat/domain/messageIdentity'
import type { ChatMessage } from '@tabtin/chat-client'
import { createLogger } from '@/utils/logger'
import type { LocalChatMessage } from '../../shared/types'
import {
  commitDraftMessageConfigBeforeSend,
  type CommitDraftMessageResult,
} from '../../session/draftMessageSessionCoordinator'
import type { DraftMessageSessionLike, PatchSessionAgentFn } from '../../session/draftSession'

const log = createLogger('DraftMessageSendPreflight')

export type DraftMessageSendPreflightDeps = {
  sessionId: string
  existingClientMessageId?: string
  expectedDraftMessageId?: string
  patchSessionAgent: PatchSessionAgentFn
  getSession: (sessionId: string) => DraftMessageSessionLike | undefined
  updateSessionInCaches: (sessionId: string, patch: DraftMessageSessionLike) => void
  updateSessionMessages: (
    sessionId: string,
    updater: (messages: ChatMessage[]) => ChatMessage[],
  ) => void
}

export type DraftMessageSendPreflightOutcome = {
  blocked: boolean
  result: CommitDraftMessageResult
}

function asLocal(msg: ChatMessage): LocalChatMessage {
  return msg as LocalChatMessage
}

function markBoundSessionUserFailed(
  deps: DraftMessageSendPreflightDeps,
): void {
  const reusedId = deps.existingClientMessageId
  if (reusedId) {
    deps.updateSessionMessages(deps.sessionId, (msgs) =>
      msgs.map((m) => {
        const local = asLocal(m)
        return local.id === reusedId || getClientMessageId(local) === reusedId
          ? { ...local, sendStatus: 'failed' as const }
          : m
      }),
    )
    return
  }
  deps.updateSessionMessages(deps.sessionId, (msgs) => {
    let marked = false
    return [...msgs].reverse().map((m) => {
      const local = asLocal(m)
      if (
        !marked
        && local.role === 'user'
        && (local.sendStatus === 'sending' || local.sendStatus === 'failed')
      ) {
        marked = true
        return { ...local, sendStatus: 'failed' as const }
      }
      return m
    }).reverse()
  })
}

function toastForFailureReason(
  reason: Extract<CommitDraftMessageResult, { ok: false }>['reason'],
): void {
  if (reason === 'agent_bind_failed') {
    toast({
      title: i18n.t('chat:errors.agentBindFailed', {
        defaultValue: '绑定 Agent 失败，请重试发送',
      }),
      variant: 'destructive',
    })
    return
  }
  if (reason === 'cancelled' || reason === 'draft_message_mismatch') {
    toast({
      title: i18n.t('chat:errors.draftMessageCancelled', {
        defaultValue: '草稿会话已切换或取消，请重试发送',
      }),
      variant: 'destructive',
    })
    return
  }
  toast({
    title: i18n.t('chat:errors.draftMessageCommitFailed', {
      defaultValue: '发送前准备失败，请重试',
    }),
    variant: 'destructive',
  })
}

/**
 * 仅当 session 绑定了待交接 DraftMessage 时 commit。
 * 任意 ok:false → blocked，保留/恢复可重试 failed 气泡。
 */
export async function runDraftMessageSendPreflight(
  deps: DraftMessageSendPreflightDeps,
): Promise<DraftMessageSendPreflightOutcome> {
  const result = await commitDraftMessageConfigBeforeSend({
    sessionId: deps.sessionId,
    getSession: deps.getSession,
    updateSessionInCaches: deps.updateSessionInCaches,
    patchSessionAgent: deps.patchSessionAgent,
    expectedDraftMessageId: deps.expectedDraftMessageId,
  })
  if (result.ok) {
    return { blocked: false, result }
  }

  log.warn('DraftMessage 交接失败，阻止发送', {
    sessionId: deps.sessionId,
    expectedDraftMessageId: deps.expectedDraftMessageId,
    reason: result.reason,
  })
  markBoundSessionUserFailed(deps)
  toastForFailureReason(result.reason)
  return { blocked: true, result }
}
