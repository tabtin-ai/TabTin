import { AgentStreamEvents, LocalRuntimeEvents } from '@tabtin/ws-gateway-client';
import {
  CAPABILITY_DISCOVERY_SNAPSHOT_VERSION,
  createMcpToolItems,
  createRuntimeToolItems,
  type HostRuntimeSnapshot,
} from '@tabtin/shared';

// ── globalThis.tabtin type declaration ───────────────────────────────────────
// Provides compile-time safety for the cross-module runtime bridge injected by
// injectGlobalTabtin(). Consumers must not access globalThis.tabtin directly
// before the Daemon's start() method completes.

declare global {
  // eslint-disable-next-line no-var
  var tabtin: TabtinGlobal | undefined;
}

interface TabtinGlobal {
  /** Base URL of the TabTin server (without /api suffix). */
  apiBaseUrl: string;
  auth: {
    /** Returns the current gateway access token (may be stale if gateway not yet connected). */
    getAccessToken(): string | null | undefined;
  };
}
// ─────────────────────────────────────────────────────────────────────────────
import type { Updater } from '../platform/system/update/updater.js';
import { ConfigManager } from '../platform/system/config/config-manager.js';
import { TerminalRuntime } from '../platform/terminal/terminal-runtime.js';
import type { DaemonConfig, LastExitInfo, FatalExitHandler, LastExitReason } from '../base/types/daemon-config.js';
import { createDaemonContainer, type DaemonContainer } from './container.js';
// SessionManager available at ./session/index.js — will be wired in Phase 2
// to drive the gateway connection lifecycle (runLoop + runSession).
import { TableKernelService } from '../platform/table/table-kernel-service.js';
import { TableLocalServer } from '../transport/table/table-local-server.js';
import { createSyncApiClient, createTableSchemaFetcher, createRemoteApiClient, createAuthedFetcher } from '../platform/table/sync-api-client.js';
import { TabTinMcpServer } from '../transport/mcp/mcp-server.js';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { deriveApiBaseUrl, joinApiPath, API_ENDPOINTS } from '@tabtin/config';
import {
  setTableKernelAPI,
  setHttpCrawlAPI,
  resolveHttpCrawlAPI,
} from '@tabtin/action-tools/headless';
import { setCheckpointLogger } from '../platform/workspace/checkpoint/CheckpointService.js';
import { requestPlatformApproval } from '@tabtin/agent-runtime';
import { wirePythonRuntimeHost } from '@tabtin/python-runtime-host';
import { CheckpointService } from '@tabtin/checkpoint-core';
import { DaemonCliServer, type CLIServerInfo } from '../transport/cli/cli-server.js';
import { updateDjangoProxyCredential } from '../transport/cli/routes/shared/error-handler.js';
import {
  isDaemonControlRegistrationEnabled,
  registerDaemonControlDevice,
} from '../transport/gateway/daemon-control-registration.js';
import { getActiveVideoTaskCount, initVideoRouteWs, shutdownVideoTasks } from '../transport/cli/routes/media/video.js';
import { validateUrl } from '../platform/browser/DaemonBrowserService.js';
import { BrowserRuntime } from '../platform/browser/browser-runtime.js';
import { DaemonBrowserApplication } from '../platform/browser/DaemonBrowserApplication.js';
import { DaemonLifecycle } from '../application/lifecycle/daemon-lifecycle.js';
import { setTerminalCoreLocale, atomicWriteFileSync } from '@tabtin/terminal-core';
import { DaemonAgentHost, type DaemonQueryRequest } from '../application/agent/daemon-agent-host.js';
import { PromptForwardController } from '../application/agent/prompt-forward-controller.js';
import { DocParserRuntime } from '../platform/content/document/doc-parser-runner.js';
import {
  daemonHostRuntimeOptions,
  decodeAttachmentStrategyFromPayload,
} from '@tabtin/agent-host/configuration'
const { decodeCloudPressureThresholds } = daemonHostRuntimeOptions
import { registerDaemonStorageBuckets } from '../platform/storage/storage-bucket-registration.js';
import { NodeStorageFileSystem } from '../platform/storage/node-storage-file-system.js';
import { createDaemonStorageApplication } from '../application/storage/daemon-storage.js';
import { createMcpContentApiPort, createMcpTablePort } from './adapters/mcp-runtime-adapters.js';
import { normalizeExecutionLimitsForCostCap } from '@tabtin/app-shell/agent-config-v2';
import {
  resolveDisabledToolPrefixes,
} from '@tabtin/agent-wire';
import {
  isCrossTurnMemoryEnabled,
  selectRecentHistoryForRuntime,
  type HistorySourceMessage,
} from '@tabtin/agent-runtime/history';
import { decodeWirePendingApprovals, decodeWirePendingSingleHitl } from '@tabtin/agent-runtime';
import {
  decodeForwardWorkspaceSnapshot,
  deriveRelaySessionId,
  type ForwardConversationRequest,
  type ForwardDecodeFailure,
} from '@tabtin/agent-host/conversation'
import type { SerializedPendingApproval, SerializedPendingSingleHitl } from '@tabtin/agent-runtime/engine';

/** sysexits EX_CONFIG — needs human intervention, systemd should NOT auto-restart. */
const EXIT_CODE_AUTH_FATAL = 78;

/**
 * Business-layer approval timeout (Daemon WS path).
 * Aligned with agent-runtime interactive HITL (30 min). Must be shorter than
 * action-bridge APPROVAL_FALLBACK_TIMEOUT_MS (PERMISSION_TIMEOUTS.FALLBACK_MS).
 * Electron IPC path uses the same FINAL_MS in ApprovalManager.ts.
 */

export class TabTinDaemon {
  private readonly c: DaemonContainer;

  // Convenience aliases for frequently-accessed container services
  private get config(): DaemonConfig { return this.c.config; }
  private get configManager(): ConfigManager { return this.c.configManager; }
  private get logger() { return this.c.logger; }
  private get gateway() { return this.c.gateway; }
  private get heartbeat() { return this.c.heartbeat; }
  private get bridge() { return this.c.bridge; }
  private get capabilityDetector() { return this.c.capabilityDetector; }
  private get pluginManager() { return this.c.pluginManager; }
  private get processManager() { return this.c.processManager; }
  private get updater() { return this.c.updater; }
  private get sleepBlocker() { return this.c.sleepBlocker; }
  private get stateWriter() { return this.c.stateWriter; }
  private get gitStatusRegistry() { return this.c.gitStatusRegistry; }
  private get offlineBuffer() { return this.c.offlineBuffer; }

  // Optional services (initialized during start)
  private localAgentHost: DaemonAgentHost | null = null;
  private tableKernelService: TableKernelService | null = null;
  private tableLocalServer: TableLocalServer | null = null;
  private mcpServer: TabTinMcpServer | null = null;
  private cliServerInfo: CLIServerInfo | null = null;
  private readonly cliServer = new DaemonCliServer();
  private terminalRuntime: TerminalRuntime | null = null;
  private browserRuntime: BrowserRuntime | null = null;
  private browserApplication: DaemonBrowserApplication | null = null;
  private ffmpegAvailable = false;
  private docEditorReady = false;
  private detectedCapabilities: string[] = [];
  private periodicGCHandle: ReturnType<typeof setInterval> | null = null;
  private daemonControlRegistrationTimer: ReturnType<typeof setTimeout> | null = null;
  private daemonControlRegistrationRetryDelayMs = 5_000;
  private daemonControlRegistrationInFlight = false;
  private daemonControlRegistrationStopped = true;
  private readonly lifecycle = new DaemonLifecycle();
  private readonly promptForwardController: PromptForwardController;
  constructor(configManager: ConfigManager) {
    this.c = createDaemonContainer(configManager, () => this.stop(), {
      requestApproval: async (_threadId, _taskId, command, policy) => {
        const result = await requestPlatformApproval({
          actionType: 'terminal_execute',
          detail: command.slice(0, 500),
          reason: typeof policy.reason === 'string' ? policy.reason : undefined,
          isStrict: true,
        });
        return result.approved;
      },
      isPtyAvailable: () => this.terminalRuntime?.isAvailable() === true,
      isBrowserAvailable: () => this.browserRuntime?.isAvailable() === true,
      resolveWorkspaceSnapshot: (spaceId) => {
        const host = this.localAgentHost;
        if (!host) return null;
        if (spaceId) return host.findWorkspaceSnapshotForSpace(spaceId);
        return host.findAnyActiveWorkspaceSnapshot();
      },
      getTranscriptRollbackPort: () => {
        const host = this.localAgentHost;
        if (!host) return null;
        return {
          rollback: (input) => host.rollbackTranscript(input),
          unrevert: (input) => host.unrevertTranscript(input),
        };
      },
    });
    this.promptForwardController = new PromptForwardController({
      acceptsNewTasks: () => this.lifecycle.acceptsNewTasks(),
      lifecycleState: () => this.lifecycle.getState(),
      hasAgentHost: () => this.localAgentHost !== null,
      feed: (envelope) => this.localAgentHost?.feedAgentEnvelope(envelope),
      reportFailure: (envelope, payload, message) => this.reportPromptForwardFailure(envelope, payload, message),
      handleUnavailableUserResponse: (envelope) => this.handleLocalRuntimeUserResponse(envelope),
      warn: (message) => this.logger.warn(message),
      debug: (message) => this.logger.debug(message),
    });
  }

  private async initializePtyManager(): Promise<void> {
    if (!await this.capabilityDetector.isPtyAvailable()) return;
    const terminalRuntime = new TerminalRuntime(
      this.config,
      this.logger,
      () => this.buildPtyEnv(),
    );
    const ptyReady = await terminalRuntime.start();
    if (!ptyReady) {
      this.logger.warn('[Daemon] PTY Manager initialization failed, falling back to spawn mode');
      return;
    }
    this.terminalRuntime = terminalRuntime;
    this.lifecycle.own('terminal-runtime', 'infrastructure', async () => {
      if (this.terminalRuntime === terminalRuntime) this.terminalRuntime = null;
      await terminalRuntime.dispose();
    });
    this.logger.info('[Daemon] PTY Manager initialized — terminal_read/terminal_write enabled');
  }

  private initializeHttpCrawlApi(): void {
    if (resolveHttpCrawlAPI()?.fetch) return;
    setHttpCrawlAPI({
      fetch: async (options) => {
        const startMs = Date.now();
        try {
          validateUrl(options.url);
          const response = await fetch(options.url, {
            headers: options.headers,
            signal: AbortSignal.timeout(options.timeout || 30_000),
          });
          const content = await response.text();
          const titleMatch = content.match(/<title[^>]*>([^<]*)<\/title>/i);
          return {
            success: true,
            data: {
              url: response.url,
              title: titleMatch?.[1]?.trim() ?? '',
              content,
              content_type: response.headers.get('content-type') || 'text/html',
              status_code: response.status,
              response_time_ms: Date.now() - startMs,
            },
          };
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
    });
    this.logger.info('[Daemon] HTTP-only HttpCrawlAPI injected (pre-browser fallback)');
  }

  private async initializeBrowserIfAvailable(): Promise<void> {
    if (!this.capabilityDetector.isBrowserAvailable()) return;
    try {
      await this.initBrowserService();
    } catch (error) {
      this.logger.warn(`[Daemon] Browser service init failed (non-critical): ${error}`);
      this.browserRuntime = null;
    }
  }

  async start(): Promise<void> {
    return this.lifecycle.runStart(async () => {
      await this.startRuntime();
      if (this.localAgentHost) {
        await this.requestPendingPromptForwards();
      }
    }, async (err) => {
      this.logger.error(`[Daemon] start() failed, rolling back: ${err instanceof Error ? err.message : String(err)}`);
      await this.disposeRuntime();
    });
  }

  private async startRuntime(): Promise<void> {
      this.lifecycle.own('container', 'infrastructure', () => this.c.dispose());
      this.lifecycle.own('plugin-manager', 'infrastructure', async () => {
        let disposeTimedOut = false;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            this.pluginManager.destroyAll(),
            new Promise<void>(resolve => {
              timeoutHandle = setTimeout(() => {
                disposeTimedOut = true;
                resolve();
              }, 5_000);
              timeoutHandle.unref();
            }),
          ]);
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
        }
        if (disposeTimedOut) {
          this.logger.warn('[Daemon] pluginManager dispose timed out after 5s — continuing shutdown');
        }
      });
      this.lifecycle.own('action-execution', 'workload', () => this.bridge.dispose());
      this.lifecycle.own('action-ingress', 'ingress', () => this.bridge.suspendIngress());
      this.logger.info(`TabTin Daemon v${process.env.npm_package_version ?? '0.1.0'} starting...`);
      this.logger.info(`Device: ${this.config.device_name} (${this.config.device_id})`);
      this.logger.info(`Server: ${this.config.server_url}`);

      this.processManager.setup();
      this.processManager.setDrainHandler(() => {
        this.drain().catch(err => this.logger.error(`[Daemon] Drain triggered by signal failed: ${err}`));
      });

      const langEnv = (process.env.LANG || process.env.LC_ALL || '').toLowerCase();
      setTerminalCoreLocale(langEnv.startsWith('zh') ? 'zh-CN' : 'en-US');

      const capabilities = await this.capabilityDetector.detect();
      this.detectedCapabilities = [...capabilities];
      this.logger.info(`Capabilities: ${capabilities.join(', ')}`);

      // 自管 Python 运行时：设 process.env（PATH + TABTIN_PYTHON_RUNTIME）。
      // fire-and-forget，**不阻塞 daemon 启动**——即使下载慢/失败也不拖挂/影响正常运行
      // （函数内部全兜错、返回 null）。DaemonPtyManager 在每次 spawn 时读 process.env，
      // 故 provision 完成后新起的 agent 命令自然拿到；未完成前回落系统 python。
      void wirePythonRuntimeHost({ logger: this.logger });

      await this.initializePtyManager();

      this.injectGlobalTabtin();

      this.initializeHttpCrawlApi();

      await this.initializeBrowserIfAvailable();
      this.browserApplication = new DaemonBrowserApplication({
        resolveBrowser: () => this.browserRuntime?.getService() ?? null,
        getSpaceId: () => process.env.TABTIN_SPACE_ID ?? null,
        startRecording: async (runId, tabId) => {
          if (!this.browserRuntime) throw new Error('BrowserRuntime 尚未初始化');
          return this.browserRuntime.startRecording(runId, tabId);
        },
        stopRecording: (runId) => this.browserRuntime?.stopRecording(runId) ?? Promise.resolve(null),
        getRecordingStatus: (runId) => this.browserRuntime?.getRecordingStatus(runId) ?? null,
        loadRecording: (runId) => this.browserRuntime?.loadRecording(runId) ?? Promise.resolve(null),
        listRecordings: async () => this.browserRuntime?.listRecordings() ?? [],
        recordAction: (runId, action) => this.browserRuntime?.recordAction(runId, action),
      });

      try {
        await this.ensureCheckpointsDir();
        setCheckpointLogger(this.logger);
        this.periodicGCHandle = CheckpointService.startPeriodicGC(
          CheckpointService.defaultRoot(),
          this.logger,
        );
        this.lifecycle.own('checkpoint-gc', 'infrastructure', () => {
          if (!this.periodicGCHandle) return;
          clearInterval(this.periodicGCHandle);
          this.periodicGCHandle = null;
        });
      } catch (err) {
        this.logger.warn(`[Daemon] Checkpoint service init failed (non-critical): ${err}`);
      }

      try {
        await this.pluginManager.loadConfiguredPlugins(this.config.plugins);
      } catch (err) {
        this.logger.warn(`[Daemon] Plugin loading failed (non-critical): ${err}`);
      }

      for (const cap of this.pluginManager.getAdditionalCapabilities()) {
        if (!capabilities.includes(cap)) capabilities.push(cap);
      }
      this.ffmpegAvailable = this.hasDetectedVideoEngineCapabilities(capabilities);

      this.bridge.refreshCapabilities(capabilities);
      this.bridge.registerCoreExecutors();

      this.heartbeat.setRuntimeSnapshotProvider(() => this.buildHostRuntimeSnapshot());

      this.gateway.setAgentEnvelopeHandler((envelope) => {
        this.handleAgentEnvelopeEvent(envelope).catch(err => {
          this.logger.error('Agent envelope handling failed', err);
        });
      });
      this.gateway.setCapabilityRefreshHandler(async (envelope) => {
        await this.handleCapabilityRefreshRequest(envelope).catch(err => {
          this.logger.error('Capability refresh handling failed', err);
        });
      });
      // Register git diff handler before connect() so backend requests arriving
      // immediately after handshake are not silently dropped (WS-P1-2).
      this.gateway.setGitDiffHandler(async (envelope) => {
        const payload = envelope.payload ?? {};
        const filePath = typeof payload.file_path === 'string' ? payload.file_path : '';
        const staged = payload.staged === true;
        const replyTo = typeof payload.reply_to === 'string' ? payload.reply_to : '';
        if (!filePath || !replyTo) return;
        const diff = await this.gitStatusRegistry.getFileDiff(filePath, staged);
        await this.gateway.sendGitDiffResponse(replyTo, filePath, diff);
      });
      this.lifecycle.own('gateway-ingress', 'ingress', () => this.gateway.suspendIngress());

      // EF-R1: Initialize TableKernel and MCP server BEFORE gateway.connect()
      // to eliminate the race window where incoming actions arrive before
      // these services are ready.
      // W6 (2026-05-04): the TabSlide AgentTool group was retired; the
      // Daemon no longer needs to inject a TabSlideAPI runtime bridge.
      await this.startTableKernel();
      await this.startMcpServer();

      // Build the local consumer before subscribing the device topic. Otherwise a
      // prompt delivered immediately after connect would be terminally rejected
      // during the starting window and then deduplicated from the ready replay.
      await this.startLocalAgentHost();
      await this.connectGatewayWithRetry(5, 2000);
      this.startDaemonControlRegistration(capabilities);

      this.gateway.onReconnect(async () => {
        const currentToken = this.gateway.getAccessToken();
        if (currentToken) {
          this.config.credential = currentToken;
          updateDjangoProxyCredential(currentToken);
          this.cliServer.updateCredential(currentToken);
        }
        this.triggerDaemonControlRegistration(capabilities);

        // S2-011: Drain pending prompt.forward events from Redis Stream
        // BEFORE replaying the offline buffer. These are server-side events
        // persisted by PromptForwardService._persist_to_stream() while we
        // were disconnected. Must be delivered first so agent tasks can be
        // (re)started before we send any locally-buffered output back.
        if (this.lifecycle.acceptsNewTasks() && this.localAgentHost) {
          await this.requestPendingPromptForwards();
        }

      });

      this.heartbeat.setUpdater(this.updater);
      this.heartbeat.setGitStatusRegistry(this.gitStatusRegistry);
      this.heartbeat.onHeartbeatSuccess = () => {
        this.stateWriter.recordHeartbeat(
          this.heartbeat.tokenExpiresAt ? new Date(this.heartbeat.tokenExpiresAt).toISOString() : null,
        );
      };
      this.heartbeat.onTokenRenewed = (newToken: string) => {
        this.gateway.updateAccessToken(newToken);
        this.config.credential = newToken;
        this.configManager.save(this.config);
        updateDjangoProxyCredential(newToken);
        this.cliServer.updateCredential(newToken);
        this.logger.info('[Daemon] Credential updated across all components after token renewal');
      };

      const fatalAuthExit: FatalExitHandler = (message?: string) => {
        const reason: LastExitReason = message?.toLowerCase().includes('removed')
          ? 'device_removed'
          : 'auth_fatal';
        this.logger.error(`[Daemon] Fatal exit (${reason}) — writing exit marker and stopping`);
        try {
          const exitInfo: LastExitInfo = {
            reason,
            timestamp: Date.now(),
            message: message || 'Token renewal failed after maximum retries',
            exit_code: EXIT_CODE_AUTH_FATAL,
            action_required: reason === 'device_removed' ? 'contact_admin' : 'reinit',
          };
          const exitPath = join(this.configManager.getConfigDir(), 'last-exit.json');
          atomicWriteFileSync(exitPath, JSON.stringify(exitInfo), 0o600);
        } catch (writeErr) {
          this.logger.warn(`[Daemon] Failed to write last-exit.json: ${writeErr}`);
        }
        this.stop()
          .catch((err) => this.logger.error(`[Daemon] Error during auth-fatal shutdown: ${err}`))
          .finally(() => {
            this.processManager.cleanup();
            process.exit(EXIT_CODE_AUTH_FATAL);
          });
      };
      this.heartbeat.onFatalAuthError = fatalAuthExit;
      this.gateway.onFatalAuthError = fatalAuthExit;
      this.gitStatusRegistry.setOnStatusReady((status) => {
        this.gateway.sendGitStatus(status).catch(() => {});
      });
      this.heartbeat.start(capabilities);
      this.lifecycle.own('heartbeat', 'infrastructure', () => this.heartbeat.stop());
      this.updater.startPeriodicCheck();
      this.lifecycle.own('updater', 'infrastructure', () => this.updater.stop());
      this.sleepBlocker.start();
      this.lifecycle.own('sleep-blocker', 'infrastructure', () => this.sleepBlocker.stop());
      this.stateWriter.setCapabilities(capabilities);
      this.stateWriter.start(this.gateway, this.updater, this.offlineBuffer);
      this.lifecycle.own('state-writer', 'infrastructure', () => this.stateWriter.stop());

      this.lifecycle.own('video-tasks', 'workload', () => shutdownVideoTasks());
      const browserApplication = this.browserApplication;
      this.lifecycle.own('browser-jobs', 'workload', () => browserApplication?.shutdownJobs());

      this.startCLI();
      this.initDocEditor().catch(err => this.logger.warn(`[Daemon] Doc editor init error: ${err}`));
      this.initVideoEngine().catch(err => this.logger.warn(`[Daemon] Video engine init error: ${err}`));
      this.heartbeat.triggerNow().catch(err => this.logger.warn(`[Daemon] Initial heartbeat error: ${err}`));

      // W2.3：CLI / 各 service 都已就绪，注册 13 个 daemon storage bucket。
      // 故意放在 startCLI() 之后——确保 CLI route /storage/* 第一时间就能
      // 看到完整 bucket 列表（避免"CLI 已就绪但 registry 还没填"的窗口期）。
      // 注册失败不阻塞 daemon 启动（critical path 已完成），只 warn。
      try {
        registerDaemonStorageBuckets({
          daemonHomeDir: this.configManager.getConfigDir(),
          logger: this.logger,
        });
      } catch (err) {
        this.logger.warn(
          `[Daemon] Storage bucket registration failed (non-critical): ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      this.logger.info('Daemon started and connected.');
  }

  private startDaemonControlRegistration(capabilities: string[]): void {
    if (!isDaemonControlRegistrationEnabled(this.config)) return;
    this.daemonControlRegistrationStopped = false;
    this.lifecycle.own('daemon-control-registration', 'infrastructure', () => {
      this.stopDaemonControlRegistration();
    });
    this.triggerDaemonControlRegistration(capabilities);
  }

  private triggerDaemonControlRegistration(capabilities: string[]): void {
    if (this.daemonControlRegistrationStopped) return;
    if (this.daemonControlRegistrationTimer) {
      clearTimeout(this.daemonControlRegistrationTimer);
      this.daemonControlRegistrationTimer = null;
    }
    this.daemonControlRegistrationRetryDelayMs = 5_000;
    void this.attemptDaemonControlRegistration(capabilities);
  }

  private async attemptDaemonControlRegistration(capabilities: string[]): Promise<void> {
    if (this.daemonControlRegistrationStopped || this.daemonControlRegistrationInFlight) return;
    this.daemonControlRegistrationInFlight = true;
    let registered = false;
    try {
      registered = await registerDaemonControlDevice(
        this.config,
        capabilities,
        this.logger,
      );
    } finally {
      this.daemonControlRegistrationInFlight = false;
    }
    if (registered) {
      try {
        this.configManager.save(this.config);
      } catch (error) {
        this.logger.warn(
          `[Daemon Control] Runtime profile revision persistence failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }
    if (this.daemonControlRegistrationStopped) return;

    const delayMs = this.daemonControlRegistrationRetryDelayMs;
    this.daemonControlRegistrationRetryDelayMs = Math.min(delayMs * 2, 60_000);
    this.daemonControlRegistrationTimer = setTimeout(() => {
      this.daemonControlRegistrationTimer = null;
      void this.attemptDaemonControlRegistration(capabilities);
    }, delayMs);
    this.daemonControlRegistrationTimer.unref();
  }

  private stopDaemonControlRegistration(): void {
    this.daemonControlRegistrationStopped = true;
    if (!this.daemonControlRegistrationTimer) return;
    clearTimeout(this.daemonControlRegistrationTimer);
    this.daemonControlRegistrationTimer = null;
  }

  /**
   * S2-011: Request the backend to replay any pending events from the
   * device-scoped Redis Stream (``ws:evt:agent.action.device.{fp}``).
   *
   * Uses the standard WS ``resume`` protocol with ``last_event_id: '0-0'``
   * so Django's ``_handle_resume`` reads **all** buffered events for our
   * subscribed topics and pushes them down the WS connection.
   *
   * This covers prompt.forward envelopes persisted by
   * ``PromptForwardService._persist_to_stream()`` while we were offline.
   * Events already received are deduplicated by the WsGatewayClient's
   * ``recentEventIds`` set, so a duplicate resume is harmless.
   *
   * Best-effort: failures are logged but never block startup/reconnect.
   */
  private async requestPendingPromptForwards(): Promise<void> {
    try {
      // sendAgentEvent(threadId='', type='resume', payload)
      // routes to Django's _handle_resume handler which reads from Redis
      // Streams for all topics in self.subscriptions (including our device
      // topic) and sends each pending envelope back to us.
      await this.gateway.sendAgentEvent('', 'resume', {
        last_event_id: '0-0',
      });
      this.logger.info('[Daemon] prompt.forward resume completed — pending events drained from Redis Stream');
    } catch (err) {
      this.logger.warn(
        `[Daemon] prompt.forward resume failed (non-critical, standard resume may cover it): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async connectGatewayWithRetry(maxAttempts: number, baseDelayMs: number): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.gateway.connect();
        return;
      } catch (err) {
        if (attempt === maxAttempts) throw err;
        const delay = Math.min(baseDelayMs * Math.pow(1.5, attempt - 1), 15_000);
        this.logger.warn(`[Daemon] Gateway connect attempt ${attempt}/${maxAttempts} failed, retry in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  private async refreshAccessToken(): Promise<string | null> {
    return this.heartbeat.attemptTokenRenewal();
  }

  private async startTableKernel(): Promise<void> {
    let kernel: TableKernelService | null = null;
    let localServer: TableLocalServer | null = null;
    try {
      this.configManager.ensureConfigDir();
      const tableKernelDbPath = join(this.configManager.getConfigDir(), 'table-kernel-db');
      const apiBaseOrigin = deriveApiBaseUrl(this.config.server_url).replace(/\/api$/, '');
      const apiClientConfig = {
        baseUrl: apiBaseOrigin,
        getAuthToken: async () => this.gateway.getAccessToken(),
        refreshToken: () => this.refreshAccessToken(),
      };
      const syncApiClient = createSyncApiClient(apiClientConfig);
      const fetchTableSchema = createTableSchemaFetcher(apiClientConfig);
      const remoteApiClient = createRemoteApiClient(apiClientConfig);

      kernel = new TableKernelService({
        syncApiClient,
        fetchTableSchema,
        remoteApiClient,
        logger: this.logger,
        onEvents: (events) => {
          this.logger.debug(`[TableKernel] ${events.length} domain event(s): ${events.map(e => e?.type ?? 'unknown').join(', ')}`);
        },
        createPGlite: async () => {
          const { PGlite } = await import('@electric-sql/pglite');
          return new PGlite(tableKernelDbPath);
        },
        backgroundSyncIntervalMs: 15_000,
        reconcileIntervalMs: 5 * 60_000,
      });

      this.tableKernelService = kernel;
      await kernel.start();

      localServer = new TableLocalServer(kernel, this.logger);
      this.tableLocalServer = localServer;
      const port = await localServer.start();

      this.injectTableKernelAPI(kernel);
      this.lifecycle.own('table-kernel', 'workload', async () => {
        if (this.tableKernelService === kernel) this.tableKernelService = null;
        await kernel?.stop();
      });
      this.lifecycle.own('table-local-server', 'infrastructure', async () => {
        if (this.tableLocalServer === localServer) this.tableLocalServer = null;
        await localServer?.stop();
      });
      this.lifecycle.own('table-local-ingress', 'ingress', () => localServer?.suspendIngress());

      this.logger.info(`TableKernel local server started on port ${port}`);
    } catch (err) {
      this.logger.warn(`TableKernel startup failed (non-critical): ${err}`);
      await localServer?.stop().catch((stopError) => {
        this.logger.warn(`TableLocalServer rollback failed: ${stopError}`);
      });
      await kernel?.stop().catch((stopError) => {
        this.logger.warn(`TableKernel rollback failed: ${stopError}`);
      });
      this.tableKernelService = null;
      this.tableLocalServer = null;
    }
  }

  private async startMcpServer(): Promise<void> {
    try {
      this.mcpServer = new TabTinMcpServer({
        contentApi: createMcpContentApiPort({
          apiBaseUrl: deriveApiBaseUrl(this.config.server_url).replace(/\/api$/, ''),
          getAuthToken: async () => this.gateway.getAccessToken(),
          refreshToken: () => this.refreshAccessToken(),
        }),
        table: createMcpTablePort(this.tableKernelService),
        adapter: this.bridge.getActionAdapter(),
        workspaceRoot: this.config.workspace_root,
        // 路径权限治理 Wave 4：MCP server 不带 spaceId（本机 LLM client 譬如
        // Claude Desktop 调本地 MCP 时不会传 Space），按 dogfood 单 session
        // 模式显式取"任一活跃 session 的 snapshot"。host 还没起时返回 null，
        // mcp-server 退化到 workspaceRoot 单条目录兜底。
        // P1-5：调显式 findAnyActiveWorkspaceSnapshot（不再 fallback fallthrough）
        getWorkspaceSnapshot: () => this.localAgentHost?.findAnyActiveWorkspaceSnapshot() ?? null,
      });
      const port = await this.mcpServer.start();
      const server = this.mcpServer;
      this.lifecycle.own('mcp-server', 'infrastructure', async () => {
        if (this.mcpServer === server) this.mcpServer = null;
        await server.stop();
      });
      this.logger.info(`TabTin MCP Server started on port ${port} (bearer token written to ~/.tabtin/mcp-server.json)`);
      // WP5 D8（2026-05-14）：显式 log 通告 MCP 不暴露的 llm_facing=false 工具，
      // 便于运维 / dogfood 排查"Claude Desktop 看不到 execute_in_terminal"为何。
      const nonLlmFacing = this.mcpServer.getNonLlmFacingAdapterToolNames();
      if (nonLlmFacing.length > 0) {
        this.logger.info(
          `MCP: filtered ${nonLlmFacing.length} llm_facing=false tools (D8: not exposed to external MCP clients): ${nonLlmFacing.join(', ')}`,
        );
      }
    } catch (err) {
      this.logger.warn(`MCP Server startup failed (non-critical): ${err}`);
      this.mcpServer = null;
    }
  }

  private startCLI(): void {
    try {
      this.cliServerInfo = this.cliServer.start({
        version: process.env.npm_package_version ?? '0.1.0',
        logger: this.logger,
        serverUrl: this.config.server_url,
        wsUrl: this.config.ws_url,
        credential: this.config.credential,
        organizationId: this.config.organization_id,
        // ：透传 userId 给 CLI context，本地 skills/plugins 落盘
        // 禁止 `_unscoped`（LH2-D3 install token payload.user_id）。
        userId: this.config.user_id,
        fingerprint: this.config.fingerprint,
        browserApplicationPort: this.browserApplication,
        storageApplication: createDaemonStorageApplication(new NodeStorageFileSystem()),
        requestContext: {
          workspaceSnapshotResolver: () => this.localAgentHost?.findAnyActiveWorkspaceSnapshot() ?? null,
          subagentCancelResolver: (childId) => this.localAgentHost?.cancelSubagentById(childId) ?? false,
          skillsMaterializer: async (params) => {
            const host = this.localAgentHost;
            if (!host) throw new Error('Skill registry 未初始化');
            return host.materializeAppSkill(params);
          },
          skillsInteropAdder: async (rootPath) => {
            const host = this.localAgentHost;
            if (!host) throw new Error('Skill registry 未初始化');
            await host.addInteropRoot(rootPath);
          },
        },
      });

      // 路径权限治理 Wave 4：注入 v3 SSoT 解析器到 CLI server。
      // CLI 客户端不带 spaceId（Go CLI 调本地 daemon 时只透传命令）；按
      // dogfood 单 session 模式显式取"任一活跃 session 的 snapshot"。
      // 闭包延迟绑定 localAgentHost——startCLI 通常在 startLocalAgentHost
      // 之前完成，闭包仅在 CLI 路由命中时才取值，到那时 host 已经起来。
      // P1-5：调显式 findAnyActiveWorkspaceSnapshot（不再 fallback fallthrough）
      // W0（2026-05-30）：CLI 取消子 Agent 路由到本进程 host。同款延迟绑定闭包——
      // startCLI 通常先于 startLocalAgentHost，闭包仅在路由命中时取值。host 未起 /
      // childId 不在本进程时返回 false（CLI 据此回 404）。
      // ：CLI enable 后物化 app skill —— 延迟绑定 localAgentHost。
      // ：npm 装完后刷新 ~/.agents/skills 本机扫描。
      initVideoRouteWs((type, payload) => {
        this.gateway.sendAgentEvent('', type, payload).catch((err) => {
          this.logger.warn(`[Daemon] 视频管线 WS 事件发送失败: ${err}`);
        });
      });

      this.logger.info(`[Daemon] CLI Server started on ${this.cliServerInfo.socketPath}`);
      this.lifecycle.own('cli-server', 'infrastructure', async () => {
        await this.cliServer.stop();
        this.cliServerInfo = null;
      });
      this.lifecycle.own('cli-ingress', 'ingress', () => this.cliServer.suspendIngress());
    } catch (err) {
      this.logger.warn(`[Daemon] CLI Server startup failed (non-critical): ${err}`);
      void this.cliServer.stop().catch((stopError) => {
        this.logger.warn(`[Daemon] CLI Server rollback failed: ${stopError}`);
      });
      this.cliServerInfo = null;
    }
  }

  /**
   * Verify doc-editor module is loadable for headless ProseMirror conversion.
   * TabDoc tools in MCP use Django API; this provides local markdown↔pmJson
   * conversion as a bonus capability for offline/fast-path scenarios.
   */
  private async initDocEditor(): Promise<void> {
    try {
      const { DOC_EDITOR_MODULE_INFO, markdownToPmJson, pmJsonToMarkdown } =
        await import('@tabtin/doc-editor');
      if (typeof markdownToPmJson !== 'function' || typeof pmJsonToMarkdown !== 'function') {
        throw new Error('doc-editor exports missing expected converter functions');
      }
      this.docEditorReady = true;
      this.logger.info(
        `[Daemon] doc-editor ${DOC_EDITOR_MODULE_INFO.version} loaded — local markdown↔pmJson conversion available`,
      );
    } catch (err) {
      this.docEditorReady = false;
      this.logger.warn(
        `[Daemon] doc-editor init failed (TabDoc tools will use Django API only): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Check FFmpeg availability for TabVideo rendering and export.
   * Video clip rendering may rely on FFmpeg for encoding.
   */
  private async initVideoEngine(): Promise<void> {
    this.ffmpegAvailable = this.hasDetectedVideoEngineCapabilities();
    if (this.ffmpegAvailable) {
      this.logger.info('[Daemon] FFmpeg verified by capability detector — video export ready');
    } else {
      this.logger.warn(
        '[Daemon] FFmpeg not verified by capability detector — video export unavailable. ' +
        'Install FFmpeg, then refresh device capabilities or restart TabTin Daemon.',
      );
    }
  }

  private hasDetectedVideoEngineCapabilities(capabilities: string[] = this.detectedCapabilities): boolean {
    return capabilities.includes('video_render_mg') && capabilities.includes('video_export');
  }

  private buildHostRuntimeSnapshot(reportedAt: string = new Date().toISOString()): HostRuntimeSnapshot {
    const rawMcpStatus = this.mcpServer?.getRuntimeStatus() ?? {
      running: false,
      tools: [],
      error: 'MCP server not started',
    };

    const bridgeActions = this.bridge.getRegisteredActions();
    const mcpLocalTools = this.mcpServer?.getLocalToolNames() ?? [];
    const allRuntimeTools = [...new Set([...bridgeActions, ...mcpLocalTools])];

    return {
      version: CAPABILITY_DISCOVERY_SNAPSHOT_VERSION,
      source: 'daemon',
      reported_at: reportedAt,
      runtime_tools: createRuntimeToolItems(allRuntimeTools, reportedAt),
      mcp_server: {
        running: rawMcpStatus.running === true,
        subtype: 'builtin',
        tools: createMcpToolItems(rawMcpStatus.tools ?? [], reportedAt, 'builtin'),
        ...(typeof rawMcpStatus.port === 'number' ? { port: rawMcpStatus.port } : {}),
        ...(typeof rawMcpStatus.endpoint === 'string' ? { endpoint: rawMcpStatus.endpoint } : {}),
        ...(typeof rawMcpStatus.error === 'string' ? { error: rawMcpStatus.error } : {}),
        observed_at: reportedAt,
        reason_codes: rawMcpStatus.running ? [] : ['mcp_not_running'],
      },
      creative_engines: {
        design_export: { ready: false },
        doc_editor: { module_loaded: this.docEditorReady },
        video_render_mg: { ready: this.ffmpegAvailable },
        video_export: { ready: this.ffmpegAvailable },
      },
    };
  }

  private async handleCapabilityRefreshRequest(envelope: { request_id: string; payload?: Record<string, any> }): Promise<void> {
    const refreshRequestId = typeof envelope.payload?.refresh_request_id === 'string'
      ? envelope.payload.refresh_request_id
      : envelope.request_id;
    await this.gateway.sendCapabilityRefreshAck(refreshRequestId, { status: 'accepted' });

    try {
      this.capabilityDetector.resetPtyCache?.();
      const freshCapabilities = await this.capabilityDetector.detect();
      for (const cap of this.pluginManager.getAdditionalCapabilities()) {
        if (!freshCapabilities.includes(cap)) freshCapabilities.push(cap);
      }
      this.detectedCapabilities = [...freshCapabilities];
      this.ffmpegAvailable = this.hasDetectedVideoEngineCapabilities(freshCapabilities);
      this.heartbeat.updateCapabilities(this.detectedCapabilities);
      this.bridge.refreshCapabilities(this.detectedCapabilities);

      const snapshot = this.buildHostRuntimeSnapshot();
      await this.gateway.sendDeviceCapabilitiesReport(
        this.detectedCapabilities,
        { host_runtime_snapshot: snapshot },
        'online',
      );
      await this.gateway.sendCapabilityRefreshResult(refreshRequestId, {
        status: 'accepted',
        reported_at: snapshot.reported_at,
        snapshot_version: snapshot.version,
      });
      this.heartbeat.triggerNow().catch(err => this.logger.warn(`[Daemon] Post-refresh heartbeat error: ${err}`));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.gateway.sendCapabilityRefreshResult(refreshRequestId, {
        status: 'failed',
        error: message,
      });
    }
  }

  private async sendLocalRuntimeUserResponseDelivery(
    env: Record<string, unknown>,
    payload: Record<string, unknown>,
    status: 'delivered' | 'pending_not_found' | 'runtime_unavailable' | 'invalid_response',
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const submitId = typeof payload.submit_id === 'string' ? payload.submit_id : '';
    if (!submitId) return;
    const responseObj = (payload.response && typeof payload.response === 'object' && !Array.isArray(payload.response))
      ? payload.response as Record<string, unknown>
      : {};
    const batchId = typeof responseObj.batch_id === 'string' ? responseObj.batch_id : undefined;
    const requestId = typeof payload.request_id === 'string' ? payload.request_id : undefined;
    const threadId = typeof env.thread_id === 'string' ? env.thread_id : '';
    try {
      await this.gateway.sendAgentEvent(threadId, LocalRuntimeEvents.USER_RESPONSE_DELIVERY, {
        submit_id: submitId,
        status,
        request_id: requestId,
        batch_id: batchId,
        ...extra,
      });
    } catch (err) {
      this.logger.warn(`[LocalRT] delivery ack failed: submit=${submitId} status=${status} error=${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * `user_response` 到达时 `localAgentHost` 还没起来（daemon 启动早期 / 关闭中）
   * 唯一走的旁路——只负责把 `runtime_unavailable` 回给 gateway。
   *
   * 真正的 batch / ask_user 分发（含 delivered / pending_not_found /
   * invalid_response 三态）**只在** `DaemonAgentHost.handleSharedHostUserResponse`
   * 里实现（AgentHost 分发 `commands.userResponse` 时进入）。历史上这里也复制了
   * 一份分发逻辑，但 host-not-ready 时 pending resolver 不可能存在，那份复制
   * 是死代码；此路径只做形态解析 + `runtime_unavailable` ack。
   */
  private async handleLocalRuntimeUserResponse(envelope: unknown): Promise<void> {
    if (!envelope || typeof envelope !== 'object') {
      this.logger.warn('[LocalRT] Received invalid user_response envelope');
      return;
    }
    const env = envelope as Record<string, unknown>;
    const payload = (env.payload && typeof env.payload === 'object')
      ? env.payload as Record<string, unknown>
      : {};
    const responseObj = (payload.response && typeof payload.response === 'object' && !Array.isArray(payload.response))
      ? payload.response as Record<string, unknown>
      : {};
    const batchId = typeof responseObj.batch_id === 'string' ? responseObj.batch_id : '';
    const topRequestId = typeof payload.request_id === 'string' ? payload.request_id : '';

    this.logger.warn(
      `[LocalRT] localAgentHost not ready, ack runtime_unavailable ` +
        `(batchId=${batchId || 'n/a'} requestId=${topRequestId || 'n/a'})`,
    );
    await this.sendLocalRuntimeUserResponseDelivery(env, payload, 'runtime_unavailable', {
      error_code: 'runtime_unavailable',
      error_message: 'DaemonAgentHost is not initialised',
      retryable: true,
    });
  }

  private async handleAgentEnvelopeEvent(envelope: unknown): Promise<void> {
    await this.promptForwardController.handle(envelope);
  }

  private async initBrowserService(): Promise<void> {
    const runtime = new BrowserRuntime(
      this.logger,
      this.config.workspace_root ?? '',
      {
        setMemoryProvider: (provider) => this.heartbeat.setBrowserMemoryProvider(provider),
        sendEvent: (eventType, payload) => this.gateway.sendAgentEvent('', eventType, payload),
      },
    );
    if (await runtime.start()) {
      this.browserRuntime = runtime;
      this.lifecycle.own('browser-runtime', 'infrastructure', async () => {
        if (this.browserRuntime === runtime) this.browserRuntime = null;
        await runtime.dispose();
      });
    }
  }

  async stop(): Promise<void> {
    return this.lifecycle.runStop(async () => {
      await this.disposeRuntime();
    });
  }

  private async disposeRuntime(): Promise<void> {
    this.logger.info('Daemon shutting down...');
    await this.lifecycle.disposeOwned((name, err) => {
      this.logger.warn(`[Daemon] lifecycle resource '${name}' dispose failed: ${err}`);
    });

    this.logger.info('Daemon stopped.');
  }

  async drain(timeoutMs = 600_000): Promise<void> {
    if (!this.lifecycle.beginDrain()) {
      this.logger.warn(`[Daemon] drain() called in state '${this.lifecycle.getState()}', ignoring`);
      return;
    }
    this.stateWriter.setDrainInfo(new Date().toISOString(), timeoutMs);
    this.logger.info(`[Daemon] Entering drain mode (timeout: ${timeoutMs}ms) — no new tasks accepted`);
    await this.lifecycle.disposePhase('ingress', (name, err) => {
      this.logger.warn(`[Daemon] lifecycle ingress '${name}' dispose failed: ${err}`);
    });

    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const remainingTasks = (): number =>
      (this.localAgentHost?.getState().activeSessions ?? 0)
      + this.bridge.getInflightActionCount()
      + this.cliServer.getActiveRequestCount()
      + (this.mcpServer?.getActiveCallCount() ?? 0)
      + (this.browserApplication?.getActiveJobCount() ?? 0)
      + getActiveVideoTaskCount();

    const completed = await new Promise<boolean>((resolve) => {
      const check = () => {
        if (remainingTasks() === 0) {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          resolve(true);
          return;
        }
        pollTimer = setTimeout(check, 1_000);
        pollTimer.unref();
      };

      timeoutTimer = setTimeout(() => {
        if (pollTimer) clearTimeout(pollTimer);
        resolve(false);
      }, timeoutMs);
      timeoutTimer.unref();

      check();
    });

    const exitPath = join(this.configManager.getConfigDir(), 'last-exit.json');
    if (completed) {
      this.logger.info('[Daemon] Drain complete — all tasks finished');
      try {
        const exitInfo: LastExitInfo = {
          reason: 'drain_complete',
          timestamp: Date.now(),
          message: 'All tasks completed, graceful shutdown',
          exit_code: 0,
          action_required: 'none',
        };
        atomicWriteFileSync(exitPath, JSON.stringify(exitInfo), 0o600);
      } catch (writeErr) {
        this.logger.warn(`[Daemon] Failed to write last-exit.json: ${writeErr}`);
      }
    } else {
      const remaining = remainingTasks();
      this.logger.warn(`[Daemon] Drain timeout — ${remaining} task(s) still active`);
      try {
        const exitInfo: LastExitInfo = {
          reason: 'drain_timeout',
          timestamp: Date.now(),
          message: `Drain timed out with ${remaining} active task(s)`,
          exit_code: 0,
          action_required: 'none',
          context: { pending_tasks: remaining },
        };
        atomicWriteFileSync(exitPath, JSON.stringify(exitInfo), 0o600);
      } catch (writeErr) {
        this.logger.warn(`[Daemon] Failed to write last-exit.json: ${writeErr}`);
      }
    }

    this.stateWriter.clearDrainInfo();
    await this.stop();
    this.processManager.cleanup();
    process.exit(0);
  }

  private async ensureCheckpointsDir(): Promise<void> {
    const checkpointsRoot = CheckpointService.defaultRoot();
    await mkdir(checkpointsRoot, { recursive: true });
    this.logger.info(`[Daemon] Checkpoints directory ensured: ${checkpointsRoot}`);
  }

  private injectTableKernelAPI(kernel: TableKernelService): void {
    const apiBase = deriveApiBaseUrl(this.config.server_url);
    const fetcher = createAuthedFetcher(async () => this.gateway.getAccessToken(), undefined, () => this.refreshAccessToken());

    const apiGet = async (path: string): Promise<unknown> => {
      const url = joinApiPath(apiBase, path);
      const raw = await fetcher(url) as Record<string, unknown>;
      if (raw && typeof raw === 'object' && 'success' in raw && 'data' in raw) {
        return raw.data;
      }
      return raw;
    };

    // 后端 open API 实际前缀是 /open/v1（非 /tabdata/open/v1），
    // 保留原路径待后端确认后修正。tabtin-config 已下架 TABDATA_OPEN
    // endpoint group（见 endpoints.ts:418-420 注释），daemon 端用本地定义。
    const tabdataOpenRecords = (tid: string): string => `/tabdata/open/v1/tables/${tid}/records`;

    setTableKernelAPI({
      listTables: async (input) => {
        const spaceId = input.spaceId;
        if (spaceId) {
          const data = await apiGet(API_ENDPOINTS.OPEN_API.SPACE_TABLES(spaceId)) as Record<string, unknown>;
          const tables = (data as any).tables ?? (data as any).items ?? [];
          return { tables };
        }
        const spacesData = await apiGet(API_ENDPOINTS.OPEN_API.SPACES) as Record<string, unknown>;
        const spaces = (spacesData as any).spaces ?? [];
        const dedup = new Map<string, unknown>();
        const results = await Promise.all(
          spaces.map((s: any) => apiGet(API_ENDPOINTS.OPEN_API.SPACE_TABLES(s.id))),
        );
        for (const data of results) {
          for (const t of (data as any).tables ?? (data as any).items ?? []) {
            dedup.set(t.id, t);
          }
        }
        return { tables: [...dedup.values()] };
      },
      getTableSchema: async (tableId) => {
        const basePath = tabdataOpenRecords(tableId).replace(/\/records$/, '');
        const [apiInfo, fieldList] = await Promise.all([
          apiGet(`${basePath}/api-info`),
          apiGet(`${basePath}/fields`),
        ]);
        return { table: (apiInfo as any).table, fields: (fieldList as any).fields ?? [] };
      },
      queryRecords: async (input) => {
        const params = new URLSearchParams({
          page: String(input.page ?? 1),
          page_size: String(Math.min(input.pageSize ?? 100, 1000)),
          field_key_type: input.fieldKeyType ?? 'name',
        });
        if (input.filters && typeof input.filters === 'object') {
          params.set('filter', JSON.stringify(input.filters));
        }
        this.applyRecordSortParams(params, input.sorts);
        const data = await apiGet(`${tabdataOpenRecords(input.tableId)}?${params}`) as Record<string, unknown>;
        return {
          records: (data as any).records ?? [],
          total: (data as any).total ?? 0,
          page: input.page ?? 1,
          page_size: Math.min(input.pageSize ?? 100, 1000),
        };
      },
      createRecord: async (input) => kernel.createRecord(input),
      updateRecord: async (input) => kernel.updateRecord(input),
      deleteRecord: async (input) => kernel.deleteRecord(input),
    });
    this.logger.info('[Daemon] TableKernelAPI injected into action-tools runtime bridge');
  }

  private applyRecordSortParams(params: URLSearchParams, sorts: unknown): void {
    if (!Array.isArray(sorts) || sorts.length === 0) return;
    const first = sorts[0] as Record<string, unknown>;
    const fieldRef = (first.field_id ?? first.field ?? first.fieldId) as string | undefined;
    if (!fieldRef) return;
    params.set('sort_by', fieldRef);
    params.set('sort_order', (first.order as string) || 'asc');
  }

  /**
   * Injects the runtime bridge into `globalThis.tabtin`.
   *
   * Runtime bridge used by headless action-tools HTTP wrappers.
   */
  private injectGlobalTabtin(): void {
    const apiBaseUrl = deriveApiBaseUrl(this.config.server_url);
    const auth = { getAccessToken: () => this.gateway.getAccessToken() };
    const organizationId = this.config.organization_id || undefined;
    Object.assign((globalThis as any).tabtin ??= {}, { apiBaseUrl, auth, organizationId });
    this.logger.info('[Daemon] globalThis.tabtin injected (apiBaseUrl + auth + organizationId)');
  }

  /**
   * Builds extra env vars injected into every PTY session.
   * Called lazily at spawn time so values reflect the latest state
   * (CLI Server may start after PtyManager is created).
   */
  private buildPtyEnv(): Record<string, string> {
    const env: Record<string, string> = {};

    // SD-039 Phase 1: 不再向 PTY 子进程注入 TABTIN_SOCK 环境变量。
    // CLI 工具通过 ~/.tabtin/daemon-server.json 文件发现机制定位 socket（CB-02）。
    // TABTIN_TOKEN / TABTIN_JWT 同样不注入，防止凭据泄漏到子进程。
    // 详见 support/strategy/2026-03-24-sd039-sock-assessment.md §6.1

    const ptyApiBase = deriveApiBaseUrl(this.config.server_url).replace(/\/api$/, '');
    if (ptyApiBase) {
      env.TABTIN_API_URL = ptyApiBase;
    }

    return env;
  }


  private async startLocalAgentHost(): Promise<void> {
    let host: DaemonAgentHost | null = null;
    try {
      const candidate = new DaemonAgentHost({
        gateway: this.gateway,
        config: this.config,
        logger: this.logger,
        getAccessToken: () => this.gateway.getAccessToken() ?? '',
        getPtyManagerBridge: () => this.terminalRuntime?.getAgentBridge() ?? null,
        getMcpServerEndpoint: () => {
          const status = this.mcpServer?.getRuntimeStatus();
          if (!status?.running || !status.endpoint) return null;
          return { url: status.endpoint, token: this.mcpServer!.getBearerToken() };
        },
        workspaceRoot: this.config.workspace_root,
        organizationId: this.config.organization_id,
        docParser: new DocParserRuntime(),
      });
      host = candidate;
      candidate.bindPromptForwardHandler((request, envelope) =>
        this.routeToLocalAgentHost(request, envelope),
      );
      candidate.bindPromptForwardDecodeFailedHandler(
        (envelope, failure) =>
          this.reportPromptForwardFailure(
            envelope,
            this.getPromptForwardRawPayload(envelope),
            failure.error,
          ),
      );
      await candidate.start();
      this.localAgentHost = candidate;
      this.lifecycle.own('agent-session-runtime', 'workload', async () => {
        await candidate.flushRunningBackgroundTasksOnExit().catch(err => {
          this.logger.warn(`[Daemon] flushRunningBackgroundTasksOnExit() error: ${err}`);
        });
        await candidate.stop();
        if (this.localAgentHost === candidate) this.localAgentHost = null;
      });
      this.logger.info('[Daemon] DaemonAgentHost initialized — local runtime ready');
    } catch (err) {
      this.logger.warn(`[Daemon] DaemonAgentHost init failed (non-critical): ${err}`);
      await host?.stop().catch(() => {});
      this.localAgentHost = null;
    }
  }

  /**
   * Route an agent.prompt.forward envelope with runtime_mode='local' to
   * DaemonAgentHost. 共享 `decodeForwardRequestDetailed` 已经完成 zod 校验；
   * 本方法只承接 daemon-specific 的 DaemonQueryRequest 组装（subagent_config、
   * 跨轮 history kill-switch 需要读 `parsedPayload`，其余字段直接从 request
   * camelCase 拿）。
   */
  private async routeToLocalAgentHost(
    request: ForwardConversationRequest,
    envelope: Record<string, unknown>,
  ): Promise<boolean> {
    const rawPayload = this.getPromptForwardRawPayload(envelope);
    const threadId = typeof envelope.thread_id === 'string' ? envelope.thread_id : '';
    const payload = request.parsedPayload;
    if (!payload) {
      // 契约：`decodeForwardRequestDetailed` 成功时 `parsedPayload` 一定存在；
      // 缺失说明共享 decoder 契约被破坏。fail-closed，让 relay 上报错误。
      await this.reportPromptForwardFailure(
        envelope,
        rawPayload,
        'Invalid prompt.forward payload: parsedPayload missing after decode',
      );
      return false;
    }

    const resolvedSessionId = payload.task_id || `local_${Date.now()}`;
    const relaySessionId = request.relaySessionId ?? deriveRelaySessionId(threadId);
    const disabledApps = request.disabledApps ?? [];
    const disabledToolPrefixes = resolveDisabledToolPrefixes(
      disabledApps,
      request.disabledToolPrefixes,
    );

    const daemonRequest: DaemonQueryRequest = {
      prompt: request.prompt,
      runId: request.runId,
      sessionId: resolvedSessionId,
      taskId: payload.task_id,
      relaySessionId,
      threadId,
      modelId: request.modelId,
      modelSupportsVideoInput: request.modelSupportsVideoInput,
      modelSupportsDocumentInput: request.modelSupportsDocumentInput,
      systemPrompt: request.systemPrompt,
      agentId: request.agentId,
      authorizationPreset: this.resolveAuthPreset(rawPayload),
      yoloMode: request.yoloMode === true,
      //  三档审批策略：对话级请求档 + Agent 已授权档（Django resolve 后
      // 下发的权威值——与 yolo_mode 同信任模型）。DaemonAgentHost 内做枚举守卫
      // 后分别写入 policyContext.requestedApprovalMode / agentConfigV3.security
      // .approval_grant；缺省（旧 Django）→ undefined → build-policy legacy 归一。
      approvalMode: request.approvalMode,
      approvalGrant: request.approvalGrant,
      workspaceSnapshot:
        request.workspaceSnapshot
        ?? decodeForwardWorkspaceSnapshot(payload.workspace_snapshot, this.logger),
      customRules: request.customRules,
      agentName: request.agentName,
      personalRules: request.personalRules,
      attachments: request.attachments as DaemonQueryRequest['attachments'],
      // ：context / 结构化用户块透传（wire user_message_blocks）。
      userMessageBlocks: request.userMessageBlocks,
      //  / ：Skill 直链（wire skill_slash_invoke）
      skillSlashInvoke: request.skillSlashInvoke,
      // FR-18 Phase 2 (H2-E)：附件解析策略。Django 端可在 prompt.forward payload
      // 通过 `attachment_strategy: 'local_first' | 'cloud_first' | 'cloud_only'`
      // 覆盖 Daemon 默认；缺省时 DaemonAgentHost 走 env `TABTIN_ATTACHMENT_STRATEGY`
      // 兜底（最终默认 'local_first'）。Decoder 抽到 host-knobs 便于单测，
      // 见 `decodeAttachmentStrategyFromPayload` 的 doc-string 解释为什么不在
      // 这里 inline。
      attachmentStrategy: decodeAttachmentStrategyFromPayload(rawPayload),
      agentMode: this.resolveAgentMode(rawPayload),
      interactionMode: request.interactionMode,
      spaceId: request.spaceId,
      // ：执行场 Workspace id —— 由共享 decoder 从 `payload.workspace_id`
      // 解出并挂在 `request.workspaceId`（必填，wire schema 已收紧）。
      // DaemonAgentHost.handleQuery 会在缺失时 fail-closed。
      workspaceId: request.workspaceId,
      appContext: this.resolveAppContext(rawPayload),
      enabledApps: this.resolveEnabledApps(rawPayload),
      spaceName: request.spaceName,
      organizationName: request.organizationName,
      cliReference: request.cliReference,
      // Phase 1 跨轮记忆：Django 组装的 history + agent_config kill-switch 依赖
      // 原始 wire payload（不进 ForwardConversationRequest 顶层）。
      history: this.resolveCrossTurnHistory(rawPayload, resolvedSessionId),
      operationSwitches: this.decodeOperationSwitches(rawPayload.operation_switches),
      devicePermissions: this.decodeOperationSwitches(rawPayload.device_permissions),
      executionLimits: this.decodeExecutionLimits(rawPayload.execution_limits),
      memoryCapability: request.memoryCapability,
      workingDirType:
        request.workingDirType === 'code'
        || request.workingDirType === 'doc'
        || request.workingDirType === 'mixed'
          ? request.workingDirType
          : undefined,
      disabledApps,
      disabledToolPrefixes,
      clientMessageId: request.clientMessageId,
      billingIdempotencyScope: request.billingIdempotencyScope,
      displayMessage: request.displayMessage,
      replyTo: request.replyToMessageId
        ? {
            messageId: request.replyToMessageId,
            preview: request.replyToPreview as NonNullable<DaemonQueryRequest['replyTo']>['preview'],
          }
        : undefined,
      pendingApprovalsSerialized: this.resolvePendingApprovalsSerialized(rawPayload),
      pendingSingleHitlSerialized: this.resolvePendingSingleHitlSerialized(rawPayload),
      isGroupSpace: request.isGroupSpace,
      cloudPressureThresholds:
        request.cloudPressureThresholds
        ?? decodeCloudPressureThresholds(rawPayload.pressure_thresholds, this.logger),
    };

    this.logger.info(
      `[cross-turn] enabled=${daemonRequest.history !== undefined} history_len=${daemonRequest.history?.length ?? 0} thread=${threadId.slice(0, 12)}`,
    );
    this.logger.info(
      `[Daemon] Routing prompt.forward to local runtime: session=${daemonRequest.sessionId.slice(0, 8)}… thread=${threadId.slice(0, 8)}…`,
    );

    const result = await this.localAgentHost!.handleQuery(daemonRequest);
    if (!result.success) {
      this.logger.error(`[Daemon] Local runtime query failed: ${result.error}`);
    }
    return result.success;
  }

  private getPromptForwardRawPayload(envelope: Record<string, unknown>): Record<string, unknown> {
    return envelope.payload && typeof envelope.payload === 'object' && !Array.isArray(envelope.payload)
      ? envelope.payload as Record<string, unknown>
      : {};
  }

  private async reportPromptForwardFailure(
    envelope: Record<string, unknown>,
    rawPayload: Record<string, unknown>,
    errorMessage: string,
  ): Promise<void> {
    const threadId = typeof envelope.thread_id === 'string' ? envelope.thread_id : '';
    if (!threadId) {
      this.logger.warn('[Daemon] Cannot report prompt.forward failure: missing thread_id');
      return;
    }
    const taskId = typeof rawPayload.task_id === 'string' && rawPayload.task_id
      ? rawPayload.task_id
      : `prompt_error_${Date.now()}`;
    const sourceClientEventId = typeof rawPayload.client_message_id === 'string'
      && rawPayload.client_message_id
      ? rawPayload.client_message_id
      : undefined;

    // prompt.forward 失败兜底统一走正常的 `agent.stream.done(error)` 上报路径
    // （与 runtime 跑一半失败同构）：Django relay_handler 据此写 `runtime:result:{task_id}`
    // 让 forward_runner 解除阻塞，并向前端广播错误。relay 路径只认裸 ChatSession
    // UUID，故从 `chat-session-` 前缀剥出；非 chat-session thread 无法 relay（这类
    // thread 不走 forward_runner 阻塞，故仅记日志不致挂起）。
    const relaySessionId = deriveRelaySessionId(threadId);
    if (!relaySessionId) {
      this.logger.warn(
        `[Daemon] Cannot relay prompt.forward failure: thread_id "${threadId}" 非 chat-session 格式`,
      );
      return;
    }

    try {
      await this.gateway.relayEvents(relaySessionId, [
        {
          type: AgentStreamEvents.DONE,
          payload: {
            task_id: taskId,
            content: '',
            error: true,
            error_message: errorMessage,
            error_class: 'RUNTIME_UNAVAILABLE',
            agent_type: 'local-runtime',
            ...(sourceClientEventId
              ? { source_client_event_id: sourceClientEventId }
              : {}),
          },
        },
      ]);
    } catch (err) {
      this.logger.warn(
        `[Daemon] Failed to relay prompt.forward failure: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private resolveAuthPreset(
    payload: Record<string, unknown>,
  ): 'cautious' | 'collaborative' | 'full_auto' | 'server_auto' | undefined {
    const raw = payload.authorization_preset;
    if (raw === 'cautious' || raw === 'collaborative' || raw === 'full_auto' || raw === 'server_auto') {
      return raw;
    }
    return undefined;
  }

  /**
   * W7b M3：从 prompt.forward payload 解出 operation_switches / device_permissions。
   *
   * 两个字段共用同一形态：`{ key: 'allow' | 'confirm' | 'block' }`。
   * 对未知 value 静默丢弃（防御注入），保留已知 key + value 形成 partial overrides
   * 写入 ToolProvider；ToolProvider 内部会与 preset 默认值合并，缺失的 key 走默认。
   *
   * 非 object 输入 → undefined（行为完全等同 prompt.forward 没传该字段）。
   */
  private decodeOperationSwitches(
    raw: unknown,
  ): Record<string, 'allow' | 'confirm' | 'block'> | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const result: Record<string, 'allow' | 'confirm' | 'block'> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v === 'allow' || v === 'confirm' || v === 'block') {
        result[k] = v;
      }
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }

  /**
   * W7b M3：从 prompt.forward payload 解出 execution_limits。
   *
   * **W2.3-fix（F8 修复）**：复用 `@tabtin/app-shell` 的
   * `normalizeExecutionLimitsForCostCap` 作为 SSoT —— 该 helper 同时被
   * Electron 主进程装配 CostCap 时使用，确保两宿主对 v2 字段（含 Django
   * 校验后字符串化的 `max_credits_per_run`）的归一逻辑完全一致。
   *
   * 期望输入形态：`{ max_iterations_per_run?: number | null, max_credits_per_run?: number | string | null }`。
   * 输出形态：`{ max_iterations_per_run?: number, max_credits_per_run?: number }`，
   * CostCap.config.execution_limits 直接消费。
   */
  private decodeExecutionLimits(
    raw: unknown,
  ): { max_iterations_per_run?: number; max_credits_per_run?: number } | undefined {
    return normalizeExecutionLimitsForCostCap(raw);
  }

  /**
   * W7a：从 prompt.forward payload 解出 agent_mode。
   *
   * 与 `resolveAuthPreset` 同模式 —— 白名单识别，未知值返回 undefined 让
   * DaemonAgentHost 内部 `resolveAgentModeName(_, 'agent')` 兜底。
   *
   * 抽出独立方法（vs inline 三元）：未来加 mode（如 'group_lite'）只需改一处，
   * 与 resolveAuthPreset 风格一致。Daemon 端不引 `@tabtin/agent-modes` 依赖
   * 是为了让 daemon.ts 顶层 import 保持精简（host 内部会做 strict resolve）。
   */
  private resolveAgentMode(
    payload: Record<string, unknown>,
  ): 'agent' | 'plan' | 'ask' | 'study' | 'group' | 'yolo' | undefined {
    const raw = payload.agent_mode;
    if (
      raw === 'agent' ||
      raw === 'plan' ||
      raw === 'ask' ||
      raw === 'study' ||
      raw === 'group' ||
      // PRD v3 §5.6 Daemon 路径：'yolo' 是 PR4 新增的合法 mode（前已遗漏导致
      // payload.agent_mode='yolo' 被静默 fallback 'agent'，yolo gate 永不生效）。
      raw === 'yolo'
    ) {
      return raw;
    }
    return undefined;
  }

  /**
   * W3-轮 1：从 prompt.forward payload 解出 crash resume 快照。
   *
   * Django 在 `prompt.forward.resume` 路径上把
   * `ConversationState.interrupt_state.pending_approvals[]`（snake_case）放进
   * `payload.interrupt_state` 字段；本方法解出 + 转 camelCase
   * `SerializedPendingApproval[]` 给 DaemonAgentHost.handleQuery。
   *
   * 容错：非 object / 非 array / 空数组 → undefined（让 runtime 走非 resume
   * 路径；与 history / app_context decoder 同模式）。
   */
  private resolvePendingApprovalsSerialized(
    payload: Record<string, unknown>,
  ): SerializedPendingApproval[] | undefined {
    const interruptState = payload.interrupt_state;
    if (!interruptState || typeof interruptState !== 'object' || Array.isArray(interruptState)) {
      return undefined;
    }
    const rawList = (interruptState as Record<string, unknown>).pending_approvals;
    if (!Array.isArray(rawList) || rawList.length === 0) return undefined;
    const decoded = decodeWirePendingApprovals(rawList, (level, message) => {
      if (level === 'warn') this.logger.warn(`[Daemon] ${message}`);
      else this.logger.debug(`[Daemon] ${message}`);
    });
    return decoded.length > 0 ? decoded : undefined;
  }

  /**
   * ：单 HITL 断点恢复快照解析（与 pending_approvals 对称）。
   *
   * Django `prompt_forward_service` 在 resume 路径上把 `PendingInteraction`
   * pending / resolved 行按 `SerializedPendingSingleHitl` wire 形态放进
   * `payload.interrupt_state.pending_single_hitl`；本方法解出 + 转 camelCase
   * 给 DaemonAgentHost.handleQuery，由 pending-single-hitl-restorer 处理。
   */
  private resolvePendingSingleHitlSerialized(
    payload: Record<string, unknown>,
  ): SerializedPendingSingleHitl[] | undefined {
    const interruptState = payload.interrupt_state;
    if (!interruptState || typeof interruptState !== 'object' || Array.isArray(interruptState)) {
      return undefined;
    }
    const rawList = (interruptState as Record<string, unknown>).pending_single_hitl;
    if (!Array.isArray(rawList) || rawList.length === 0) return undefined;
    const decoded = decodeWirePendingSingleHitl(rawList, (level, message) => {
      if (level === 'warn') this.logger.warn(`[Daemon] ${message}`);
      else this.logger.debug(`[Daemon] ${message}`);
    });
    return decoded.length > 0 ? decoded : undefined;
  }

  /**
   * W7a：从 prompt.forward payload 解出 app_context（用户聚焦的 App + 打开标签）。
   *
   * 字段语义见 `@tabtin/agent-runtime/engine` 的 `AppContext`（W2.3 后
   * SSoT 在 `engine/hooks/context-injector.ts`，原
   * `middleware/context-injector.ts` 已下线）。
   * 完全由远端客户端经 Django 携带（Daemon 自身没有 GUI 不知道用户在看什么）。
   *
   * 容错策略：非 object payload → undefined（让 buildContextInjectorHook 跳过该轮注入）；
   * 不做字段级强校验，让 hook 内的 `buildContextText` 自己决定如何
   * 渲染部分字段缺失的 context（例如只有 spaceId 没有 openTabs 时也能渲染）。
   */
  private resolveAppContext(
    payload: Record<string, unknown>,
  ): DaemonQueryRequest['appContext'] | undefined {
    const raw = payload.app_context;
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      this.logger.warn(`[Daemon] prompt.forward app_context not an object, ignored`);
      return undefined;
    }
    return raw as DaemonQueryRequest['appContext'];
  }

  /**
   * W7c · Stage 4 双路径对齐：从 prompt.forward payload 解出 enabled_apps。
   *
   * Django 端 ``prompt_forward_service.derive_enabled_apps_for_forward`` 派生的
   * snake_case 形态（``{key, cli_key, display_name, capability, aliases}``）
   * 映射到 Daemon 内部 camelCase（``EnabledAppInfo``）。
   *
   * 容错：非数组 / 空数组 → undefined（让 buildAppsSection 跳过 ``<apps>`` 段）；
   * 单条 entry 缺 ``key`` / ``display_name`` / ``capability`` → 跳过该条 + warn。
   */
  private normalizeEnabledApp(
    entry: unknown,
  ): NonNullable<DaemonQueryRequest['enabledApps']>[number] | undefined {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
    const obj = entry as Record<string, unknown>;
    const readNonEmptyString = (value: unknown) => (
      typeof value === 'string' && value.trim() ? value : undefined
    );
    const key = readNonEmptyString(obj.key);
    const displayName = readNonEmptyString(obj.display_name);
    const capability = readNonEmptyString(obj.capability);
    if (!key || !displayName || !capability) {
      this.logger.warn(
        `[Daemon] prompt.forward enabled_apps entry skipped (empty key/display_name/capability)`,
      );
      return undefined;
    }
    const cliKey = readNonEmptyString(obj.cli_key);
    const aliases = Array.isArray(obj.aliases)
      ? obj.aliases.filter((alias): alias is string => typeof alias === 'string' && alias.length > 0)
      : [];
    return {
      key,
      displayName,
      capability,
      ...(cliKey ? { cliKey } : {}),
      ...(aliases.length > 0 ? { aliases } : {}),
    };
  }

  private resolveEnabledApps(
    payload: Record<string, unknown>,
  ): DaemonQueryRequest['enabledApps'] | undefined {
    const raw = payload.enabled_apps;
    if (!Array.isArray(raw) || raw.length === 0) return undefined;

    type Camel = NonNullable<DaemonQueryRequest['enabledApps']>[number];
    const mapped: Camel[] = [];
    for (const entry of raw) {
      const app = this.normalizeEnabledApp(entry);
      if (app) mapped.push(app);
    }
    return mapped.length > 0 ? mapped : undefined;
  }

  /** W7c · Stage 4：从 payload 解出可选字符串字段（trim 空串归一为 undefined）。 */
  private resolveOptionalString(
    payload: Record<string, unknown>,
    key: string,
  ): string | undefined {
    const raw = payload[key];
    if (typeof raw !== 'string') return undefined;
    const trimmed = raw.trim();
    return trimmed ? trimmed : undefined;
  }

  /**
   * W7a：从 prompt.forward payload 解出跨轮 history。
   *
   * 字段形状：`Array<{ role: 'user' | 'assistant', content: string | ContentBlock[] }>`
   * 必须是数组；非数组返回 undefined 让 host 走"无 history"路径。
   *
   * 不做 ContentBlock 级别 schema 校验 —— runtime 内部 `query.ts` 的
   * normalizeMessages 会兜底处理畸形 content（保持与 Electron 同样的"宽容
   * 输入 + runtime 兜底"哲学）。
   */
  private resolveHistory(
    payload: Record<string, unknown>,
  ): DaemonQueryRequest['history'] | undefined {
    const raw = payload.history;
    if (!Array.isArray(raw)) return undefined;
    const filtered = raw.filter(
      (m): m is { role: 'user' | 'assistant'; content: unknown } =>
        m !== null && typeof m === 'object'
        && ((m as { role?: unknown }).role === 'user' || (m as { role?: unknown }).role === 'assistant')
        && 'content' in (m as Record<string, unknown>),
    );
    if (filtered.length === 0) return undefined;
    return filtered as DaemonQueryRequest['history'];
  }

  /**
   * Phase 1 跨轮记忆：解出 Django 组装的 history 并展开 blocks_json。
   *
   * Django `_assemble_cross_turn_history` 返回 HistorySourceMessage 格式
   * （含 blocks_json），本方法做三件事：
   * 1. isCrossTurnMemoryEnabled 双层 kill switch（环境变量 + agent_config）
   * 2. 解析 payload.history → HistorySourceMessage[]（保留 blocks_json）
   * 3. selectRecentHistoryForRuntime 展开 tool_call → tool_use/tool_result
   *
   * 与 Electron 路径同构——展开逻辑复用共享包，避免两端行为分叉。
   */
  private normalizeCrossTurnHistoryMessage(
    message: unknown,
    fallbackIndex: number,
  ): HistorySourceMessage | undefined {
    if (!message || typeof message !== 'object') return undefined;
    const obj = message as Record<string, unknown>;
    if (obj.role !== 'user' && obj.role !== 'assistant') return undefined;
    return {
      id: typeof obj.id === 'string' ? obj.id : `django-${fallbackIndex}`,
      role: obj.role,
      content: typeof obj.content === 'string' ? obj.content : null,
      blocks_json: Array.isArray(obj.blocks_json)
        ? obj.blocks_json as HistorySourceMessage['blocks_json']
        : null,
    };
  }

  private resolveCrossTurnHistory(
    payload: Record<string, unknown>,
    sessionId?: string,
  ): DaemonQueryRequest['history'] | undefined {
    const rawAgentConfig = (payload.agent_config && typeof payload.agent_config === 'object'
        && !Array.isArray(payload.agent_config))
      ? payload.agent_config as Record<string, unknown>
      : undefined;

    if (!isCrossTurnMemoryEnabled(rawAgentConfig, () => process.env.DISABLE_CROSS_TURN_MEMORY)) {
      return undefined;
    }

    const raw = payload.history;
    if (!Array.isArray(raw) || raw.length === 0) return undefined;

    const sourceMessages: HistorySourceMessage[] = [];
    for (const message of raw) {
      const normalized = this.normalizeCrossTurnHistoryMessage(message, sourceMessages.length);
      if (normalized) sourceMessages.push(normalized);
    }
    if (sourceMessages.length === 0) return undefined;

    // Django 已做限条和排除当前轮，这里只展开 blocks_json
    const expanded = selectRecentHistoryForRuntime(sourceMessages, {
      maxMessages: sourceMessages.length,
      excludeCurrentTurn: false,
      sessionId,
    });

    return expanded.length > 0 ? expanded : undefined;
  }

  isRunning(): boolean {
    return this.lifecycle.getState() !== 'stopped';
  }

  getUpdater(): Updater {
    return this.updater;
  }

  /**
   * WP2: 暴露 DaemonPtyManagerBridge 给 ShellCap 装配方
   * （DaemonToolProvider）import + 调 `setPtyManagerBridge(bridge)`。
   *
   * **返回 `null` 的语义**：
   *   - daemon 未 start() / PtyManager 未就绪 / node-pty 不可用
   *   - 装配方拿到 null → fail-fast 拒绝构造 ShellCap（D6 决策）
   */
  getPtyManagerBridge() {
    return this.terminalRuntime?.getAgentBridge() ?? null;
  }
}
