import http from 'node:http'
import { okResponse } from '@tabtin/agent-wire'
// BR-8 P3c 收尾：record / replay 编排收编进 browser-core Orchestrator；本文件退成薄分发。
// 活跃录制的跨请求登记表也下沉为 browser-core 共享 runtime（RecordingRegistry），route 不再持 Map。
import {
  handleBrowserAction,
  getSharedRecordingRegistry,
  getSharedBrowserJobManager,
  BrowserActionError,
  type BrowserActionResult,
  type BrowserJobHooks,
  type BrowserJobProgress,
  type BrowserOrchestratorHostHooks,
  type BrowserSessionData,
  type BrowserSessionHooks,
} from '@tabtin/browser-core'
import type { SendJSON, ActionExecutor } from './_helpers'
import { buildBrowserRequestScope, resolveTabId, errorResponse, getCLIViewGetter, electronPolicyHooks } from './_helpers'
import { runWithBrowserApprovalContext } from '../../browser-policy-middleware'
import { getEventPersistence } from '../../../run-session/EventPersistence'
import { getRunSessionManager } from '../../../run-session/RunSessionManager'
import { getReplayEngine } from '../../../run-session/ReplayEngine'
import { getVideoRecorder, getExistingVideoRecorder, removeVideoRecorder } from '../../../run-session/VideoRecorder'
import { createLogger } from '../../../logger'
import { runWithTabLock } from '../../../browser-tab-lock/runWithTabLock'
import { BrowserTabUserInControlError } from '../../../browser-tab-lock/browserTabInputLock'

const log = createLogger('browser/record')

/**
 * 把 Orchestrator 结果用 Electron envelope 落地（record/replay/run 只产 ok/error，
 * 不会出 electron-executor；`'kind' in result` 仅作类型收窄兜底）。
 *
 * 供同族的 `run.ts` 复用（两者都是 session 命令的薄分发）。
 */
export function respondSessionResult(
  res: http.ServerResponse,
  sendJSON: SendJSON,
  result: BrowserActionResult,
): void {
  if ('kind' in result) {
    sendJSON(res, 500, errorResponse('INTERNAL_ERROR', '意外的 executor 结果（session 命令不应产出）'))
    return
  }
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

export async function runElectronReplay(
  body: any,
  executor: NonNullable<ActionExecutor>,
  opts?: { signal?: AbortSignal; reportProgress?: (progress: BrowserJobProgress) => void },
): Promise<BrowserSessionData> {
  const runId = body?.runId
  if (!runId) {
    throw new BrowserActionError(400, {
      code: 'VALIDATION_ERROR',
      message: '缺少 runId 参数',
      suggestions: ['使用 tabtin browser replay list 查看可回放的 run', '使用 tabtin browser record start 先录制产生一个 run'],
    })
  }

  let result
  try {
    const engine = getReplayEngine()
    if (!engine.getStatus().state || engine.getStatus().state === 'idle') {
      engine.setActionExecutor(executor)
    }
    result = await engine.replay(runId, {
      speed: body?.speed,
      skipWaits: body?.skipWaits ?? body?.skip_waits,
      stopOnError: body?.stopOnError ?? body?.stop_on_error,
      signal: opts?.signal,
      onProgress: (progress) => {
        const percent = progress.total > 0 ? Math.min(100, Math.round((progress.completed / progress.total) * 100)) : 0
        opts?.reportProgress?.({
          phase: 'replaying',
          percent,
          completed: progress.completed,
          total: progress.total,
          detail: `已回放 ${progress.completed}/${progress.total} 个事件`,
        })
      },
    })
  } catch (err: any) {
    if (err instanceof BrowserTabUserInControlError) throw err
    // BT-011: 统一使用 errorResponse() 保证错误字段完整性（code/suggestions/retryable）
    throw new BrowserActionError(500, {
      code: err?.name === 'AbortError' ? 'ABORTED' : 'INTERNAL_ERROR',
      message: err?.message || String(err),
      retryable: err?.name === 'AbortError' ? false : true,
      suggestions: ['检查 runId 是否正确', '使用 tabtin browser replay list 查看可回放会话'],
    })
  }

  if (result.success) {
    return result as unknown as BrowserSessionData
  }
  const errMsg =
    result.errors.length > 0
      ? result.errors.map((e) => `${e.type}: ${e.error}`).join('; ')
      : 'Replay failed'
  throw new BrowserActionError(500, { code: 'INTERNAL_ERROR', message: errMsg })
}

/**
 * Electron 端 record / replay 的「最后一公里」，注入 Orchestrator。
 * 行为逐字段复刻原 route（事件流走 RunSessionManager、视频走 VideoRecorder、回放走 ReplayEngine）；
 * 校验/冲突/未找到经 `BrowserActionError` 上抛，由 Orchestrator 决策状态码。
 */
function buildRecordSessionHooks(executor: NonNullable<ActionExecutor>): BrowserSessionHooks {
  return {
    async recordStart(body: any): Promise<BrowserSessionData> {
      const tabId = await resolveTabId(body?.tabId, buildBrowserRequestScope(body)) || '__default'

      const registry = getSharedRecordingRegistry()
      const existing = registry.get(tabId)
      if (existing) {
        throw new BrowserActionError(409, {
          code: 'VALIDATION_ERROR',
          message: `Recording already active for tab ${tabId}`,
          detail: { runId: existing.runId, startedAt: existing.startedAt },
        })
      }

      const manager = getRunSessionManager()
      const runId = body?.runId || `rec-${Date.now()}`
      manager.createRun(runId)

      const fps = body?.fps || 2
      manager.addObservation({
        runId,
        viewId: tabId,
        type: 'RECORDING_STARTED',
        timestamp: Date.now(),
        data: { tabId, fps },
      })

      let videoStarted = false
      const viewGetterFn = getCLIViewGetter()
      if (viewGetterFn) {
        try {
          const view = viewGetterFn(tabId)
          const webContents = view?.webContents ?? view
          if (webContents && typeof webContents.capturePage === 'function') {
            const recorder = getVideoRecorder(tabId, webContents)
            await recorder.start({ fps })
            videoStarted = true
          }
        } catch (err: any) {
          log.warn('VideoRecorder start 失败（降级，不阻断录制）:', err?.message)
        }
      }

      registry.set(tabId, { runId, startedAt: Date.now() })

      return {
        runId,
        tabId,
        videoRecording: videoStarted,
        message: videoStarted
          ? 'Event + video recording started.'
          : 'Event recording started (video unavailable — no webContents).',
      }
    },

    async recordStop(body: any): Promise<BrowserSessionData> {
      const tabId = await resolveTabId(body?.tabId, buildBrowserRequestScope(body)) || '__default'
      const registry = getSharedRecordingRegistry()
      const recording = registry.get(tabId)

      if (!recording) {
        // BT-011: 统一使用 errorResponse() 保证错误字段完整性（code/suggestions/retryable）
        throw new BrowserActionError(404, {
          code: 'NOT_FOUND',
          message: `找不到 tab ${tabId} 的活跃录制`,
          suggestions: ['使用 tabtin browser record start 启动录制', '使用 tabtin browser record status 查看录制状态'],
        })
      }

      let videoPath: string | undefined

      try {
        const recorder = getExistingVideoRecorder(tabId)
        if (recorder) {
          videoPath = await recorder.stop() ?? undefined
          removeVideoRecorder(tabId)
        }
      } catch { /* video may not have been started */ }

      const manager = getRunSessionManager()
      manager.addObservation({
        runId: recording.runId,
        viewId: tabId,
        type: 'RECORDING_STOPPED',
        timestamp: Date.now(),
        data: { durationMs: Date.now() - recording.startedAt, videoPath },
      })
      void getEventPersistence().flush()
      registry.delete(tabId)

      const stats = manager.getRunStats(recording.runId)
      const eventCount = stats?.eventCount ?? 0

      try {
        await manager.endRun(recording.runId, { reason: 'recording-stopped' })
      } catch { /* run may have been ended separately */ }

      return {
        runId: recording.runId,
        durationMs: Date.now() - recording.startedAt,
        eventCount,
        videoPath,
      }
    },

    async recordStatus(body: any): Promise<BrowserSessionData> {
      const tabId = await resolveTabId(body?.tabId, buildBrowserRequestScope(body)) || '__default'
      const recording = getSharedRecordingRegistry().get(tabId)

      if (!recording) {
        return { recording: false, tabId }
      }

      let videoStatus: any = null
      try {
        const recorder = getExistingVideoRecorder(tabId)
        if (recorder) videoStatus = recorder.getStatus()
      } catch { /* ignore */ }

      const manager = getRunSessionManager()
      const stats = manager.getRunStats(recording.runId)
      const eventCount = stats?.eventCount ?? 0

      return {
        recording: true,
        runId: recording.runId,
        tabId,
        startedAt: recording.startedAt,
        durationMs: Date.now() - recording.startedAt,
        eventCount,
        video: videoStatus,
      }
    },

    async replayRun(body: any): Promise<BrowserSessionData> {
      return runElectronReplay(body, executor)
    },

    async replayList(): Promise<BrowserSessionData> {
      try {
        const persistence = getEventPersistence()
        const runs = persistence.listRuns()
        return { runs }
      } catch (err: any) {
        throw new BrowserActionError(500, { code: 'INTERNAL_ERROR', message: err?.message || String(err) })
      }
    },
  }
}

function buildElectronReplayJobHooks(executor: NonNullable<ActionExecutor>): BrowserJobHooks {
  return {
    manager: getSharedBrowserJobManager(),
    async execute(actionId, body, ctx): Promise<unknown> {
      if (actionId !== 'replay.run') {
        throw new BrowserActionError(400, { code: 'VALIDATION_ERROR', message: `job 暂不支持异步执行 action: ${actionId}` })
      }
      return runElectronReplay(body, executor, {
        signal: ctx.signal,
        reportProgress: ctx.reportProgress,
      })
    },
  }
}

const RECORD_ROUTES: Record<string, string> = {
  '/record/start': 'record.start',
  '/record/stop': 'record.stop',
  '/record/status': 'record.status',
  '/replay/run': 'replay.run',
  '/replay/list': 'replay.list',
}

export async function handleRecordRoute(
  route: string,
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
  executor: NonNullable<ActionExecutor>,
): Promise<boolean> {
  const actionId = RECORD_ROUTES[route]
  if (!actionId) return false

  // 原 record/replay route 无外层 try/catch：意外异常（如 createRun 配额抛错）向上抛，
  // 经 Orchestrator 透传后由本分发继续上抛，保留现状行为。
  const hostHooks: BrowserOrchestratorHostHooks = {
    runtime: 'electron',
    session: buildRecordSessionHooks(executor),
    jobs: buildElectronReplayJobHooks(executor),
    // BR-9：record.start/record.stop/replay.run 是 write→confirm，必须注入 policy，
    // 否则统一闸门会 fail-closed 把这些现有可用动作拒成 403。
    policy: electronPolicyHooks,
  }
  const tabId = actionId === 'record.status' || actionId === 'replay.list'
    ? undefined
    : await resolveTabId(body?.tabId ?? body?.tab_id, buildBrowserRequestScope(body))
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
}
