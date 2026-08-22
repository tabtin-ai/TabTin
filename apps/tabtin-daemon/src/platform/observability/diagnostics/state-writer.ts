import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../logging/logger.js';
import { atomicWriteFileSync } from '@tabtin/terminal-core';

export interface DaemonState {
  pid: number;
  version: string;
  started_at: string;
  ws_status: string;
  last_heartbeat_at: string | null;
  uptime_seconds: number;
  active_actions: number;
  capabilities: string[];
  token_expires_at: string | null;
  last_heartbeat_success_at: string | null;
  ws_reconnect_count: number;
  offline_buffer_pending: number;
  drain_started_at: string | null;
  drain_timeout_ms: number | null;
}

const WRITE_INTERVAL_MS = 10_000;

interface StatePathPort {
  getConfigDir(): string;
  ensureConfigDir(): void;
}

interface GatewayStatePort {
  getStatus(): string;
  getReconnectCount(): number;
}

interface VersionStatePort {
  getCurrentVersion(): string;
}

interface OfflineBufferStatePort {
  getPendingCount(): number;
}

export class StateWriter {
  private readonly configManager: StatePathPort;
  private readonly logger: Logger;
  private readonly statePath: string;
  private readonly startedAt: string;
  private gateway: GatewayStatePort | null = null;
  private updater: VersionStatePort | null = null;
  private offlineBuffer: OfflineBufferStatePort | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeatAt: string | null = null;
  private activeActions = 0;
  private capabilities: string[] = [];
  private tokenExpiresAt: string | null = null;
  private drainStartedAt: string | null = null;
  private drainTimeoutMs: number | null = null;

  constructor(configManager: StatePathPort, logger: Logger) {
    this.configManager = configManager;
    this.logger = logger;
    this.statePath = path.join(configManager.getConfigDir(), 'state.json');
    this.startedAt = new Date().toISOString();
  }

  start(gateway: GatewayStatePort, updater: VersionStatePort, offlineBuffer?: OfflineBufferStatePort): void {
    this.gateway = gateway;
    this.updater = updater;
    this.offlineBuffer = offlineBuffer ?? null;
    this.write();
    this.timer = setInterval(() => this.write(), WRITE_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.removeStateFile();
  }

  recordHeartbeat(tokenExpiresAt?: string | null): void {
    this.lastHeartbeatAt = new Date().toISOString();
    if (tokenExpiresAt !== undefined) {
      this.tokenExpiresAt = tokenExpiresAt;
    }
    this.write();
  }

  setDrainInfo(startedAt: string, timeoutMs: number): void {
    this.drainStartedAt = startedAt;
    this.drainTimeoutMs = timeoutMs;
    this.write();
  }

  clearDrainInfo(): void {
    this.drainStartedAt = null;
    this.drainTimeoutMs = null;
    this.write();
  }

  setCapabilities(caps: string[]): void {
    this.capabilities = caps;
  }

  incrementActions(): void {
    this.activeActions++;
  }

  decrementActions(): void {
    if (this.activeActions > 0) this.activeActions--;
  }

  private write(): void {
    try {
      const state: DaemonState = {
        pid: process.pid,
        version: this.updater?.getCurrentVersion() ?? process.env.npm_package_version ?? '0.1.0',
        started_at: this.startedAt,
        ws_status: this.gateway?.getStatus?.() ?? 'unknown',
        last_heartbeat_at: this.lastHeartbeatAt,
        uptime_seconds: Math.floor((Date.now() - new Date(this.startedAt).getTime()) / 1000),
        active_actions: this.activeActions,
        capabilities: this.capabilities,
        token_expires_at: this.tokenExpiresAt,
        last_heartbeat_success_at: this.lastHeartbeatAt,
        ws_reconnect_count: this.gateway?.getReconnectCount?.() ?? 0,
        offline_buffer_pending: this.offlineBuffer?.getPendingCount?.() ?? 0,
        drain_started_at: this.drainStartedAt,
        drain_timeout_ms: this.drainTimeoutMs,
      };
      this.configManager.ensureConfigDir();
      atomicWriteFileSync(this.statePath, JSON.stringify(state, null, 2), 0o600);
    } catch (err) {
      this.logger.debug(`[StateWriter] write failed: ${err}`);
    }
  }

  private removeStateFile(): void {
    try {
      if (fs.existsSync(this.statePath)) {
        fs.unlinkSync(this.statePath);
      }
    } catch (err) {
      this.logger.debug(`[StateWriter] removeStateFile failed: ${err}`);
    }
  }

  static readState(configManager: Pick<StatePathPort, 'getConfigDir'>): DaemonState | null {
    const statePath = path.join(configManager.getConfigDir(), 'state.json');
    try {
      if (!fs.existsSync(statePath)) return null;
      const raw = fs.readFileSync(statePath, 'utf-8');
      return JSON.parse(raw) as DaemonState;
    } catch {
      return null;
    }
  }
}
