/**
 * MonitorExecutor — Electron 端的 Monitor 进程执行器
 *
 * 接收 monitor_start 请求后：
 * 1. 通过 PtyManager 创建一个 PTY session
 * 2. 按行读取 stdout，根据 notify_on 过滤
 * 3. 匹配的行通过 WS 推送 agent.monitor.event 给后端
 * 4. 每 30 秒发送 heartbeat
 * 5. 进程退出时发送 stream_ended
 *
 * 正则安全：on_pattern 的匹配加 100ms 超时保护。
 */

import { createLogger } from '../logger'
import type { MonitorStart, MonitorStop } from '@tabtin/agent-wire'
import { MonitorDeviceEvents } from '@tabtin/agent-wire'
import { getPtyManager } from '../terminal/PtyManager'

const log = createLogger('MonitorExecutor')

const HEARTBEAT_INTERVAL_MS = 30_000
const REGEX_MATCH_TIMEOUT_MS = 100
const MAX_EVENTS_PER_SECOND = 20
const MAX_LINE_BUFFER = 1_048_576 // 1 MB
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g
const ERROR_KEYWORDS = /\b(error|Error|ERROR|FAIL|fail|fatal|FATAL|panic|PANIC|exception|Exception)\b/
const BUILD_SUCCESS_KEYWORDS = /\b(compiled|build succeeded|no errors|ready in|watching for|built in|done in|success)\b/i

interface ActiveMonitor {
  monitorId: string
  sessionId: string
  heartbeatTimer: ReturnType<typeof setInterval>
  lineBuffer: string
  pattern?: RegExp
  notifyOn: 'every_line' | 'on_error' | 'on_pattern' | 'on_build'
  description: string
  emitCount: number
  emitWindowStart: number
  droppedCount: number
  dataHandler: (data: string) => void
  exitHandler: (exitCode: number) => void
  ptyOnData: (sessionId: string, data: string) => void
  ptyOnExit: (sessionId: string, exitCode: number, signal?: number) => void
}

type EmitFn = (eventType: string, payload: Record<string, unknown>) => void

export class MonitorExecutor {
  private monitors = new Map<string, ActiveMonitor>()

  constructor(private emit: EmitFn) {}

  async start(request: MonitorStart): Promise<{ success: boolean; error?: string }> {
    const { monitor_id, command, description, notify_on, pattern, working_directory } = request

    if (this.monitors.has(monitor_id)) {
      return { success: false, error: `Monitor ${monitor_id} already running` }
    }

    let compiledPattern: RegExp | undefined
    if (notify_on === 'on_pattern' && pattern) {
      try {
        compiledPattern = new RegExp(pattern, 'i')
      } catch (err) {
        return { success: false, error: `Invalid regex pattern: ${err}` }
      }
    }

    try {
      const { getPtyManager } = await import('../terminal/PtyManager')
      const ptyManager = getPtyManager()

      const sessionId = `monitor-${monitor_id}-${Date.now()}`
      const spawned = ptyManager.spawn(sessionId, { cwd: working_directory || undefined })
      if (!spawned) {
        return { success: false, error: 'Failed to spawn PTY session (busy or limit reached)' }
      }

      const dataHandler = (data: string) => this._handleData(monitor_id, data)
      const exitHandler = (exitCode: number) => this._handleExit(monitor_id, exitCode)

      const ptyOnData = (sid: string, data: string) => {
        if (sid === sessionId) dataHandler(data)
      }
      const ptyOnExit = (sid: string, exitCode: number, _signal?: number) => {
        if (sid === sessionId) exitHandler(exitCode)
      }

      const monitor: ActiveMonitor = {
        monitorId: monitor_id,
        sessionId,
        lineBuffer: '',
        pattern: compiledPattern,
        notifyOn: notify_on as ActiveMonitor['notifyOn'],
        description,
        emitCount: 0,
        emitWindowStart: Date.now(),
        droppedCount: 0,
        dataHandler,
        exitHandler,
        ptyOnData,
        ptyOnExit,
        heartbeatTimer: setInterval(() => {
          this.emit(MonitorDeviceEvents.HEARTBEAT, {
            type: MonitorDeviceEvents.HEARTBEAT,
            monitor_id,
            timestamp: Date.now(),
          })
        }, HEARTBEAT_INTERVAL_MS),
      }

      this.monitors.set(monitor_id, monitor)

      ptyManager.on('data', ptyOnData)
      ptyManager.on('exit', ptyOnExit)

      const wrote = ptyManager.write(sessionId, `${command}\n`)
      if (!wrote) {
        ptyManager.removeListener('data', ptyOnData)
        ptyManager.removeListener('exit', ptyOnExit)
        ptyManager.kill(sessionId)
        clearInterval(monitor.heartbeatTimer)
        this.monitors.delete(monitor_id)
        return { success: false, error: 'Failed to write command to PTY session' }
      }

      log.info(`Monitor ${monitor_id} started: "${description}" (${notify_on})`)
      return { success: true }

    } catch (err) {
      log.error(`Monitor ${monitor_id} start failed:`, err)
      this.emit(MonitorDeviceEvents.FAILED, {
        type: MonitorDeviceEvents.FAILED,
        monitor_id,
        reason: err instanceof Error ? err.message : String(err),
      })
      return { success: false, error: String(err) }
    }
  }

  stop(request: MonitorStop): void {
    const monitor = this.monitors.get(request.monitor_id)
    if (!monitor) {
      log.warn(`Monitor ${request.monitor_id} not found for stop`)
      return
    }
    this._cleanup(request.monitor_id, 'stopped')
  }

  stopAll(): void {
    for (const id of [...this.monitors.keys()]) {
      this._cleanup(id, 'stopped_all')
    }
  }

  private _handleData(monitorId: string, data: string): void {
    const monitor = this.monitors.get(monitorId)
    if (!monitor) return

    monitor.lineBuffer += data
    if (monitor.lineBuffer.length > MAX_LINE_BUFFER) {
      monitor.lineBuffer = monitor.lineBuffer.slice(-MAX_LINE_BUFFER)
    }
    const lines = monitor.lineBuffer.split('\n')
    monitor.lineBuffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.replace(/\r$/, '')
      if (!trimmed) continue

      if (this._shouldNotify(monitor, trimmed)) {
        const now = Date.now()
        if (now - monitor.emitWindowStart > 1000) {
          monitor.emitWindowStart = now
          monitor.emitCount = 0
          monitor.droppedCount = 0
        }
        if (monitor.emitCount >= MAX_EVENTS_PER_SECOND) {
          monitor.droppedCount++
          continue
        }
        monitor.emitCount++

        const payload: Record<string, unknown> = {
          type: MonitorDeviceEvents.EVENT,
          monitor_id: monitorId,
          line: trimmed,
          timestamp: now,
          description: monitor.description,
        }
        if (monitor.droppedCount > 0) {
          payload.dropped_since_last = monitor.droppedCount
          monitor.droppedCount = 0
        }
        this.emit(MonitorDeviceEvents.EVENT, payload)
      }
    }
  }

  private _shouldNotify(monitor: ActiveMonitor, line: string): boolean {
    const clean = line.replace(ANSI_RE, '')
    switch (monitor.notifyOn) {
      case 'every_line':
        return true

      case 'on_error':
        return ERROR_KEYWORDS.test(clean)

      case 'on_build':
        return ERROR_KEYWORDS.test(clean) || BUILD_SUCCESS_KEYWORDS.test(clean)

      case 'on_pattern':
        if (!monitor.pattern) return false
        return this._safeRegexTest(monitor.pattern, clean)

      default:
        return true
    }
  }

  /**
   * Test a regex with timeout protection.
   * If the regex takes longer than REGEX_MATCH_TIMEOUT_MS, treat as no match.
   */
  private _safeRegexTest(regex: RegExp, input: string): boolean {
    const start = performance.now()
    try {
      const result = regex.test(input)
      const elapsed = performance.now() - start
      if (elapsed > REGEX_MATCH_TIMEOUT_MS) {
        log.warn(`Regex match took ${elapsed.toFixed(0)}ms (limit ${REGEX_MATCH_TIMEOUT_MS}ms), treating as timeout`)
        return false
      }
      return result
    } catch {
      return false
    }
  }

  private _handleExit(monitorId: string, exitCode: number): void {
    const monitor = this.monitors.get(monitorId)
    if (!monitor) return

    const lastLine = monitor.lineBuffer.trim()
    this.emit(MonitorDeviceEvents.STREAM_ENDED, {
      type: MonitorDeviceEvents.STREAM_ENDED,
      monitor_id: monitorId,
      exit_code: exitCode,
      last_output: lastLine || undefined,
    })

    this._cleanup(monitorId, 'stream_ended')
  }

  private _cleanup(monitorId: string, reason: string): void {
    const monitor = this.monitors.get(monitorId)
    if (!monitor) return

    clearInterval(monitor.heartbeatTimer)
    this.monitors.delete(monitorId)

    try {
      const ptyManager = getPtyManager()
      ptyManager.removeListener('data', monitor.ptyOnData)
      ptyManager.removeListener('exit', monitor.ptyOnExit)
      ptyManager.kill(monitor.sessionId)
    } catch (err) {
      log.debug(`Cleanup session ${monitor.sessionId} failed (may already be closed):`, err)
    }

    log.info(`Monitor ${monitorId} cleaned up (reason=${reason})`)
  }
}
