/**
 * Daemon Composition Root — explicit dependency injection graph.
 *
 * All service instantiation happens here. The Daemon class holds a
 * reference to the container and delegates lifecycle (start/stop)
 * to it. This makes dependencies explicit, testable, and replaceable.
 *
 * Inspired by Bitwarden's ServiceContainer pattern (hand-written DI).
 *
 * The container only constructs services — it does NOT start them.
 * Service startup/shutdown order is managed by TabTinDaemon.start()
 * and TabTinDaemon.stop(), which call into container services.
 */

import { ConfigManager } from '../platform/system/config/config-manager.js';
import { DaemonGatewayClient } from '../transport/gateway/gateway-client.js';
import { HeartbeatService } from '../transport/gateway/heartbeat.js';
import {
  DaemonActionBridge,
  type TranscriptRollbackPort,
} from '../application/execution/action-bridge.js';
import { installDaemonTelemetrySink } from '../platform/observability/telemetry/telemetry-sink.js';
import { OfflineMessageBuffer } from '../platform/storage/offline-buffer.js';
import { CapabilityDetector } from '../platform/system/capability/detector.js';
import { PluginManager } from '../platform/plugins/plugin-manager.js';
import { ProcessManager } from '../platform/system/process/process-manager.js';
import { initSentryDaemon } from '../platform/observability/logging/sentry.js';
import { Updater } from '../platform/system/update/updater.js';
import { SleepBlocker } from '../platform/system/process/sleep-blocker.js';
import { StateWriter } from '../platform/observability/diagnostics/state-writer.js';
import { GitStatusRegistry } from '../platform/observability/git-status/git-status-registry.js';
import { Logger } from '../platform/observability/logging/logger.js';
import type { DaemonConfig } from '../base/types/daemon-config.js';
import type { WorkspaceSnapshotResolver } from '../application/security/path-access.js';
import { createActionWorkspaceHistoryAdapter } from './adapters/action-workspace-history-adapter.js';
// v3: parseSecurityPolicy removed — hardline checks are stateless

// ─── Container Interface ─────────────────────────────────────────────

export interface DaemonContainer {
  // Infrastructure
  readonly config: DaemonConfig;
  readonly configManager: ConfigManager;
  readonly logger: Logger;

  // Connection
  readonly gateway: DaemonGatewayClient;
  readonly heartbeat: HeartbeatService;

  // Execution
  readonly bridge: DaemonActionBridge;

  // System
  readonly capabilityDetector: CapabilityDetector;
  readonly pluginManager: PluginManager;
  readonly processManager: ProcessManager;
  readonly updater: Updater;
  readonly sleepBlocker: SleepBlocker;
  readonly stateWriter: StateWriter;
  readonly gitStatusRegistry: GitStatusRegistry;
  readonly offlineBuffer: OfflineMessageBuffer;

  /**
   * Shut down core services in reverse construction order.
   * Optional/lazy services (PTY, browser, MCP, etc.) are not managed
   * by the container — the Daemon class handles them in stop().
   */
  dispose(): Promise<void>;
}

export interface DaemonActionRuntimeBindings {
  requestApproval(
    threadId: string,
    taskId: string,
    command: string,
    policy: Record<string, any>,
  ): Promise<boolean>;
  isPtyAvailable(): boolean;
  isBrowserAvailable(): boolean;
  resolveWorkspaceSnapshot(spaceId?: string): ReturnType<WorkspaceSnapshotResolver>;
  getTranscriptRollbackPort(): TranscriptRollbackPort | null;
}

// ─── Factory ─────────────────────────────────────────────────────────

const GATEWAY_CLOSE_DRAIN_MS = 100;

export function createDaemonContainer(
  configManager: ConfigManager,
  onStop: () => Promise<void>,
  actionRuntime: DaemonActionRuntimeBindings,
): DaemonContainer {
  const config = configManager.load();

  // === Infrastructure ===
  const logger = new Logger(
    config.log_level,
    config.log_file ?? configManager.getLogPath(),
  );

  // H1-E：越早越好地挂上 telemetry sink，让后续任何位置的 Runtime 埋点都能
  // 通过 daemon Logger 写入日志文件（TELEMETRY.md 定义的契约）。
  // 多次初始化幂等；测试场景通过 `resetTelemetrySink` 复位。
  // device 维度区分走日志文件路径（默认 `~/.tabtin-daemon/daemon.log`，可由
  // `config.log_file` 覆盖；见 ConfigManager.getLogPath）；sink 内部补的是
  // host/platform/app_version。
  installDaemonTelemetrySink(logger);

  // ：Sentry 错误上报（errors-only）。早于所有服务构建，保证后续
  // 任何位置的 captureRunError / captureFatal 可用。DSN 未配置时零开销 no-op。
  initSentryDaemon(config, logger);

  // === Capability & Plugin ===
  const capabilityDetector = new CapabilityDetector(logger);
  const pluginManager = new PluginManager(logger);

  const gitStatusRegistry = new GitStatusRegistry(logger);
  const workspaceHistory = createActionWorkspaceHistoryAdapter();
  if (config.workspace_root) {
    gitStatusRegistry.getOrCreate(config.workspace_root);
  }

  // === Execution ===
  const gateway = new DaemonGatewayClient(config, logger);
  const bridge = new DaemonActionBridge(config, pluginManager, logger, {
    sendResult: (threadId, taskId, result, traceId) =>
      gateway.sendActionResult(threadId, taskId, result, traceId),
    sendMonitorEvent: async (eventType, payload) => {
      const threadId = (payload as any)?.thread_id || (payload as any)?.monitor_id || '';
      await gateway.sendAgentEvent(threadId, eventType, payload as Record<string, any>);
    },
    requestApproval: actionRuntime.requestApproval,
    isPtyAvailable: actionRuntime.isPtyAvailable,
    isBrowserAvailable: actionRuntime.isBrowserAvailable,
    resolveWorkspaceSnapshot: actionRuntime.resolveWorkspaceSnapshot,
    getTranscriptRollbackPort: actionRuntime.getTranscriptRollbackPort,
    gitStatusRegistry,
    workspaceHistory,
  });

  gateway.bindActionHandler((envelope) => {
    bridge.handleAction(envelope).catch(err => {
      logger.error('Action handling failed', err);
    });
  });

  const offlineBuffer = new OfflineMessageBuffer(logger);

  // === Connection ===
  const heartbeat = new HeartbeatService(config, gateway, capabilityDetector, logger);

  // === System ===
  const processManager = new ProcessManager(configManager, logger, onStop);
  const updater = new Updater(logger, onStop);
  const sleepBlocker = new SleepBlocker(logger);
  const stateWriter = new StateWriter(configManager, logger);
  return {
    config,
    configManager,
    logger,
    gateway,
    heartbeat,
    bridge,
    capabilityDetector,
    pluginManager,
    processManager,
    updater,
    sleepBlocker,
    stateWriter,
    gitStatusRegistry,
    offlineBuffer,

    async dispose() {
      const disposeStep = async (name: string, step: () => void | Promise<void>) => {
        try {
          await step();
        } catch (error) {
          logger.warn(`[DaemonContainer] cleanup '${name}' failed: ${error}`);
        }
      };

      await disposeStep('git-status-registry', () => gitStatusRegistry.destroy());
      await disposeStep('gateway', () => gateway.close());
      await new Promise(r => setTimeout(r, GATEWAY_CLOSE_DRAIN_MS));
      await disposeStep('process-manager', () => processManager.cleanup());
      await disposeStep('logger', () => logger.close());
    },
  };
}
