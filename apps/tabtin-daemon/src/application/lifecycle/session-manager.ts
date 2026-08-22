/**
 * SessionManager — WS connection lifecycle state machine.
 *
 * Implements the runLoop + runSession pattern from the engine spec (§P6):
 *
 *   Disconnected → Connecting → Initializing → Running → (fault) → Backoff → Connecting
 *
 * runLoop: eternal loop with exponential backoff (1s → 30s)
 * runSession: single connection lifecycle (connect → init → routines → any critical failure → return)
 *
 * Routine classification:
 *   - Session-critical: failure → entire session ends → outer loop reconnects
 *   - Session-optional: failure → local retry → degraded if threshold exceeded
 *
 * Inspired by Coder Agent's apiConnRoutineManager.
 */

import { FatalSessionError } from './errors.js';

export type SessionState =
  | 'disconnected'
  | 'connecting'
  | 'initializing'
  | 'running'
  | 'backoff'
  | 'stopped';

export interface SessionManagerConfig {
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  maxRetries?: number;
}

export interface SessionManagerCallbacks {
  connect(signal: AbortSignal): Promise<void>;
  runSession(signal: AbortSignal): Promise<void>;
  onStateChange?(state: SessionState): void;
}

interface SessionManagerLogger {
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
}

const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_MAX_RETRIES = 0; // 0 = unlimited

export class SessionManager {
  private state: SessionState = 'disconnected';
  private abortController: AbortController | null = null;
  private retryCount = 0;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxRetries: number;

  constructor(
    private readonly logger: SessionManagerLogger,
    private readonly callbacks: SessionManagerCallbacks,
    config?: SessionManagerConfig,
  ) {
    this.initialBackoffMs = config?.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.maxBackoffMs = config?.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.maxRetries = config?.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  getState(): SessionState {
    return this.state;
  }

  /**
   * Run the eternal reconnection loop. Returns only when stop() is called
   * or maxRetries is exceeded.
   */
  async runLoop(): Promise<void> {
    this.logger.info('[SessionManager] runLoop started');

    while (this.state !== 'stopped') {
      try {
        this.setState('connecting');
        this.abortController = new AbortController();
        const signal = this.abortController.signal;

        await this.callbacks.connect(signal);

        this.setState('initializing');
        this.retryCount = 0;

        this.setState('running');
        await this.callbacks.runSession(signal);

      } catch (err) {
        if (this.getState() === 'stopped') break;

        if (err instanceof FatalSessionError) {
          this.logger.error(`[SessionManager] Fatal session error: ${err.message}`);
        } else {
          this.logger.warn(`[SessionManager] Session ended: ${err instanceof Error ? err.message : String(err)}`);
        }
      } finally {
        this.abortController?.abort();
        this.abortController = null;
      }

      if (this.getState() === 'stopped') break;

      if (this.maxRetries > 0 && this.retryCount >= this.maxRetries) {
        this.logger.error(`[SessionManager] Max retries (${this.maxRetries}) exceeded, giving up`);
        this.setState('disconnected');
        break;
      }

      this.setState('backoff');
      const jitter = Math.random() * 0.3 + 0.85; // 0.85–1.15
      const backoff = Math.min(
        this.initialBackoffMs * Math.pow(2, this.retryCount) * jitter,
        this.maxBackoffMs,
      );
      this.retryCount++;
      this.logger.info(`[SessionManager] Reconnecting in ${Math.round(backoff)}ms (attempt ${this.retryCount})`);
      await this.sleep(backoff);
    }

    this.logger.info('[SessionManager] runLoop exited');
  }

  stop(): void {
    this.logger.info('[SessionManager] Stopping...');
    this.setState('stopped');
    this.abortController?.abort();
  }

  private setState(state: SessionState): void {
    if (this.state === state) return;
    const prev = this.state;
    this.state = state;
    this.logger.info(`[SessionManager] ${prev} → ${state}`);
    this.callbacks.onStateChange?.(state);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.state === 'stopped') { resolve(); return; }
      const timer = setTimeout(resolve, ms);
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    });
  }
}
