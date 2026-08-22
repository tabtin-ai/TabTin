import type { IPty } from 'node-pty'
import type {
  PtyHostClient,
  PtyHostDisposable,
  PtyHostExitEvent,
  PtyHostSession,
  PtyHostSpawnedEvent,
  PtyHostSpawnRequest,
} from './PtyHost'
import { normalizeSize } from './utils/normalize-size'

/**
 * Callback invoked when a tracked session's underlying process exits,
 * so the host client can remove it from the active set.
 */
type SessionExitCallback = (session: InProcessPtyHostSession) => void

class InProcessPtyHostSession implements PtyHostSession {
  constructor(
    private readonly ptyProcess: IPty,
    private readonly onSessionExit?: SessionExitCallback,
  ) {
    // Auto-remove from tracking when the process exits naturally.
    this.ptyProcess.onExit(() => {
      this.onSessionExit?.(this)
    })
  }

  get pid(): number {
    return this.ptyProcess.pid
  }

  onSpawned(handler: (event: PtyHostSpawnedEvent) => void): PtyHostDisposable {
    queueMicrotask(() => {
      handler({ pid: this.ptyProcess.pid })
    })
    return {
      dispose: () => {},
    }
  }

  write(data: string): void {
    this.ptyProcess.write(data)
  }

  /**
   * E2E-1 fix: delegates to node-pty's pause() to stop reading from the
   * underlying fd, providing backpressure when the consumer cannot keep up.
   * Previously a no-op, which caused PtyManager.syncSessionOutputFlowControl()
   * calls to have no effect in InProcess mode.
   */
  pauseOutput(): void {
    try {
      this.ptyProcess.pause()
    } catch {
      // Swallow errors if the process has already exited or pause is
      // unsupported by this node-pty build — matches SubprocessPtyHost
      // resilience pattern.
    }
  }

  /**
   * E2E-1 fix: delegates to node-pty's resume() to restart reading from the
   * underlying fd after a prior pause.
   */
  resumeOutput(): void {
    try {
      this.ptyProcess.resume()
    } catch {
      // Swallow errors — see pauseOutput comment.
    }
  }

  /**
   * PC-31 fix: validates and clamps dimensions using normalizeSize before
   * passing to node-pty, preventing exceptions from 0 or negative values.
   */
  resize(cols: number, rows: number): void {
    const size = normalizeSize(cols, rows)
    this.ptyProcess.resize(size.cols, size.rows)
  }

  kill(signal?: string): void {
    this.ptyProcess.kill(signal)
  }

  onData(handler: (data: string) => void): PtyHostDisposable {
    return this.ptyProcess.onData(handler)
  }

  onExit(handler: (event: PtyHostExitEvent) => void): PtyHostDisposable {
    return this.ptyProcess.onExit(({ exitCode, signal }) => {
      handler({
        exitCode: exitCode ?? null,
        signal,
      })
    })
  }
}

let nodePtyModule: typeof import('node-pty') | null = null

function requireNodePty(): typeof import('node-pty') {
  if (!nodePtyModule) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      nodePtyModule = require('node-pty')
    } catch {
      throw new Error(
        '@tabtin/pty-core: node-pty is required for InProcessPtyHostClient. ' +
          'Install it as a dependency in your app: npm install node-pty',
      )
    }
  }
  return nodePtyModule!
}

/**
 * Sentinel session returned when node-pty spawn fails (PC-16 fix).
 * All methods are no-ops; onSpawned is never called, and onExit fires
 * immediately with exitCode = 1 so callers can detect the failure.
 */
class FailedPtyHostSession implements PtyHostSession {
  readonly pid: number = -1
  private readonly error: Error

  constructor(error: Error) {
    this.error = error
  }

  onSpawned(_handler: (event: PtyHostSpawnedEvent) => void): PtyHostDisposable {
    // Intentionally never called — spawn failed
    return { dispose: () => {} }
  }

  write(_data: string): void {
    // no-op: process never started
  }

  pauseOutput(): void {}
  resumeOutput(): void {}

  resize(_cols: number, _rows: number): void {
    // no-op: process never started
  }

  kill(_signal?: string): void {
    // no-op: process never started
  }

  onData(_handler: (data: string) => void): PtyHostDisposable {
    return { dispose: () => {} }
  }

  onExit(handler: (event: PtyHostExitEvent) => void): PtyHostDisposable {
    // Notify caller asynchronously that the process exited immediately
    queueMicrotask(() => {
      handler({ exitCode: 1, signal: undefined })
    })
    return { dispose: () => {} }
  }
}

export class InProcessPtyHostClient implements PtyHostClient {
  private readonly ptyModule: typeof import('node-pty')

  /**
   * P1-STB-2 fix: tracks all active PTY sessions so they can be cleaned up
   * when the host process exits, preventing orphan/zombie child processes.
   */
  private readonly activeSessions = new Set<InProcessPtyHostSession>()
  private cleanupInstalled = false
  private disposed = false

  constructor(ptyModule?: typeof import('node-pty')) {
    this.ptyModule = ptyModule ?? requireNodePty()
  }

  /**
   * P1-STB-2 fix: installs process-exit handlers to kill all tracked PTY
   * child processes. Lazily installed on first spawn to avoid side effects
   * if InProcessPtyHostClient is constructed but never used.
   *
   * The cleanup is best-effort: failures are silently ignored so they never
   * block or crash the main process during shutdown.
   */
  private installProcessExitCleanup(): void {
    if (this.cleanupInstalled) return
    this.cleanupInstalled = true

    const cleanup = () => {
      this.killAllSessions()
    }

    // 'exit' is the last chance — synchronous only, no async work allowed.
    process.on('exit', cleanup)

    // SIGTERM / SIGINT: kill children then re-raise so the default handler
    // terminates the main process with the correct exit code / signal.
    const signalCleanup = (signal: NodeJS.Signals) => {
      this.killAllSessions()
      // Remove our handler to allow the default behaviour (process termination).
      process.removeListener(signal, signalCleanup as (...args: unknown[]) => void)
      process.kill(process.pid, signal)
    }

    process.on('SIGTERM', signalCleanup as (...args: unknown[]) => void)
    process.on('SIGINT', signalCleanup as (...args: unknown[]) => void)
  }

  /**
   * Best-effort kill of all tracked active sessions.
   * Errors are swallowed to never block process exit.
   */
  private killAllSessions(): void {
    for (const session of this.activeSessions) {
      try {
        session.kill()
      } catch {
        // Best-effort: process may have already exited.
      }
    }
    this.activeSessions.clear()
  }

  /**
   * Spawns a new PTY process. If node-pty throws during spawn (e.g. invalid
   * shell path, resource exhaustion), returns a FailedPtyHostSession that
   * fires onExit with exitCode=1 and never fires onSpawned (PC-16 fix).
   */
  spawn(request: PtyHostSpawnRequest): PtyHostSession {
    if (this.disposed) {
      return new FailedPtyHostSession(new Error('InProcessPtyHostClient has been disposed'))
    }

    try {
      const ptyProcess = this.ptyModule.spawn(request.shell, [], {
        name: request.termName ?? 'xterm-256color',
        cols: request.cols,
        rows: request.rows,
        cwd: request.cwd,
        env: request.env,
      })

      const session = new InProcessPtyHostSession(ptyProcess, (exitedSession) => {
        this.activeSessions.delete(exitedSession)
      })

      this.activeSessions.add(session)
      this.installProcessExitCleanup()

      return session
    } catch (error) {
      return new FailedPtyHostSession(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /**
   * P1-STB-2: Returns the number of currently tracked active sessions.
   * Primarily exposed for testing and diagnostics.
   */
  get activeSessionCount(): number {
    return this.activeSessions.size
  }

  /**
   * P1-STB-2: Explicitly kills all active sessions and marks this client as
   * disposed. Subsequent spawn() calls will return FailedPtyHostSession.
   * This is the recommended way to tear down the host client during
   * graceful application shutdown.
   */
  dispose(): void {
    this.disposed = true
    this.killAllSessions()
  }
}
