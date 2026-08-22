/**
 * LSP runtime singleton manager —— 全局单例 + 异步初始化 + bare 模式跳过。
 *
 * 设计要点（与既定 LSP 语义一致）：
 *   - 4 状态：not-started / pending / success / failed
 *   - bare/disabled 模式跳过（不初始化）
 *   - 异步初始化（不阻塞启动）
 *   - generation counter 防止 stale promise 在 reinit 后污染状态
 *   - reinitialize 支持（plugin 刷新后调用，TabTin 等价：动态配置变更）
 *   - shutdown 错误不传播（应用退出时记录日志即可）
 */

import { logForDebugging, logError } from '../util/log.js';
import { errorMessage } from '../util/errors.js';
import {
  createLSPServerManager,
  type LSPServerManager,
  type LspServerConfigLoader,
} from './LSPServerManager.js';

/**
 * Initialization state of the LSP server manager
 *
 */
type InitializationState = 'not-started' | 'pending' | 'success' | 'failed';

/**
 * Module-scope singleton state.
 *
 */
let lspManagerInstance: LSPServerManager | undefined;
let initializationState: InitializationState = 'not-started';
let initializationError: Error | undefined;
let initializationGeneration = 0;
let initializationPromise: Promise<void> | undefined;
let activeConfigLoader: LspServerConfigLoader | undefined;
/**
 * onInitialized 回调列表 —— C5 阶段会接 `registerLSPNotificationHandlers`。
 * 当前为空，留作扩展点。
 */
const onInitializedCallbacks: Array<(manager: LSPServerManager) => void> = [];

/**
 * 检查是否禁用 LSP。
 *
 * 双重控制：
 *   1. 环境变量 `TABTIN_DISABLE_LSP=1` —— 运行时禁用（部署/CI 场景）
 *   2. 工厂参数 `disabled: true` —— 编程禁用（测试/特定场景）
 *
 *   TabTin 没有 bare 模式但需要等价的 escape hatch（如 daemon 单次 RPC 不需要 LSP）。
 *   采用环境变量 + 参数双控制是 TabTin 自定义但语义等价的扩展。
 */
function isLspDisabled(opts?: { disabled?: boolean }): boolean {
  if (opts?.disabled) return true;
  return process.env.TABTIN_DISABLE_LSP === '1';
}

/**
 * Test-only sync reset.
 *
 */
export function _resetLspManagerForTesting(): void {
  lspManagerInstance = undefined;
  initializationState = 'not-started';
  initializationError = undefined;
  initializationPromise = undefined;
  initializationGeneration++;
  activeConfigLoader = undefined;
  onInitializedCallbacks.length = 0;
}

/**
 * Get the singleton LSP server manager instance.
 * Returns undefined if not yet initialized, initialization failed, or still pending.
 *
 */
export function getLspServerManager(): LSPServerManager | undefined {
  if (initializationState === 'failed') {
    return undefined;
  }
  return lspManagerInstance;
}

/**
 * Get the current initialization status of the LSP server manager.
 *
 */
export function getInitializationStatus():
  | { status: 'not-started' }
  | { status: 'pending' }
  | { status: 'success' }
  | { status: 'failed'; error: Error } {
  if (initializationState === 'failed') {
    return {
      status: 'failed',
      error: initializationError || new Error('Initialization failed'),
    };
  }
  if (initializationState === 'not-started') {
    return { status: 'not-started' };
  }
  if (initializationState === 'pending') {
    return { status: 'pending' };
  }
  return { status: 'success' };
}

/**
 * Check whether at least one language server is connected and healthy.
 *
 */
export function isLspConnected(): boolean {
  if (initializationState === 'failed') return false;
  const manager = getLspServerManager();
  if (!manager) return false;
  const servers = manager.getAllServers();
  if (servers.size === 0) return false;
  for (const server of servers.values()) {
    if (server.state !== 'error') return true;
  }
  return false;
}

/**
 * Wait for LSP server manager initialization to complete.
 *
 */
export async function waitForInitialization(): Promise<void> {
  if (initializationState === 'success' || initializationState === 'failed') {
    return;
  }
  if (initializationState === 'pending' && initializationPromise) {
    await initializationPromise;
  }
}

/**
 * 注册一个回调：当 LSP runtime 初始化成功后会被调用（带 manager 实例）。
 *
 * TabTin 扩展点（本仓库扩展）：C5 阶段 `registerLSPNotificationHandlers`
 * 会通过这个 API 接入，避免 singleton 直接依赖 diagnostics 模块。
 */
export function onLspInitialized(
  callback: (manager: LSPServerManager) => void,
): void {
  onInitializedCallbacks.push(callback);
  // 如果已经初始化成功，立即触发（解决 register-after-init race）
  if (initializationState === 'success' && lspManagerInstance) {
    try {
      callback(lspManagerInstance);
    } catch (error) {
      logError(
        `onLspInitialized callback threw synchronously: ${errorMessage(error)}`,
        error as Error,
      );
    }
  }
}

/**
 * Initialize the LSP server manager singleton.
 *
 * This function is called during TabTin startup. It synchronously creates
 * the manager instance, then starts async initialization in the background
 * without blocking the startup process.
 *
 * @param configLoader - 配置加载器，提供 LSP server 列表
 * @param opts - 可选：disabled=true 显式禁用（不创建 manager）
 *
 */
export function initializeLspServerManager(
  configLoader: LspServerConfigLoader,
  opts?: { disabled?: boolean },
): void {
  // TabTin disabled 模式（bare mode）：跳过初始化
  if (isLspDisabled(opts)) {
    logForDebugging('[LSP MANAGER] LSP disabled (env or opts), skipping init');
    return;
  }
  logForDebugging('[LSP MANAGER] initializeLspServerManager() called');

  // Skip if already initialized or currently initializing
  if (lspManagerInstance !== undefined && initializationState !== 'failed') {
    logForDebugging(
      '[LSP MANAGER] Already initialized or initializing, skipping',
    );
    return;
  }

  // Reset state for retry if previous initialization failed
  if (initializationState === 'failed') {
    lspManagerInstance = undefined;
    initializationError = undefined;
  }

  // Create the manager instance and mark as pending
  activeConfigLoader = configLoader;
  lspManagerInstance = createLSPServerManager(configLoader);
  initializationState = 'pending';
  logForDebugging('[LSP MANAGER] Created manager instance, state=pending');

  // Increment generation to invalidate any pending initializations
  const currentGeneration = ++initializationGeneration;
  logForDebugging(
    `[LSP MANAGER] Starting async initialization (generation ${currentGeneration})`,
  );

  // Start initialization asynchronously without blocking
  initializationPromise = lspManagerInstance
    .initialize()
    .then(() => {
      if (currentGeneration === initializationGeneration) {
        initializationState = 'success';
        logForDebugging('LSP server manager initialized successfully');

        // Register passive notification handlers via onInitialized callbacks
        // (C5 阶段 registerLSPNotificationHandlers 通过 onLspInitialized 接入)
        if (lspManagerInstance) {
          const manager = lspManagerInstance;
          for (const cb of onInitializedCallbacks) {
            try {
              cb(manager);
            } catch (error) {
              logError(
                `onLspInitialized callback threw: ${errorMessage(error)}`,
                error as Error,
              );
            }
          }
        }
      }
    })
    .catch((error: unknown) => {
      if (currentGeneration === initializationGeneration) {
        initializationState = 'failed';
        initializationError = error as Error;
        lspManagerInstance = undefined;

        logError(
          `Failed to initialize LSP server manager: ${errorMessage(error)}`,
          error as Error,
        );
      }
    });
}

/**
 * Force re-initialization of the LSP server manager.
 *
 * 用例：配置（如 plugin / 内置 server 列表）变更后强制重建 manager。
 *
 */
export function reinitializeLspServerManager(
  configLoader?: LspServerConfigLoader,
  opts?: { disabled?: boolean },
): void {
  if (initializationState === 'not-started') {
    return;
  }

  logForDebugging('[LSP MANAGER] reinitializeLspServerManager() called');

  // Best-effort shutdown of any running servers on the old instance
  if (lspManagerInstance) {
    void lspManagerInstance.shutdown().catch((err) => {
      logForDebugging(
        `[LSP MANAGER] old instance shutdown during reinit failed: ${errorMessage(err)}`,
      );
    });
  }

  // Force the idempotence check in initializeLspServerManager() to fall through
  lspManagerInstance = undefined;
  initializationState = 'not-started';
  initializationError = undefined;

  // 使用新 configLoader（如有）或回退到之前的 loader
  const loader = configLoader ?? activeConfigLoader;
  if (!loader) {
    logError(
      '[LSP MANAGER] reinitialize called without configLoader and no prior loader available',
      new Error('No active config loader'),
    );
    return;
  }

  initializeLspServerManager(loader, opts);
}

/**
 * Shutdown the LSP server manager and clean up resources.
 *
 * Errors during shutdown are logged but NOT propagated (acceptable during
 * application exit when recovery is not possible).
 *
 */
export async function shutdownLspServerManager(): Promise<void> {
  if (lspManagerInstance === undefined) {
    return;
  }

  try {
    await lspManagerInstance.shutdown();
    logForDebugging('LSP server manager shut down successfully');
  } catch (error: unknown) {
    logError(
      `Failed to shutdown LSP server manager: ${errorMessage(error)}`,
      error as Error,
    );
  } finally {
    lspManagerInstance = undefined;
    initializationState = 'not-started';
    initializationError = undefined;
    initializationPromise = undefined;
    activeConfigLoader = undefined;
    initializationGeneration++;
  }
}
