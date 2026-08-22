/**
 * onActionRequired handler — extracted from sendMessageAction.
 *
 * Responsible for executing agent tool actions via IPC and
 * reporting results back to the backend.
 */

import type { ChatClient } from '@tabtin/chat-client'
import { PERMISSION_TIMEOUTS } from '@tabtin/agent-wire'
import type { RunState } from '../../shared/types'
import { agentClient } from '../../../../crawlspace/electron/agent-client'
import { runSessionClient } from '../../../../crawlspace/electron/run-session-client'
import { resolveRunningTraceId } from '../../../../crawlspace/utils/resolveRunningTraceId'
import { logActionResultToMain } from '../../../../crawlspace/utils/logActionResult'
import { API_CONFIG } from '../../../../config/api'
import { useAuthStore } from '../../../useAuthStore'
import { createLogger } from '@/utils/logger'
import { useChatRuntimeStore } from '../../../useChatRuntimeStore'
import { useSpaceStore } from '../../../useSpaceStore'

const log = createLogger('ActionRequired')

// ---------------------------------------------------------------------------
// Minimal store shape
// ---------------------------------------------------------------------------

export interface ActionRequiredStore {
}

// ---------------------------------------------------------------------------
// Mutable context shared with the parent sendMessage scope
// ---------------------------------------------------------------------------

export interface ActionContext {
  currentTraceId: string | null
  currentRunId: string | null
  runCreated: boolean
}

export interface ActionRequiredDeps {
  client: ChatClient
  sessionId: string
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createActionRequiredHandler(
  deps: ActionRequiredDeps,
  ctx: ActionContext,
) {
  const { client, sessionId } = deps

  return async (action: any, taskId: string) => {
    const actionStartTime = Date.now()
    const timestamp = new Date().toISOString()
    log.info(`[${timestamp}] onActionRequired called`, {
      taskId,
      actionType: action.action,
      params: action.params,
    })

    const submitThreadId = action.thread_id || `chat-session-${sessionId}`

    try {
      if (!ctx.currentTraceId) {
        ctx.currentTraceId = action.trace_id || null
      }
      if (!ctx.currentTraceId) {
        const token = useAuthStore.getState().accessToken
        if (submitThreadId) {
          ctx.currentTraceId = await resolveRunningTraceId({
            baseURL: API_CONFIG.baseURL,
            threadId: submitThreadId,
            token: token || undefined,
          })
        }
      }
      if (!ctx.currentRunId) {
        const runState = useChatRuntimeStore.getState().runStateBySessionId[sessionId]
        ctx.currentRunId = runState?.runId || null
      }
      const runSessionId = ctx.currentRunId || ctx.currentTraceId
      if (runSessionId && !ctx.runCreated) {
        try {
          const createResult = (await runSessionClient.create(runSessionId, `session-${sessionId}`)) as {
            success?: boolean
          }
          if (createResult?.success) {
            ctx.runCreated = true
            log.info('Run session created (runId=%s, traceId=%s)', ctx.currentRunId, ctx.currentTraceId)
          }
        } catch (err) {
          log.warn('Run Session creation failed (continuing):', err)
        }
      }
      log.debug('[+0ms] Invoking main process to execute tool')
      const ipcStartTime = Date.now()

      // Must exceed interactive HITL wait (FINAL_MS) plus post-approval tool execution.
      const TOOL_EXECUTION_HEADROOM_MS = 300_000 // aligned with FrontendActionBridge EXECUTE_ACTION_TIMEOUT_MS
      const IPC_TIMEOUT_MS =
        PERMISSION_TIMEOUTS.FINAL_MS + TOOL_EXECUTION_HEADROOM_MS + PERMISSION_TIMEOUTS.FALLBACK_GRACE_MS

      // PRD §11：Agent 目录是 CLI 执行锚。在 enrich params 时把当前 Space 对应 Agent
      // 的 working_dir 作为 _workspace_root 优先级最高地注入——main 进程
      // FrontendActionBridge.effectiveWorkspaceRoot 解析链会优先用 _workspace_root，
      // 让 Agent 在 working_dir 下跑命令（而不是 organization root / sandbox）。
      // Server 传过来的 action.params._workspace_root 是按 organization 算的，覆盖掉。
      const enrichedParams: Record<string, unknown> = {
        ...action.params,
        runId: ctx.currentRunId || undefined,
        trace_id: ctx.currentTraceId || undefined,
      }
      try {
        // selectedSpace 是用户当前焦点的 Space —— action 触发时它通常就是 chat
        // session 所在 Space（用户在哪 Space 发起 chat）。selectedAgent 一致同理。
        // 避免循环 import useChatStore.sessions 反查（actionRequiredHandler 是 useChatStore
        // 内部 handler，反向 import 会出循环依赖）。
        const spaceStore = useSpaceStore.getState()
        const sp = spaceStore.selectedSpace
        const agentId = sp?.agent_id ?? null
        const agent = agentId
          ? (spaceStore.agentCache[agentId] ?? spaceStore.selectedAgent)
          : spaceStore.selectedAgent
        if (agent?.working_dir) {
          enrichedParams._workspace_root = agent.working_dir
          // 同时设 working_directory：FrontendActionBridge 的降级路径优先看这条
          if (!enrichedParams.working_directory) {
            enrichedParams.working_directory = agent.working_dir
          }
        }
      } catch (enrichErr) {
        log.warn('Failed to enrich working_dir into action params (fallback to default)', enrichErr)
      }

      const executePromise = agentClient.executeAction({
        task_id: taskId,
        action: action.action,
        thread_id: action.thread_id,
        trace_id: ctx.currentTraceId || undefined,
        params: enrichedParams,
        sandbox_policy: action.sandbox_policy,
      })
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`IPC timeout: agent:execute-action exceeded ${IPC_TIMEOUT_MS}ms`)), IPC_TIMEOUT_MS),
      )
      type ExecuteActionResult = {
        success: boolean
        clean_html?: string
        data?: Record<string, unknown>
        accessibility_tree?: unknown
        xpath_map?: Record<string, unknown>
      }
      const result = (await Promise.race([executePromise, timeoutPromise])) as ExecuteActionResult
      const ipcDuration = Date.now() - ipcStartTime

      log.info(`[+${ipcDuration}ms] Tool execution succeeded`, {
        taskId,
        success: result.success,
        contentLength: result.clean_html?.length || 0,
        ipcDuration: `${ipcDuration}ms`,
      })

      log.debug(`[+${Date.now() - actionStartTime}ms] Submitting result to agent backend`)

      const resultRecord = result as unknown as Record<string, unknown>
      const debugInfo = {
        topLevelKeys: Object.keys(result),
        hasData: !!result.data,
        hasAccessibilityTree: !!resultRecord.accessibility_tree,
        hasXpathMap: !!resultRecord.xpath_map,
        dataKeys: result.data ? Object.keys(result.data) : [],
        accessibilityTreeLength: Array.isArray(resultRecord.accessibility_tree) ? resultRecord.accessibility_tree.length : 0,
        xpathMapSize: resultRecord.xpath_map && typeof resultRecord.xpath_map === 'object' ? Object.keys(resultRecord.xpath_map).length : 0,
      }
      log.debug(`Result structure to submit: ${JSON.stringify(debugInfo, null, 2)}`)

      const submitStartTime = Date.now()
      await client.actions.submitResult(submitThreadId || sessionId, taskId, {
        ...(result as Record<string, unknown>),
        trace_id: ctx.currentTraceId || undefined,
        success: result.success,
      })
      logActionResultToMain({
        threadId: submitThreadId || sessionId || undefined,
        taskId,
        traceId: ctx.currentTraceId,
        success: result.success,
        resultKeys: Object.keys(result),
      })
      const submitDuration = Date.now() - submitStartTime
      const totalDuration = Date.now() - actionStartTime
      log.info(`[+${totalDuration}ms] Result submitted (submit: ${submitDuration}ms, total: ${totalDuration}ms)`)
    } catch (error) {
      const totalDuration = Date.now() - actionStartTime
      log.error(`[+${totalDuration}ms] Tool execution or result submission failed:`, error)

      try {
        await client.actions.submitResult(submitThreadId || sessionId, taskId, {
          trace_id: ctx.currentTraceId || undefined,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        })
        logActionResultToMain({
          threadId: submitThreadId || sessionId || undefined,
          taskId,
          traceId: ctx.currentTraceId,
          success: false,
          resultKeys: ['success', 'error'],
        })
        log.info('Failure result submitted')
      } catch (submitError) {
        log.error('Failed to submit failure result:', submitError)
      }
    }
  }
}
