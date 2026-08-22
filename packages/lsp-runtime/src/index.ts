/**
 * @tabtin/lsp-runtime —— TabTin Agent runtime 的 LSP 子系统。
 *
 * 覆盖常见 agent LSP 运行时能力（client / manager / diagnostics / registry）。
 *
 * 当前实现进度（按总控 14 checkpoint）：
 *   - C1：LSPClient ✅（src/client/LSPClient.ts，10 个测试）
 *   - C2：LSPServerInstance ✅（src/client/LSPServerInstance.ts，16 个测试）
 *   - C3：LSPServerManager ✅（src/manager/LSPServerManager.ts，13 个测试）
 *   - C4：singleton manager ✅（src/manager/singleton.ts，17 个测试）
 *   - C5：passiveFeedback wire ✅（src/diagnostics/passiveFeedback.ts，9 个测试）
 *   - C6：LSPDiagnosticRegistry ✅（src/diagnostics/LSPDiagnosticRegistry.ts，15 个测试）
 *   - C7：builtin servers + 内置打包 ✅（src/registry/, scripts/, lsp-servers/，10 个测试）
 *
 * @tabtin/lsp-runtime 包内 90/90 测试全过。
 */

// ─── Client ──────────────────────────────────────
export { createLSPClient } from './client/LSPClient.js';
export type { LSPClient } from './client/LSPClient.js';

export { createLSPServerInstance } from './client/LSPServerInstance.js';
export type { LSPServerInstance } from './client/LSPServerInstance.js';

// ─── Manager ─────────────────────────────────────
export { createLSPServerManager } from './manager/LSPServerManager.js';
export type {
  LSPServerManager,
  LspServerConfigLoader,
} from './manager/LSPServerManager.js';

export {
  initializeLspServerManager,
  reinitializeLspServerManager,
  shutdownLspServerManager,
  getLspServerManager,
  getInitializationStatus,
  waitForInitialization,
  isLspConnected,
  onLspInitialized,
  _resetLspManagerForTesting,
} from './manager/singleton.js';

export type {
  LspServerState,
  ScopedLspServerConfig,
} from './manager/types.js';

// ─── Diagnostics ─────────────────────────────────
export {
  registerPendingLSPDiagnostic,
  checkForLSPDiagnostics,
  clearAllLSPDiagnostics,
  clearDeliveredDiagnosticsForFile,
  resetAllLSPDiagnosticState,
  getPendingLSPDiagnosticCount,
} from './diagnostics/LSPDiagnosticRegistry.js';
export type { PendingLSPDiagnostic } from './diagnostics/LSPDiagnosticRegistry.js';

export {
  formatDiagnosticsForAttachment,
  registerLSPNotificationHandlers,
} from './diagnostics/passiveFeedback.js';
export type { HandlerRegistrationResult } from './diagnostics/passiveFeedback.js';

export type { Diagnostic, DiagnosticFile } from './diagnostics/types.js';

// ─── Registry (builtin servers + bundled paths) ──
export { createBuiltinServersLoader } from './registry/builtin-servers.js';
export type { BuiltinServersOptions } from './registry/builtin-servers.js';

export {
  getLspServersRoot,
  which,
  resolveTypescriptLanguageServer,
  resolveTsserver,
  resolvePyrightLangserver,
  detectPythonInterpreter,
} from './registry/bundled-paths.js';

// ─── Logger ──────────────────────────────────────
export { setLogger } from './util/log.js';
export type { LspLogger } from './util/log.js';
