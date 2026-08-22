import { fork } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { InProcessPtyHostClient } from './InProcessPtyHost'
import type {
  PtyHostClient,
  PtyHostDisposable,
  PtyHostExitEvent,
  PtyHostSession,
  PtyHostSpawnedEvent,
  PtyHostSpawnRequest,
} from './PtyHost'
import type { PtyHostCommand, PtyHostEvent } from './PtyHostProtocol'
import { createLogger } from '../logger'

const log = createLogger('SubprocessPtyHost')

interface PtyHostChildProcess {
  readonly pid?: number
  readonly stderr?: NodeJS.ReadableStream | null
  send(command: PtyHostCommand): void
  kill(signal?: string): boolean | void
  on(event: 'message', listener: (message: unknown) => void): this
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): this
  on(event: 'error', listener: (error: Error) => void): this
}

type UtilityProcessModule = Pick<typeof Electron.UtilityProcess, 'fork'>
type UtilityProcessInstance = Electron.UtilityProcess
type ChildFactory = (scriptPath: string) => PtyHostChildProcess

const require = createRequire(import.meta.url)

class UtilityProcessChildAdapter implements PtyHostChildProcess {
  constructor(private readonly child: UtilityProcessInstance) {}

  get pid(): number | undefined {
    return this.child.pid
  }

  get stderr(): NodeJS.ReadableStream | null {
    return this.child.stderr
  }

  send(command: PtyHostCommand): void {
    this.child.postMessage(command)
  }

  kill(_signal?: string): boolean {
    // utilityProcess.kill() does not accept POSIX signals. PtyManager still
    // terminates the spawned shell process tree separately when a PTY exists.
    return this.child.kill()
  }

  on(event: 'message', listener: (message: unknown) => void): this
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(
    event: 'message' | 'exit' | 'error',
    listener:
      | ((message: unknown) => void)
      | ((code: number | null, signal: string | null) => void)
      | ((error: Error) => void),
  ): this {
    if (event === 'exit') {
      const onExit = listener as (code: number | null, signal: string | null) => void
      this.child.on('exit', (code) => onExit(code, null))
      return this
    }
    if (event === 'error') {
      const onError = listener as (error: Error) => void
      this.child.on('error', (type, location, report) => {
        const error = new Error(`utility process ${type} at ${location}: ${report}`)
        onError(error)
      })
      return this
    }
    const onMessage = listener as (message: unknown) => void
    this.child.on('message', (message) => onMessage(message))
    return this
  }
}

export function createUtilityPtyHostChild(
  scriptPath: string,
  utilityProcess: UtilityProcessModule,
): PtyHostChildProcess {
  const child = utilityProcess.fork(scriptPath, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    serviceName: 'TabTin PTY Host',
    env: process.env,
  })
  return new UtilityProcessChildAdapter(child)
}

export function createPtyHostChildFromElectron(
  scriptPath: string,
  electronModule: Partial<typeof import('electron')>,
): PtyHostChildProcess | null {
  const { utilityProcess } = electronModule
  if (utilityProcess && typeof utilityProcess.fork === 'function') {
    return createUtilityPtyHostChild(scriptPath, utilityProcess)
  }
  return null
}

export function createDefaultPtyHostChild(scriptPath: string): PtyHostChildProcess {
  try {
    const child = createPtyHostChildFromElectron(
      scriptPath,
      require('electron') as Partial<typeof import('electron')>,
    )
    if (child) return child
  } catch {
    // 非 Electron 环境（单测 / Node smoke）回退到 child_process.fork。
  }
  return fork(scriptPath, [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    serialization: 'json',
  }) as PtyHostChildProcess
}

function getHostProcessScriptPath(): string {
  try {
    const { app } = require('electron') as typeof import('electron')
    const appPath = app?.getAppPath?.() ?? process.cwd()
    return join(appPath, 'out', 'main', 'pty-host-process.mjs')
  } catch {
    const currentDir = dirname(fileURLToPath(import.meta.url))
    return join(currentDir, '..', 'pty-host-process.mjs')
  }
}

class SubprocessPtyHostSession implements PtyHostSession {
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly exitListeners = new Set<(event: PtyHostExitEvent) => void>()
  private readonly spawnedListeners = new Set<(event: PtyHostSpawnedEvent) => void>()
  private readonly queuedCommands: PtyHostCommand[] = []
  private ready = false

  static MAX_QUEUED_COMMANDS = 1000
  private spawned = false
  private closed = false
  private emittedExit = false
  private currentPid: number
  private readyTimeoutHandle: ReturnType<typeof setTimeout> | null = null

  /** Visible for testing – default 10 000 ms */
  static READY_TIMEOUT_MS = 10_000

  constructor(
    private readonly child: PtyHostChildProcess,
    request: PtyHostSpawnRequest,
  ) {
    this.currentPid = child.pid ?? 0

    this.queueOrSend({ kind: 'spawn', request })

    child.on('message', (message: unknown) => {
      this.handleHostEvent(message as PtyHostEvent)
    })

    child.on('exit', (code, signal) => {
      this.clearReadyTimeout()
      this.emitExitOnce({
        exitCode: code ?? null,
        signal: typeof signal === 'number' ? signal : undefined,
      })
    })

    child.on('error', (error) => {
      log.error('child process error:', error)
      this.clearReadyTimeout()
      this.emitExitOnce({
        exitCode: null,
        signal: undefined,
      })
    })

    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      const trimmed = text.trim()
      if (trimmed) {
        log.warn(`child stderr: ${trimmed}`)
      }
    })

    // P1-FUN-2: ready 超时 — 子进程在规定时间内未发送 ready 消息则强制终止
    this.readyTimeoutHandle = setTimeout(() => {
      if (!this.ready && !this.closed) {
        log.error(
          `child did not become ready within ${SubprocessPtyHostSession.READY_TIMEOUT_MS}ms, killing`,
        )
        try {
          child.kill('SIGKILL')
        } catch {
          // 进程可能已退出，忽略
        }
        this.emitExitOnce({
          exitCode: null,
          signal: undefined,
        })
      }
    }, SubprocessPtyHostSession.READY_TIMEOUT_MS)
  }

  get pid(): number {
    return this.currentPid
  }

  onSpawned(handler: (event: PtyHostSpawnedEvent) => void): PtyHostDisposable {
    this.spawnedListeners.add(handler)
    if (this.spawned) {
      queueMicrotask(() => handler({ pid: this.currentPid }))
    }
    return {
      dispose: () => {
        this.spawnedListeners.delete(handler)
      },
    }
  }

  write(data: string): void {
    this.queueOrSend({ kind: 'write', data })
  }

  pauseOutput(): void {
    this.queueOrSend({ kind: 'pause-output' })
  }

  resumeOutput(): void {
    this.queueOrSend({ kind: 'resume-output' })
  }

  resize(cols: number, rows: number): void {
    this.queueOrSend({ kind: 'resize', cols, rows })
  }

  kill(signal?: string): void {
    this.queueOrSend({ kind: 'kill', signal })
    if (signal === 'SIGKILL') {
      this.child.kill('SIGKILL')
    }
  }

  onData(handler: (data: string) => void): PtyHostDisposable {
    this.dataListeners.add(handler)
    return {
      dispose: () => {
        this.dataListeners.delete(handler)
      },
    }
  }

  onExit(handler: (event: PtyHostExitEvent) => void): PtyHostDisposable {
    this.exitListeners.add(handler)
    return {
      dispose: () => {
        this.exitListeners.delete(handler)
      },
    }
  }

  private queueOrSend(command: PtyHostCommand): void {
    if (this.closed) {
      return
    }

    if (!this.ready || (!this.spawned && command.kind !== 'spawn')) {
      if (this.queuedCommands.length >= SubprocessPtyHostSession.MAX_QUEUED_COMMANDS) {
        const dropIdx = this.queuedCommands.findIndex(c => c.kind !== 'spawn')
        if (dropIdx !== -1) {
          this.queuedCommands.splice(dropIdx, 1)
          log.warn(
            `command queue at limit (${SubprocessPtyHostSession.MAX_QUEUED_COMMANDS}), dropped oldest non-spawn command`,
          )
        }
      }
      this.queuedCommands.push(command)
      return
    }

    this.child.send(command)
  }

  private flushQueuedCommands(): void {
    if (!this.ready || this.closed) {
      return
    }

    const remaining: PtyHostCommand[] = []
    for (const command of this.queuedCommands.splice(0, this.queuedCommands.length)) {
      if (command.kind !== 'spawn' && !this.spawned) {
        remaining.push(command)
        continue
      }
      this.child.send(command)
    }
    this.queuedCommands.push(...remaining)
  }

  private clearReadyTimeout(): void {
    if (this.readyTimeoutHandle !== null) {
      clearTimeout(this.readyTimeoutHandle)
      this.readyTimeoutHandle = null
    }
  }

  private handleHostEvent(event: PtyHostEvent): void {
    switch (event.kind) {
      case 'ready':
        this.clearReadyTimeout()
        this.ready = true
        this.flushQueuedCommands()
        return
      case 'spawned':
        this.spawned = true
        this.currentPid = event.pid
        for (const listener of this.spawnedListeners) {
          listener({ pid: event.pid })
        }
        this.flushQueuedCommands()
        return
      case 'data':
        for (const listener of this.dataListeners) {
          listener(event.data)
        }
        return
      case 'exit':
        this.emitExitOnce({
          exitCode: event.exitCode,
          signal: event.signal,
        })
        return
      case 'error':
        log.error(`host error: ${event.message}`)
        return
    }
  }

  private emitExitOnce(event: PtyHostExitEvent): void {
    if (this.emittedExit) {
      return
    }
    this.emittedExit = true
    this.closed = true
    // 清理 pending 命令队列，防止内存泄漏
    this.queuedCommands.length = 0
    for (const listener of this.exitListeners) {
      listener(event)
    }
  }
}

export interface SubprocessPtyHostClientOptions {
  childFactory?: ChildFactory
  scriptPath?: string
}

export class SubprocessPtyHostClient implements PtyHostClient {
  private readonly childFactory: ChildFactory
  private readonly scriptPath: string

  constructor(options: SubprocessPtyHostClientOptions = {}) {
    this.childFactory = options.childFactory ?? createDefaultPtyHostChild
    this.scriptPath = options.scriptPath ?? getHostProcessScriptPath()
  }

  spawn(request: PtyHostSpawnRequest): PtyHostSession {
    const child = this.childFactory(this.scriptPath)
    return new SubprocessPtyHostSession(child, request)
  }
}

export function createDefaultPtyHostClient(): PtyHostClient {
  // ：node-pty 的 forkpty() 在 Electron 重度多线程主进程（CrBrowserMain +
  // V8 + IO 线程）里会偶发 EXC_BAD_ACCESS(SIGSEGV)——fork 出的子进程只剩 forking
  // 这一个线程，却继承了全部 mutex/堆状态，exec 前若触到 V8/Chromium 即崩，且时序
  // 敏感（典型现象：浏览器 tab → 终端 tab 切换时整 app 崩）。
  //
  // 修复：默认把 PTY host 放进独立 Node 子进程（与 VS Code 的 pty-host 同构），
  // forkpty 发生在干净的单职责进程里，主进程不再 fork。仅排障时可设
  // TABTIN_PTY_HOST_MODE=in-process 回退到旧行为（有崩溃风险，勿用于生产）。
  if (process.env.TABTIN_PTY_HOST_MODE === 'in-process') {
    // pnpm 严格模块隔离下，pty-core（peerDependency）内部的 require('node-pty')
    // 从 packages/pty-core/dist/ 路径开始查找，无法到达 apps/tabtin-electron/node_modules/。
    // 在应用层显式 require 后传入构造函数，绕过路径解析问题。
    const nodePty = require('node-pty') as typeof import('node-pty')
    return new InProcessPtyHostClient(nodePty)
  }
  return new SubprocessPtyHostClient()
}
