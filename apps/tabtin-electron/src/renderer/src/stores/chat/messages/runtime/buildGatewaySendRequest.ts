/**
 * 远控 gateway 出站物料：UI 薄 payload，拼装由执行端 Host 完成。
 */

import { awaitInFlightContextSync } from '../../execution/contextSyncInFlight'
import { getLastAppContext } from '../../session/slices/contextSyncSlice'
import { buildRemoteAppContext } from './buildRemoteAppContext'
import type { AgentModeName, ApprovalModeName } from '../../shared/types'
import type { SessionExecutionTarget } from '@/services/remoteExecutionGuard'

type ReplyToContext = {
  messageId: string
  preview: { role: 'user' | 'assistant' | 'system' | 'tool'; author?: string; text: string }
}

type UploadedAttachmentLike = {
  status?: string
  type?: string
  fileId?: string
  filename?: string
  mimeType?: string
  size?: number
  remoteUrl?: string
  previewUrl?: string
}

export type BuildGatewaySendRequestParams = {
  sessionId: string
  message: string
  displayMessage: string
  contextBlocks?: Array<Record<string, unknown>>
  uploadedAttachments?: UploadedAttachmentLike[]
  replyTo?: ReplyToContext
  clientMessageId: string
  modelId: string
  currentAgentMode: AgentModeName
  currentApprovalMode: ApprovalModeName
  capturedOrganizationId?: string
  capturedRuntimeSpaceId?: string
  executionTarget?: SessionExecutionTarget | null
  capturedTabScopeKey?: string | null
  effectiveSkillSlashInvoke?: { skillKey: string; args?: string }
  source?: string
  triggeredBy?: 'user' | 'push-notification' | 'continuation'
}

export async function buildGatewaySendRequest(params: BuildGatewaySendRequestParams) {
  const {
    sessionId,
    message,
    displayMessage,
    contextBlocks,
    uploadedAttachments,
    replyTo,
    clientMessageId,
    modelId,
    currentAgentMode,
    currentApprovalMode,
    capturedOrganizationId,
    capturedRuntimeSpaceId,
    executionTarget,
    capturedTabScopeKey,
    effectiveSkillSlashInvoke,
    source,
    triggeredBy,
  } = params

  const readyAttachments = uploadedAttachments
    ?.filter(a => a.status === 'ready')
    .map(a => ({
      type: a.type ?? 'file',
      file_id: a.fileId,
      filename: a.filename,
      mime_type: a.mimeType,
      size: a.size,
      url: a.remoteUrl,
      preview_url: a.previewUrl,
    }))
  const userVisibleText = displayMessage.trim()
  const remoteBlocks = contextBlocks && contextBlocks.length > 0
    ? [
        ...(userVisibleText ? [{ type: 'text', text: userVisibleText }] : []),
        ...contextBlocks,
      ]
    : undefined

  await awaitInFlightContextSync(sessionId)
  const cachedAppContext = getLastAppContext(sessionId)
  const appContext = buildRemoteAppContext(cachedAppContext, {
    organizationId: capturedOrganizationId,
    spaceId: capturedRuntimeSpaceId,
    tabScopeKey: capturedTabScopeKey,
    displayMessage: userVisibleText,
    replyTo,
  })

  return {
    payload: {
      session_id: sessionId,
      message,
      client_event_id: clientMessageId,
      model_id: modelId,
      ...(executionTarget ? { execution_target: executionTarget } : {}),
      ...(remoteBlocks ? { blocks: remoteBlocks } : {}),
      ...(readyAttachments && readyAttachments.length > 0 ? { attachments: readyAttachments } : {}),
      ...(currentAgentMode !== 'agent' ? { agent_mode: currentAgentMode } : {}),
      ...(currentApprovalMode !== 'always_ask' ? { approval_mode: currentApprovalMode } : {}),
      ...(effectiveSkillSlashInvoke?.skillKey
        ? {
            skill_slash_invoke: {
              skill_key: effectiveSkillSlashInvoke.skillKey,
              ...(effectiveSkillSlashInvoke.args
                ? { args: effectiveSkillSlashInvoke.args }
                : {}),
            },
          }
        : {}),
      app_context: appContext,
      metadata: {
        client_platform: 'electron',
        input_method: source ?? 'composer',
        ...(triggeredBy ? { triggered_by: triggeredBy } : {}),
      },
    },
    requestOptions: {
      threadId: `chat-session-${sessionId}`,
      sessionId,
      organizationId: capturedOrganizationId,
    },
  }
}

export { buildRemoteAppContext } from './buildRemoteAppContext'
