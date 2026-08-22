/**
 * 浏览器长任务 job 路由（BR-10 P2）—— Electron 端。
 *
 * 两个出口，逻辑全在 browser-core（`handleBrowserAction` 的 `job.status` / `job.cancel`）：
 *   - `/job/status`：按 jobId 查异步任务进度 / 结果（未找到 404）。
 *   - `/job/cancel`：按 jobId 取消异步任务（触发引擎中止，已终态则 no-op）。
 *
 * job 运行时（`BrowserJobManager`）是进程级共享单例，`buildElectronJobHooks` 注入其 manager；
 * stream.download / replay.run 已接 AbortSignal；非 stream 的 direct download 仍是步骤边界 best-effort。
 */

import http from 'node:http'
import {
  handleBrowserAction,
  type BrowserOrchestratorHostHooks,
} from '@tabtin/browser-core'
import { okResponse } from '@tabtin/agent-wire'
import type { SendJSON, ActionExecutor } from './_helpers'
import { buildBrowserRequestScope, errorResponse, resolveTabId } from './_helpers'
import { buildElectronJobHooks } from './resources'
import { runWithTabLock } from '../../../browser-tab-lock/runWithTabLock'

/** job 路由 → 能力 actionId。 */
const JOB_ROUTES: Record<string, string> = {
  '/job/status': 'job.status',
  '/job/cancel': 'job.cancel',
}

/**
 * 处理 job 路由。命中 `/job/status` / `/job/cancel` 返回 true（已消费），否则 false。
 */
export async function handleJobRoute(
  route: string,
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
  executor: NonNullable<ActionExecutor>,
): Promise<boolean> {
  const actionId = JOB_ROUTES[route]
  if (!actionId) return false

  const hostHooks: BrowserOrchestratorHostHooks = {
    runtime: 'electron',
    jobs: buildElectronJobHooks(executor),
  }
  const rawTabId = body?.tabId ?? body?.tab_id
  const tabId = actionId === 'job.status' || !rawTabId
    ? undefined
    : await resolveTabId(rawTabId, buildBrowserRequestScope(body))
  const result = await runWithTabLock(
    tabId,
    () => handleBrowserAction(actionId, body, hostHooks),
    typeof body?._thread_id === 'string' ? body._thread_id : undefined,
  )
  if (!result) return false

  // job.* 永不产出 electron-executor 变体；用 `'ok' in result` 收窄成 ok/error 联合。
  if ('ok' in result) {
    if (result.ok) {
      sendJSON(res, result.status, okResponse(result.data))
    } else {
      sendJSON(res, result.status, errorResponse(result.error.code as any, result.error.message, {
        suggestions: result.error.suggestions,
        retryable: result.error.retryable,
        detail: result.error.detail,
      }))
    }
  }
  return true
}
