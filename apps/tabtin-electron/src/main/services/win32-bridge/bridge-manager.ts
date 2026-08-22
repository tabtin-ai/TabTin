/**
 * Win32 Bridge Manager —— 管理 bridge.py 常驻子进程的生命周期。
 *
 * 职责：
 * 1. spawn bridge.py 子进程（stdio JSONL 通信）
 * 2. 请求/响应匹配（按 id 配对）
 * 3. 健康检查（ping）
 * 4. 崩溃自动重启（最多 3 次 / 5 分钟）
 * 5. 进程清理（Electron 退出时 kill）
 *
 * 规范出处：docs/planning/tabdesktop-spec-v1.md § 9.4.1 第 2 项。
 *
 * platform guard：仅 win32 平台实际 spawn Python 进程；其他平台
 * call() 抛 AX_UNAVAILABLE，不走 spawn 路径。
 */

import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { dirname, join } from 'node:path'
import { createReadStream, existsSync } from 'node:fs'
import { createInterface, type Interface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { createLogger } from '../../logger'
import { DesktopError, DesktopErrorCode } from '../desktop-error-codes'

const log = createLogger('Win32Bridge')

// ESM 输出下 __dirname 不存在；顶层 const 在模块求值时即会 ReferenceError，
// 导致 bridge-manager 一旦被 Win32 启动路径静态 import 就崩。
const moduleDir = dirname(fileURLToPath(import.meta.url))
const BRIDGE_SCRIPT = join(moduleDir, 'bridge.py')

const CALL_TIMEOUT_MS = 15_000
const MAX_RESTARTS = 3
const RESTART_WINDOW_MS = 5 * 60 * 1000

export interface BridgeRequest {
  id: number
  method: string
  params: Record<string, unknown>
}

export interface BridgeResponse {
  id: number
  result?: Record<string, unknown>
  error?: { code: string; message: string }
}

type PendingCallback = {
  resolve: (resp: BridgeResponse) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Win32 Bridge Manager。
 *
 * 单例模式——整个 Electron 主进程生命周期内只维护一个 bridge.py 子进程。
 * 外部通过 `call(method, params)` 发送 JSONL 请求并获得 Promise 响应。
 */
export class Win32BridgeManager {
  private process: ChildProcess | null = null
  private readline: Interface | null = null
  private nextId = 1
  private pending = new Map<number, PendingCallback>()
  private restartTimestamps: number[] = []
  private _ready = false
  private _disposed = false
  private _spawnPromise: Promise<void> | null = null

  /**
   * 启动 bridge.py 子进程。
   *
   * 非 win32 平台直接 return（不 spawn）。
   * 已经在运行或已 disposed 时也直接 return。
   */
  async start(): Promise<void> {
    if (this._disposed) return
    if (this.process && this._ready) return
    if (this._spawnPromise) return this._spawnPromise

    // FIXME(Win真机验): Python 可执行路径检测——Windows 上可能是
    // python / python3 / py.exe，需要按优先级尝试
    if (process.platform !== 'win32') {
      log.info('非 Windows 平台，跳过 bridge.py 启动')
      return
    }

    this._spawnPromise = this._doStart()
    return this._spawnPromise
  }

  private async _doStart(): Promise<void> {
    try {
      const scriptPath = this._resolveBridgeScript()
      if (!scriptPath) {
        log.warn('bridge.py 不存在，跳过启动')
        return
      }

      const pythonCmd = this._findPython()
      log.info(`启动 bridge.py: ${pythonCmd} ${scriptPath}`)

      const child = spawn(pythonCmd, [scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })

      this.process = child

      child.stderr?.on('data', (data: Buffer) => {
        log.warn(`bridge.py stderr: ${data.toString().trim()}`)
      })

      child.on('exit', (code, signal) => {
        log.info(`bridge.py 退出: code=${code}, signal=${signal}`)
        this._onProcessExit()
      })

      child.on('error', (err) => {
        log.error('bridge.py spawn 错误:', err)
        this._onProcessExit()
      })

      this.readline = createInterface({ input: child.stdout! })
      this.readline.on('line', (line) => this._onLine(line))

      await this._waitReady()
    } finally {
      this._spawnPromise = null
    }
  }

  /**
   * 定位 bridge.py 脚本。
   */
  _resolveBridgeScript(): string | null {
    if (existsSync(BRIDGE_SCRIPT)) return BRIDGE_SCRIPT
    const alt = join(process.cwd(), 'src', 'main', 'services', 'win32-bridge', 'bridge.py')
    if (existsSync(alt)) return alt
    return null
  }

  /**
   * 检测 Python 可执行路径——按优先级尝试多个候选名。
   * Windows 上 Python 3 官方安装器注册的是 `python`（和 `py` launcher），
   * macOS/Linux 上通常是 `python3`。
   */
  _findPython(): string {
    const candidates = process.platform === 'win32'
      ? ['python', 'python3', 'py']
      : ['python3', 'python']

    for (const cmd of candidates) {
      try {
        execFileSync(cmd, ['--version'], { timeout: 3000, stdio: 'ignore' })
        return cmd
      } catch {
        // 该候选不可用，尝试下一个
      }
    }

    log.warn('未找到可用的 Python 可执行文件，回退到 "python"')
    return 'python'
  }

  /**
   * 等待 bridge.py 发出 ready 信号。
   */
  private _waitReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new DesktopError(
          DesktopErrorCode.INTERNAL_ERROR,
          'bridge.py 启动超时（15 秒内未收到 ready 信号）。' +
          'Python 子进程可能未正确启动。' +
          '请检查 Python 是否已安装并在 PATH 中。',
        ))
      }, CALL_TIMEOUT_MS)

      const readyHandler = (line: string) => {
        try {
          const msg = JSON.parse(line)
          if (msg.id === 0 && msg.result?.status === 'ready') {
            clearTimeout(timeout)
            this._ready = true
            log.info(`bridge.py 就绪: version=${msg.result.version}`)
            resolve()
          }
        } catch {
          // non-JSON line, ignore
        }
      }

      // 临时监听第一行
      this.readline?.once('line', readyHandler)
    })
  }

  /**
   * 向 bridge.py 发送请求并等待响应。
   *
   * @throws DesktopError - 超时 / 进程不可用 / bridge 返回 error
   */
  async call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (process.platform !== 'win32') {
      throw new DesktopError(
        DesktopErrorCode.AX_UNAVAILABLE,
        `Win32 Bridge 仅在 Windows 平台可用（当前平台：${process.platform}）。` +
        `本次操作未执行。` +
        `macOS 请使用原生 AX 路径，Linux 不支持桌面操控。`,
      )
    }

    if (!this._ready || !this.process) {
      await this.start()
    }

    if (!this._ready || !this.process?.stdin?.writable) {
      throw new DesktopError(
        DesktopErrorCode.INTERNAL_ERROR,
        'bridge.py 进程不可用：子进程未启动或已崩溃。' +
        '本次操作未执行。' +
        '请稍后重试，系统会自动尝试重启 bridge.py。',
      )
    }

    const id = this.nextId++
    const request: BridgeRequest = { id, method, params }

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new DesktopError(
          DesktopErrorCode.INTERNAL_ERROR,
          `bridge.py 请求超时（${CALL_TIMEOUT_MS / 1000} 秒）：method=${method}。` +
          `目标窗口可能无响应或 UIA 查询耗时过长。` +
          `请重试或使用 tabtin desktop screenshot + 坐标点击作为替代。`,
        ))
      }, CALL_TIMEOUT_MS)

      this.pending.set(id, {
        resolve: (resp) => {
          clearTimeout(timer)
          this.pending.delete(id)
          if (resp.error) {
            const code = (resp.error.code as DesktopErrorCode) || DesktopErrorCode.INTERNAL_ERROR
            reject(new DesktopError(code, resp.error.message))
          } else {
            resolve(resp.result ?? {})
          }
        },
        reject: (err) => {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(err)
        },
        timer,
      })

      const line = JSON.stringify(request) + '\n'
      this.process!.stdin!.write(line)
    })
  }

  /**
   * 处理 bridge.py stdout 的每一行。
   */
  private _onLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return

    let msg: BridgeResponse
    try {
      msg = JSON.parse(trimmed)
    } catch {
      log.warn(`bridge.py 非 JSON 输出: ${trimmed.slice(0, 200)}`)
      return
    }

    // ready 消息在 _waitReady 中已处理
    if (msg.id === 0) return

    const pending = this.pending.get(msg.id)
    if (pending) {
      pending.resolve(msg)
    } else {
      log.warn(`bridge.py 响应 id=${msg.id} 无匹配请求（可能已超时）`)
    }
  }

  /**
   * 子进程退出处理：reject 所有 pending，按崩溃策略决定是否重启。
   */
  private _onProcessExit(): void {
    this._ready = false
    this.process = null
    this.readline = null

    for (const [id, cb] of this.pending) {
      cb.reject(new DesktopError(
        DesktopErrorCode.INTERNAL_ERROR,
        'bridge.py 进程意外退出，请求被中断。',
      ))
    }
    this.pending.clear()

    if (this._disposed) return

    const now = Date.now()
    this.restartTimestamps = this.restartTimestamps.filter(
      (ts) => now - ts < RESTART_WINDOW_MS,
    )

    if (this.restartTimestamps.length >= MAX_RESTARTS) {
      log.error(
        `bridge.py 在 ${RESTART_WINDOW_MS / 60000} 分钟内已崩溃 ${MAX_RESTARTS} 次，` +
        `停止自动重启。需要手动排查后重启应用。`,
      )
      return
    }

    this.restartTimestamps.push(now)
    log.info(`bridge.py 崩溃，尝试自动重启（第 ${this.restartTimestamps.length}/${MAX_RESTARTS} 次）`)

    setTimeout(() => {
      if (!this._disposed) this.start().catch((err) => log.error('bridge.py 重启失败:', err))
    }, 1000)
  }

  /**
   * 健康检查。
   */
  async ping(): Promise<boolean> {
    try {
      const result = await this.call('ping')
      return result?.status === 'ok'
    } catch {
      return false
    }
  }

  /**
   * 当前是否就绪。
   */
  get ready(): boolean {
    return this._ready
  }

  /**
   * 清理：kill 子进程，释放所有资源。
   */
  dispose(): void {
    this._disposed = true
    this._ready = false

    for (const [, cb] of this.pending) {
      clearTimeout(cb.timer)
      cb.reject(new DesktopError(
        DesktopErrorCode.INTERNAL_ERROR,
        'bridge.py 管理器已销毁。',
      ))
    }
    this.pending.clear()

    if (this.process) {
      try {
        this.process.kill('SIGTERM')
      } catch {
        // 已退出
      }
      this.process = null
    }

    this.readline = null
  }
}

/** 全局单例。 */
let _instance: Win32BridgeManager | null = null

export function getWin32BridgeManager(): Win32BridgeManager {
  if (!_instance) {
    _instance = new Win32BridgeManager()
  }
  return _instance
}

export function disposeWin32BridgeManager(): void {
  _instance?.dispose()
  _instance = null
}
