import i18n from '@/i18n'
import { getSessionController, hasRuntimeBridge } from '@/services/agentService'
import type { ChatMessage } from '@tabtin/chat-client'
import type { AskUserRequestState } from '../../shared/types'
import type { SendMessageSetPartial } from '../actions/sendMessageTypes'
import {
  buildSoftAskUserStoreClearPatch,
  type SoftAskUserSubmitPlan,
} from '../product/hitl/hitlOnSubmit'

/**
 * 技术域：执行产品域 soft AskUser 跳过计划（store 写入 + IPC + system 消息）。
 */
export function applySoftAskUserSubmitPlan(
  sessionId: string,
  plan: SoftAskUserSubmitPlan,
  deps: {
    getPendingAskUserBySessionId: () => Record<string, AskUserRequestState>
    getAskUserSubmittingBySessionId: () => Record<string, boolean>
    set: (partial: SendMessageSetPartial) => void
    updateSessionMessages: (
      sessionId: string,
      updater: (messages: ChatMessage[]) => ChatMessage[],
    ) => void
    log: { warn: (...args: unknown[]) => void }
  },
): void {
  if (plan.clearPendingAskUser || plan.clearAskUserSubmitting) {
    deps.set(buildSoftAskUserStoreClearPatch(
      sessionId,
      deps.getPendingAskUserBySessionId(),
      deps.getAskUserSubmittingBySessionId(),
    ))
  }

  // ipcSkip 由产品域在 evaluate 时（bridge 可用才）产出；此处执行时刻再复检一次
  // hasRuntimeBridge()，覆盖 evaluate 与 apply 之间 bridge 掉线的窗口。两处 gate 都需保留。
  if (plan.ipcSkip && hasRuntimeBridge()) {
    const { interruptId, threadId } = plan.ipcSkip
    getSessionController(sessionId).answerAskUser(interruptId, { skipped: true }, threadId)
      .catch((firstErr: unknown) => {
        deps.log.warn('soft-blocking skip via IPC failed, retrying in 2s:', firstErr)
        setTimeout(() => {
          getSessionController(sessionId).answerAskUser(interruptId, { skipped: true }, threadId)
            .catch((retryErr: unknown) => {
              deps.log.warn('soft-blocking skip IPC retry also failed:', retryErr)
            })
        }, 2000)
      })
  }

  if (plan.appendAutoSkippedSystemMessage) {
    deps.updateSessionMessages(sessionId, (prev) => [
      ...prev,
      {
        id: `ask-user-auto-skipped-${Date.now()}`,
        role: 'system',
        content: i18n.t('chat:askUser.autoSkipped', {
          defaultValue: 'Agent 的问题已自动跳过，将根据你的新消息继续执行',
        }),
        created_at: new Date().toISOString(),
        metadata: { system_fact: 'ask_user_auto_skipped' },
      },
    ])
  }
}
