/**
 * ReplayEngine — Replays recorded browser automation events.
 *
 * Two replay modes:
 *   1. Action replay: re-executes recorded actions in a browser
 *   2. Video replay: plays back a pre-recorded MP4 (handled by frontend)
 *
 * For action replay, events are loaded from EventPersistence (NDJSON files)
 * and re-dispatched through the action executor with proper timing.
 */

import { getEventPersistence, type PersistedEvent } from './EventPersistence'
import { createLogger } from '../logger'

const log = createLogger('ReplayEngine')

export interface ReplayOptions {
  speed?: number          // Playback speed multiplier (default 1.0)
  skipWaits?: boolean     // Skip wait actions
  stopOnError?: boolean   // Stop on first error
  signal?: AbortSignal
  onProgress?: (progress: { currentEventIndex: number; completed: number; total: number }) => void
}

export interface ReplayStatus {
  state: 'idle' | 'playing' | 'finished' | 'error'
  runId?: string
  currentEventIndex: number
  totalEvents: number
  elapsedMs: number
  speed: number
  error?: string
}

export interface ReplayResult {
  success: boolean
  eventsReplayed: number
  totalEvents: number
  elapsedMs: number
  errors: Array<{ eventIndex: number; type: string; error: string }>
}

type ActionExecutor = (action: any) => Promise<any>

function replayAbortError(): Error {
  const err = new Error('Replay aborted')
  err.name = 'AbortError'
  return err
}

export class ReplayEngine {
  private executor: ActionExecutor | null = null
  private status: ReplayStatus = {
    state: 'idle',
    currentEventIndex: 0,
    totalEvents: 0,
    elapsedMs: 0,
    speed: 1.0,
  }
  private abortController: AbortController | null = null

  setActionExecutor(executor: ActionExecutor): void {
    this.executor = executor
  }

  getStatus(): ReplayStatus {
    return { ...this.status }
  }

  /**
   * List all available runs for replay.
   */
  listRuns(): Array<{ runId: string; eventCount: number; firstEvent: number; lastEvent: number }> {
    const persistence = getEventPersistence()
    return persistence.listRuns()
  }

  /**
   * Replay events from a recorded run.
   */
  async replay(runId: string, options?: ReplayOptions): Promise<ReplayResult> {
    if (!this.executor) {
      throw new Error('Action executor not set')
    }

    const persistence = getEventPersistence()
    const events = persistence.getEvents(runId)

    if (events.length === 0) {
      return { success: true, eventsReplayed: 0, totalEvents: 0, elapsedMs: 0, errors: [] }
    }

    const speed = options?.speed ?? 1.0
    const skipWaits = options?.skipWaits ?? false
    const stopOnError = options?.stopOnError ?? false

    log.info('开始回放', { runId, totalEvents: events.length, speed, skipWaits, stopOnError })

    this.abortController = new AbortController()
    const abortController = this.abortController
    const externalSignal = options?.signal
    if (externalSignal?.aborted) {
      abortController.abort()
    }
    const abortFromExternal = () => abortController.abort()
    externalSignal?.addEventListener('abort', abortFromExternal, { once: true })
    this.status = {
      state: 'playing',
      runId,
      currentEventIndex: 0,
      totalEvents: events.length,
      elapsedMs: 0,
      speed,
    }

    const startTime = Date.now()
    const errors: Array<{ eventIndex: number; type: string; error: string }> = []
    let replayed = 0

    const NON_REPLAYABLE_TYPES = new Set([
      'RECORDING_STARTED',
      'RECORDING_STOPPED',
      'execute_act_result',
      'request_snapshot',
    ])

    try {
      for (let i = 0; i < events.length; i++) {
        if (abortController.signal.aborted) break

        const event = events[i]
        this.status.currentEventIndex = i
        this.status.elapsedMs = Date.now() - startTime

        if (i > 0) {
          const timeDelta = event.timestamp - events[i - 1].timestamp
          const scaledDelay = Math.round(timeDelta / speed)
          if (scaledDelay > 0 && scaledDelay < 30000) {
            await this.sleep(scaledDelay)
          }
        }

        if (abortController.signal.aborted) break
        if (NON_REPLAYABLE_TYPES.has(event.type)) continue

        if (skipWaits && event.type === 'execute_act') {
          const actions = event.data?.actions || []
          if (actions.length === 1 && actions[0]?.type === 'wait') continue
        }

        try {
          await this.replayEvent(event)
          replayed++
          options?.onProgress?.({ currentEventIndex: i, completed: replayed, total: events.length })
        } catch (err: any) {
          if (err?.name === 'AbortError' || err?.message === 'Replay aborted') break
          const errorMsg = err?.message || String(err)
          errors.push({ eventIndex: i, type: event.type, error: errorMsg })
          log.warn('回放事件失败', { runId, eventIndex: i, type: event.type }, err)
          if (stopOnError) break
        }
      }
    } finally {
      externalSignal?.removeEventListener('abort', abortFromExternal)
    }

    const wasAborted = abortController.signal.aborted
    this.abortController = null

    if (wasAborted) {
      this.status.state = 'idle'
    } else {
      this.status.state = errors.length > 0 && stopOnError ? 'error' : 'finished'
    }
    this.status.elapsedMs = Date.now() - startTime

    log.info('回放结束', {
      runId,
      state: this.status.state,
      wasAborted,
      eventsReplayed: replayed,
      totalEvents: events.length,
      errorCount: errors.length,
      elapsedMs: this.status.elapsedMs,
    })

    return {
      success: errors.length === 0 || !stopOnError,
      eventsReplayed: replayed,
      totalEvents: events.length,
      elapsedMs: this.status.elapsedMs,
      errors,
    }
  }

  /**
   * Stop an ongoing replay.
   */
  stop(): void {
    if (this.abortController) {
      this.abortController.abort()
    }
    this.status.state = 'idle'
  }

  private async replayEvent(event: PersistedEvent): Promise<void> {
    if (!this.executor) return
    if (this.abortController?.signal.aborted) throw replayAbortError()

    switch (event.type) {
      case 'execute_act': {
        const actions = event.data?.actions || []
        if (actions.length === 0) return

        await this.executor({
          task_id: `replay-act-${Date.now()}`,
          type: 'execute_act',
          params: {
            actions,
            stop_on_error: true,
            crawlTabId: event.viewId,
            runId: event.runId,
          },
          thread_id: '',
        })
        break
      }

      case 'TAB_OPENED': {
        const url = event.data?.url || event.context?.url
        if (url) {
          await this.executor({
            task_id: `replay-open-${Date.now()}`,
            type: 'open_tab',
            params: { url },
            thread_id: '',
          })
        }
        break
      }

      case 'TAB_SWITCHED': {
        const tabId = event.data?.tabId || event.viewId
        if (tabId) {
          await this.executor({
            task_id: `replay-switch-${Date.now()}`,
            type: 'switch_tab',
            params: { tabId },
            thread_id: '',
          })
        }
        break
      }

      case 'TAB_CLOSED': {
        const tabId = event.data?.tabId || event.viewId
        if (tabId) {
          await this.executor({
            task_id: `replay-close-${Date.now()}`,
            type: 'close_tab',
            params: { tabId },
            thread_id: '',
          })
        }
        break
      }

      case 'execute_observe': {
        const selector = event.data?.selector
        await this.executor({
          task_id: `replay-observe-${Date.now()}`,
          type: 'execute_observe',
          params: {
            selector,
            crawlTabId: event.viewId,
            runId: event.runId,
          },
          thread_id: '',
        })
        break
      }

      case 'navigation':
      case 'load_tab_url': {
        const url = event.data?.url
        if (url) {
          await this.executor({
            task_id: `replay-nav-${Date.now()}`,
            type: 'load_tab_url',
            params: {
              url,
              crawlTabId: event.viewId,
            },
            thread_id: '',
          })
        }
        break
      }

      default:
        break
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const signal = this.abortController?.signal
      if (signal?.aborted) {
        reject(replayAbortError())
        return
      }
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(replayAbortError())
      }, { once: true })
    })
  }
}

let sharedReplayEngine: ReplayEngine | null = null

export function getReplayEngine(): ReplayEngine {
  if (!sharedReplayEngine) {
    sharedReplayEngine = new ReplayEngine()
  }
  return sharedReplayEngine
}
