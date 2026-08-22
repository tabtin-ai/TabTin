import { spawn, execSync, type ChildProcess } from 'node:child_process';
import type { Logger } from '../../observability/logging/logger.js';

/**
 * Prevents the system from sleeping while the daemon is running.
 * - macOS: spawns `caffeinate -im` (prevent idle + disk sleep)
 * - Windows: periodically calls SetThreadExecutionState via PowerShell
 * - Linux: no-op (servers typically don't sleep)
 */
export class SleepBlocker {
  private readonly logger: Logger;
  private caffeinateProcess: ChildProcess | null = null;
  private caffeinateRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private windowsTimer: ReturnType<typeof setInterval> | null = null;
  private caffeinateRetries = 0;
  private stopped = false;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  start(): void {
    switch (process.platform) {
      case 'darwin':
        this.startMac();
        break;
      case 'win32':
        this.startWindows();
        break;
      default:
        this.logger.debug(`SleepBlocker: no-op on ${process.platform}`);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.caffeinateRetryTimer) {
      clearTimeout(this.caffeinateRetryTimer);
      this.caffeinateRetryTimer = null;
    }
    if (this.caffeinateProcess && !this.caffeinateProcess.killed) {
      this.caffeinateProcess.kill('SIGTERM');
      this.caffeinateProcess = null;
      this.logger.debug('SleepBlocker: caffeinate stopped');
    }
    if (this.windowsTimer) {
      clearInterval(this.windowsTimer);
      this.windowsTimer = null;
      this.resetWindows();
      this.logger.debug('SleepBlocker: Windows sleep prevention stopped');
    }
  }

  private startMac(): void {
    try {
      this.caffeinateProcess = spawn('caffeinate', ['-im'], {
        stdio: 'ignore',
        detached: false,
      });
      this.caffeinateProcess.on('error', (err) => {
        this.caffeinateProcess = null;
        this.logger.debug(`SleepBlocker: caffeinate error: ${err}`);
      });
      this.caffeinateProcess.on('exit', (code) => {
        this.caffeinateProcess = null;
        if (code !== 0 && !this.stopped && this.caffeinateRetries < 3) {
          this.caffeinateRetries++;
          this.logger.warn(`SleepBlocker: caffeinate exited with ${code}, retrying (${this.caffeinateRetries}/3)`);
          this.caffeinateRetryTimer = setTimeout(() => {
            this.caffeinateRetryTimer = null;
            this.startMac();
          }, 5000);
        }
      });
      this.logger.info('SleepBlocker: macOS sleep prevention enabled (caffeinate -im)');
    } catch {
      this.logger.warn('SleepBlocker: failed to start caffeinate');
    }
  }

  private startWindows(): void {
    const setExecState = () => {
      try {
        execSync(
          'powershell -NoProfile -NonInteractive -Command ' +
            '"[System.Runtime.InteropServices.Marshal]::' +
            'WriteInt32([System.Runtime.InteropServices.Marshal]::AllocHGlobal(4),0); ' +
            'Add-Type -TypeDefinition \'' +
            'using System.Runtime.InteropServices; ' +
            'public class SleepPreventer { ' +
            '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags); ' +
            '}\'; ' +
            '[SleepPreventer]::SetThreadExecutionState(0x80000003)"',
          { stdio: 'pipe', timeout: 5000 },
        );
      } catch (err) {
        this.logger.debug(`[SleepBlocker] Windows SetThreadExecutionState failed: ${err}`);
      }
    };
    setExecState();
    this.windowsTimer = setInterval(setExecState, 60_000);
    this.logger.info('SleepBlocker: Windows sleep prevention enabled');
  }

  private resetWindows(): void {
    try {
      execSync(
        'powershell -NoProfile -NonInteractive -Command ' +
          '"Add-Type -TypeDefinition \'' +
          'using System.Runtime.InteropServices; ' +
          'public class SleepPreventer { ' +
          '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags); ' +
          '}\'; ' +
          '[SleepPreventer]::SetThreadExecutionState(0x80000000)"',
        { stdio: 'pipe', timeout: 5000 },
      );
    } catch (err) {
      this.logger.debug(`[SleepBlocker] Windows reset failed: ${err}`);
    }
  }
}
