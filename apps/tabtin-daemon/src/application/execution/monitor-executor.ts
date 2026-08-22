/**
 * MonitorExecutor — Daemon 端的 Monitor 进程执行器
 *
 * Daemon 运行在用户服务器上（headless Node.js），使用 child_process.spawn
 * 而不是 PTY。核心逻辑与 Electron 端 MonitorExecutor 对称：
 *
 * 1. spawn 子进程执行命令
 * 2. 按行读取 stdout，根据 notify_on 过滤
 * 3. 匹配的行通过 WS gateway 推送 agent.monitor.event 给后端
 * 4. 每 30 秒发送 heartbeat
 * 5. 进程退出时发送 stream_ended
 *
 * 正则安全：on_pattern 的匹配加 100ms 超时保护。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface, type Interface as ReadlineInterface } from 'node:readline'
import { MonitorDeviceEvents } from '@tabtin/agent-wire'
import type { MonitorStart, MonitorStop } from '@tabtin/agent-wire'

const HEARTBEAT_INTERVAL_MS = 30_000
const REGEX_MATCH_TIMEOUT_MS = 100
const MAX_EVENTS_PER_SECOND = 20
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g
const ERROR_KEYWORDS = /\b(error|Error|ERROR|FAIL|fail|fatal|FATAL|panic|PANIC|exception|Exception)\b/
const BUILD_SUCCESS_KEYWORDS = /\b(compiled|build succeeded|no errors|ready in|watching for|built in|done in|success)\b/i

interface ActiveMonitor {
  monitorId: string
  process: ChildProcess
  readline: ReadlineInterface
  stderrReadline?: ReadlineInterface
  heartbeatTimer: ReturnType<typeof setInterval>
  pattern?: RegExp
  notifyOn: 'every_line' | 'on_error' | 'on_pattern' | 'on_build'
  description: string
  emitCount: number
  emitWindowStart: number
  droppedCount: number
}

type EmitFn = (eventType: string, payload: Record<string, unknown>) => void

export class DaemonMonitorExecutor {
  private monitors = new Map<string, ActiveMonitor>()

  constructor(private emit: EmitFn) {}

  start(request: MonitorStart): { success: boolean; error?: string } {
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
      const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
      const args = process.platform === 'win32' ? ['/c', command] : ['-c', command]

      const child = spawn(shell, args, {
        cwd: working_directory || undefined,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      if (!child.stdout) {
        return { success: false, error: 'Failed to capture stdout from spawned process' }
      }

      const rl = createInterface({ input: child.stdout })

      const monitor: ActiveMonitor = {
        monitorId: monitor_id,
        process: child,
        readline: rl,
        pattern: compiledPattern,
        notifyOn: notify_on as ActiveMonitor['notifyOn'],
        description,
        emitCount: 0,
        emitWindowStart: Date.now(),
        droppedCount: 0,
        heartbeatTimer: setInterval(() => {
          this.emit(MonitorDeviceEvents.HEARTBEAT, {
            type: MonitorDeviceEvents.HEARTBEAT,
            monitor_id,
            timestamp: Date.now(),
          })
        }, HEARTBEAT_INTERVAL_MS),
      }

      this.monitors.set(monitor_id, monitor)

      let lastLine = ''

      const emitRateLimited = (emitLine: string): void => {
        const now = Date.now()
        if (now - monitor.emitWindowStart > 1000) {
          monitor.emitWindowStart = now
          monitor.emitCount = 0
          monitor.droppedCount = 0
        }
        if (monitor.emitCount >= MAX_EVENTS_PER_SECOND) {
          monitor.droppedCount++
          return
        }
        monitor.emitCount++

        const payload: Record<string, unknown> = {
          type: MonitorDeviceEvents.EVENT,
          monitor_id,
          line: emitLine,
          timestamp: now,
          description,
        }
        if (monitor.droppedCount > 0) {
          payload.dropped_since_last = monitor.droppedCount
          monitor.droppedCount = 0
        }
        this.emit(MonitorDeviceEvents.EVENT, payload)
      }

      rl.on('line', (line: string) => {
        lastLine = line
        if (this._shouldNotify(monitor, line)) {
          emitRateLimited(line)
        }
      })

      if (child.stderr) {
        const stderrRl = createInterface({ input: child.stderr })
        monitor.stderrReadline = stderrRl
        stderrRl.on('line', (line: string) => {
          lastLine = line
          if (this._shouldNotify(monitor, line)) {
            emitRateLimited(`[stderr] ${line}`)
          }
        })
      }

      child.on('exit', (code: number | null) => {
        this.emit(MonitorDeviceEvents.STREAM_ENDED, {
          type: MonitorDeviceEvents.STREAM_ENDED,
          monitor_id,
          exit_code: code,
          last_output: lastLine || undefined,
        })
        this._cleanup(monitor_id)
      })

      child.on('error', (err: Error) => {
        this.emit(MonitorDeviceEvents.FAILED, {
          type: MonitorDeviceEvents.FAILED,
          monitor_id,
          reason: err.message,
        })
        this._cleanup(monitor_id)
      })

      return { success: true }
    } catch (err) {
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
    if (!monitor) return

    clearInterval(monitor.heartbeatTimer)
    try {
      monitor.process.kill('SIGTERM')
      setTimeout(() => {
        try { if (!monitor.process.killed) monitor.process.kill('SIGKILL') } catch {}
      }, 5000)
    } catch {}
  }

  stopAll(): void {
    for (const id of [...this.monitors.keys()]) {
      this.stop({ type: 'agent.action.monitor_stop' as const, monitor_id: id })
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

  private _safeRegexTest(regex: RegExp, input: string): boolean {
    const start = performance.now()
    try {
      const result = regex.test(input)
      if (performance.now() - start > REGEX_MATCH_TIMEOUT_MS) return false
      return result
    } catch {
      return false
    }
  }

  private _cleanup(monitorId: string): void {
    const monitor = this.monitors.get(monitorId)
    if (!monitor) return
    clearInterval(monitor.heartbeatTimer)
    try { monitor.readline.close() } catch {}
    try { monitor.stderrReadline?.close() } catch {}
    this.monitors.delete(monitorId)
  }
}
