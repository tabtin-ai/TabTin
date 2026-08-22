/**
 * PtyManager - 管理伪终端会话
 *
 * 职责：
 * - 创建和管理多个 pty 会话
 * - 处理 pty 数据输入/输出
 * - 处理终端 resize
 * - 会话生命周期管理
 */

import { EventEmitter } from 'events'
import { app } from 'electron'
import {
  evaluateLocalTerminalPolicy,
  getInteractiveTerminalPolicySupportError,
  evaluateTerminalPolicyDegradation,
  executeDegraded,
  type TerminalExecutionContext,
  type TerminalExecutionPolicy,
  type DegradationDecision,
} from '@tabtin/terminal-core'
import { runWithHumanInteractionContext } from '@tabtin/agent-runtime'
import {
  PtyOutputBuffer,
  PtyWriteChannel,
  PtySessionStore,
  PtyProcessTerminator,
  PtyCommandRunner,
  SyntheticPtyHostSession,
  MARKER_PREFIX,
  ANSI_RE,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  MAX_OUTPUT_BUFFER_BYTES,
  cleanOutput,
  resolveCwd,
  resolveShell,
  detectShellType,
  sanitizeEnv,
  normalizeSize,
  type PtyHostClient,
  type AgentSessionClosedInfo,
  type ExecuteCommandResult,
  type PtySession,
  type PtySessionCloseReason,
  type ShellType,
} from '@tabtin/pty-core'
import { collectProcessUsageTable } from '../resource-monitor/process-usage'
import { createDefaultPtyHostClient } from './SubprocessPtyHost'
import { saveAutoCheckpoint } from './snapshot'
import { requestApproval } from '../services/ApprovalManager'
import { createLogger } from '../logger'
import { getCLIServerInfo } from '../cli/cli-server'
import type { TerminalSnapshot } from '@shared/types/terminal'

const log = createLogger('PtyManager')

/**
 * 打包版从 Finder/Dock 启动的 Electron 不继承 shell 环境，process.env.LANG 缺失，
 * PTY 子进程会退回 C/POSIX locale，导致终端里中文按单字节处理而乱码。
 * dev 从终端 `pnpm dev` 启动则继承了 shell 的 *.UTF-8，故不受影响。
 *
 * 兜底策略：仅当 env 完全没有 LANG/LC_ALL/LC_CTYPE 时，才补一个从系统 locale 派生的
 * UTF-8 locale；已有任一 locale 变量则原样尊重用户/系统配置，不覆盖。
 */
const DEFAULT_UTF8_LOCALE = 'en_US.UTF-8'

function bcp47ToPosixUtf8Locale(osLocale: string): string {
  // Electron app.getLocale() 返回 BCP-47（如 zh-CN、en-US）。取「语言-两位地区」
  // 映射为 POSIX 形态 zh_CN.UTF-8；缺地区或无法解析时回退到肯定可用且为 UTF-8
  // 码集的 en_US.UTF-8（仅影响消息语言，中文显示不受影响）。
  const match = /^([A-Za-z]{2,3})-([A-Za-z]{2})$/.exec(osLocale.trim())
  if (!match) {
    return DEFAULT_UTF8_LOCALE
  }
  return `${match[1].toLowerCase()}_${match[2].toUpperCase()}.UTF-8`
}

export function resolveDefaultLocaleEnv(
  env: Record<string, string | undefined>,
  osLocale: string,
): { LANG?: string } {
  if (env.LANG || env.LC_ALL || env.LC_CTYPE) {
    return {}
  }
  return { LANG: bcp47ToPosixUtf8Locale(osLocale) }
}

function mergeCurrentCLIServerEnv(
  env?: Record<string, string>,
): Record<string, string> | undefined {
  if (env && ('TABTIN_SOCK' in env || '_TABTIN_TRANSPORT_TOKEN' in env)) {
    return env
  }

  const info = getCLIServerInfo()
  if (!info?.socketPath || !info.token) {
    return env
  }

  return {
    TABTIN_SOCK: info.socketPath,
    _TABTIN_TRANSPORT_TOKEN: info.token,
    ...(env ?? {}),
  }
}

function resolveCurrentShellType(): ShellType {
  return detectShellType(resolveShell())
}

export type {
  AgentSessionClosedInfo,
  ExecuteCommandResult,
  PtySession,
  PtySessionCloseReason,
} from '@tabtin/pty-core'

export type { PaneStatus, PaneStatusEvent } from '@shared/types/terminal'
import type { PaneStatus, PaneStatusEvent } from '@shared/types/terminal'

export interface PtySpawnOptions {
  cwd?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
  spaceId?: string
  /**
   * Phase 4（PRD §1.5）：桌面/本地沙箱终端「不绑定任何执行 Space」。置 true 时
   * 不从全局 `process.env.TABTIN_*SPACE_ID` 兜底注入 Space，并在最终 env 中剔除
   * 这两个变量——避免桌面终端 shell 内的 tabtin CLI 静默落到当前活跃 Space（执行串台）。
   * 仅 renderer 经 pty:spawn IPC 起的、未显式带 spaceId 的用户终端会置此标志；
   * Agent / 执行型终端显式带 spaceId、不置此标志，行为不变。
   */
  noSpaceBinding?: boolean
  synthetic?: boolean
}

export interface AutoRespondRule {
  pattern: string
  response: string
}

const MAX_SESSIONS = 20
const MAX_AGENT_SESSIONS_PER_SPACE = 6
const IDLE_TIMEOUT_MS = 30 * 60 * 1000
const AGENT_IDLE_TIMEOUT_MS = 60 * 60 * 1000
const IDLE_CHECK_INTERVAL_MS = 10 * 60 * 1000
const READ_OUTPUT_DEMAND_WINDOW_MS = 30_000

const PANE_STATUS_CLEANUP_DELAY_MS = 5_000
const AUTO_CHECKPOINT_MIN_INTERVAL_MS = 5_000 // 同一 session 两次自动快照最小间隔 5 秒
const RESIZE_DEBOUNCE_MS = 80

function mergeSpaceIdIntoEnv(
  baseEnv: Record<string, string> | undefined,
  spaceId: string | undefined,
): Record<string, string> | undefined {
  if (!spaceId) return baseEnv
  return { ...baseEnv, TABTIN_SPACE_ID: spaceId, TABTIN_AGENT_SPACE_ID: spaceId }
}

function isAgentSessionId(sessionId: string): boolean {
  return sessionId.startsWith('agent-')
}

export class PtyManager extends EventEmitter {
  private readonly sessionStore = new PtySessionStore()
  private readonly commandRunner: PtyCommandRunner
  private readonly paneStatuses = new Map<string, PaneStatus>()
  private readonly paneStatusCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly resizeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly pendingResizes = new Map<string, { cols: number; rows: number }>()
  private readonly readDemandExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly lastAutoCheckpointAt = new Map<string, number>()
  /** P1-STB-3: 每个 session 的 pty listener disposable，session 销毁时统一 dispose */
  private readonly sessionDisposables = new Map<string, Array<{ dispose(): void }>>()
  private idleTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly hostClient: PtyHostClient = createDefaultPtyHostClient(),
    private readonly processTerminator: PtyProcessTerminator = new PtyProcessTerminator({
      collectProcessTable: collectProcessUsageTable,
    }),
  ) {
    super()
    this.setMaxListeners(15)

    this.commandRunner = new PtyCommandRunner(
      {
        store: this.sessionStore,
        write: (sessionId, data) => {
          const session = this.sessionStore.getSession(sessionId)
          if (!session) return false
          return this.enqueueSessionWrite(session, data, 'command')
        },
        logger: {
          debug: (msg: string) => log.debug(msg),
          warn: (msg: string) => log.warn(msg),
        },
        // TT-04: 直接回调替代日志字符串解析，消除格式变动导致的隐形耦合
        onNeedsRestart: (sessionId: string) => this.handleNeedsRestartCallback(sessionId),
        onAutoRespondTriggered: (sessionId: string, pattern: string) => this.handleAutoRespondCallback(sessionId, pattern),
      },
      { autoRespondDelayMs: 100 },
    )

    this.startIdleCleanup()
  }

  private updatePaneStatus(sessionId: string, status: PaneStatus, exitCode?: number | null): void {
    const prev = this.paneStatuses.get(sessionId)
    if (prev === status) return
    this.paneStatuses.set(sessionId, status)
    const event: PaneStatusEvent = { sessionId, status, exitCode }
    this.emit('pane-status', event)

    const existingTimer = this.paneStatusCleanupTimers.get(sessionId)
    if (existingTimer) {
      clearTimeout(existingTimer)
      this.paneStatusCleanupTimers.delete(sessionId)
    }
    if (status === 'exited') {
      const timer = setTimeout(() => {
        this.paneStatuses.delete(sessionId)
        this.paneStatusCleanupTimers.delete(sessionId)
      }, PANE_STATUS_CLEANUP_DELAY_MS)
      this.paneStatusCleanupTimers.set(sessionId, timer)
    }
  }

  getPaneStatus(sessionId: string): PaneStatus {
    return this.paneStatuses.get(sessionId) ?? 'idle'
  }

  getAllPaneStatuses(): Record<string, PaneStatus> {
    const result: Record<string, PaneStatus> = {}
    for (const [id, status] of this.paneStatuses) {
      result[id] = status
    }
    return result
  }

  private startIdleCleanup(): void {
    if (this.idleTimer) return
    this.idleTimer = setInterval(() => this.evictIdleSessions(), IDLE_CHECK_INTERVAL_MS)
  }

  private isAgentSession(session: PtySession): boolean {
    return isAgentSessionId(session.id)
  }

  private evictIdleSessions(): void {
    const now = Date.now()
    const toEvict: string[] = []
    for (const [sessionId, session] of this.sessionStore.getSessionEntries()) {
      const isAgent = this.isAgentSession(session)
      const idleMs = now - session.lastOutputAt
      if (!session.isRunning && idleMs > IDLE_TIMEOUT_MS) {
        toEvict.push(sessionId)
      } else if (isAgent && session.isRunning && idleMs > AGENT_IDLE_TIMEOUT_MS) {
        toEvict.push(sessionId)
      }
    }
    for (const sid of toEvict) {
      log.info(`evicting idle session: ${sid}`)
      this.kill(sid, 'idle_timeout')
    }
  }

  private appendToOutputBuffer(sessionId: string, data: string): void {
    const session = this.sessionStore.getSession(sessionId)
    if (!session) return
    session.outputBuffer.append(data)
    session.lastOutputAt = Date.now()

    // Delegate marker scanning, auto-respond, and backgrounded watcher checks
    // to PtyCommandRunner (EM-1: eliminates duplicated logic)
    const hadPending = this.sessionStore.hasPendingCommand(sessionId)
    const hadWatchers = (this.sessionStore.getBackgroundedWatchers(sessionId)?.length ?? 0) > 0

    this.commandRunner.handleData(sessionId)

    // Post-handleData: detect state transitions for PtyManager-specific side effects
    const hasPendingNow = this.sessionStore.hasPendingCommand(sessionId)
    const hasWatchersNow = (this.sessionStore.getBackgroundedWatchers(sessionId)?.length ?? 0) > 0

    // If pending command just resolved (marker found), update pane status.
    // P1-H (WP2)：原 emit `agent-session-title` 链路已退役（agent-bridge.ts
    // L168-174 硬契约：D3 决策每次命令独立 session 后标题在 created 时一次定死）。
    if (hadPending && !hasPendingNow) {
      this.updatePaneStatus(sessionId, 'idle')
      this.syncSessionOutputFlowControl(sessionId)
    }

    // If watchers changed, sync flow control
    if (hadWatchers !== hasWatchersNow) {
      this.syncSessionOutputFlowControl(sessionId)
    }
  }

  /**
   * 向指定 session 的 PTY 数据通道注入合成消息（降级提示等）。
   * 仅更新 outputBuffer + emit 'data'，不触发 marker 扫描/auto-respond。
   */
  private emitToSession(sessionId: string, data: string): void {
    this.emit('data', sessionId, data)
    const session = this.sessionStore.getSession(sessionId)
    if (session) {
      session.outputBuffer.append(data)
      session.lastOutputAt = Date.now()
    }
  }

  appendAgentTranscriptData(sessionId: string, data: string): void {
    this.emitToSession(sessionId, data)
  }

  markAgentTranscriptRunning(sessionId: string): void {
    const session = this.sessionStore.getSession(sessionId)
    if (!session) return
    session.isRunning = true
    this.updatePaneStatus(sessionId, 'running')
    this.syncSessionOutputFlowControl(sessionId)
  }

  markAgentTranscriptCompleted(
    sessionId: string,
    result: { cwd?: string; exitCode: number | null },
  ): void {
    const session = this.sessionStore.getSession(sessionId)
    if (!session) return
    if (result.cwd) session.cwd = result.cwd
    session.lastExitCode = result.exitCode
    session.lastCommandCompletedAt = Date.now()
    session.isRunning = false
    this.updatePaneStatus(sessionId, 'idle', result.exitCode)
    this.syncSessionOutputFlowControl(sessionId)

    // run_terminal_command_后台执行重构_2026-05-18 §5.1：
    // 与"自然退出延迟 5 秒释放"路径（本文件 L424-433）对称——synthetic
    // agent transcript 不走 onExit，必须显式延迟释放 MAX_SESSIONS 配额，
    // 否则 LLM 累计 20 次 run_terminal_command 就撞 limit（dogfood 2026-05-18
    // session 16dd07d8 已撞过）。5 秒延迟让用户能看到最后输出再回收。
    setTimeout(() => {
      if (this.sessionStore.hasSession(sessionId)) {
        log.info(`removing completed agent transcript: ${sessionId}`)
        this.lastAutoCheckpointAt.delete(sessionId)
        this.disposeSessionListeners(sessionId)
        this.sessionStore.deleteSession(sessionId)
      }
    }, 5_000)
  }

  private enqueueSessionWrite(
    session: PtySession,
    data: string,
    source: 'user' | 'command' | 'auto_respond',
  ): boolean {
    if (!session.writeChannel) {
      log.warn(`synthetic/output-only session cannot accept input: session=${session.id}, source=${source}`)
      return false
    }
    const queued = session.writeChannel.enqueue(data)
    if (!queued) {
      log.warn(`write channel rejected: session=${session.id}, source=${source}`)
    }
    return queued
  }

  private hasRecentReadDemand(session: PtySession): boolean {
    if (!session.lastReadDemandAt) return false
    return (Date.now() - session.lastReadDemandAt) < READ_OUTPUT_DEMAND_WINDOW_MS
  }

  private shouldPauseSessionOutput(session: PtySession): boolean {
    if (!session.isRunning) return false
    if (this.isAgentSession(session)) return false
    if (session.rendererDataSubscribed) return false
    if (this.sessionStore.hasPendingCommand(session.id)) return false
    if ((this.sessionStore.getBackgroundedWatchers(session.id)?.length ?? 0) > 0) return false
    if (this.hasRecentReadDemand(session)) return false
    return true
  }

  private syncSessionOutputFlowControl(sessionId: string): void {
    const session = this.sessionStore.getSession(sessionId)
    if (!session || session.terminationFinalized) {
      return
    }

    const shouldPause = this.shouldPauseSessionOutput(session)
    if (shouldPause === Boolean(session.outputPaused)) {
      return
    }

    try {
      if (shouldPause) {
        session.pty.pauseOutput()
        session.outputPaused = true
      } else {
        session.pty.resumeOutput()
        session.outputPaused = false
      }
    } catch (error) {
      log.warn(`output flow control failed: session=${sessionId}`, error)
    }
  }

  private clearReadDemandExpiryTimer(sessionId: string): void {
    const timer = this.readDemandExpiryTimers.get(sessionId)
    if (!timer) {
      return
    }
    clearTimeout(timer)
    this.readDemandExpiryTimers.delete(sessionId)
  }

  private scheduleReadDemandExpiry(sessionId: string): void {
    this.clearReadDemandExpiryTimer(sessionId)

    const timer = setTimeout(() => {
      if (this.readDemandExpiryTimers.get(sessionId) !== timer) {
        return
      }
      this.readDemandExpiryTimers.delete(sessionId)
      this.syncSessionOutputFlowControl(sessionId)
    }, READ_OUTPUT_DEMAND_WINDOW_MS)

    this.readDemandExpiryTimers.set(sessionId, timer)
  }

  private terminateSessionProcessTree(
    session: PtySession,
    options?: {
      gracefulSignal?: NodeJS.Signals
      forceSignal?: NodeJS.Signals
      forceAfterMs?: number
    },
  ): void {
    this.processTerminator.terminateTree(session.pid ?? 0, options)
  }

  private emitAgentSessionClosedIfNeeded(
    session: PtySession,
    reason: PtySessionCloseReason,
  ): void {
    if (!session.spaceId || session.closeEventEmitted) {
      return
    }

    session.closeEventEmitted = true
    const event: AgentSessionClosedInfo = {
      sessionId: session.id,
      spaceId: session.spaceId,
      reason,
    }
    this.emit('agent-session-closed', event)
  }

  private finalizeSessionTermination(
    session: PtySession,
    options: {
      reason: PtySessionCloseReason
      exitCode: number | null
      removeSession: boolean
      disposeWriteChannel: boolean
    },
  ): void {
    if (session.terminationFinalized) {
      if (options.removeSession && this.sessionStore.hasSession(session.id)) {
        this.sessionStore.deleteSession(session.id)
      }
      return
    }

    this.clearReadDemandExpiryTimer(session.id)

    // Delegate core finalization (pending command resolution, watcher cleanup,
    // session state update) to PtyCommandRunner (EM-1)
    this.commandRunner.finalizeSession(session, {
      exitCode: options.exitCode,
      removeSession: options.removeSession,
      disposeWriteChannel: options.disposeWriteChannel,
    })

    session.outputPaused = false
    this.emitAgentSessionClosedIfNeeded(session, options.reason)
  }

  private handleSessionExit(session: PtySession, exitCode: number | null, signal?: number): void {
    this.clearResizeState(session.id)
    const resolvedExitCode = exitCode ?? 128
    this.finalizeSessionTermination(session, {
      reason: 'exit',
      exitCode: resolvedExitCode,
      removeSession: false,
      disposeWriteChannel: false,
    })
    // Close (not dispose) write channel on natural exit — allows queued writes
    // to drain before shutdown, matching PtyCommandRunner.handleExit behavior.
    session.writeChannel?.close()
    // P1-STB-3: 自然退出时也释放 listener disposable
    this.disposeSessionListeners(session.id)
    this.updatePaneStatus(session.id, 'exited', resolvedExitCode)
    this.emit('exit', session.id, resolvedExitCode, signal)

    // P2-02: 自然退出的 session 延迟 5 秒后从 store 移除，释放 MAX_SESSIONS 配额
    // 避免 Agent 批量执行时因退出 session 占用配额而耗尽
    const exitedSessionId = session.id
    setTimeout(() => {
      if (this.sessionStore.hasSession(exitedSessionId)) {
        log.info(`removing naturally exited session: ${exitedSessionId}`)
        this.lastAutoCheckpointAt.delete(exitedSessionId)
        this.sessionStore.deleteSession(exitedSessionId)
      }
    }, 5_000)
  }

  /**
   * Agent 命令执行前自动快照（轻量、不阻塞命令执行）
   * - 仅对 Agent session 生效
   * - 频率限制：同一 session 两次快照间隔至少 AUTO_CHECKPOINT_MIN_INTERVAL_MS
   * - 异步执行，不 await（fire-and-forget）
   */
  private fireAutoCheckpoint(session: PtySession): void {
    const now = Date.now()
    const lastAt = this.lastAutoCheckpointAt.get(session.id) ?? 0
    if (now - lastAt < AUTO_CHECKPOINT_MIN_INTERVAL_MS) {
      return // 频率限制：跳过
    }
    this.lastAutoCheckpointAt.set(session.id, now)

    const rawOutput = session.outputBuffer.readAll()
    if (!rawOutput.trim()) return // 空输出无需快照

    const snapshot: TerminalSnapshot = {
      sessionId: session.id,
      ansiOutput: rawOutput,
      cwd: session.cwd,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      capturedAt: now,
      checkpointType: 'auto',
    }

    // fire-and-forget：不阻塞命令执行
    saveAutoCheckpoint(snapshot).then((saved) => {
      if (saved) {
        this.emit('auto-checkpoint-saved', {
          sessionId: session.id,
          spaceId: session.spaceId,
          capturedAt: now,
        })
      }
    }).catch((err) => {
      log.warn(`auto checkpoint 异常: ${session.id}`, err)
    })
  }

  triggerAutoCheckpoint(sessionId: string): void {
    const session = this.sessionStore.getSession(sessionId)
    if (session && this.isAgentSession(session)) {
      this.fireAutoCheckpoint(session)
    }
  }

  /**
   * 降级路径专用：await 等待 Checkpoint 保存完成（比普通命令更积极）。
   * 与 fireAutoCheckpoint 共享频率限制逻辑，但保证保存完成后才继续执行。
   */
  private async fireAutoCheckpointSync(session: PtySession): Promise<void> {
    const now = Date.now()
    const lastAt = this.lastAutoCheckpointAt.get(session.id) ?? 0
    if (now - lastAt < AUTO_CHECKPOINT_MIN_INTERVAL_MS) {
      return
    }
    this.lastAutoCheckpointAt.set(session.id, now)

    const rawOutput = session.outputBuffer.readAll()
    if (!rawOutput.trim()) return

    const snapshot: TerminalSnapshot = {
      sessionId: session.id,
      ansiOutput: rawOutput,
      cwd: session.cwd,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      capturedAt: now,
      checkpointType: 'auto',
    }

    try {
      const saved = await saveAutoCheckpoint(snapshot)
      if (saved) {
        this.emit('auto-checkpoint-saved', {
          sessionId: session.id,
          spaceId: session.spaceId,
          capturedAt: now,
        })
      }
    } catch (err) {
      log.warn(`auto checkpoint 异常 (降级路径): ${session.id}`, err)
    }
  }

  /**
   * PTY 策略降级执行：当 PTY 不支持 sandbox/network-restricted 策略时，
   * 降级到 CommandExecutor spawn+sandbox 执行，并将输出推送到 PTY 数据通道。
   * 核心逻辑已提取到 @tabtin/terminal-core 的 executeDegraded。
   */
  private async executeDegradedCommand(
    sessionId: string,
    command: string,
    degradation: DegradationDecision,
    options?: {
      blockUntilMs?: number
      workingDirectory?: string
      context?: TerminalExecutionContext
      policy?: TerminalExecutionPolicy
      autoRespond?: AutoRespondRule[]
      killOnTimeout?: boolean
    },
  ): Promise<ExecuteCommandResult> {
    if (this.sessionStore.hasPendingCommand(sessionId)) {
      throw new Error(`Session ${sessionId} already has a pending command`)
    }

    const session = this.sessionStore.getSession(sessionId)

    // 降级前触发 Checkpoint — await 确保保存完成（比普通命令更积极）
    if (session && this.isAgentSession(session)) {
      await this.fireAutoCheckpointSync(session)
    }

    const cwd = options?.workingDirectory
      || options?.context?.workingDirectory
      || session?.cwd
      || process.cwd()

    this.updatePaneStatus(sessionId, 'running')

    const timeoutMs = options?.blockUntilMs != null && options.blockUntilMs > 0
      ? options.blockUntilMs
      : undefined

    const result = await executeDegraded({
      command,
      cwd,
      degradation,
      threadId: options?.context?.threadId,
      timeout: timeoutMs,
      onOutput: (data) => this.emitToSession(sessionId, data),
    })

    if (result.interactiveBlocked) {
      this.emitToSession(sessionId,
        '\r\n\x1b[33m⚡ 检测到交互式命令，需要人工确认\x1b[0m\r\n')
      this.updatePaneStatus(sessionId, 'idle')
      const detail = `${command.length > 200 ? command.slice(0, 200) + '…' : command}\n\n⚠ ${result.interactiveReason}`
      const requestInteractiveApproval = () => requestApproval({
        actionType: 'interactive_command',
        detail,
        mode: 'pty_direct',
        reason: result.interactiveReason || undefined,
        isStrict: true,
      })
      const threadId = options?.context?.threadId?.trim()
      const { approved } = threadId
        ? await runWithHumanInteractionContext(
            { threadId, interactionMode: 'interactive' },
            requestInteractiveApproval,
          )
        : await requestInteractiveApproval()
      if (!approved) {
        throw new Error(
          `Interactive command requires approval but was denied: ${result.interactiveReason}`,
        )
      }
      return this.executeCommandViaPtyRunner(sessionId, command, {
        blockUntilMs: options?.blockUntilMs,
        env: mergeCurrentCLIServerEnv(
          mergeSpaceIdIntoEnv(options?.context?.env, options?.context?.spaceId),
        ),
        workingDirectory: cwd,
        autoRespond: options?.autoRespond,
        killOnTimeout: options?.killOnTimeout,
      })
    }

    this.emitToSession(sessionId,
      `\r\n\x1b[33m⚡ 安全执行完成 (exit: ${result.exitCode})\x1b[0m\r\n`)

    this.updatePaneStatus(sessionId, 'idle')

    return {
      output: result.stdout || result.stderr,
      exitCode: result.exitCode,
      cwd: result.cwd,
      backgrounded: false,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      sessionId,
    }
  }

  private clearResizeState(sessionId: string): void {
    const timer = this.resizeTimers.get(sessionId)
    if (timer) clearTimeout(timer)
    this.resizeTimers.delete(sessionId)
    this.pendingResizes.delete(sessionId)
  }

  /**
   * P1-STB-3: 释放指定 session 的所有 pty listener disposable
   */
  private disposeSessionListeners(sessionId: string): void {
    const disposables = this.sessionDisposables.get(sessionId)
    if (disposables) {
      for (const d of disposables) {
        try {
          d.dispose()
        } catch (err) {
          log.warn(`dispose listener failed: session=${sessionId}`, err)
        }
      }
      this.sessionDisposables.delete(sessionId)
    }
  }

  /**
   * P0-F1: restart a session's shell process in-place after a command could not
   * be stopped via Ctrl+C. Keeps the session entry (preserving spaceId, thread
   * mappings, etc.) and replaces only the underlying PTY process.
   */
  private restartSessionShell(sessionId: string): boolean {
    const session = this.sessionStore.getSession(sessionId)
    if (!session) return false

    log.info(`♻️ Restarting session shell: ${sessionId}`)

    this.clearResizeState(sessionId)
    session.needsRestart = false

    try {
      session.pty.kill()
    } catch (err) {
      log.warn(`restart: kill old PTY failed: ${sessionId}`, err)
    }
    this.terminateSessionProcessTree(session, {
      gracefulSignal: 'SIGKILL',
      forceSignal: 'SIGKILL',
      forceAfterMs: 0,
    })

    session.writeChannel?.dispose()
    this.disposeSessionListeners(sessionId)

    const pending = this.sessionStore.deletePendingCommand(sessionId)
    if (pending) {
      if (pending.timer) clearTimeout(pending.timer)
      if (pending.autoRespondTimers) {
        for (const t of pending.autoRespondTimers) clearTimeout(t)
      }
      pending.resolve({
        output: '',
        exitCode: null,
        cwd: session.cwd,
        backgrounded: false,
        timedOut: false,
        durationMs: Date.now() - pending.startedAt,
        sessionId,
      })
    }
    this.sessionStore.deleteBackgroundedWatchers(sessionId)

    const shell = resolveShell()
    // 多 Electron 实例不能依赖全局 discovery：隔离实例不发布 server.json，
    // 交互式 shell 必须显式绑定当前主进程自己的 CLI Server。
    const cliEnv = mergeCurrentCLIServerEnv(session.cliTransportEnv) ?? {}
    const resolvedSpaceId = session.spaceId || process.env.TABTIN_SPACE_ID || process.env.TABTIN_AGENT_SPACE_ID
    if (resolvedSpaceId) {
      cliEnv.TABTIN_SPACE_ID = resolvedSpaceId
      cliEnv.TABTIN_AGENT_SPACE_ID = resolvedSpaceId
    }
    const resolvedOrganizationId = process.env.TABTIN_ORGANIZATION_ID
    if (resolvedOrganizationId) {
      cliEnv.TABTIN_ORGANIZATION_ID = resolvedOrganizationId
    }
    const restartAgentEnv = this.isAgentSession(session) ? { TABTIN_AGENT: '1' } : {}
    const env = {
      ...sanitizeEnv(process.env),
      ...cliEnv,
      ...restartAgentEnv,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    }

    try {
      const newPty = this.hostClient.spawn({
        shell,
        cwd: session.cwd,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        env: env as Record<string, string>,
        termName: 'xterm-256color',
      })

      session.pty = newPty
      session.pid = newPty.pid
      session.isRunning = true
      session.shellType = detectShellType(shell)
      session.terminationFinalized = false
      session.lastExitCode = null
      session.outputPaused = false
      session.titleEmitted = false

      session.writeChannel = new PtyWriteChannel(newPty, {
        onWriteError: (error, chunk) => {
          const chunkPreview = chunk ? chunk.slice(0, 120) : '<empty>'
          log.warn(
            `write channel error: session=${sessionId}, chunk=${JSON.stringify(chunkPreview)}`,
            error,
          )
        },
      })

      const disposables: Array<{ dispose(): void }> = []
      disposables.push(newPty.onSpawned(({ pid }) => {
        session.pid = pid
      }))
      disposables.push(newPty.onData((data: string) => {
        this.appendToOutputBuffer(sessionId, data)
        this.emit('data', sessionId, data)
      }))
      disposables.push(newPty.onExit(({ exitCode, signal }) => {
        log.info(`会话退出: ${sessionId}, exitCode=${exitCode}, signal=${signal}`)
        this.handleSessionExit(session, exitCode ?? null, signal)
      }))
      this.sessionDisposables.set(sessionId, disposables)

      this.updatePaneStatus(sessionId, 'idle')
      this.syncSessionOutputFlowControl(sessionId)

      this.emit('session-restarted', {
        sessionId,
        spaceId: session.spaceId ?? null,
        newPid: newPty.pid,
      })

      log.info(`✅ Session restarted: ${sessionId}, newPid=${newPty.pid}`)
      return true
    } catch (error) {
      log.error(`❌ Session restart failed: ${sessionId}`, error)
      session.isRunning = false
      session.needsRestart = true
      return false
    }
  }

  /**
   * TT-04: PtyCommandRunner 直接回调 — session 被标记为需要重启时触发重启。
   * 提取为方法以便单元测试可直接调用，无需解析日志字符串。
   */
  private handleNeedsRestartCallback(sessionId: string): void {
    const session = this.sessionStore.getSession(sessionId)
    if (session?.needsRestart) {
      this.restartSessionShell(sessionId)
    }
  }

  /**
   * TT-04: PtyCommandRunner 直接回调 — auto-respond 规则匹配并响应后触发。
   * 提取为方法以便单元测试可直接调用。
   */
  private handleAutoRespondCallback(sessionId: string, pattern: string): void {
    const session = this.sessionStore.getSession(sessionId)
    this.emit('auto-respond-triggered', {
      sessionId,
      spaceId: session?.spaceId ?? null,
      pattern,
      responseLength: 0,
      timestamp: Date.now(),
    })
  }

  spawn(sessionId: string, options: PtySpawnOptions = {}): boolean {
    if (this.sessionStore.hasSession(sessionId)) {
      log.warn(`会话已存在: ${sessionId}`)
      return false
    }

    if (this.sessionStore.getSessionCount() >= MAX_SESSIONS) {
      log.warn(`已达会话上限 (${MAX_SESSIONS})，无法创建: ${sessionId}`)
      return false
    }

    const cwd = resolveCwd(options.cwd)
    const size = normalizeSize(options.cols, options.rows)
    const cols = size.cols
    const rows = size.rows
    const shell = resolveShell()

    const cliEnv: Record<string, string> = {}
    // Phase 4：桌面终端（noSpaceBinding）不绑 Space —— 不从全局 env 兜底注入 spaceId。
    const resolvedSpaceId = options.noSpaceBinding
      ? undefined
      : (options.spaceId || process.env.TABTIN_SPACE_ID || process.env.TABTIN_AGENT_SPACE_ID)
    if (resolvedSpaceId) {
      cliEnv.TABTIN_SPACE_ID = resolvedSpaceId
      cliEnv.TABTIN_AGENT_SPACE_ID = resolvedSpaceId
    }
    const resolvedOrganizationId = process.env.TABTIN_ORGANIZATION_ID
    if (resolvedOrganizationId) {
      cliEnv.TABTIN_ORGANIZATION_ID = resolvedOrganizationId
    }

    const agentEnv = isAgentSessionId(sessionId) ? { TABTIN_AGENT: '1' } : {}
    const optionEnv = options.env ?? {}
    const explicitTransportEnv = Object.fromEntries(
      ['TABTIN_SOCK', '_TABTIN_TRANSPORT_TOKEN']
        .filter((key) => key in optionEnv)
        .map((key) => [key, optionEnv[key]]),
    ) as Record<string, string>
    const sessionEnv = mergeCurrentCLIServerEnv({
      ...sanitizeEnv(optionEnv as NodeJS.ProcessEnv),
      ...explicitTransportEnv,
    }) ?? {}
    const baseEnv = {
      ...sanitizeEnv(process.env),
      ...cliEnv,
      ...agentEnv,
      ...sessionEnv,
    } as Record<string, string | undefined>
    const env = {
      ...baseEnv,
      // 打包版缺 LANG 时补 UTF-8 locale 兜底，修中文乱码。
      // app 在非 Electron / 单测上下文可能不可用，守卫后回退空串（→ en_US.UTF-8）。
      ...resolveDefaultLocaleEnv(baseEnv, app?.getLocale?.() ?? ''),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor'
    }
    // 桌面终端：剔除从 process.env 展开进来的活跃 Space 变量（cliEnv 已不注入），
    // 确保 shell 内 tabtin CLI 不会误把命令落到当前活跃 Space。
    if (options.noSpaceBinding) {
      const mutableEnv = env as Record<string, string | undefined>
      delete mutableEnv.TABTIN_SPACE_ID
      delete mutableEnv.TABTIN_AGENT_SPACE_ID
    }

    let ptyProcess: ReturnType<PtyHostClient['spawn']> | SyntheticPtyHostSession | null = null
    try {
      ptyProcess = options.synthetic
        ? new SyntheticPtyHostSession()
        : this.hostClient.spawn({
            shell,
            cwd,
            cols,
            rows,
            env: env as Record<string, string>,
            termName: 'xterm-256color',
          })

      const writeChannel = options.synthetic
        ? undefined
        : new PtyWriteChannel(ptyProcess, {
            onWriteError: (error, chunk) => {
              const chunkPreview = chunk ? chunk.slice(0, 120) : '<empty>'
              log.warn(
                `write channel error: session=${sessionId}, chunk=${JSON.stringify(chunkPreview)}`,
                error,
              )
            },
          })

      const now = Date.now()
      const session: PtySession = {
        id: sessionId,
        pty: ptyProcess,
        writeChannel,
        cwd,
        cliTransportEnv: Object.keys(explicitTransportEnv).length > 0
          ? explicitTransportEnv
          : undefined,
        shellType: detectShellType(shell),
        createdAt: now,
        outputBuffer: new PtyOutputBuffer(MAX_OUTPUT_BUFFER_BYTES),
        lastOutputAt: now,
        pid: ptyProcess.pid,
        isRunning: true,
        lastExitCode: null,
        lastCommandCompletedAt: null,
        terminationFinalized: false,
        closeEventEmitted: false,
        rendererDataSubscribed: false,
        outputPaused: false,
        lastReadDemandAt: null,
      }

      this.sessionStore.createSession(session)

      // P1-STB-3: 保存 listener disposable，session 销毁时统一释放
      const disposables: Array<{ dispose(): void }> = []

      disposables.push(ptyProcess.onSpawned(({ pid }) => {
        session.pid = pid
      }))

      disposables.push(ptyProcess.onData((data: string) => {
        // P2-01: 先更新 buffer 再 emit，避免 listener 异常导致 buffer 不更新、marker 检测失败
        this.appendToOutputBuffer(sessionId, data)
        this.emit('data', sessionId, data)
      }))

      disposables.push(ptyProcess.onExit(({ exitCode, signal }) => {
        log.info(`会话退出: ${sessionId}, exitCode=${exitCode}, signal=${signal}`)
        this.handleSessionExit(session, exitCode ?? null, signal)
      }))

      this.sessionDisposables.set(sessionId, disposables)

      this.updatePaneStatus(sessionId, 'idle')
      this.syncSessionOutputFlowControl(sessionId)

      log.info(
        `✅ 创建会话: ${sessionId}, shell=${options.synthetic ? 'synthetic' : shell}, cwd=${cwd}, pid=${ptyProcess.pid}`,
      )
      return true
    } catch (error) {
      log.error(`❌ 创建会话失败: ${sessionId}`, error)

      // EM-15: 回滚 — 如果 pty 进程已创建但后续步骤失败，kill 孤儿进程并清理 session
      if (ptyProcess) {
        try {
          ptyProcess.kill()
        } catch (killError) {
          log.warn(`回滚 kill 失败: ${sessionId}`, killError)
        }
        // P1-STB-3: 回滚 listener disposable
        this.disposeSessionListeners(sessionId)
        // 清理可能已创建的 session 记录
        if (this.sessionStore.hasSession(sessionId)) {
          this.sessionStore.deleteSession(sessionId)
        }
      }

      return false
    }
  }

  /**
   * 向 pty 写入数据
   */
  write(sessionId: string, data: string): boolean {
    const session = this.sessionStore.getSession(sessionId)
    if (!session) {
      log.warn(`会话不存在: ${sessionId}`)
      return false
    }

    try {
      return this.enqueueSessionWrite(session, data, 'user')
    } catch (error) {
      log.error(`写入失败: ${sessionId}`, error)
      return false
    }
  }

  /**
   * 调整 pty 大小（leading + trailing debounce）
   *
   * 首次调用立即执行（用户零延迟感知），后续调用在 RESIZE_DEBOUNCE_MS 窗口内
   * 合并为一次 trailing 执行。trailing 回调内重新从 sessionStore 获取 session，
   * 避免闭包捕获 stale 引用（如 restartSessionShell 期间 pty 被替换）。
   */
  resize(sessionId: string, cols: number, rows: number): boolean {
    const session = this.sessionStore.getSession(sessionId)
    if (!session) {
      log.warn(`会话不存在: ${sessionId}`)
      return false
    }

    if (!this.resizeTimers.has(sessionId)) {
      // Leading edge: 立即执行
      try {
        session.pty.resize(cols, rows)
      } catch (error) {
        log.error(`resize 失败: ${sessionId}`, error)
        return false
      }
      this.resizeTimers.set(sessionId, setTimeout(() => {
        this.resizeTimers.delete(sessionId)
        const pending = this.pendingResizes.get(sessionId)
        this.pendingResizes.delete(sessionId)
        if (!pending) return
        const freshSession = this.sessionStore.getSession(sessionId)
        if (freshSession) {
          try { freshSession.pty.resize(pending.cols, pending.rows) } catch {}
        }
      }, RESIZE_DEBOUNCE_MS))
    } else {
      // Debounce 窗口内：仅记录最新尺寸，等 trailing edge 执行
      this.pendingResizes.set(sessionId, { cols, rows })
    }
    return true
  }

  kill(
    sessionId: string,
    reason: PtySessionCloseReason = 'kill',
    signalOpts?: {
      gracefulSignal?: NodeJS.Signals
      forceSignal?: NodeJS.Signals
      forceAfterMs?: number
    },
  ): boolean {
    const session = this.sessionStore.getSession(sessionId)
    if (!session) {
      log.warn(`会话不存在: ${sessionId}`)
      return false
    }

    this.clearResizeState(sessionId)

    // P1-STB-1: 先 finalize（标记 terminationFinalized=true），这样后续 onExit 回调
    // 触发 handleSessionExit 时会因 terminationFinalized 直接跳过，避免冗余事件。
    // 注意：先 finalize 再 kill 进程，而非先从 store 删除再 kill。
    this.finalizeSessionTermination(session, {
      reason,
      exitCode: null,
      removeSession: false, // 先不删除，等 kill 和 process tree 清理完成后再删
      disposeWriteChannel: true,
    })

    try {
      session.pty.kill()
    } catch (error) {
      log.warn(`终止失败 (force removing): ${sessionId}`, error)
    }
    // 默认 graceful 策略：cleanup 走 SIGKILL，普通 kill 走 SIGTERM + 750ms 回退 SIGKILL；
    // 调用方可通过 signalOpts 覆盖（bridge AgentKillSignal: SIGINT / SIGTERM / SIGKILL）。
    this.terminateSessionProcessTree(session, {
      gracefulSignal: signalOpts?.gracefulSignal ?? (reason === 'cleanup' ? 'SIGKILL' : 'SIGTERM'),
      forceSignal: signalOpts?.forceSignal ?? 'SIGKILL',
      forceAfterMs: signalOpts?.forceAfterMs ?? (reason === 'cleanup' ? 0 : 750),
    })

    // P1-STB-3: 释放 pty listener disposable
    this.disposeSessionListeners(sessionId)

    // P2-03: 清理 lastAutoCheckpointAt，防止内存泄漏
    this.lastAutoCheckpointAt.delete(sessionId)

    // P1-STB-1: kill 和 process tree 清理完成后，再从 store 删除 session
    this.sessionStore.deleteSession(sessionId)

    this.updatePaneStatus(sessionId, 'exited', null)

    log.info(`⏹️ 终止会话: ${sessionId}, reason=${reason}`)
    return true
  }

  has(sessionId: string): boolean {
    return this.sessionStore.hasSession(sessionId)
  }

  getSession(sessionId: string): PtySession | undefined {
    return this.sessionStore.getSession(sessionId)
  }

  getAllSessionIds(): string[] {
    return this.sessionStore.getAllSessionIds()
  }

  getSessionCount(): number {
    return this.sessionStore.getSessionCount()
  }


  getSessionOutput(
    sessionId: string,
    options?: { tail?: number; sinceCursor?: number },
  ): {
    output: string
    metadata: {
      pid: number
      cwd: string
      isRunning: boolean
      lastOutputAt: number
      lastExitCode: number | null
      lastCommandCompletedAt: number | null
      hasPendingCommand: boolean
      // RT-4 R1：cursor 增量读支持字段。
      nextCursor: number
      totalBytes: number
      overflowed: boolean
    }
  } | null {
    const session = this.sessionStore.getSession(sessionId)
    if (!session) return null
    session.lastReadDemandAt = Date.now()
    this.syncSessionOutputFlowControl(sessionId)
    this.scheduleReadDemandExpiry(sessionId)
    const buf = session.outputBuffer
    // RT-4 R1：cursor 增量优先（readFromCursor 只读新增 chunk + cleanOutput 增量
    // 片段），其次 tail，最后全量。前台 poll 走 sinceCursor 把每轮 O(n) 全量
    // readAll + cleanOutput 降到 O(增量)，消除累积 O(n²)。
    let rawOutput: string
    if (options?.sinceCursor != null) {
      rawOutput = buf.readFromCursor(options.sinceCursor)
    } else if (options?.tail) {
      rawOutput = buf.readTail(options.tail)
    } else {
      rawOutput = buf.readAll()
    }
    return {
      output: cleanOutput(rawOutput),
      metadata: {
        pid: session.pid ?? 0,
        cwd: session.cwd,
        isRunning: session.isRunning,
        lastOutputAt: session.lastOutputAt,
        lastExitCode: session.lastExitCode,
        lastCommandCompletedAt: session.lastCommandCompletedAt,
        hasPendingCommand: this.sessionStore.hasPendingCommand(sessionId),
        // 下次增量读应传入的 cursor（= 末尾 chunk cursor + 1）。
        nextCursor: buf.createCursor(),
        // buffer 当前累计字节（raw，环形 evict 后为现存量）。
        totalBytes: buf.getTotalBytes(),
        overflowed: buf.hasOverflowed(),
      },
    }
  }

  getAllSessionsWithStatus(spaceId?: string): Array<{
    id: string
    pid: number
    cwd: string
    isRunning: boolean
    lastOutputAt: number
    createdAt: number
    lastExitCode: number | null
    lastCommandCompletedAt: number | null
    hasPendingCommand: boolean
  }> {
    let sessions = this.sessionStore.getAllSessions()
    if (spaceId) {
      sessions = sessions.filter(s => s.spaceId === spaceId)
    }
    return sessions.map((s) => ({
      id: s.id,
      pid: s.pid ?? 0,
      cwd: s.cwd,
      isRunning: s.isRunning,
      lastOutputAt: s.lastOutputAt,
      createdAt: s.createdAt,
      lastExitCode: s.lastExitCode,
      lastCommandCompletedAt: s.lastCommandCompletedAt,
      hasPendingCommand: this.sessionStore.hasPendingCommand(s.id),
    }))
  }

  hasPendingCommand(sessionId: string): boolean {
    return this.sessionStore.hasPendingCommand(sessionId)
  }

  setRendererDataSubscription(sessionId: string, subscribed: boolean): void {
    const session = this.sessionStore.getSession(sessionId)
    if (!session) return
    session.rendererDataSubscribed = subscribed
    this.syncSessionOutputFlowControl(sessionId)
  }

  async executeCommand(
    sessionId: string,
    command: string,
    options?: {
      blockUntilMs?: number
      workingDirectory?: string
      context?: TerminalExecutionContext
      policy?: TerminalExecutionPolicy
      autoRespond?: AutoRespondRule[]
      killOnTimeout?: boolean
    },
  ): Promise<ExecuteCommandResult> {
    // Defense-in-depth: explicit blocked-route guard (aligned with Daemon's daemon-pty-manager)
    if (options?.policy?.route === 'blocked') {
      throw new Error(
        `Command blocked by security policy: ${options.policy.denyReason || 'execution not allowed by current sandbox policy'}`,
      )
    }

    const unsupportedPolicyError = getInteractiveTerminalPolicySupportError(options?.policy)
    if (unsupportedPolicyError) {
      const degradation = evaluateTerminalPolicyDegradation(options?.policy)
      if (degradation?.canDegrade) {
        log.warn(
          `PTY policy unsupported, degrading to sandboxed spawn: session=${sessionId}, route=${options?.policy?.route}`,
        )
        return this.executeDegradedCommand(sessionId, command, degradation, options)
      }
      throw new Error(unsupportedPolicyError)
    }

    // Agent 命令执行前自动快照（仅 Agent session，不阻塞执行）
    const currentSession = this.sessionStore.getSession(sessionId)
    if (currentSession && this.isAgentSession(currentSession)) {
      this.fireAutoCheckpoint(currentSession)
    }

    // Security policy check has been unified at the FrontendActionBridge layer
    // (PolicyEvaluator.evaluate). PtyManager retains a defensive baseline check
    // using evaluateLocalTerminalPolicy as a safety net — blocked commands should
    // not normally reach this point.
    const policyDecision = evaluateLocalTerminalPolicy(
      command,
      options?.policy,
    )
    if (policyDecision.blocked) {
      const session = this.sessionStore.getSession(sessionId)
      return {
        output: policyDecision.denyReason || 'Command blocked by security policy.',
        exitCode: 126,
        cwd: session?.cwd ?? '',
        backgrounded: false,
        timedOut: false,
        durationMs: 0,
        sessionId,
      }
    }

    return this.executeCommandViaPtyRunner(sessionId, command, {
      blockUntilMs: options?.blockUntilMs,
      env: mergeCurrentCLIServerEnv(
        mergeSpaceIdIntoEnv(
          options?.context?.env as Record<string, string> | undefined,
          options?.context?.spaceId,
        ),
      ),
      workingDirectory: options?.workingDirectory ?? options?.context?.workingDirectory,
      autoRespond: options?.autoRespond,
      killOnTimeout: options?.killOnTimeout,
    })
  }

  private async executeCommandViaPtyRunner(
    sessionId: string,
    command: string,
    options?: {
      blockUntilMs?: number
      env?: Record<string, string>
      workingDirectory?: string
      shellType?: ShellType
      autoRespond?: AutoRespondRule[]
      killOnTimeout?: boolean
    },
  ): Promise<ExecuteCommandResult> {
    // P0-F1: pre-flight check — if a previous timeout left the session in
    // needsRestart state, restart the shell before executing the new command.
    const preflight = this.sessionStore.getSession(sessionId)
    if (preflight?.needsRestart) {
      const restarted = this.restartSessionShell(sessionId)
      if (!restarted) {
        throw new Error(
          `Session ${sessionId} requires restart after an unresponsive command, but restart failed`,
        )
      }
    }

    // Delegate the entire command execution pipeline to PtyCommandRunner (EM-1).
    // PtyCommandRunner handles: marker generation, pending command lifecycle,
    // backgrounded watchers, auto-respond, incremental scanning (EM-2), and
    // buffer overflow detection.
    this.updatePaneStatus(sessionId, 'running')
    this.syncSessionOutputFlowControl(sessionId)

    try {
      const resultPromise = this.commandRunner.execute(sessionId, command, {
        blockUntilMs: options?.blockUntilMs,
        env: options?.env,
        workingDirectory: options?.workingDirectory,
      shellType: options?.shellType ?? preflight?.shellType ?? resolveCurrentShellType(),
        autoRespond: options?.autoRespond,
        killOnTimeout: options?.killOnTimeout ?? true,
      })
      // `PtyCommandRunner.execute()` registers the pending command synchronously.
      // Re-sync once more so paused sessions resume before the write reaches a
      // subprocess PTY host; otherwise buffered input can stall behind pause state.
      this.syncSessionOutputFlowControl(sessionId)
      const result = await resultPromise

      // Post-execution side effects
      if (!result.backgrounded) {
        this.updatePaneStatus(sessionId, 'idle')
      }
      // P1-H (WP2)：emit `agent-session-title` 链路已退役（见 appendToOutputBuffer 注释）。
      this.syncSessionOutputFlowControl(sessionId)

      return result
    } catch (error) {
      // P2-04: catch 中先检查 session 是否仍存在于 store，不存在则跳过 updatePaneStatus
      // 避免对已删除的 session 写入 status 导致永久残留
      if (this.sessionStore.hasSession(sessionId)) {
        this.updatePaneStatus(sessionId, 'idle')
        this.syncSessionOutputFlowControl(sessionId)
      }
      throw error
    }
  }

  spawnAgentSession(
    spaceId: string,
    options?: { cwd?: string; threadId?: string },
  ): string | null {
    // S6-B1: 防止超出 UI pane 上限导致 PTY 资源泄漏
    const runningAgentCount = this.sessionStore.getAllSessions()
      .filter(s => s.spaceId === spaceId && s.isRunning)
      .length
    if (runningAgentCount >= MAX_AGENT_SESSIONS_PER_SPACE) {
      log.warn(
        `Agent session limit per space reached: ${spaceId} (${runningAgentCount}/${MAX_AGENT_SESSIONS_PER_SPACE})`,
      )
      return null
    }

    const sessionId = `agent-${spaceId}-${Date.now()}`
    const success = this.spawn(sessionId, {
      cwd: options?.cwd,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      spaceId,
    })
    if (!success) return null

    const session = this.sessionStore.getSession(sessionId)
    if (session) {
      session.spaceId = spaceId
    }

    if (options?.threadId) {
      this.sessionStore.setThreadSession(options.threadId, sessionId)
    }

    this.emit('agent-session-created', {
      sessionId,
      spaceId,
      threadId: options?.threadId || null,
      cwd: resolveCwd(options?.cwd),
    })

    return sessionId
  }

  getOrSpawnAgentSession(
    threadId: string,
    spaceId: string,
    options?: { cwd?: string },
  ): string | null {
    const existingSessionId = this.sessionStore.getThreadSession(threadId)
    if (existingSessionId) {
      const session = this.sessionStore.getSession(existingSessionId)
      if (session && session.isRunning) {
        return existingSessionId
      }
      this.sessionStore.deleteThreadSession(threadId)
    }

    return this.spawnAgentSession(spaceId, {
      cwd: options?.cwd,
      threadId,
    })
  }

  resolveThreadSession(threadId: string): string | null {
    const sessionId = this.sessionStore.getThreadSession(threadId)
    if (!sessionId) return null
    const session = this.sessionStore.getSession(sessionId)
    if (session && session.isRunning) return sessionId
    return null
  }

  releaseThreadSession(threadId: string): void {
    const sessionId = this.sessionStore.getThreadSession(threadId)
    if (sessionId) {
      this.sessionStore.deleteThreadSession(threadId)
      log.debug(`released thread mapping: ${threadId} -> ${sessionId}`)
    }
  }

  cleanup(): void {
    log.info(`清理所有会话 (${this.sessionStore.getSessionCount()} 个)`)
    if (this.idleTimer) {
      clearInterval(this.idleTimer)
      this.idleTimer = null
    }

    for (const [sessionId, session] of Array.from(this.sessionStore.getSessionEntries())) {
      this.clearResizeState(sessionId)
      this.clearReadDemandExpiryTimer(sessionId)
      this.finalizeSessionTermination(session, {
        reason: 'cleanup',
        exitCode: null,
        removeSession: true,
        disposeWriteChannel: true,
      })
      try {
        session.pty.kill('SIGKILL')
      } catch (error) {
        log.warn(`清理会话失败: ${sessionId}`, error)
      }
      this.terminateSessionProcessTree(session, {
        gracefulSignal: 'SIGKILL',
        forceSignal: 'SIGKILL',
        forceAfterMs: 0,
      })
      // P1-STB-3: 释放 listener disposable
      this.disposeSessionListeners(sessionId)
    }

    this.sessionStore.clear()
    this.paneStatuses.clear()
    for (const timer of this.paneStatusCleanupTimers.values()) {
      clearTimeout(timer)
    }
    this.paneStatusCleanupTimers.clear()

    // EM-5: 清理可能残留的 readDemandExpiryTimers（orphan timer 防泄漏）
    for (const timer of this.readDemandExpiryTimers.values()) {
      clearTimeout(timer)
    }
    this.readDemandExpiryTimers.clear()
    // P2-resize: 兜底清理残留的 resize timer（正常路径已在循环中逐个清理）
    for (const timer of this.resizeTimers.values()) {
      clearTimeout(timer)
    }
    this.resizeTimers.clear()
    this.pendingResizes.clear()
    this.lastAutoCheckpointAt.clear()
    // P1-STB-3: 清理可能残留的 sessionDisposables（兜底，正常路径已在循环中 dispose）
    this.sessionDisposables.clear()
  }
}

// 单例
let instance: PtyManager | null = null

export function getPtyManager(): PtyManager {
  if (!instance) {
    instance = new PtyManager()
  }
  return instance
}

export function destroyPtyManager(): void {
  if (instance) {
    instance.cleanup()
    instance.removeAllListeners()
    instance = null
  }
}
