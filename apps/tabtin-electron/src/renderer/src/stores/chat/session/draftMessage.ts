import type { ModelParamOverrides, ModelParamValue } from '@tabtin/chat-client'
import type { AgentModeName } from '../shared/types'

export interface DraftMessageMetadata {
  organizationId?: string
  executionWorkspaceId?: string
  projectId?: string
  agentId?: string
}

/** Composer 中尚未发送的消息意图；不包含 ChatSession 生命周期状态。 */
export interface DraftMessage {
  draftMessageId: string
  draftScopeKey: string
  organizationId?: string
  executionWorkspaceId?: string
  projectId?: string
  mode?: AgentModeName
  agentId?: string
  modelId?: string
  contextTierId?: string
  modelParamOverrides?: ModelParamOverrides
  revision: number
}

export interface DraftMessageContext {
  draftScopeKey: string
  isUiDraft?: boolean
  metadata?: DraftMessageMetadata
}

const draftMessageById = new Map<string, DraftMessage>()
const activeDraftMessageByScopeKey = new Map<string, string>()
let revisionSeq = 0
let draftMessageSeq = 0

export function resetAllDraftMessages(): void {
  draftMessageById.clear()
  activeDraftMessageByScopeKey.clear()
  revisionSeq = 0
  draftMessageSeq = 0
}

export function isDraftMessageActive(draftMessageId: string | null | undefined): boolean {
  if (!draftMessageId) return false
  const draftMessage = draftMessageById.get(draftMessageId)
  return Boolean(draftMessage && activeDraftMessageByScopeKey.get(draftMessage.draftScopeKey) === draftMessageId)
}

export function getDraftMessageById(draftMessageId: string | null | undefined): DraftMessage | undefined {
  return draftMessageId ? draftMessageById.get(draftMessageId) : undefined
}

export function getDraftMessageByScopeKey(draftScopeKey: string | null | undefined): DraftMessage | undefined {
  if (!draftScopeKey) return undefined
  const draftMessageId = activeDraftMessageByScopeKey.get(draftScopeKey)
  return draftMessageId ? draftMessageById.get(draftMessageId) : undefined
}

export function destroyDraftMessage(draftMessageId: string): void {
  const draftMessage = draftMessageById.get(draftMessageId)
  if (!draftMessage) return
  draftMessageById.delete(draftMessageId)
  if (activeDraftMessageByScopeKey.get(draftMessage.draftScopeKey) === draftMessageId) {
    activeDraftMessageByScopeKey.delete(draftMessage.draftScopeKey)
  }
}

export function cancelDraftMessageByScopeKey(draftScopeKey: string | null | undefined): void {
  const draftMessage = getDraftMessageByScopeKey(draftScopeKey)
  if (draftMessage) destroyDraftMessage(draftMessage.draftMessageId)
}

export function beginDraftMessage(draftScopeKey: string, metadata?: DraftMessageMetadata): DraftMessage {
  cancelDraftMessageByScopeKey(draftScopeKey)
  const draftMessage: DraftMessage = {
    draftMessageId: `draft-message-${++draftMessageSeq}`,
    draftScopeKey,
    revision: ++revisionSeq,
    organizationId: metadata?.organizationId,
    executionWorkspaceId: metadata?.executionWorkspaceId,
    projectId: metadata?.projectId,
    agentId: metadata?.agentId,
  }
  draftMessageById.set(draftMessage.draftMessageId, draftMessage)
  activeDraftMessageByScopeKey.set(draftScopeKey, draftMessage.draftMessageId)
  return draftMessage
}

export function mutateActiveDraftMessage(
  draftScopeKey: string,
  mutator: (draftMessage: DraftMessage) => DraftMessage,
): DraftMessage | null {
  const draftMessage = getDraftMessageByScopeKey(draftScopeKey)
  if (!draftMessage) return null
  const next = mutator({ ...draftMessage })
  draftMessageById.set(draftMessage.draftMessageId, next)
  return next
}

function ensureDraftMessage(draftScopeKey: string, metadata?: DraftMessageMetadata): void {
  if (!getDraftMessageByScopeKey(draftScopeKey)) beginDraftMessage(draftScopeKey, metadata)
}

export function nextDraftMessageRevision(): number {
  return ++revisionSeq
}

export function recordDraftModeIntent(
  draftScopeKey: string,
  mode: AgentModeName,
  agentIdSnapshot?: string | null,
  metadata?: DraftMessageMetadata,
): DraftMessage | null {
  ensureDraftMessage(draftScopeKey, metadata)
  return mutateActiveDraftMessage(draftScopeKey, (prev) => ({
    ...prev,
    mode,
    agentId: prev.agentId ?? agentIdSnapshot ?? undefined,
    revision: nextDraftMessageRevision(),
    organizationId: prev.organizationId ?? metadata?.organizationId,
    executionWorkspaceId: prev.executionWorkspaceId ?? metadata?.executionWorkspaceId,
    projectId: prev.projectId ?? metadata?.projectId,
  }))
}

export function recordDraftAgentIntent(
  draftScopeKey: string,
  agentId: string,
  metadata?: DraftMessageMetadata,
): DraftMessage | null {
  ensureDraftMessage(draftScopeKey, metadata)
  return mutateActiveDraftMessage(draftScopeKey, (prev) => ({
    ...prev,
    agentId,
    revision: nextDraftMessageRevision(),
    organizationId: prev.organizationId ?? metadata?.organizationId,
    executionWorkspaceId: prev.executionWorkspaceId ?? metadata?.executionWorkspaceId,
    projectId: prev.projectId ?? metadata?.projectId,
  }))
}

export function recordDraftModelIntent(
  draftScopeKey: string,
  modelId: string,
  metadata?: DraftMessageMetadata,
  options?: { contextTierId?: string | null; controlChange?: { key: string; value: ModelParamValue } },
): DraftMessage | null {
  ensureDraftMessage(draftScopeKey, metadata)
  return mutateActiveDraftMessage(draftScopeKey, (prev) => {
    const nextOverrides = { ...(prev.modelParamOverrides ?? {}) }
    const controlKey = options?.controlChange?.key.trim()
    if (controlKey && options?.controlChange) {
      const value = options.controlChange.value
      if (value === null) delete nextOverrides[controlKey]
      else nextOverrides[controlKey] = value
    }
    const nextTier = options?.contextTierId
    return {
      ...prev,
      modelId,
      contextTierId: typeof nextTier === 'string' && nextTier.trim()
        ? nextTier
        : (nextTier === null ? undefined : prev.contextTierId),
      modelParamOverrides: Object.keys(nextOverrides).length > 0 ? nextOverrides : undefined,
      revision: nextDraftMessageRevision(),
      organizationId: prev.organizationId ?? metadata?.organizationId,
      executionWorkspaceId: prev.executionWorkspaceId ?? metadata?.executionWorkspaceId,
      projectId: prev.projectId ?? metadata?.projectId,
    }
  })
}

export function mutateDraftMessageMetadata(
  draftScopeKey: string,
  metadata: DraftMessageMetadata,
): DraftMessage | null {
  if (!getDraftMessageByScopeKey(draftScopeKey)) return null
  return mutateActiveDraftMessage(draftScopeKey, (prev) => ({
    ...prev,
    organizationId: metadata.organizationId ?? prev.organizationId,
    executionWorkspaceId: metadata.executionWorkspaceId ?? prev.executionWorkspaceId,
    projectId: metadata.projectId ?? prev.projectId,
    agentId: metadata.agentId ?? prev.agentId,
    revision: nextDraftMessageRevision(),
  }))
}

export function peekDraftModelIntent(scopeKey: string | null | undefined): string | null {
  const value = getDraftMessageByScopeKey(scopeKey)?.modelId
  return typeof value === 'string' && value.trim() ? value : null
}

export function peekDraftContextTierIntent(scopeKey: string | null | undefined): string | null {
  const value = getDraftMessageByScopeKey(scopeKey)?.contextTierId
  return typeof value === 'string' && value.trim() ? value : null
}

export function peekDraftModelParamOverrides(scopeKey: string | null | undefined): ModelParamOverrides | null {
  const value = getDraftMessageByScopeKey(scopeKey)?.modelParamOverrides
  return value && Object.keys(value).length > 0 ? { ...value } : null
}

export function peekDraftAgentIntent(scopeKey: string | null | undefined): string | null {
  const value = getDraftMessageByScopeKey(scopeKey)?.agentId
  return typeof value === 'string' && value.trim() ? value : null
}
