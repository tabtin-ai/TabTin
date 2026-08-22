import http from 'node:http'
// BR-8 P3c 收尾：run 编排收编进 browser-core Orchestrator；本文件退成薄分发。
import {
  handleBrowserAction,
  BrowserActionError,
  type BrowserOrchestratorHostHooks,
  type BrowserSessionData,
  type BrowserSessionHooks,
} from '@tabtin/browser-core'
import type { SendJSON, ActionExecutor } from './_helpers'
import {
  buildBrowserRequestScope,
  handleRouteError,
  getCLIViewGetter,
  electronPolicyHooks,
  resolveTabId,
} from './_helpers'
import { respondSessionResult } from './record'
import { runWithBrowserApprovalContext } from '../../browser-policy-middleware'
import { getEventPersistence } from '../../../run-session/EventPersistence'
import { getRunSessionManager } from '../../../run-session/RunSessionManager'
import { getVideoRecorder, getExistingVideoRecorder, removeVideoRecorder } from '../../../run-session/VideoRecorder'
import { createLogger } from '../../../logger'
import { runWithTabLock } from '../../../browser-tab-lock/runWithTabLock'

const log = createLogger('browser/run')

/**
 * Electron 端 run.* 的「最后一公里」，注入 Orchestrator。
 *
 * 失败语义忠实复刻原 route：
 *  - 缺 runId（run.end / run.status）/ run 不存在（run.status）→ 抛 `BrowserActionError`
 *    （Orchestrator 决策 400 / 404）。
 *  - 引擎/管理器抛出的非结构化异常**不在此吞**——透传给 route 分发的 `handleRouteError`
 *    （保留原 `catch (err) { handleRouteError(...) }` 的丰富错误映射，含 enhanceErrorResponse）。
 *
 * 注：run.* 仅 Electron 提供；Daemon 不注入这些 hook，故 `/run/*` 在 Daemon 维持现状 404。
 */
const runSessionHooks: BrowserSessionHooks = {
  async runStart(body: any): Promise<BrowserSessionData> {
    const manager = getRunSessionManager()
    const name = body?.name
    const runId = body?.runId || undefined
    const ctx = manager.createRun(runId, undefined, body?.profile)

    const record = body?.record === true
    let videoStarted = false

    if (record && body?.tabId) {
      const viewGetterFn = getCLIViewGetter()
      if (viewGetterFn) {
        try {
          const view = viewGetterFn(body.tabId)
          const webContents = view?.webContents ?? view
          if (webContents && typeof webContents.capturePage === 'function') {
            const recorder = getVideoRecorder(body.tabId, webContents)
            await recorder.start({ fps: body?.fps || 2 })
            videoStarted = true
          }
        } catch (err: any) {
          log.warn('run/start 时 VideoRecorder start 失败（降级，不阻断）:', err?.message)
        }
      }
    }

    getEventPersistence().addEvent({
      runId: ctx.runId,
      type: 'RUN_STARTED',
      timestamp: Date.now(),
      data: { name, record, videoStarted },
    })

    return { runId: ctx.runId, name, videoRecording: videoStarted, createdAt: ctx.createdAt }
  },

  async runEnd(body: any): Promise<BrowserSessionData> {
    const runId = body?.runId
    if (!runId) {
      throw new BrowserActionError(400, {
        code: 'VALIDATION_ERROR',
        message: '缺少 runId 参数',
        suggestions: ['runId 由执行环境在启动 Run 时分配；用带 --run-id 的命令关联，如 tabtin browser open --run-id <id>'],
      })
    }

    const manager = getRunSessionManager()
    const run = manager.getRun(runId)

    let videoPath: string | undefined
    if (run?.views) {
      for (const view of (Array.isArray(run.views) ? run.views : [])) {
        try {
          const recorder = getExistingVideoRecorder(view.viewId)
          if (recorder) {
            videoPath = await recorder.stop() ?? undefined
            removeVideoRecorder(view.viewId)
          }
        } catch { /* ignore */ }
      }
    }

    getEventPersistence().addEvent({
      runId,
      type: 'RUN_ENDED',
      timestamp: Date.now(),
      data: { reason: body?.reason || 'manual', videoPath },
    })
    await manager.endRun(runId, { reason: body?.reason || 'cli-run-end' })

    return { runId, videoPath }
  },

  async runStatus(body: any): Promise<BrowserSessionData> {
    const runId = body?.runId
    if (!runId) {
      throw new BrowserActionError(400, {
        code: 'VALIDATION_ERROR',
        message: '缺少 runId 参数',
        suggestions: ['runId 由执行环境在启动 Run 时分配；用带 --run-id 的命令关联，如 tabtin browser open --run-id <id>'],
      })
    }

    const manager = getRunSessionManager()
    const run = manager.getRun(runId)

    if (!run) {
      throw new BrowserActionError(404, {
        code: 'NOT_FOUND',
        message: `Run ${runId} 不存在或已结束`,
        suggestions: ['确认 runId 仍有效（Run 可能已结束）'],
      })
    }

    return {
      runId: run.runId,
      viewCount: Array.isArray(run.views) ? run.views.length : 0,
      activeViewId: run.activeViewId,
      observationCount: run.observations?.length || 0,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      durationMs: Date.now() - run.createdAt,
      spaceId: run.spaceId,
    }
  },

  async runList(): Promise<BrowserSessionData> {
    const manager = getRunSessionManager()
    const runs = manager.listRuns()
    return { runs, count: runs.length }
  },
}

const RUN_ROUTES: Record<string, string> = {
  '/run/start': 'run.start',
  '/run/end': 'run.end',
  '/run/status': 'run.status',
  '/run/list': 'run.list',
}

export async function handleRunRoute(
  route: string,
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
  _executor: NonNullable<ActionExecutor>,
): Promise<boolean> {
  const actionId = RUN_ROUTES[route]
  if (!actionId) return false

  const hostHooks: BrowserOrchestratorHostHooks = {
    runtime: 'electron',
    session: runSessionHooks,
    // BR-9：run.* 未在 contract 注册 → fail-safe 当 write → confirm，必须注入 policy，
    // 否则统一闸门会 fail-closed 把这些现有可用动作拒成 403。
    policy: electronPolicyHooks,
  }
  const tabId = actionId === 'run.status' || actionId === 'run.list'
    ? undefined
    : await resolveTabId(body?.tabId ?? body?.tab_id, buildBrowserRequestScope(body))
  // 原各 run/* 分支以 `catch (err) { handleRouteError(...) }` 兜底非结构化异常；
  // Orchestrator 只接管 BrowserActionError（→ ok/error 结果）、透传其余异常，故在此统一兜底。
  try {
    const result = await runWithBrowserApprovalContext(
      body,
      () => runWithTabLock(
        tabId,
        () => handleBrowserAction(actionId, body, hostHooks),
        typeof body?._thread_id === 'string' ? body._thread_id : undefined,
      ),
    )
    if (result) {
      respondSessionResult(res, sendJSON, result)
      return true
    }
    return false
  } catch (err: any) {
    handleRouteError(err, sendJSON, res)
    return true
  }
}
