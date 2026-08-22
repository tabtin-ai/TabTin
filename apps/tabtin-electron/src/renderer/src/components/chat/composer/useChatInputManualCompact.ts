import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { Model, ContextTier } from '@tabtin/chat-client'
import { selectRecentHistoryForRuntime, type HistorySourceMessage } from '@tabtin/agent-runtime/history'
import { useSpaceStore } from '@stores/useSpaceStore'
import type { AgentModeName } from '../../../stores/chat/shared/types'
import { useChatStore } from '@/stores/chat/useChatStore'
import { getChatClient } from '@/services/chatApi'
import { getLocalAgentClient } from '@/services/localAgentClient'
import type { ContextRef, ChatAttachment } from '../types'
import type { PresetInstance } from '../composer-presets/registry/types'
import {
  MANUAL_COMPACT_KEEP_LAST_MESSAGES,
  MANUAL_COMPACT_MAX_HISTORY_MESSAGES,
} from './chatInputConstants'
import { resolveManualCompactContext } from './chatInputManualCompactContext'
import { appendLocalSystemMessage, removeLocalSystemMessage } from './chatInputCompactMessages'

export interface UseChatInputManualCompactInput {
  sessionId: string | null
  spaceId: string | null
  attachments: ChatAttachment[]
  allContextRefs: ContextRef[]
  hasActivePresets: boolean
  activePresets: PresetInstance[]
  isManualCompacting: boolean
  setIsManualCompacting: (value: boolean) => void
  currentModel: Model | null | undefined
  currentContextTier: ContextTier | null | undefined
  agentMode: AgentModeName
  clearInputState: () => void
}

export function useChatInputManualCompact({
  sessionId,
  spaceId,
  attachments,
  allContextRefs,
  hasActivePresets,
  isManualCompacting,
  setIsManualCompacting,
  currentModel,
  currentContextTier,
  agentMode,
  clearInputState,
}: UseChatInputManualCompactInput) {
  const { t } = useTranslation('chat')

  const rejectCompact = useCallback((message: string) => {
    if (!sessionId) return
    appendLocalSystemMessage(sessionId, message)
    clearInputState()
  }, [clearInputState, sessionId])

  const handleManualCompact = useCallback(async (focus: string) => {
    if (!sessionId) return
    if (attachments.length > 0 || allContextRefs.length > 0 || hasActivePresets) {
      rejectCompact('/compact 只压缩当前会话历史，请先移除附件和上下文引用')
      return
    }
    if (isManualCompacting) return

    const snapshotMessages = useChatStore.getState().messagesBySessionId[sessionId] ?? []
    const compactableMessages = snapshotMessages.filter(message => (
      (message.role === 'user' || message.role === 'assistant')
      && message.message_kind !== 'compaction_summary'
    ))
    if (compactableMessages.length <= MANUAL_COMPACT_KEEP_LAST_MESSAGES + 1) {
      rejectCompact('当前会话历史还不需要压缩')
      return
    }

    const boundary = compactableMessages[
      Math.max(0, compactableMessages.length - MANUAL_COMPACT_KEEP_LAST_MESSAGES - 1)
    ]
    if (!boundary) {
      rejectCompact('无法确定压缩边界')
      return
    }

    const historySource = snapshotMessages.map(message => ({
      id: message.id,
      role: message.role,
      content: message.content,
      message_kind: message.message_kind,
      metadata: message.metadata as HistorySourceMessage['metadata'],
      blocks_json: message.content_blocks_json as unknown as HistorySourceMessage['blocks_json'],
    }))
    const history = selectRecentHistoryForRuntime(historySource, {
      maxMessages: MANUAL_COMPACT_MAX_HISTORY_MESSAGES,
      excludeCurrentTurn: false,
      sessionId,
    })
    if (history.length === 0) {
      rejectCompact('没有可压缩的历史上下文')
      return
    }

    const spaceState = useSpaceStore.getState()
    const session = useChatStore.getState().getSessionById(sessionId)
    const compactContext = resolveManualCompactContext(
      session,
      spaceId,
      spaceState.selectedSpace,
      spaceState.spaces,
    )
    if (!compactContext) {
      rejectCompact('当前会话与所选 Space 不属于同一组织，无法压缩上下文')
      return
    }
    const modelId = currentModel?.id
    if (!modelId) {
      rejectCompact('请先选择模型后再压缩上下文')
      return
    }
    const workspaceId = session?.workspace_id
    if (!workspaceId) {
      rejectCompact('当前会话未绑定执行工作空间，无法压缩上下文')
      return
    }
    const sessionAgentId = session?.agent_id
    if (!sessionAgentId) {
      rejectCompact('当前会话未绑定 Agent，无法压缩上下文')
      return
    }

    setIsManualCompacting(true)
    let progressMessageId: string | null = appendLocalSystemMessage(
      sessionId,
      t('agentSteps.compactionInProgress'),
      { status: 'running' },
    )
    clearInputState()
    try {
      const compactResult = await getLocalAgentClient().compactSession(
        sessionId,
        history,
        focus || undefined,
        MANUAL_COMPACT_KEEP_LAST_MESSAGES,
        {
          modelId,
          agentId: sessionAgentId,
          workspaceId,
          agentMode,
          spaceId: compactContext.spaceId,
          organizationId: compactContext.organizationId,
          modelContextWindow: currentContextTier?.max_input_tokens ?? currentModel.context_window_tokens ?? currentModel.max_tokens,
          modelMaxOutput: currentModel.max_output_tokens,
          modelSupportsVision: currentModel.supports_vision,
          modelSupportsFunctionCalling: currentModel.supports_function_calling,
          modelCapabilitiesConfig: currentModel.capabilities_config,
          modelProvider: currentModel.provider,
          isByokMode: currentModel.provider_scope === 'organization' || currentModel.provider_scope === 'user',
        },
      )
      if (!compactResult.success || !compactResult.summary) {
        if (progressMessageId) removeLocalSystemMessage(sessionId, progressMessageId)
        progressMessageId = null
        appendLocalSystemMessage(sessionId, compactResult.error || '上下文压缩失败')
        return
      }

      // ：本地 compact 成功即算成功（runtime 真相源）。云端 checkpoint
      // 与自动压缩对齐——失败只提示，不把整次 /compact 打成失败。
      if (progressMessageId) {
        removeLocalSystemMessage(sessionId, progressMessageId)
        progressMessageId = null
      }
      appendLocalSystemMessage(sessionId, '上下文已压缩')

      try {
        const clientEventId = crypto.randomUUID()
        const checkpoint = await getChatClient().messages.createCompactionCheckpoint(sessionId, {
          summary: compactResult.summary,
          compacted_up_to_message_id: boundary.id,
          source: 'manual',
          focus: focus || null,
          stats: compactResult.stats ?? null,
          client_event_id: clientEventId,
        })
        const store = useChatStore.getState()
        const current = store.messagesBySessionId[sessionId] ?? []
        if (!current.some(message => message.id === checkpoint.message.id)) {
          store.upsertMessage(sessionId, checkpoint.message)
        }
      } catch (checkpointError) {
        const message = checkpointError instanceof Error
          ? checkpointError.message
          : String(checkpointError)
        console.warn('[Chat] failed to persist manual compaction checkpoint:', checkpointError)
        appendLocalSystemMessage(
          sessionId,
          `本地已压缩，云端检查点未写入：${message}`,
        )
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (progressMessageId) removeLocalSystemMessage(sessionId, progressMessageId)
      appendLocalSystemMessage(sessionId, `上下文压缩失败：${message}`)
    } finally {
      setIsManualCompacting(false)
    }
  }, [
    agentMode,
    allContextRefs.length,
    attachments.length,
    clearInputState,
    currentContextTier?.max_input_tokens,
    currentModel,
    hasActivePresets,
    isManualCompacting,
    rejectCompact,
    sessionId,
    setIsManualCompacting,
    spaceId,
    t,
  ])

  return { handleManualCompact }
}
