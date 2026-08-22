import type { PtyHostSession } from './PtyHost'
import { PtyOutputBuffer } from './PtyOutputBuffer'
import type { PtyWriteChannel } from './PtyWriteChannel'
import type { ShellType } from './marker/command-wrapper'

export interface ExecuteCommandResult {
  output: string
  exitCode: number | null
  cwd: string
  backgrounded: boolean
  timedOut: boolean
  durationMs: number
  sessionId: string
  /** 命令被检测为交互式，降级执行被阻断（需上层发起 HITL 确认） */
  interactiveBlocked?: boolean
  /** 交互式检测的原因描述 */
  interactiveReason?: string
  /** 匹配到的交互式命令 */
  matchedCommand?: string
  /** 输出因缓冲区溢出被截断 */
  outputTruncated?: boolean
}

export type PtySessionCloseReason = 'exit' | 'kill' | 'cleanup' | 'idle_timeout'

export interface AgentSessionClosedInfo {
  sessionId: string
  spaceId: string
  reason: PtySessionCloseReason
}

export interface PtySession {
  id: string
  pty: PtyHostSession
  writeChannel?: PtyWriteChannel
  cwd: string
  shellType?: ShellType
  createdAt: number
  outputBuffer: PtyOutputBuffer
  lastOutputAt: number
  pid: number | null
  isRunning: boolean
  lastExitCode: number | null
  lastCommandCompletedAt: number | null
  spaceId?: string
  /**
   * 本地 LLM `PtyManagerBridge.executeAgentCommand` / `spawnAgentSessionDetached`
   * 起的 session 携带的溯源信息。**仅 bridge 路径写入**：人控 4 件套
   * `spawnAgentSession` 路径不会设置该字段（即便 sessionId 也以 `agent-` 起头）。
   *
   * 字段语义与 `@tabtin/terminal-core` 的 `AgentCommandRequest.agentMeta` 严格对齐，
   * 在 PtySession 上做一份副本是为了：
   *   - bridge 实现层在 `agent-session-created` / `agent-session-closed`
   *     emit 时能从 session 反查 toolUseId / agentId（事件 payload 必填）
   *   - `outputFilePath` 持续写盘的 helper 能挂在 session 生命周期上做 close
   *   - WP2 contract test 验证 bridge 路径与 4 件套人控路径的隔离性
   */
  agentMeta?: {
    toolUseId: string
    spaceId: string
    agentId: string
    threadId?: string
    description?: string
    originatedBy: 'local-llm-shellcap'
  }
  /** @internal Electron-only */
  titleEmitted?: boolean
  /** Set by PtyCommandRunner to track whether session termination has been finalized */
  terminationFinalized?: boolean
  /** @internal Electron-only */
  closeEventEmitted?: boolean
  /** @internal Electron-only */
  rendererDataSubscribed?: boolean
  /** @internal Electron-only */
  outputPaused?: boolean
  /** @internal Electron-only */
  lastReadDemandAt?: number | null
  /**
   * P2-07 fix: set to true when a timed-out command could not be stopped
   * via Ctrl+C. Consumers should check this flag and restart the session.
   */
  needsRestart?: boolean
  /**
   * Electron 交互式 shell 显式指定的 CLI transport。
   * shell 重启时必须原样恢复，不能混入当前实例的另一半 socket/token。
   */
  cliTransportEnv?: {
    TABTIN_SOCK?: string
    _TABTIN_TRANSPORT_TOKEN?: string
  }
}

export interface ActiveAutoRespond {
  pattern: string
  response: string
  consumed: boolean
  lastCheckedCursor: number
}

export interface PendingCommand {
  nonce: string
  startMarker: string
  endMarkerPrefix: string
  startedAt: number
  bufferStartCursor: number
  /**
   * Tracks the buffer cursor up to which we have already scanned for the end
   * marker. Enables incremental O(new-data) scanning instead of re-scanning
   * the full command output on every onSessionData event.
   */
  markerScanCursor?: number
  /**
   * Keeps the trailing marker-length window from the previous incremental
   * scan so markers split across 3+ chunks can still be detected.
   */
  markerScanTail?: string
  resolve: (result: ExecuteCommandResult) => void
  timer: ReturnType<typeof setTimeout> | null
  sessionId: string
  autoRespond?: ActiveAutoRespond[]
  /**
   * PC-33 fix: tracks auto-respond setTimeout timer IDs so they can be
   * cleared when the session is deleted, preventing writes to closed channels.
   */
  autoRespondTimers?: Array<ReturnType<typeof setTimeout>>
}

export interface BackgroundedWatcher {
  endMarkerPrefix: string
  sessionId: string
  createdAt: number
  bufferSearchCursor: number
  searchTail?: string
}

export class PtySessionStore {
  private readonly sessions = new Map<string, PtySession>()
  private readonly pendingCommands = new Map<string, PendingCommand>()
  private readonly backgroundedWatchers = new Map<string, BackgroundedWatcher[]>()
  private readonly threadSessionMap = new Map<string, string>()

  createSession(session: PtySession): void {
    this.sessions.set(session.id, session)
  }

  deleteSession(sessionId: string): PtySession | undefined {
    const session = this.sessions.get(sessionId)
    if (!session) return undefined

    this.sessions.delete(sessionId)
    this.releaseThreadSessionBySessionId(sessionId)

    // PC-5: Cascade-clean pendingCommands — reject the pending promise so
    // upstream callers (Agent) are unblocked instead of hanging forever.
    const pending = this.pendingCommands.get(sessionId)
    if (pending) {
      if (pending.timer) {
        clearTimeout(pending.timer)
      }
      // PC-33 fix: clear any tracked auto-respond timers to prevent
      // writes to the (soon-to-be-closed) channel after session deletion.
      if (pending.autoRespondTimers) {
        for (const t of pending.autoRespondTimers) {
          clearTimeout(t)
        }
        pending.autoRespondTimers.length = 0
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
      this.pendingCommands.delete(sessionId)
    }

    // PC-5: Cascade-clean backgroundedWatchers for this session.
    this.backgroundedWatchers.delete(sessionId)

    return session
  }

  getSession(sessionId: string): PtySession | undefined {
    return this.sessions.get(sessionId)
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  getAllSessionIds(): string[] {
    return Array.from(this.sessions.keys())
  }

  getAllSessions(): PtySession[] {
    return Array.from(this.sessions.values())
  }

  getSessionEntries(): IterableIterator<[string, PtySession]> {
    return this.sessions.entries()
  }

  getSessionCount(): number {
    return this.sessions.size
  }

  getPendingCommand(sessionId: string): PendingCommand | undefined {
    return this.pendingCommands.get(sessionId)
  }

  setPendingCommand(sessionId: string, pendingCommand: PendingCommand): void {
    this.pendingCommands.set(sessionId, pendingCommand)
  }

  deletePendingCommand(sessionId: string): PendingCommand | undefined {
    const pendingCommand = this.pendingCommands.get(sessionId)
    if (!pendingCommand) return undefined

    this.pendingCommands.delete(sessionId)
    return pendingCommand
  }

  hasPendingCommand(sessionId: string): boolean {
    return this.pendingCommands.has(sessionId)
  }

  getPendingCommandEntries(): IterableIterator<[string, PendingCommand]> {
    return this.pendingCommands.entries()
  }

  getBackgroundedWatchers(sessionId: string): BackgroundedWatcher[] | undefined {
    return this.backgroundedWatchers.get(sessionId)
  }

  setBackgroundedWatchers(sessionId: string, watchers: BackgroundedWatcher[]): void {
    this.backgroundedWatchers.set(sessionId, watchers)
  }

  deleteBackgroundedWatchers(sessionId: string): void {
    this.backgroundedWatchers.delete(sessionId)
  }

  getThreadSession(threadId: string): string | undefined {
    return this.threadSessionMap.get(threadId)
  }

  setThreadSession(threadId: string, sessionId: string): void {
    this.threadSessionMap.set(threadId, sessionId)
  }

  deleteThreadSession(threadId: string): void {
    this.threadSessionMap.delete(threadId)
  }

  /**
   * Releases ALL thread bindings for a given session.
   * PC-15 fix: previously returned after the first match, leaking remaining
   * thread→session bindings when multiple threads shared the same session.
   */
  releaseThreadSessionBySessionId(sessionId: string): void {
    for (const [threadId, currentSessionId] of this.threadSessionMap) {
      if (currentSessionId === sessionId) {
        this.threadSessionMap.delete(threadId)
      }
    }
  }

  clear(): void {
    this.sessions.clear()
    this.pendingCommands.clear()
    this.backgroundedWatchers.clear()
    this.threadSessionMap.clear()
  }
}
