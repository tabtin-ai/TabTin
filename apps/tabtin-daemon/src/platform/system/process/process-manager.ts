import fs from 'node:fs';
import lockfile from 'proper-lockfile';
import type { ConfigManager } from '../config/config-manager.js';
import type { Logger } from '../../observability/logging/logger.js';
import { captureFatal } from '../../observability/logging/sentry.js';
import { atomicWriteFileSync } from '@tabtin/terminal-core';

const GRACEFUL_TIMEOUT_MS = 15_000;
const MAX_UNHANDLED_REJECTIONS = 3;

export class ProcessManager {
  private readonly configManager: ConfigManager;
  private readonly logger: Logger;
  private readonly onShutdown: () => Promise<void>;
  private lockRelease: (() => void) | null = null;
  private shuttingDown = false;
  private unhandledRejectionCount = 0;
  private started = false;
  private ownsPidFile = false;
  private readonly handlers = new Map<NodeJS.Signals | 'uncaughtException' | 'unhandledRejection', (...args: any[]) => void>();
  private onDrain: (() => void) | null = null;

  constructor(configManager: ConfigManager, logger: Logger, onShutdown: () => Promise<void>) {
    this.configManager = configManager;
    this.logger = logger;
    this.onShutdown = onShutdown;
  }

  setDrainHandler(handler: (() => void) | null): void {
    this.onDrain = handler;
  }

  setup(): void {
    if (this.started) return;
    this.acquireLock();
    try {
      this.writePid();
      this.ownsPidFile = true;
    } catch (error) {
      this.releaseLock();
      throw error;
    }

    const shutdown = async (signal: string) => {
      if (this.shuttingDown) return;
      this.shuttingDown = true;
      this.logger.info(`Received ${signal}, starting graceful shutdown...`);

      const forceExitTimer = setTimeout(() => {
        this.logger.error('Graceful shutdown timed out, forcing exit');
        process.exit(1);
      }, GRACEFUL_TIMEOUT_MS);
      forceExitTimer.unref();

      try {
        await this.onShutdown();
      } catch (err) {
        this.logger.error('Error during shutdown', err);
      }

      clearTimeout(forceExitTimer);
      this.cleanup();
      process.exit(0);
    };

    this.bind('SIGTERM', () => void shutdown('SIGTERM'));
    this.bind('SIGINT', () => void shutdown('SIGINT'));
    this.bind('SIGHUP', () => void shutdown('SIGHUP'));
    this.bind('SIGUSR2', () => {
      if (this.onDrain) {
        this.logger.info('Received SIGUSR2, triggering drain mode...');
        this.onDrain();
      } else {
        this.logger.warn('Received SIGUSR2 but no drain handler registered, ignoring');
      }
    });
    this.bind('uncaughtException', (err) => {
      this.logger.error('Uncaught exception', err);
      // ：进程级兜底上报。captureFatal 内含 flush（2s 超时），
      // 在 graceful shutdown（15s 上限）之前先把事件发出去。
      void captureFatal(err, 'daemon_uncaught_exception').finally(() => {
        void shutdown('uncaughtException');
      });
    });
    this.bind('unhandledRejection', (reason) => {
      this.unhandledRejectionCount++;
      this.logger.error('Unhandled rejection', reason);
      if (this.unhandledRejectionCount >= MAX_UNHANDLED_REJECTIONS) {
        this.logger.error(`${MAX_UNHANDLED_REJECTIONS} unhandled rejections reached, triggering shutdown`);
        void captureFatal(reason, 'daemon_unhandled_rejection').finally(() => {
          void shutdown('unhandledRejection');
        });
      }
    });
    this.started = true;
  }

  cleanup(): void {
    for (const [event, handler] of this.handlers) process.off(event, handler);
    this.handlers.clear();
    this.started = false;
    this.shuttingDown = false;
    this.unhandledRejectionCount = 0;
    this.onDrain = null;
    this.releaseLock();
    if (this.ownsPidFile) {
      const pidPath = this.configManager.getPidPath();
      try {
        if (fs.existsSync(pidPath) && fs.readFileSync(pidPath, 'utf8').trim() === String(process.pid)) {
          fs.unlinkSync(pidPath);
        }
      } catch {
        // best effort
      }
      this.ownsPidFile = false;
    }
  }

  private bind(
    event: NodeJS.Signals | 'uncaughtException' | 'unhandledRejection',
    handler: (...args: any[]) => void,
  ): void {
    this.handlers.set(event, handler);
    process.on(event, handler);
  }

  private acquireLock(): void {
    const lockDir = this.configManager.getConfigDir();
    this.configManager.ensureConfigDir();
    try {
      const release = lockfile.lockSync(lockDir, { stale: 30_000, update: 5_000 });
      this.lockRelease = release as () => void;
      this.logger.debug('Process lock acquired');
    } catch (err) {
      throw new Error(
        `Another daemon instance is already running. ` +
        `If you're sure no other instance is running, remove the lockfile in ${lockDir} and retry.`,
      );
    }
  }

  private releaseLock(): void {
    if (!this.lockRelease) return;
    try {
      this.lockRelease();
    } catch {
      // best effort — lock may already be released
    }
    this.lockRelease = null;
  }

  private writePid(): void {
    const pidPath = this.configManager.getPidPath();
    this.configManager.ensureConfigDir();
    atomicWriteFileSync(pidPath, String(process.pid), 0o600);
    this.logger.debug(`PID ${process.pid} written to ${pidPath}`);
  }
}
