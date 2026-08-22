import type { ChatSession } from '@tabtin/chat-client'
import { isOpenAICodexModel } from '../../../shared/openai-codex-models'

type ModelSelectionFields = Pick<ChatSession, 'current_model_id' | 'context_tier_id'>

/**
 * 本机 Codex 模型只存在于 renderer 缓存（Django 不认该 id）。
 * 服务端 session GET / list 刷新时不得把本地选择盖回平台模型。
 */
export function isLocalCodexModelSelection(
  modelId: string | null | undefined,
): boolean {
  return Boolean(modelId && isOpenAICodexModel(modelId))
}

/** 合并服务端会话时，若本地已选 Codex，保留本地 model / tier。 */
export function withPreservedLocalCodexModelSelection<T extends ModelSelectionFields>(
  local: T | null | undefined,
  incoming: T,
): T {
  if (!local || !isLocalCodexModelSelection(local.current_model_id)) return incoming
  return {
    ...incoming,
    current_model_id: local.current_model_id,
    context_tier_id: local.context_tier_id ?? null,
  }
}

/** 终态 patch 写回：剔除会覆盖本机 Codex 选择的字段。 */
export function omitServerModelFieldsWhenLocalCodex(
  local: ModelSelectionFields | null | undefined,
  patch: Partial<ChatSession>,
): Partial<ChatSession> {
  if (!local || !isLocalCodexModelSelection(local.current_model_id)) return patch
  const next: Partial<ChatSession> = { ...patch }
  delete next.current_model_id
  delete next.context_tier_id
  return next
}
