/**
 * runtime_dispatch 前的共享准备：模型设置、个人规则、工作区 snapshot。
 * sendMessage 与 draft prefetch 共用，并行执行以降低串行 IPC/HTTP 延迟。
 */

import { useChatModelStore } from '../../useChatModelStore'
import { useAuthStore } from '@stores/useAuthStore'
import { resolvePersonalRulesForRuntime } from '@/services/personalRulesRuntimeCache'
import { createLogger } from '@/utils/logger'
import {
  type SendTimingTrace,
  trackSendTimingTelemetry,
} from './sendTimingTrace'

const log = createLogger('RuntimeDispatchPrep')

export interface RuntimeDispatchAgent {
  personal_rules?: string | null
  user_id?: string | null
}

export interface PrepareRuntimeDispatchContextParams {
  sessionId: string
  spaceId?: string | null
  currentAgent?: RuntimeDispatchAgent | null
  sendTimingTrace?: SendTimingTrace
  includeTier?: boolean
  includePersonalRules?: boolean
  includeWorkspace?: boolean
}

export interface PrepareRuntimeDispatchContextResult {
  personalRules?: string
  workspaceSnapshot?: unknown
}

async function trackPrepStep<T>(
  stepName: string,
  sessionId: string,
  sendTimingTrace: SendTimingTrace | undefined,
  task: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now()
  try {
    return await task()
  } finally {
    if (sendTimingTrace) {
      trackSendTimingTelemetry(stepName, {
        sessionId,
        durationMs: Math.round(performance.now() - startedAt),
      }, sendTimingTrace, {
        counterKey: stepName,
        sessionId,
      })
    }
  }
}

export async function fetchWorkspaceSnapshotForSpace(spaceId: string): Promise<unknown | undefined> {
  if (!spaceId) return undefined

  const { notifyWorkspacePathsForSpace } = await import(
    '@components/workspace/notifyWorkspacePaths'
  )
  await notifyWorkspacePathsForSpace(spaceId)

  const snapshotApi = (typeof window !== 'undefined'
    ? (window as unknown as {
        tabtin?: {
          agentSecurity?: {
            getWorkspaceSnapshot?: (spaceId: string) => Promise<{ snapshot: unknown } | null>
          }
        }
      }).tabtin?.agentSecurity?.getWorkspaceSnapshot
    : undefined)

  if (typeof snapshotApi !== 'function') return undefined

  const snapResult = await snapshotApi(spaceId)
  return snapResult?.snapshot ?? undefined
}

export async function prepareRuntimeDispatchContext(
  params: PrepareRuntimeDispatchContextParams,
): Promise<PrepareRuntimeDispatchContextResult> {
  const {
    sessionId,
    spaceId,
    currentAgent,
    sendTimingTrace,
    includeTier = true,
    includePersonalRules = true,
    includeWorkspace = true,
  } = params
  // 发送热路径不再调用本函数；仅 session prefetch 预热仍用。
  // 个人规则 / workspace snapshot 的权威来源是 Host prepareTurnInputs。

  const authUserId = useAuthStore.getState().user?.id
  const authOwnerKey = authUserId != null ? String(authUserId) : 'anonymous'
  const agentOwnerKey = currentAgent?.user_id != null ? String(currentAgent.user_id) : authOwnerKey
  const canFallbackToCurrentUserProfileRules =
    currentAgent?.user_id == null || String(currentAgent.user_id) === authOwnerKey

  const tasks: Array<Promise<unknown>> = []
  let personalRulesIndex = -1
  let workspaceIndex = -1

  if (includeTier) {
    tasks.push(
      trackPrepStep(
        'message.send.prep.tier',
        sessionId,
        sendTimingTrace,
        () => useChatModelStore.getState().syncTierForActiveSession(sessionId),
      ).catch((err) => {
        log.warn('[prepareRuntimeDispatchContext] syncTier failed (non-blocking):', err)
      }),
    )
    tasks.push(
      trackPrepStep(
        'message.send.prep.model_params',
        sessionId,
        sendTimingTrace,
        () => useChatModelStore.getState().syncModelParamsForActiveSession(sessionId),
      ),
    )
  }

  if (includePersonalRules) {
    personalRulesIndex = tasks.length
    tasks.push(
      trackPrepStep(
        'message.send.prep.personal_rules',
        sessionId,
        sendTimingTrace,
        () => resolvePersonalRulesForRuntime(
          currentAgent,
          agentOwnerKey,
          { allowApiFallback: canFallbackToCurrentUserProfileRules },
        ),
      ).catch((err) => {
        log.warn('[prepareRuntimeDispatchContext] personal rules failed (non-blocking):', err)
        return undefined
      }),
    )
  }

  if (includeWorkspace && spaceId) {
    workspaceIndex = tasks.length
    tasks.push(
      trackPrepStep(
        'message.send.prep.workspace',
        sessionId,
        sendTimingTrace,
        () => fetchWorkspaceSnapshotForSpace(spaceId),
      ).catch((err) => {
        log.warn('[prepareRuntimeDispatchContext] workspace snapshot failed (non-blocking):', err)
        return undefined
      }),
    )
  }

  if (tasks.length === 0) {
    return {}
  }

  const results = await Promise.all(tasks)

  return {
    personalRules: personalRulesIndex >= 0
      ? (results[personalRulesIndex] as string | undefined)
      : undefined,
    workspaceSnapshot: workspaceIndex >= 0
      ? results[workspaceIndex]
      : undefined,
  }
}
