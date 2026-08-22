/**
 * publishDiagnostics handler wire —— 监听所有 LSP server 的诊断推送，
 * 转格式后入 LSPDiagnosticRegistry。
 *
 * 设计要点（与既定 LSP 语义一致）：
 *   - LSP severity 1=Error / 2=Warning / 3=Info / 4=Hint / 默认 Error
 *   - URI: `file://` 前缀转 fileURLToPath，否则保留
 *   - 空 diagnostic 不入 registry
 *   - per-server 失败累计 3 次以上日志 WARNING
 *   - errors are isolated to avoid breaking other servers
 */

import { fileURLToPath } from 'url';
import type {
  PublishDiagnosticsParams,
  Diagnostic as LSPDiagnostic,
} from 'vscode-languageserver-protocol';
import { logForDebugging, logError } from '../util/log.js';
import { errorMessage } from '../util/errors.js';
import type { DiagnosticFile } from './types.js';
import { registerPendingLSPDiagnostic } from './LSPDiagnosticRegistry.js';
import type { LSPServerManager } from '../manager/LSPServerManager.js';

/**
 * Map LSP severity to TabTin diagnostic severity.
 *
 * 接受 LSP DiagnosticSeverity 枚举值（1=Error, 2=Warning, 3=Information, 4=Hint）
 * 或 undefined；invalid/missing 默认 'Error'（**注意是 Error 不是 Hint**——
 * 设计选择，对应 "未知严重度默认按最严重处理"）。
 *
 */
function mapLSPSeverity(
  lspSeverity: number | undefined,
): 'Error' | 'Warning' | 'Info' | 'Hint' {
  switch (lspSeverity) {
    case 1:
      return 'Error';
    case 2:
      return 'Warning';
    case 3:
      return 'Info';
    case 4:
      return 'Hint';
    default:
      return 'Error';
  }
}

/**
 * Convert LSP diagnostics to TabTin's DiagnosticFile format.
 *
 */
export function formatDiagnosticsForAttachment(
  params: PublishDiagnosticsParams,
): DiagnosticFile[] {
  // Parse URI (may be file:// or plain path) and normalize to file system path
  let uri: string;
  try {
    // Handle both file:// URIs and plain paths
    uri = params.uri.startsWith('file://')
      ? fileURLToPath(params.uri)
      : params.uri;
  } catch (error) {
    logError(
      `Failed to convert URI to file path: ${params.uri}. Error: ${errorMessage(error)}. Using original URI as fallback.`,
      error as Error,
    );
    // Gracefully fallback to original URI - LSP servers may send malformed URIs
    uri = params.uri;
  }

  const diagnostics = params.diagnostics.map((diag: LSPDiagnostic) => ({
    message: diag.message,
    severity: mapLSPSeverity(diag.severity),
    range: {
      start: {
        line: diag.range.start.line,
        character: diag.range.start.character,
      },
      end: {
        line: diag.range.end.line,
        character: diag.range.end.character,
      },
    },
    source: diag.source,
    code:
      diag.code !== undefined && diag.code !== null
        ? String(diag.code)
        : undefined,
  }));

  return [
    {
      uri,
      diagnostics,
    },
  ];
}

/**
 * Handler registration result with tracking data.
 *
 */
export type HandlerRegistrationResult = {
  /** Total number of servers */
  totalServers: number;
  /** Number of successful registrations */
  successCount: number;
  /** Registration errors per server */
  registrationErrors: Array<{ serverName: string; error: string }>;
  /** Runtime failure tracking (shared across all handler invocations) */
  diagnosticFailures: Map<string, { count: number; lastError: string }>;
};

/**
 * Register LSP notification handlers on all servers.
 *
 * Sets up `textDocument/publishDiagnostics` handlers on every configured server
 * and routes incoming diagnostics through `formatDiagnosticsForAttachment` →
 * `registerPendingLSPDiagnostic`.
 *
 * Errors are isolated per server — one server's handler error doesn't break
 * other servers.
 *
 */
export function registerLSPNotificationHandlers(
  manager: LSPServerManager,
): HandlerRegistrationResult {
  // Register handlers on all configured servers to capture diagnostics from any language
  const servers = manager.getAllServers();

  // Track partial failures - allow successful server registrations even if some fail
  const registrationErrors: Array<{ serverName: string; error: string }> = [];
  let successCount = 0;

  // Track consecutive failures per server to warn users after 3+ failures
  const diagnosticFailures: Map<
    string,
    { count: number; lastError: string }
  > = new Map();

  for (const [serverName, serverInstance] of servers.entries()) {
    try {
      // Validate server instance has onNotification method
      if (
        !serverInstance ||
        typeof serverInstance.onNotification !== 'function'
      ) {
        const errorMsg = !serverInstance
          ? 'Server instance is null/undefined'
          : 'Server instance has no onNotification method';

        registrationErrors.push({ serverName, error: errorMsg });

        const err = new Error(`${errorMsg} for ${serverName}`);
        logError(err.message, err);
        logForDebugging(
          `Skipping handler registration for ${serverName}: ${errorMsg}`,
        );
        continue; // Skip this server but track the failure
      }

      // Errors are isolated to avoid breaking other servers
      serverInstance.onNotification(
        'textDocument/publishDiagnostics',
        (params: unknown) => {
          logForDebugging(
            `[PASSIVE DIAGNOSTICS] Handler invoked for ${serverName}! Params type: ${typeof params}`,
          );
          try {
            // Validate params structure before casting
            if (
              !params ||
              typeof params !== 'object' ||
              !('uri' in params) ||
              !('diagnostics' in params)
            ) {
              const err = new Error(
                `LSP server ${serverName} sent invalid diagnostic params (missing uri or diagnostics)`,
              );
              logError(err.message, err);
              logForDebugging(
                `Invalid diagnostic params from ${serverName}: ${JSON.stringify(params)}`,
              );
              return;
            }

            const diagnosticParams = params as PublishDiagnosticsParams;
            logForDebugging(
              `Received diagnostics from ${serverName}: ${diagnosticParams.diagnostics.length} diagnostic(s) for ${diagnosticParams.uri}`,
            );

            // Convert LSP diagnostics to TabTin format (can throw on invalid URIs)
            const diagnosticFiles =
              formatDiagnosticsForAttachment(diagnosticParams);

            // Only send notification if there are diagnostics
            const firstFile = diagnosticFiles[0];
            if (
              !firstFile ||
              diagnosticFiles.length === 0 ||
              firstFile.diagnostics.length === 0
            ) {
              logForDebugging(
                `Skipping empty diagnostics from ${serverName} for ${diagnosticParams.uri}`,
              );
              return;
            }

            // Register diagnostics for async delivery via attachment system
            try {
              registerPendingLSPDiagnostic({
                serverName,
                files: diagnosticFiles,
              });

              logForDebugging(
                `LSP Diagnostics: Registered ${diagnosticFiles.length} diagnostic file(s) from ${serverName} for async delivery`,
              );

              // Success - reset failure counter for this server
              diagnosticFailures.delete(serverName);
            } catch (error) {
              logError(
                `Error registering LSP diagnostics from ${serverName}: URI: ${diagnosticParams.uri}, Diagnostic count: ${firstFile.diagnostics.length}, Error: ${errorMessage(error)}`,
                error as Error,
              );

              // Track consecutive failures and warn after 3+
              const failures = diagnosticFailures.get(serverName) || {
                count: 0,
                lastError: '',
              };
              failures.count++;
              failures.lastError = errorMessage(error);
              diagnosticFailures.set(serverName, failures);

              if (failures.count >= 3) {
                logForDebugging(
                  `WARNING: LSP diagnostic handler for ${serverName} has failed ${failures.count} times consecutively. ` +
                    `Last error: ${failures.lastError}. ` +
                    `This may indicate a problem with the LSP server or diagnostic processing. ` +
                    `Check logs for details.`,
                );
              }
            }
          } catch (error) {
            // Catch any unexpected errors from the entire handler to prevent breaking the notification loop
            logError(
              `Unexpected error processing diagnostics from ${serverName}: ${errorMessage(error)}`,
              error as Error,
            );

            // Track consecutive failures and warn after 3+
            const failures = diagnosticFailures.get(serverName) || {
              count: 0,
              lastError: '',
            };
            failures.count++;
            failures.lastError = errorMessage(error);
            diagnosticFailures.set(serverName, failures);

            if (failures.count >= 3) {
              logForDebugging(
                `WARNING: LSP diagnostic handler for ${serverName} has failed ${failures.count} times consecutively. ` +
                  `Last error: ${failures.lastError}. ` +
                  `This may indicate a problem with the LSP server or diagnostic processing. ` +
                  `Check logs for details.`,
              );
            }

            // Don't re-throw - isolate errors to this server only
          }
        },
      );

      logForDebugging(`Registered diagnostics handler for ${serverName}`);
      successCount++;
    } catch (error) {
      registrationErrors.push({
        serverName,
        error: errorMessage(error),
      });

      logError(
        `Failed to register diagnostics handler for ${serverName}: Error: ${errorMessage(error)}`,
        error as Error,
      );
    }
  }

  // Report overall registration status
  const totalServers = servers.size;
  if (registrationErrors.length > 0) {
    const failedServers = registrationErrors
      .map((e) => `${e.serverName} (${e.error})`)
      .join(', ');
    logError(
      `Failed to register diagnostics for ${registrationErrors.length} LSP server(s): ${failedServers}`,
      new Error(failedServers),
    );
    logForDebugging(
      `LSP notification handler registration: ${successCount}/${totalServers} succeeded. ` +
        `Failed servers: ${failedServers}. ` +
        `Diagnostics from failed servers will not be delivered.`,
    );
  } else {
    logForDebugging(
      `LSP notification handlers registered successfully for all ${totalServers} server(s)`,
    );
  }

  // Return tracking data for monitoring and testing
  return {
    totalServers,
    successCount,
    registrationErrors,
    diagnosticFailures,
  };
}
