import os from 'node:os';
import type { HostRuntimeSnapshot } from '@tabtin/shared';
import { API_ENDPOINTS, deriveApiBaseUrl, joinApiPath } from '@tabtin/config';
import type { DaemonConfig, FatalExitHandler } from '../../base/types/daemon-config.js';
import type { DaemonGatewayClient } from './gateway-client.js';
import type { CapabilityDetector } from '../../platform/system/capability/detector.js';
import type { Updater } from '../../platform/system/update/updater.js';
import type { GitStatusRegistry } from '../../platform/observability/git-status/git-status-registry.js';
import type { Logger } from '../../platform/observability/logging/logger.js';
import { OfflineState, isAuthError } from '../../base/errors/offline-state.js';

export class HeartbeatService {
  static readonly MIN_INTERVAL_MS = 10_000;

  private readonly config: DaemonConfig;
  private readonly gateway: DaemonGatewayClient;
  private readonly capabilityDetector: CapabilityDetector;
  private readonly logger: Logger;
  private readonly offlineState: OfflineState;
  private updater: Updater | null = null;
  private gitStatusRegistry: GitStatusRegistry | null = null;
  private runtimeSnapshotProvider: (() => HostRuntimeSnapshot | null) | null = null;
  private browserMemoryProvider: (() => Promise<{ jsHeapUsedSize: number; jsHeapTotalSize: number; pageCount: number } | null>) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private capabilities: string[] = [];
  private sandboxStatus: { available: boolean; degraded_reason?: string } | null = null;
  private consecutiveAuthErrors = 0;
  private static readonly MAX_AUTH_ERRORS = 5;

  onFatalAuthError: FatalExitHandler | null = null;
  onTokenRenewed: ((newToken: string) => void) | null = null;
  onHeartbeatSuccess: (() => void) | null = null;
  tokenExpiresAt: number | null = null;
  lastHeartbeatSuccessAt: string | null = null;
  private renewController: AbortController | null = null;

  constructor(
    config: DaemonConfig,
    gateway: DaemonGatewayClient,
    capabilityDetector: CapabilityDetector,
    logger: Logger,
  ) {
    this.config = config;
    this.gateway = gateway;
    this.capabilityDetector = capabilityDetector;
    this.logger = logger;
    this.offlineState = new OfflineState(logger);
  }

  setUpdater(updater: Updater): void {
    this.updater = updater;
  }

  setGitStatusRegistry(registry: GitStatusRegistry): void {
    this.gitStatusRegistry = registry;
  }

  setRuntimeSnapshotProvider(provider: () => HostRuntimeSnapshot | null): void {
    this.runtimeSnapshotProvider = provider;
  }

  setBrowserMemoryProvider(provider: () => Promise<{ jsHeapUsedSize: number; jsHeapTotalSize: number; pageCount: number } | null>): void {
    this.browserMemoryProvider = provider;
  }

  updateCapabilities(caps: string[]): void {
    this.capabilities = [...caps];
  }

  start(capabilities: string[]): void {
    this.capabilities = capabilities;
    this.detectSandboxStatus().catch(() => {});
    const interval = Math.max(this.config.heartbeat_interval_ms ?? 15_000, HeartbeatService.MIN_INTERVAL_MS);
    if (interval !== this.config.heartbeat_interval_ms) {
      this.logger.warn(
        `Heartbeat interval clamped from ${this.config.heartbeat_interval_ms}ms to minimum ${HeartbeatService.MIN_INTERVAL_MS}ms`,
      );
    }
    const scheduleNext = () => {
      this.timer = setTimeout(async () => {
        await this.sendHeartbeat();
        if (this.timer !== null) scheduleNext();
      }, interval);
    };
    void this.sendHeartbeat();
    scheduleNext();
    this.logger.debug(`Heartbeat started (interval: ${interval}ms)`);
  }

  private async detectSandboxStatus(): Promise<void> {
    try {
      const { createPlatformSandbox, getBwrapUnavailableReason } = await import('@tabtin/terminal-core');
      const sandbox = createPlatformSandbox();
      const available = await sandbox.isAvailable();
      const reason = !available ? getBwrapUnavailableReason() : undefined;
      this.sandboxStatus = { available, degraded_reason: reason ?? undefined };
      this.logger.info(`OS sandbox: ${available ? 'available' : `degraded (${reason ?? 'unknown'})`}`);
    } catch (err) {
      this.sandboxStatus = { available: false, degraded_reason: 'detection failed' };
      this.logger.warn(`OS sandbox detection failed: ${err}`);
    }
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async triggerNow(): Promise<void> {
    await this.sendHeartbeat();
  }

  async attemptTokenRenewal(): Promise<string | null> {
    if (this.renewController && !this.renewController.signal.aborted) return null;
    this.renewController = new AbortController();
    const timeout = setTimeout(() => this.renewController?.abort(), 30_000);
    try {
      return await this.renewToken(this.renewController.signal);
    } finally {
      clearTimeout(timeout);
      this.renewController = null;
    }
  }

  private async renewToken(signal?: AbortSignal): Promise<string | null> {
    try {
      const renewUrl = joinApiPath(
        deriveApiBaseUrl(this.config.server_url),
        API_ENDPOINTS.DEVICE.TOKEN_RENEW,
      );
      const response = await fetch(renewUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.gateway.getAccessToken()}`,
          'X-Client-Type': 'daemon',
          'X-Organization-Id': this.config.organization_id,
          'X-Device-Id': this.config.fingerprint,
        },
        body: JSON.stringify({ fingerprint: this.config.fingerprint }),
        signal: signal ?? AbortSignal.timeout(20_000),
      });

      if (!response.ok) {
        this.logger.error(`Token renewal failed: HTTP ${response.status}`);
        return null;
      }

      const json = await response.json() as Record<string, any>;
      const newToken = json?.data?.access_token;
      if (typeof newToken === 'string' && newToken.length > 0) {
        this.logger.info('[Heartbeat] Token renewed successfully');
        this.onTokenRenewed?.(newToken);
        return newToken;
      }
      this.logger.error('[Heartbeat] Token renewal response missing access_token');
      return null;
    } catch (err) {
      this.logger.error(`[Heartbeat] Token renewal error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private async buildSystemInfo(): Promise<Record<string, any>> {
    const gitStatus = this.gitStatusRegistry?.getCachedStatus() ?? null;
    const allGitStatuses = this.gitStatusRegistry?.getAllCachedStatuses() ?? [];
    this.gitStatusRegistry?.collectAll();
    const systemInfo: Record<string, any> = {
      uptime: os.uptime(), load_avg: os.loadavg(), free_memory: os.freemem(),
      total_memory: os.totalmem(), cpu_count: os.cpus().length, home_dir: os.homedir(),
    };
    if (this.sandboxStatus !== null) {
      systemInfo.os_sandbox_available = this.sandboxStatus.available;
      systemInfo.os_sandbox_degraded = !this.sandboxStatus.available;
      systemInfo.os_sandbox_degraded_reason = this.sandboxStatus.degraded_reason;
    }
    if (gitStatus) systemInfo.git_status = gitStatus;
    if (allGitStatuses.length > 1) systemInfo.git_statuses = allGitStatuses;
    const runtimeSnapshot = this.runtimeSnapshotProvider?.() ?? null;
    if (runtimeSnapshot) systemInfo.host_runtime_snapshot = runtimeSnapshot;
    if (this.browserMemoryProvider) {
      try {
        const browserMemory = await this.browserMemoryProvider();
        if (browserMemory) systemInfo.browser_memory = browserMemory;
      } catch {
        // CDP 可能不可用，静默跳过
      }
    }
    return systemInfo;
  }

  private async handleHeartbeatFailure(response: Response): Promise<void> {
    if (await this.checkDeviceNotFound(response)) return;
    if (!isAuthError(response.status)) {
      this.offlineState.fail('heartbeat', `HTTP ${response.status}`);
      return;
    }
    this.consecutiveAuthErrors++;
    this.logger.error(
      `Heartbeat auth failed: ${response.status} (${this.consecutiveAuthErrors}/${HeartbeatService.MAX_AUTH_ERRORS})`,
    );
    if (this.consecutiveAuthErrors >= HeartbeatService.MAX_AUTH_ERRORS && this.onFatalAuthError) {
      this.logger.error('[Heartbeat] Too many consecutive auth errors, triggering daemon restart');
      this.onFatalAuthError();
    }
  }

  private handleTokenExpiry(expiresIn: number): void {
    this.tokenExpiresAt = Date.now() + expiresIn * 1000;
    const sixHours = 6 * 3600;
    const sevenDays = 7 * 24 * 3600;
    const thirtyDays = 30 * 24 * 3600;
    if (expiresIn <= 0) {
      this.logger.error('Access token has EXPIRED — attempting automatic renewal...');
      this.startBackgroundTokenRenewal('expired');
    } else if (expiresIn < sixHours) {
      this.logger.warn(`Access token expires in ${Math.ceil(expiresIn / 3600)} hours — attempting automatic renewal...`);
      this.startBackgroundTokenRenewal('soon');
    } else if (expiresIn < sevenDays) {
      this.logger.info(`Access token expires in ${Math.ceil(expiresIn / 86400)} days`);
    } else if (expiresIn < thirtyDays) {
      this.logger.debug(`Access token expires in ${Math.ceil(expiresIn / 86400)} days`);
    }
  }

  private startBackgroundTokenRenewal(reason: 'expired' | 'soon'): void {
    this.attemptTokenRenewal().catch((err) => {
      this.logger.debug(`[Heartbeat] Background token renewal (${reason}): ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private async handleHeartbeatSuccess(response: Response): Promise<void> {
    this.consecutiveAuthErrors = 0;
    this.offlineState.recover();
    this.lastHeartbeatSuccessAt = new Date().toISOString();
    try {
      const json = await response.json() as Record<string, any>;
      const data = json?.data;
      const version = data?.latest_daemon_version;
      if (version && typeof version === 'string' && this.updater) this.updater.notifyLatestVersion(version);
      const expiresIn = data?.token_expires_in_seconds;
      if (typeof expiresIn === 'number') this.handleTokenExpiry(expiresIn);
    } catch (error) {
      this.logger.warn('[Heartbeat] Response parse error:', error);
    }
    this.onHeartbeatSuccess?.();
  }

  private async sendHeartbeat(): Promise<void> {
    try {
      const url = joinApiPath(deriveApiBaseUrl(this.config.server_url), API_ENDPOINTS.DEVICE.HEARTBEAT);
      const body = {
        fingerprint: this.config.fingerprint,
        capabilities: this.capabilities,
        system_info: await this.buildSystemInfo(),
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.gateway.getAccessToken()}`,
          'X-Client-Type': 'daemon',
          'X-Organization-Id': this.config.organization_id,
          'X-Device-Id': this.config.fingerprint,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        await this.handleHeartbeatFailure(response);
        return;
      }
      await this.handleHeartbeatSuccess(response);
    } catch (err) {
      this.offlineState.fail('heartbeat', err instanceof Error ? err.message : String(err));
    }
  }

  private async checkDeviceNotFound(response: Response): Promise<boolean> {
    if (response.status !== 404) return false;
    try {
      const body = await response.json() as Record<string, unknown>;
      if (body?.code === 'DEVICE_NOT_FOUND') {
        this.logger.error('[Heartbeat] Device has been removed from backend — triggering fatal exit');
        this.onFatalAuthError?.('Device has been removed by administrator');
        return true;
      }
    } catch {
      // JSON parse failure — not a DEVICE_NOT_FOUND response, fall through
    }
    return false;
  }

}
