import { useChatModelStore } from '@/stores/useChatModelStore'
import { useChatStore } from '@/stores/chat/useChatStore'
import type { ChatSession } from '@tabtin/chat-client'

/** 对话结算完成后，仅为实际使用专项点券的模型静默刷新余额。 */
export function refreshPromotionCreditAfterDone(sessionId: string): void {
  const session = useChatStore.getState().getSessionById(sessionId)
  const modelId = session?.current_model_id
    || (session as ChatSession & { current_model?: string } | undefined)?.current_model
  if (!modelId) return

  const modelState = useChatModelStore.getState()
  const organizationId = session?.organization_id
  if (!organizationId || modelState.loadedOrganizationId !== organizationId) return

  const settledModel = modelState.availableModels.find(model => model.id === modelId)
  if (!settledModel?.promotion_credit) return

  void modelState.refreshPromotionCredits(organizationId)
}
