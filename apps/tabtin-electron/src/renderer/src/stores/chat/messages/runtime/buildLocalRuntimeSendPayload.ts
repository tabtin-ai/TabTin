import type { MessageBlock } from '@tabtin/chat-client'
import type { ChatAttachment } from '../../../../components/chat/types'
import type { AgentModeName, ApprovalModeName } from '../../shared/types'
import type { LocalAgentStreamOptions } from '@/services/localAgentClient'
import type { SessionStreamDeps } from '@/services/agentService'
import { getCapabilityOverride } from '@tabtin/app-shell'
import type { AgentConfig as AgentConfigV2 } from '@tabtin/app-shell'
import { useMemoRecordStyleStore } from '@stores/useMemoRecordStyleStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { getLastAppContext } from '../../session/slices/contextSyncSlice'
import { buildUserVisibleBlocks } from '../actions/buildUserVisibleBlocks'
import type { EnabledAppInfoForSend } from '../../execution/captureEnabledAppsForSend'
import type { SessionExecutionTarget } from '@/services/remoteExecutionGuard'

type AgentLike = {
  id: string
  agent_config?: unknown
  working_dir_type?: string | null
}

type SpaceLike = {
  id: string
  working_dir?: string | null
}

type ModelLike = {
  id: string
  context_window_tokens?: number
  max_output_tokens?: number
  supports_vision?: boolean
  supports_video_input?: boolean
  supports_document_input?: boolean
  supports_function_calling?: boolean
  resolved_capabilities?: {
    supports_vision?: boolean
    supports_video_input?: boolean
    supports_document_input?: boolean
    supports_function_calling?: boolean
  }
  capabilities_config?: {
    supports_vision?: boolean
    supports_video_input?: boolean
    supports_document_input?: boolean
    supports_function_calling?: boolean
  } & LocalAgentStreamOptions['modelCapabilitiesConfig']
  provider?: string
  provider_scope?: string | null
}

type ReplyTo = {
  messageId: string
  preview: {
    role: 'user' | 'assistant' | 'system' | 'tool'
    author?: string
    text: string
  }
}

export type BuildLocalRuntimeSendPayloadInput = {
  sessionId: string
  message: string
  displayMessage: string
  optionsDisplayMessage?: string
  triggeredBy?: 'user' | 'push-notification' | 'continuation'
  modelId: string
  currentModel: ModelLike | null | undefined
  currentAgent: AgentLike | null
  currentAgentMode: AgentModeName
  currentApprovalMode: ApprovalModeName
  isGroupSpace: boolean
  clientMessageId: string
  replyTo?: ReplyTo
  contextBlocks?: Array<Record<string, unknown>>
  uploadedAttachments?: ChatAttachment[]
  effectiveSkillSlashInvoke?: { skillKey: string; args?: string }
  capturedSpaceId?: string
  capturedSpaceName?: string
  capturedSessionTitle?: string
  capturedRuntimeSpaceId?: string
  executionTarget?: SessionExecutionTarget | null
  capturedTabScopeKey?: string | null
  capturedWorkspaceMode?: 'conversation' | 'desktop' | 'non-space' | null
  capturedOrganizationId?: string
  capturedOrganizationName?: string
  capturedEnabledApps: EnabledAppInfoForSend[]
  spaces: SpaceLike[]
  streamDeps: Pick<
    SessionStreamDeps,
    | 'client'
    | 'addStreamingSession'
    | 'removeStreamingSession'
    | 'updateSessionTokenUsageInCaches'
    | 'updateSessionInCaches'
  >
}

export type LocalRuntimeSendMaterial = {
  message: string
  deps: SessionStreamDeps
  options: LocalAgentStreamOptions
}

/** 拼装本机 runtime `controller.send` 的惰性物料（不含 dispatch 本身）。 */
export function buildLocalRuntimeSendPayload(
  input: BuildLocalRuntimeSendPayloadInput,
): LocalRuntimeSendMaterial {
  const agentCfgV2 = input.currentAgent?.agent_config as AgentConfigV2 | undefined
  const opSwitchesRaw = getCapabilityOverride<Record<string, 'allow' | 'confirm' | 'block'>>(
    agentCfgV2, 'shell', 'operation_switches',
  )
  const opSwitches = opSwitchesRaw && Object.keys(opSwitchesRaw).length > 0
    ? opSwitchesRaw
    : undefined
  const runtimeSpace = input.spaces.find((s) => s.id === input.capturedRuntimeSpaceId)
  const memoryEnabled = useMemoRecordStyleStore.getState().isEnabled(input.capturedOrganizationId)
  const rawWorkingDirType = input.currentAgent?.working_dir_type
  const workingDirType =
    rawWorkingDirType === 'code' || rawWorkingDirType === 'doc' || rawWorkingDirType === 'mixed'
      ? rawWorkingDirType
      : undefined
  const workingDir = runtimeSpace?.working_dir?.trim() || undefined
  const userVisibleText = (input.optionsDisplayMessage ?? input.displayMessage).trim()
  const persistedUserMessageBlocks = input.contextBlocks && input.contextBlocks.length > 0
    ? buildUserVisibleBlocks(userVisibleText, input.contextBlocks as MessageBlock[])
    : undefined

  const cached = getLastAppContext(input.sessionId)
  const appContext = (cached || input.capturedRuntimeSpaceId || input.capturedTabScopeKey)
    ? {
        ...(cached ?? {}),
        ...(input.capturedRuntimeSpaceId ? { spaceId: input.capturedRuntimeSpaceId } : {}),
        ...(input.capturedSpaceId && input.capturedSpaceId !== input.capturedRuntimeSpaceId
          ? { projectSpaceId: input.capturedSpaceId }
          : {}),
        ...(input.capturedTabScopeKey
          ? {
              workspaceMode: input.capturedWorkspaceMode,
              tabScopeKey: input.capturedTabScopeKey,
              workspaceScopeKey: input.capturedTabScopeKey,
            }
          : {}),
      }
    : undefined

  const currentModel = input.currentModel
  return {
    message: input.message,
    deps: {
      getContext: () => ({
        spaceId: input.capturedSpaceId,
        spaceName: input.capturedSpaceName,
        sessionTitle: input.capturedSessionTitle,
      }),
      client: input.streamDeps.client,
      addStreamingSession: input.streamDeps.addStreamingSession,
      removeStreamingSession: input.streamDeps.removeStreamingSession,
      updateSessionTokenUsageInCaches: input.streamDeps.updateSessionTokenUsageInCaches,
      updateSessionInCaches: input.streamDeps.updateSessionInCaches,
      // Checkpoint 由 lifecycleHandler 消费 checkpointPendingContext；no-op 防重复 commit。
      onLifecycleEnd: () => {},
    },
    options: {
      modelId: input.modelId,
      agentId: input.currentAgent?.id,
      workspaceId: input.capturedRuntimeSpaceId,
      executionTarget: input.executionTarget ?? undefined,
      yoloMode: useOrganizationStore.getState().selectedOrganization?.settings?.allow_member_yolo === true,
      agentMode: input.currentAgentMode,
      approvalMode: input.currentApprovalMode,
      attachments: input.uploadedAttachments?.filter(a => a.status === 'ready').map(a => ({
        type: a.type ?? 'file',
        file_id: a.fileId,
        filename: a.filename,
        mime_type: a.mimeType,
        size: a.size,
        url: a.remoteUrl,
        preview_url: a.previewUrl,
      })),
      appContext,
      clientMessageId: input.clientMessageId,
      displayMessage: input.displayMessage,
      triggeredBy: input.triggeredBy,
      ...(input.effectiveSkillSlashInvoke?.skillKey
        ? { skillSlashInvoke: input.effectiveSkillSlashInvoke }
        : {}),
      ...(input.replyTo
        ? { replyTo: { messageId: input.replyTo.messageId, preview: input.replyTo.preview } }
        : {}),
      contextBlocks: input.contextBlocks && input.contextBlocks.length > 0
        ? input.contextBlocks
        : undefined,
      userMessageBlocks: persistedUserMessageBlocks,
      operationSwitches: opSwitches,
      memoryCapability: memoryEnabled || undefined,
      workingDirType,
      workingDir,
      modelContextWindow: currentModel?.context_window_tokens,
      modelMaxOutput: currentModel?.max_output_tokens,
      modelSupportsVision: currentModel?.supports_vision
        ?? currentModel?.resolved_capabilities?.supports_vision
        ?? currentModel?.capabilities_config?.supports_vision,
      modelSupportsVideoInput: currentModel?.supports_video_input
        ?? currentModel?.resolved_capabilities?.supports_video_input
        ?? currentModel?.capabilities_config?.supports_video_input,
      modelSupportsDocumentInput: currentModel?.supports_document_input
        ?? currentModel?.resolved_capabilities?.supports_document_input
        ?? currentModel?.capabilities_config?.supports_document_input,
      modelSupportsFunctionCalling: currentModel?.supports_function_calling
        ?? currentModel?.resolved_capabilities?.supports_function_calling
        ?? currentModel?.capabilities_config?.supports_function_calling,
      modelCapabilitiesConfig: currentModel?.capabilities_config,
      modelProvider: currentModel?.provider,
      isByokMode: (() => {
        const scope = currentModel?.provider_scope
        return scope != null && scope !== 'global'
      })(),
      spaceName: input.capturedSpaceName,
      organizationName: input.capturedOrganizationName,
      spaceId: input.capturedRuntimeSpaceId,
      organizationId: input.capturedOrganizationId,
      enabledApps: input.capturedEnabledApps.length > 0 ? input.capturedEnabledApps : undefined,
      isGroupSpace: input.isGroupSpace,
    },
  }
}
