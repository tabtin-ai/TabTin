/**
 * sendMessage 编排：门禁 → 持稿 → 准备 → SessionController.send → 投影。
 * 不分支本机/远控；#9345 ACK 前不上主时间线。
 */

import type { ChatAttachment } from '../../../../components/chat/types'
import { getSessionController } from '@/services/agentService'
import { getRemoteExecutionAccess } from '@/services/remoteExecutionGuard'
import { markSessionSuspended } from '@/services/sessionSuspended'
import { useChatModelStore } from '../../../useChatModelStore'
import { useChatRuntimeStore } from '../../../useChatRuntimeStore'
import { isSendableChatModel } from '@/utils/chatModelGuards'
import { createLogger } from '@/utils/logger'
import { captureEnabledAppsForSend } from '../../execution/captureEnabledAppsForSend'
import { kickoffCheckpointBaselineOnSend } from '../../checkpoint/utils/kickoffCheckpointBaselineOnSend'
import { trackSendTimingTelemetry } from '../../execution/sendTimingTrace'
import { resolveSendExecutionContext } from '../../execution/resolveSendExecutionContext'
import { resolveSendAgentPolicy } from '../../session/resolveSendAgentPolicy'
import { bumpSessionSidebarOnSend as bumpSidebar } from '../../session/bumpSessionSidebarOnSend'
import { completeDraftMessageSend } from '../../session/draftMessageSessionCoordinator'
import {
  beginProvisionalSessionClaim,
  completeProvisionalSessionClaim,
} from '../../session/provisionalSessionHost'
import { resolveSessionForSend } from './sendDispatchInputs'
import type { SendMessageDeps, SendMessageOptions } from './sendMessageTypes'
import { runSendSubmissionGates } from '../product/delivery/runSendSubmissionGates'
import { applyBlockedSubmissionFeedback } from '../runtime/applyBlockedSubmissionFeedback'
import { createPendingUserSend } from '../runtime/optimisticUserSend'
import { prepareOutboundSendMaterial } from '../runtime/prepareOutboundSendMaterial'
import { buildLocalRuntimeSendPayload } from '../runtime/buildLocalRuntimeSendPayload'
import { buildGatewaySendRequest } from '../runtime/buildGatewaySendRequest'
import {
  projectSendFailure,
  projectSendOutcome,
  type SendSubmissionResult,
} from '../runtime/projectSendOutcome'

export type {
  SendMessageDeps,
  SendMessageOptions,
  SendMessageSetPartial,
  SendMessageSource,
  SendMessageStore,
} from './sendMessageTypes'
export { markPersistedUserMessage } from './messageStatusUpdates'
export { resolveSessionForSend } from './sendDispatchInputs'
export { classifyRunTermination } from './runTermination'
export type { SendSubmissionResult } from '../runtime/projectSendOutcome'

const log = createLogger('SendMessage')

export function createSendMessageAction(deps: SendMessageDeps) {
  const {
    get,
    set,
    getChatClient,
    updateSessionMessages,
    addStreamingSession,
    removeStreamingSession,
    updateSessionInCaches,
    updateSessionTokenUsageInCaches,
    resolveSpacePath,
  } = deps

  const rejected = (reason: string): SendSubmissionResult => ({
    accepted: false,
    persisted: false,
    reason,
  })

  return async (
    message: string,
    streaming = true,
    attachments?: ChatAttachment[],
    contextBlocks?: Array<Record<string, unknown>>,
    targetSessionId?: string,
    options?: SendMessageOptions,
  ): Promise<SendSubmissionResult> => {
    const visibleMessage = options?.displayMessage ?? message
    const sendTimingTrace = options?.sendTimingTrace
    const gateDeps = { get, set, getChatClient, updateSessionMessages, updateSessionInCaches }

    try {
      const pre = await runSendSubmissionGates({
      sessionId: targetSessionId ?? get().currentSessionId,
      visibleMessage,
      attachments,
      contextBlocks,
      options,
      sendRoute: 'unavailable',
      phase: 'pre_execution',
      sendTimingTrace,
      deps: gateDeps,
      log,
    })
      if (!pre.ok) return rejected('submission_gate_rejected')
      const { sessionId } = pre

      const execution = await resolveSendExecutionContext({
      sessionId,
      store: get(),
      explicitSpaceId: options?.spaceId ?? null,
      tabScopeKey: options?.tabScopeKey ?? null,
      log,
    })
      if (!execution.ok) return rejected(execution.reason)
      const { context } = execution

      const post = await runSendSubmissionGates({
      sessionId,
      visibleMessage,
      attachments,
      contextBlocks,
      options,
      sendRoute: context.sendRoute,
      phase: 'post_execution',
      sendTimingTrace,
      deps: gateDeps,
      log,
    })
      if (!post.ok) return rejected('submission_gate_rejected')

      const currentModel = useChatModelStore.getState().getCurrentModel()
      if (!currentModel || !isSendableChatModel(currentModel)) return rejected('model_unavailable')
      if (!streaming) {
        log.error('non-streaming sendMessage is no longer supported', { sessionId })
        return rejected('non_streaming_unsupported')
      }

      get().setSendInFlight(sessionId, true)

      const pending = createPendingUserSend({
      sessionId,
      message,
      visibleMessage,
      attachments,
      contextBlocks,
      options,
      existingMessages: get().messagesBySessionId[sessionId] ?? [],
      sendTimingTrace,
      updateSessionMessages,
      getMessages: () => get().messagesBySessionId[sessionId] ?? [],
      getChatClient,
      getSession: () => resolveSessionForSend(get(), sessionId) ?? null,
    })

      trackSendTimingTelemetry('message.send.start', {
      sessionId,
      streaming,
      hasAttachments: Boolean(attachments && attachments.length > 0),
      hasContextBlocks: Boolean(contextBlocks && contextBlocks.length > 0),
    }, sendTimingTrace, {
      counterKey: 'message.send.start',
      sessionId,
    })
    trackSendTimingTelemetry('message.send.preamble_done', {
      sessionId,
    }, sendTimingTrace, {
      counterKey: 'message.send.preamble_done',
      sessionId,
    })

      const policy = resolveSendAgentPolicy(sessionId, get())
      pending.patchAgentMode(policy.currentAgentMode)

      const bumpSessionSidebarOnSend = () => {
      bumpSidebar({
        sessionId,
        displayMessage: pending.displayMessage,
        sessions: get().sessions,
        updateSessionInCaches: (id, patch) => {
          updateSessionInCaches(id, patch as Parameters<typeof updateSessionInCaches>[1])
        },
      })
    }

      const prepared = await prepareOutboundSendMaterial({
      sessionId,
      message,
      visibleMessage,
      attachments,
      contextBlocks,
      options,
      pending,
      log,
      setSendInFlight: (sid, inFlight) => get().setSendInFlight(sid, inFlight),
    })
      if (!prepared.ok) return rejected('outbound_material_rejected')

      const {
      currentAgent,
      capturedSpaceId,
      capturedRuntimeSpaceId,
      capturedTabScopeKey,
      capturedSpaceName,
      capturedWorkspaceMode,
      capturedOrganizationId,
      capturedOrganizationName,
      capturedSessionTitle,
      spaceStoreState,
    } = context
      const { currentAgentMode, currentApprovalMode, resolutionContext } = policy
      const displayMessage = options?.displayMessage ?? pending.displayMessage
      const { controlDeviceId } = getRemoteExecutionAccess(capturedRuntimeSpaceId)
      const executionTarget = context.persistedSession?.execution_target
      const ttft0 = performance.now()

      const projection = {
      sessionId,
      capturedRuntimeSpaceId,
      currentAgentMode,
      pending,
      visibleMessage,
      uploadedAttachments: prepared.uploadedAttachments,
      contextBlocks: prepared.contextBlocks,
      sendTimingTrace,
      get,
      bumpSessionSidebarOnSend,
      addStreamingSession,
      removeStreamingSession,
      updateSessionMessages,
      log,
    }

      const claimStarted = await beginProvisionalSessionClaim(sessionId)
      if (!claimStarted) {
        completeDraftMessageSend(sessionId, false)
        return projectSendFailure(projection, new Error('预建会话正在被删除'))
      }
      try {
        const outcome = await getSessionController(sessionId).send({
        spaceId: capturedRuntimeSpaceId,
        executionTarget,
        targetDeviceId: context.persistedSession?.target_device_id,
        agentConfig: currentAgent?.agent_config as { use_local_runtime?: boolean } | undefined,
        runtimeExecution: () => {
          kickoffCheckpointBaselineOnSend({
            sessionId,
            spaceId: capturedRuntimeSpaceId,
            userLocalMessageId: pending.userMessageId,
            userClientMessageId: pending.clientMessageId,
            //  / ：按会话绑定根解析，禁止无参回落全局 active Space
            resolveSpacePath: (sid) => resolveSpacePath(sid ?? sessionId),
            setCheckpointPendingContext: (sid, ctx) => get().setCheckpointPendingContext(sid, ctx),
            log,
          })
          markSessionSuspended(sessionId, false)
          log.info(`[TTFT] stream 调用开始 ${Math.round(performance.now() - ttft0)}ms`)
          trackSendTimingTelemetry('message.send.runtime_dispatch', {
            sessionId,
            mode: 'local_ipc',
          }, sendTimingTrace, {
            counterKey: 'message.send.runtime_dispatch',
            sessionId,
          })
          return buildLocalRuntimeSendPayload({
            sessionId,
            message,
            displayMessage: pending.displayMessage,
            optionsDisplayMessage: options?.displayMessage,
            triggeredBy: options?.triggeredBy,
            modelId: currentModel.id,
            currentModel,
            currentAgent,
            currentAgentMode,
            currentApprovalMode,
            isGroupSpace: resolutionContext.isGroupSpace,
            clientMessageId: pending.clientMessageId,
            replyTo: pending.replyTo,
            contextBlocks: prepared.contextBlocks,
            uploadedAttachments: prepared.uploadedAttachments,
            effectiveSkillSlashInvoke: prepared.effectiveSkillSlashInvoke,
            capturedSpaceId,
            capturedSpaceName,
            capturedSessionTitle,
            capturedRuntimeSpaceId,
            executionTarget,
            capturedTabScopeKey,
            capturedWorkspaceMode,
            capturedOrganizationId,
            capturedOrganizationName,
            capturedEnabledApps: captureEnabledAppsForSend(capturedRuntimeSpaceId, log),
            spaces: spaceStoreState.spaces as Array<{ id: string; working_dir?: string | null }>,
            streamDeps: {
              client: getChatClient(),
              addStreamingSession,
              removeStreamingSession,
              updateSessionTokenUsageInCaches,
              updateSessionInCaches,
            },
          })
        },
        gatewayRequest: async () => {
          useChatRuntimeStore.getState().clearRichContentBlocks(sessionId)
          addStreamingSession(sessionId)
          markSessionSuspended(sessionId, false)
          log.info('[RemoteExecution] gateway send', {
            sessionId,
            controlDeviceId: executionTarget?.device_identity_key ?? controlDeviceId,
          })
          trackSendTimingTelemetry('message.send.runtime_dispatch', {
            sessionId,
            mode: 'remote_gateway',
          }, sendTimingTrace, {
            counterKey: 'message.send.runtime_dispatch',
            sessionId,
          })
          return buildGatewaySendRequest({
            sessionId,
            message,
            displayMessage,
            contextBlocks: prepared.contextBlocks,
            uploadedAttachments: prepared.uploadedAttachments,
            replyTo: pending.replyTo,
            clientMessageId: pending.clientMessageId,
            modelId: currentModel.id,
            currentAgentMode,
            currentApprovalMode,
            capturedOrganizationId,
            capturedRuntimeSpaceId,
            executionTarget,
            capturedTabScopeKey,
            effectiveSkillSlashInvoke: prepared.effectiveSkillSlashInvoke,
            source: options?.source,
            triggeredBy: options?.triggeredBy,
          })
        },
      })
        const result = projectSendOutcome({ ...projection, outcome })
        await completeProvisionalSessionClaim(sessionId, result.accepted)
        completeDraftMessageSend(sessionId, result.accepted)
        return result
      } catch (error) {
        await completeProvisionalSessionClaim(sessionId, false)
        return projectSendFailure(projection, error)
      }
    } catch (error) {
      log.error('sendMessage rejected before dispatch', error)
      return rejected(error instanceof Error ? error.message : String(error))
    }
  }
}
