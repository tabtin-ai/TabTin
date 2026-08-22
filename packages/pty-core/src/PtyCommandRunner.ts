import type {
  ExecuteCommandResult,
  PtySession,
  PtySessionStore,
  ActiveAutoRespond,
  BackgroundedWatcher,
  PendingCommand,
} from './PtySessionStore'
import { cleanOutput } from './marker/output-cleaner'
import { extractMarkerTail, parseEndMarker } from './marker/parser'
import { generateMarkerPair } from './marker/generator'
import { wrapCommand } from './marker/command-wrapper'
import type { ShellType } from './marker/command-wrapper'
import { checkAutoRespond } from './auto-respond/checker'
import { DEFAULT_BLOCK_UNTIL_MS, BG_WATCHER_MAX_AGE_MS } from './marker/constants'

/**
 * P2-05 fix: creates a fresh ANSI regex each call to avoid shared lastIndex
 * state bugs with the global ANSI_EXTENDED_RE constant.
 */
function createAnsiRE(): RegExp {
  return /\x1B(?:\](?:[^\x07\x1B]|\x1B[^\\])*(?:\x07|\x1B\\|\x9C)?|[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g
}

/**
 * P2-05 fix: strips ANSI escape sequences from raw output so that marker
 * detection (indexOf / includes) is not disrupted by CSI sequences that
 * some shell configurations inject into echoed marker text.
 * Unlike cleanOutput(), this does NOT strip marker lines themselves.
 */
function stripAnsi(raw: string): string {
  return raw.replace(createAnsiRE(), '')
}

export interface PtyCommandRunnerLogger {
  debug(msg: string): void
  warn(msg: string): void
}

export interface PtyCommandRunnerDeps {
  store: PtySessionStore
  write: (sessionId: string, data: string) => boolean
  logger?: PtyCommandRunnerLogger
  /**
   * TT-04: 当会话被标记为需要重启时直接回调，消除对日志字符串的解析依赖。
   * 调用方（PtyManager/DaemonPtyManager）应在此回调中触发 restartSessionShell。
   */
  onNeedsRestart?: (sessionId: string) => void
  /**
   * TT-04: 当 auto-respond 规则匹配并触发响应时直接回调。
   * 调用方可据此 emit 业务事件，而无需解析日志字符串。
   */
  onAutoRespondTriggered?: (sessionId: string, pattern: string) => void
}

export interface RunCommandOptions {
  blockUntilMs?: number
  env?: Record<string, string>
  workingDirectory?: string
  shellType?: ShellType
  autoRespond?: Array<{ pattern: string; response: string }>
  /**
   * P2-07 fix: when true, sends Ctrl+C (\x03) to the PTY on timeout to
   * terminate runaway commands (e.g. `yes`, infinite loops). If the command
   * is still producing output 2 seconds after Ctrl+C, marks the session as
   * needing restart via `session.needsRestart`.
   */
  killOnTimeout?: boolean
}

export interface FinalizeSessionOptions {
  exitCode: number | null
  removeSession: boolean
  disposeWriteChannel: boolean
}

/**
 * Shared marker-based command execution pipeline.
 *
 * Encapsulates: marker scanning, backgrounded watchers, auto-respond,
 * session termination finalisation, and the execute-command promise lifecycle.
 * Consumers (Daemon, Electron) create an instance, wire `handleData` into
 * the PTY onData callback, and delegate `executeCommand` here.
 */
export class PtyCommandRunner {
  private readonly autoRespondDelayMs: number

  constructor(
    private readonly deps: PtyCommandRunnerDeps,
    options?: { autoRespondDelayMs?: number },
  ) {
    this.autoRespondDelayMs = options?.autoRespondDelayMs ?? 100
  }

  /** Call on every PTY data event (after appending to outputBuffer). */
  handleData(sessionId: string): void {
    this.checkAutoRespond(sessionId)
    this.checkPendingCommandMarker(sessionId)
    this.checkBackgroundedWatchers(sessionId)
  }

  /** Handle shell exit: finalize session and close the write channel. */
  handleExit(session: PtySession, exitCode: number | null): void {
    this.finalizeSession(session, {
      exitCode: exitCode ?? 128,
      removeSession: false,
      disposeWriteChannel: false,
    })
    session.writeChannel?.close()
  }

  /** Mark a session as stopped; resolve any pending command and clean up watchers. */
  finalizeSession(session: PtySession, options: FinalizeSessionOptions): void {
    if (session.terminationFinalized) {
      if (options.removeSession && this.deps.store.hasSession(session.id)) {
        this.deps.store.deleteSession(session.id)
      }
      return
    }

    session.terminationFinalized = true
    session.isRunning = false
    session.lastExitCode = options.exitCode
    session.lastCommandCompletedAt = Date.now()

    this.resolvePendingOnTermination(session, options.exitCode)
    this.deps.store.deleteBackgroundedWatchers(session.id)
    this.deps.store.releaseThreadSessionBySessionId(session.id)

    if (options.disposeWriteChannel) {
      session.writeChannel?.dispose()
    }
    if (options.removeSession) {
      this.deps.store.deleteSession(session.id)
    }
  }

  /** Execute a command with marker protocol; returns when the end-marker is detected or timeout fires. */
  execute(
    sessionId: string,
    command: string,
    options?: RunCommandOptions,
  ): Promise<ExecuteCommandResult> {
    // P2-06 fix: empty command guard — avoid executing a blank line which
    // would inherit the previous command's exit code, misleading callers.
    if (!command || command.trim().length === 0) {
      const session = this.deps.store.getSession(sessionId)
      return Promise.resolve({
        output: '',
        exitCode: 0,
        cwd: session?.cwd ?? '',
        backgrounded: false,
        timedOut: false,
        durationMs: 0,
        sessionId,
      })
    }

    const session = this.deps.store.getSession(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)
    if (!session.isRunning) throw new Error(`Session ${sessionId} shell has exited`)
    if (this.deps.store.hasPendingCommand(sessionId)) {
      throw new Error(
        `Session ${sessionId} already has a running command. ` +
          `Wait for it to complete, use read_terminal_output to check status, or use a different session.`,
      )
    }

    const markers = generateMarkerPair()
    const blockUntilMs = options?.blockUntilMs ?? DEFAULT_BLOCK_UNTIL_MS
    const bufferStartCursor = session.outputBuffer.createCursor()
    const wrappedCmd = wrapCommand(command, markers, {
      env: options?.env,
      workingDirectory: options?.workingDirectory,
      shellType: options?.shellType,
    })

    const activeAutoRespond: ActiveAutoRespond[] | undefined = options?.autoRespond?.map(
      (rule) => ({
        pattern: rule.pattern,
        response: rule.response,
        consumed: false,
        lastCheckedCursor: bufferStartCursor,
      }),
    )

    return new Promise<ExecuteCommandResult>((resolve) => {
      const pending: PendingCommand = {
        nonce: markers.nonce,
        startMarker: markers.startMarker,
        endMarkerPrefix: markers.endMarkerPrefix,
        startedAt: Date.now(),
        bufferStartCursor,
        markerScanCursor: bufferStartCursor,
        markerScanTail: '',
        resolve,
        timer: null,
        sessionId,
        autoRespond: activeAutoRespond,
      }

      if (blockUntilMs > 0) {
        pending.timer = setTimeout(() => {
          // PC-18 fix: guard against race where marker detection already
          // resolved the command before this timeout fires. Without this
          // check, a residual backgroundedWatcher would be added.
          if (!this.deps.store.hasPendingCommand(sessionId)) {
            return
          }
          this.deps.store.deletePendingCommand(sessionId)
          // Always add backgrounded watcher to track end-marker for session
          // state updates (cwd, lastExitCode), regardless of kill decision.
          this.addBackgroundedWatcher(sessionId, markers.endMarkerPrefix, pending.markerScanTail)
          const partial = session.outputBuffer.readFromCursor(bufferStartCursor)
          // P2-05 fix: strip ANSI before searching for start marker
          const stripped = stripAnsi(partial)
          const startIdx = stripped.indexOf(markers.startMarker)
          const output =
            startIdx >= 0
              ? stripped.substring(startIdx + markers.startMarker.length + 1)
              : stripped

          // EF2 fix: backgrounded and killOnTimeout are mutually exclusive
          // semantics. If killOnTimeout is set, we kill the command and report
          // backgrounded=false so the Agent knows the process was terminated.
          // If killOnTimeout is false, the command continues running and
          // backgrounded=true tells the Agent it can poll for completion.
          const shouldKill = options?.killOnTimeout === true

          resolve({
            output: cleanOutput(output.trim()),
            exitCode: null,
            cwd: session.cwd,
            backgrounded: !shouldKill,
            timedOut: true,
            durationMs: Date.now() - pending.startedAt,
            sessionId,
          })

          // P2-07: kill runaway command on timeout by sending Ctrl+C.
          // Only fires when killOnTimeout=true (the caller explicitly wants
          // the command terminated, e.g. `yes`, infinite loops).
          if (shouldKill) {
            this.deps.write(sessionId, '\x03')
            this.deps.logger?.debug(
              `[PtyRunner] Timeout kill: sent Ctrl+C to session=${sessionId}`,
            )
            const outputAtKill = session.outputBuffer.createCursor()
            setTimeout(() => {
              const currentSession = this.deps.store.getSession(sessionId)
              if (!currentSession) return
              const newOutput = currentSession.outputBuffer.readFromCursor(outputAtKill)
              if (newOutput && newOutput.length > 10) {
                currentSession.needsRestart = true
                this.deps.logger?.warn(
                  `[PtyRunner] Session ${sessionId} marked for restart: command did not stop after Ctrl+C`,
                )
                // TT-04: 直接回调，调用方无需解析日志字符串
                this.deps.onNeedsRestart?.(sessionId)
              }
            }, 2000)
          }
        }, blockUntilMs)
      }

      this.deps.store.setPendingCommand(sessionId, pending)

      const writeOk = this.deps.write(sessionId, wrappedCmd)
      if (!writeOk) {
        if (pending.timer) clearTimeout(pending.timer)
        this.deps.store.deletePendingCommand(sessionId)
        resolve({
          output: '',
          exitCode: 1,
          cwd: session.cwd,
          backgrounded: false,
          timedOut: false,
          durationMs: 0,
          sessionId,
        })
        return
      }

      if (blockUntilMs === 0) {
        if (pending.timer) clearTimeout(pending.timer)
        this.deps.store.deletePendingCommand(sessionId)
        this.addBackgroundedWatcher(sessionId, markers.endMarkerPrefix)
        resolve({
          output: '',
          exitCode: null,
          cwd: session.cwd,
          backgrounded: true,
          timedOut: false,
          durationMs: 0,
          sessionId,
        })
      }
    })
  }

  // ── Private helpers ──

  /**
   * PC-33 fix: clears all tracked auto-respond timers on a pending command.
   */
  private clearAutoRespondTimers(pending: PendingCommand): void {
    if (pending.autoRespondTimers) {
      for (const t of pending.autoRespondTimers) {
        clearTimeout(t)
      }
      pending.autoRespondTimers.length = 0
    }
  }

  private resolvePendingOnTermination(session: PtySession, exitCode: number | null): void {
    const pending = this.deps.store.deletePendingCommand(session.id)
    if (!pending) return

    if (pending.timer) clearTimeout(pending.timer)
    this.clearAutoRespondTimers(pending)
    const partial = session.outputBuffer.readFromCursor(pending.bufferStartCursor)
    pending.resolve({
      output: cleanOutput(partial.trim()),
      exitCode,
      cwd: session.cwd,
      backgrounded: false,
      timedOut: false,
      durationMs: Date.now() - pending.startedAt,
      sessionId: session.id,
    })
  }

  private checkPendingCommandMarker(sessionId: string): void {
    const pending = this.deps.store.getPendingCommand(sessionId)
    if (!pending) return
    const session = this.deps.store.getSession(sessionId)
    if (!session) return

    // PC-1 fix: when the buffer has overflowed and the start marker's chunk
    // has been evicted, the end marker may also have been lost. Instead of
    // waiting until timeout, immediately resolve as backgrounded so the caller
    // is not blocked indefinitely.
    if (session.outputBuffer.hasOverflowed()) {
      const oldest = session.outputBuffer.getOldestCursor()
      if (oldest > pending.bufferStartCursor) {
        const isStillRunning = session.isRunning
        this.deps.logger?.warn(
          `[PtyRunner] Buffer overflow: session=${sessionId}, ` +
            `start=${pending.bufferStartCursor}, oldest=${oldest}, ` +
            `isRunning=${isStillRunning}. Resolving with truncated output.`,
        )
        if (pending.timer) clearTimeout(pending.timer)
        this.clearAutoRespondTimers(pending)
        this.deps.store.deletePendingCommand(sessionId)
        if (isStillRunning) {
          this.addBackgroundedWatcher(sessionId, pending.endMarkerPrefix, pending.markerScanTail)
        }
        const partial = session.outputBuffer.readAll()
        pending.resolve({
          output: cleanOutput(partial.trim()),
          exitCode: isStillRunning ? null : (session.lastExitCode ?? null),
          cwd: session.cwd,
          backgrounded: isStillRunning,
          timedOut: false,
          outputTruncated: true,
          durationMs: Date.now() - pending.startedAt,
          sessionId,
        })
        return
      }
    }

    const newDataRaw = session.outputBuffer.readFromCursor(pending.markerScanCursor!)
    if (!newDataRaw) return

    // P2-05 fix: strip ANSI escape sequences before marker detection so that
    // CSI sequences injected by shell prompt/theme configurations don't break
    // indexOf/includes matching on marker strings.
    const newData = `${pending.markerScanTail ?? ''}${stripAnsi(newDataRaw)}`
    if (!newData.includes(pending.endMarkerPrefix)) {
      pending.markerScanTail = newData.slice(-(pending.endMarkerPrefix.length - 1))
      pending.markerScanCursor = session.outputBuffer.createCursor()
      return
    }

    const recentOutputRaw = session.outputBuffer.readFromCursor(pending.bufferStartCursor)
    // P2-05 fix: strip ANSI for marker extraction and start-marker search
    const recentOutput = stripAnsi(recentOutputRaw)
    const markerTail = extractMarkerTail(recentOutput, pending.endMarkerPrefix)
    if (markerTail === null) return

    const parsed = parseEndMarker(markerTail, session.cwd)
    session.cwd = parsed.cwd

    const startIdx = recentOutput.indexOf(pending.startMarker)
    let output: string
    if (startIdx >= 0) {
      const afterStart = recentOutput.substring(startIdx + pending.startMarker.length)
      const afterStartNewline = afterStart.indexOf('\n')
      const contentStart = afterStartNewline >= 0 ? afterStartNewline + 1 : 0
      output = afterStart.substring(contentStart, afterStart.indexOf(pending.endMarkerPrefix))
    } else {
      const endIdx = recentOutput.indexOf(pending.endMarkerPrefix)
      output = recentOutput.substring(0, endIdx)
    }

    if (pending.timer) clearTimeout(pending.timer)
    this.clearAutoRespondTimers(pending)
    this.deps.store.deletePendingCommand(sessionId)

    session.lastExitCode = parsed.exitCode
    session.lastCommandCompletedAt = Date.now()

    pending.resolve({
      output: cleanOutput(output.trim()),
      exitCode: parsed.exitCode,
      cwd: parsed.cwd,
      backgrounded: false,
      timedOut: false,
      durationMs: Date.now() - pending.startedAt,
      sessionId,
    })
  }

  private addBackgroundedWatcher(
    sessionId: string,
    endMarkerPrefix: string,
    searchTail: string = '',
  ): void {
    const session = this.deps.store.getSession(sessionId)
    const watchers = this.deps.store.getBackgroundedWatchers(sessionId) || []
    watchers.push({
      endMarkerPrefix,
      sessionId,
      createdAt: Date.now(),
      bufferSearchCursor: session ? session.outputBuffer.createCursor() : 0,
      searchTail,
    })
    this.deps.store.setBackgroundedWatchers(sessionId, watchers)
  }

  private checkBackgroundedWatchers(sessionId: string): void {
    const watchers = this.deps.store.getBackgroundedWatchers(sessionId)
    if (!watchers || watchers.length === 0) return
    const session = this.deps.store.getSession(sessionId)
    if (!session) return

    const now = Date.now()
    const remaining: BackgroundedWatcher[] = []
    for (const w of watchers) {
      if (now - w.createdAt > BG_WATCHER_MAX_AGE_MS) continue
      // P2-05 fix: strip ANSI before searching for end marker in backgrounded watchers
      const searchSlice = `${w.searchTail ?? ''}${stripAnsi(session.outputBuffer.readFromCursor(w.bufferSearchCursor))}`
      const tail = extractMarkerTail(searchSlice, w.endMarkerPrefix)
      if (tail === null) {
        w.searchTail = searchSlice.slice(-(w.endMarkerPrefix.length - 1))
        w.bufferSearchCursor = session.outputBuffer.createCursor()
        remaining.push(w)
        continue
      }
      const parsed = parseEndMarker(tail, session.cwd)
      session.lastExitCode = parsed.exitCode
      session.lastCommandCompletedAt = now
      session.cwd = parsed.cwd
      this.deps.logger?.debug(
        `[PtyRunner] Backgrounded command completed: session=${sessionId}, exitCode=${parsed.exitCode}`,
      )
    }

    if (remaining.length > 0) {
      this.deps.store.setBackgroundedWatchers(sessionId, remaining)
    } else {
      this.deps.store.deleteBackgroundedWatchers(sessionId)
    }
  }

  private checkAutoRespond(sessionId: string): void {
    const pending = this.deps.store.getPendingCommand(sessionId)
    if (!pending?.autoRespond) return
    const session = this.deps.store.getSession(sessionId)
    if (!session) return

    for (const rule of pending.autoRespond) {
      if (rule.consumed) continue

      // P2-08 fix: when updating lastCheckedCursor, retain a backtrack
      // window equal to the pattern length so that a prompt split across
      // two PTY data chunks is not missed. Without this, the cursor jumps
      // past the first half of a split pattern and indexOf never sees it.
      const patternBacktrack = rule.pattern.length
      const rawCursor = Math.max(pending.bufferStartCursor, rule.lastCheckedCursor)
      const searchFrom = Math.max(pending.bufferStartCursor, rawCursor - patternBacktrack)
      const recentOutput = session.outputBuffer.readFromCursor(searchFrom)
      if (!recentOutput) continue

      const match = checkAutoRespond(cleanOutput(recentOutput), [
        { pattern: rule.pattern, response: rule.response },
      ])
      if (match.matched) {
        rule.consumed = true
        // PC-33 fix: track the timer so it can be cleared when session is deleted,
        // preventing writes to a closed channel after session destruction.
        const timer = setTimeout(() => {
          // Guard: skip if session no longer exists (destroyed between match and fire)
          if (!this.deps.store.getSession(sessionId)) {
            this.deps.logger?.debug(
              `[PtyRunner] Auto-respond skipped (session gone): session=${sessionId}, pattern=${rule.pattern}`,
            )
            return
          }
          const ok = this.deps.write(sessionId, match.response!)
          this.deps.logger?.debug(
            ok
              ? `[PtyRunner] Auto-respond triggered: session=${sessionId}, pattern=${rule.pattern}`
              : `[PtyRunner] Auto-respond write failed: session=${sessionId}, pattern=${rule.pattern}`,
          )
          // TT-04: 直接回调，调用方无需解析日志字符串
          if (ok) {
            this.deps.onAutoRespondTriggered?.(sessionId, rule.pattern)
          }
        }, this.autoRespondDelayMs)
        if (!pending.autoRespondTimers) {
          pending.autoRespondTimers = []
        }
        pending.autoRespondTimers.push(timer)
      } else {
        // P2-08 fix: use lastChunkCursor() instead of createCursor() so
        // the trailing chunk overlaps with the next scan, matching the
        // marker cross-chunk strategy from P1-FUN-3.
        rule.lastCheckedCursor = session.outputBuffer.lastChunkCursor()
      }
    }
  }
}
