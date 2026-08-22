import type { Model } from '@tabtin/chat-client'
import { isOpenAICodexModel } from '../../../shared/openai-codex-models'

const CHAT_MODEL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Provider 静态声明的 catalog 条目（id 形如 declared:provider:model），不能用于建会话/发消息。 */
export function isSendableChatModelId(modelId: string | null | undefined): boolean {
  const trimmed = (modelId || '').trim()
  if (!trimmed || trimmed.startsWith('declared:')) return false
  return CHAT_MODEL_UUID_RE.test(trimmed) || isOpenAICodexModel(trimmed)
}

/** ：渠道暂停路由后即便残留在本地列表，也不得再被选用/发送。 */
export function isRoutableChatModel(model: Model | null | undefined): boolean {
  if (!model) return false
  if (model.provider_routing_enabled === false) return false
  if (model.routing_enabled === false) return false
  return true
}

export function isSendableChatModel(model: Model | null | undefined): model is Model {
  return isSendableChatModelId(model?.id) && isRoutableChatModel(model)
}

export function filterSendableChatModels(models: Model[]): Model[] {
  return models.filter(isSendableChatModel)
}

export function findSendableChatModel(
  models: Model[],
  modelId: string | null | undefined,
): Model | null {
  if (!isSendableChatModelId(modelId)) return null
  return models.find(model => model.id === modelId) ?? null
}

export function pickDefaultSendableChatModel(
  models: Model[],
  options?: {
    /** 本机 sticky（含 Codex）；优先于 Agent 平台首选 */
    stickyModelId?: string | null
    preferredModelId?: string | null
    defaultModelName?: string | null
  },
): Model | null {
  const sendable = filterSendableChatModels(models)
  if (!sendable.length) return null

  const sticky = findSendableChatModel(sendable, options?.stickyModelId)
  if (sticky) return sticky

  const preferred = findSendableChatModel(sendable, options?.preferredModelId)
  if (preferred) return preferred

  const defaultName = (options?.defaultModelName || '').trim()
  if (defaultName) {
    const byName = sendable.find(model => model.name === defaultName)
    if (byName) return byName
  }

  return sendable.find(model => model.is_default) ?? sendable[0] ?? null
}
