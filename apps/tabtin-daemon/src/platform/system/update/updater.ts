import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { gt as semverGt, valid as semverValid } from 'semver';
import type { Logger } from '../../observability/logging/logger.js';

const execFileAsync = promisify(execFile);

const CURRENT_VERSION = process.env.npm_package_version ?? '0.1.0';
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

export class Updater {
  private readonly logger: Logger;
  private readonly onRequestRestart: () => Promise<void>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private latestKnownVersion: string | null = null;
  private updating = false;

  constructor(logger: Logger, onRequestRestart: () => Promise<void>) {
    this.logger = logger;
    this.onRequestRestart = onRequestRestart;
  }

  startPeriodicCheck(): void {
    this.timer = setInterval(() => void this.maybeUpdate(), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Called by HeartbeatService when backend responds with a version hint. */
  notifyLatestVersion(version: string): void {
    if (!version || !semverValid(version)) return;
    if (version === this.latestKnownVersion) return;

    this.latestKnownVersion = version;
    if (semverGt(version, CURRENT_VERSION)) {
      this.logger.info(`Backend reports newer daemon version: ${version} (current: ${CURRENT_VERSION})`);
      void this.maybeUpdate();
    } else {
      this.logger.debug(`Backend version ${version} is not newer than current ${CURRENT_VERSION}, skipping`);
    }
  }

  getCurrentVersion(): string {
    return CURRENT_VERSION;
  }

  /** Check npm registry for latest version (fallback when backend doesn't supply it). */
  async checkRegistry(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('npm', ['view', '@tabtin/daemon', 'version'], {
        timeout: 15_000,
      });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /** Check locally installed version (not registry). */
  private async checkLocalVersion(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('npm', ['list', '-g', '@tabtin/daemon', '--json'], {
        timeout: 15_000,
      });
      const json = JSON.parse(stdout);
      const ver = json?.dependencies?.['@tabtin/daemon']?.version;
      return typeof ver === 'string' && semverValid(ver) ? ver : null;
    } catch {
      return null;
    }
  }

  private async maybeUpdate(): Promise<void> {
    if (this.updating) return;

    let targetVersion = this.latestKnownVersion;
    if (!targetVersion) {
      targetVersion = await this.checkRegistry();
    }
    if (!targetVersion || !semverValid(targetVersion)) return;
    if (!semverGt(targetVersion, CURRENT_VERSION)) return;

    this.updating = true;
    this.logger.info(`Updating daemon: ${CURRENT_VERSION} → ${targetVersion}`);

    try {
      await execFileAsync('npm', ['update', '-g', '@tabtin/daemon'], { timeout: 120_000 });

      const installedVersion = await this.checkLocalVersion();
      if (installedVersion && semverGt(installedVersion, CURRENT_VERSION)) {
        this.logger.info(`Update installed (${installedVersion}), spawning new process and shutting down...`);
        this.spawnNewDaemon();
        await this.onRequestRestart();
      } else {
        this.logger.warn(`npm update ran but local version (${installedVersion ?? 'unknown'}) is not newer than ${CURRENT_VERSION}, skipping restart`);
      }
    } catch (err) {
      this.logger.warn('Update failed', err instanceof Error ? err.message : String(err));
    } finally {
      this.updating = false;
    }
  }

  private spawnNewDaemon(): void {
    if (this.isManagedByServiceManager()) {
      this.logger.info('Running under service manager (systemd/launchd) — skipping spawn, will be restarted automatically');
      return;
    }
    try {
      const child = spawn('tabtin-daemon', ['start'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      this.logger.info(`Spawned new daemon process (PID ${child.pid})`);
    } catch (err) {
      this.logger.error('Failed to spawn new daemon process', err instanceof Error ? err.message : String(err));
    }
  }

  private isManagedByServiceManager(): boolean {
    // systemd sets INVOCATION_ID; launchd sets __CF_USER_TEXT_ENCODING and ppid=1
    if (process.env.INVOCATION_ID) return true;
    if (process.env.LAUNCHED_BY_LAUNCHD === '1') return true;
    if (process.ppid === 1) return true;
    return false;
  }
}
