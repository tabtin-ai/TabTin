/**
 * LSP Diagnostic Registry —— 异步诊断推送的限流 + 去重 + 取出引擎。
 *
 * 设计要点（与既定 LSP 语义一致）：
 *   - pendingDiagnostics: Map<uuid, { serverName, files, timestamp, attachmentSent }>
 *   - deliveredDiagnostics: LRUCache<fileUri, Set<diagnosticKey>> (max 500 文件)
 *   - 常量：MAX_DIAGNOSTICS_PER_FILE = 10 / MAX_TOTAL_DIAGNOSTICS = 30
 *   - 五元组 hash key：JSON.stringify({ message, severity, range, source||null, code||null })
 *   - checkForLSPDiagnostics：取出 → batch+cross-turn dedup → severity sort → cap → 写 delivered LRU
 *   - clearDeliveredDiagnosticsForFile：编辑文件时清单一文件 LRU
 *   - clearAllLSPDiagnostics：清 pending（不清 delivered）
 *   - resetAllLSPDiagnosticState：清所有（session reset）
 */

import { randomUUID } from 'crypto';
import { LRUCache } from 'lru-cache';
import { logForDebugging, logError } from '../util/log.js';
import { errorMessage } from '../util/errors.js';
import type { DiagnosticFile } from './types.js';

/**
 * Pending LSP diagnostic notification
 *
 */
export type PendingLSPDiagnostic = {
  /** Server that sent the diagnostic */
  serverName: string;
  /** Diagnostic files */
  files: DiagnosticFile[];
  /** When diagnostic was received */
  timestamp: number;
  /** Whether attachment was already sent to conversation */
  attachmentSent: boolean;
};

// Volume limiting constants
const MAX_DIAGNOSTICS_PER_FILE = 10;
const MAX_TOTAL_DIAGNOSTICS = 30;

// Max files to track for deduplication - prevents unbounded memory growth
const MAX_DELIVERED_FILES = 500;

// Global registry state
const pendingDiagnostics = new Map<string, PendingLSPDiagnostic>();

// Cross-turn deduplication: tracks diagnostics that have been delivered
// Maps file URI to a set of diagnostic keys (hash of message+severity+range)
// Using LRUCache to prevent unbounded growth in long sessions
const deliveredDiagnostics = new LRUCache<string, Set<string>>({
  max: MAX_DELIVERED_FILES,
});

/**
 * Register LSP diagnostics received from a server.
 * These will be delivered as attachments in the next query.
 *
 */
export function registerPendingLSPDiagnostic({
  serverName,
  files,
}: {
  serverName: string;
  files: DiagnosticFile[];
}): void {
  // Use UUID for guaranteed uniqueness (handles rapid registrations)
  const diagnosticId = randomUUID();

  logForDebugging(
    `LSP Diagnostics: Registering ${files.length} diagnostic file(s) from ${serverName} (ID: ${diagnosticId})`,
  );

  pendingDiagnostics.set(diagnosticId, {
    serverName,
    files,
    timestamp: Date.now(),
    attachmentSent: false,
  });
}

/**
 * Maps severity string to numeric value for sorting.
 * Error=1, Warning=2, Info=3, Hint=4
 *
 */
function severityToNumber(severity: string | undefined): number {
  switch (severity) {
    case 'Error':
      return 1;
    case 'Warning':
      return 2;
    case 'Info':
      return 3;
    case 'Hint':
      return 4;
    default:
      return 4;
  }
}

/**
 * Creates a unique key for a diagnostic based on its content.
 * Used for both within-batch and cross-turn deduplication.
 *
 */
function createDiagnosticKey(diag: {
  message: string;
  severity?: string;
  range?: unknown;
  source?: string;
  code?: unknown;
}): string {
  return JSON.stringify({
    message: diag.message,
    severity: diag.severity,
    range: diag.range,
    source: diag.source || null,
    code: diag.code || null,
  });
}

/**
 * Deduplicates diagnostics by file URI and diagnostic content.
 * Also filters out diagnostics that were already delivered in previous turns.
 *
 */
function deduplicateDiagnosticFiles(
  allFiles: DiagnosticFile[],
): DiagnosticFile[] {
  // Group diagnostics by file URI
  const fileMap = new Map<string, Set<string>>();
  const dedupedFiles: DiagnosticFile[] = [];

  for (const file of allFiles) {
    if (!fileMap.has(file.uri)) {
      fileMap.set(file.uri, new Set());
      dedupedFiles.push({ uri: file.uri, diagnostics: [] });
    }

    const seenDiagnostics = fileMap.get(file.uri)!;
    const dedupedFile = dedupedFiles.find((f) => f.uri === file.uri)!;

    // Get previously delivered diagnostics for this file (for cross-turn dedup)
    const previouslyDelivered = deliveredDiagnostics.get(file.uri) || new Set();

    for (const diag of file.diagnostics) {
      try {
        const key = createDiagnosticKey(diag);

        // Skip if already seen in this batch OR already delivered in previous turns
        if (seenDiagnostics.has(key) || previouslyDelivered.has(key)) {
          continue;
        }

        seenDiagnostics.add(key);
        dedupedFile.diagnostics.push(diag);
      } catch (error: unknown) {
        const truncatedMessage =
          diag.message?.substring(0, 100) || '<no message>';
        logError(
          `Failed to deduplicate diagnostic in ${file.uri}: ${errorMessage(error)}. Diagnostic message: ${truncatedMessage}`,
          error as Error,
        );
        // Include the diagnostic anyway to avoid losing information
        dedupedFile.diagnostics.push(diag);
      }
    }
  }

  // Filter out files with no diagnostics after deduplication
  return dedupedFiles.filter((f) => f.diagnostics.length > 0);
}

/**
 * Get all pending LSP diagnostics that haven't been delivered yet.
 * Deduplicates + caps + sorts.
 *
 */
export function checkForLSPDiagnostics(): Array<{
  serverName: string;
  files: DiagnosticFile[];
}> {
  logForDebugging(
    `LSP Diagnostics: Checking registry - ${pendingDiagnostics.size} pending`,
  );

  // Collect all diagnostic files from all pending notifications
  const allFiles: DiagnosticFile[] = [];
  const serverNames = new Set<string>();
  const diagnosticsToMark: PendingLSPDiagnostic[] = [];

  for (const diagnostic of pendingDiagnostics.values()) {
    if (!diagnostic.attachmentSent) {
      allFiles.push(...diagnostic.files);
      serverNames.add(diagnostic.serverName);
      diagnosticsToMark.push(diagnostic);
    }
  }

  if (allFiles.length === 0) {
    return [];
  }

  // Deduplicate diagnostics across all files
  let dedupedFiles: DiagnosticFile[];
  try {
    dedupedFiles = deduplicateDiagnosticFiles(allFiles);
  } catch (error: unknown) {
    logError(
      `Failed to deduplicate LSP diagnostics: ${errorMessage(error)}`,
      error as Error,
    );
    // Fall back to undedup'd files to avoid losing diagnostics
    dedupedFiles = allFiles;
  }

  // Only mark as sent AFTER successful deduplication, then delete from map.
  // Entries are tracked in deliveredDiagnostics LRU for dedup, so we don't
  // need to keep them in pendingDiagnostics after delivery.
  for (const diagnostic of diagnosticsToMark) {
    diagnostic.attachmentSent = true;
  }
  for (const [id, diagnostic] of pendingDiagnostics) {
    if (diagnostic.attachmentSent) {
      pendingDiagnostics.delete(id);
    }
  }

  const originalCount = allFiles.reduce(
    (sum, f) => sum + f.diagnostics.length,
    0,
  );
  const dedupedCount = dedupedFiles.reduce(
    (sum, f) => sum + f.diagnostics.length,
    0,
  );

  if (originalCount > dedupedCount) {
    logForDebugging(
      `LSP Diagnostics: Deduplication removed ${originalCount - dedupedCount} duplicate diagnostic(s)`,
    );
  }

  // Apply volume limiting: cap per file and total
  let totalDiagnostics = 0;
  let truncatedCount = 0;
  for (const file of dedupedFiles) {
    // Sort by severity (Error=1 < Warning=2 < Info=3 < Hint=4) to prioritize errors
    file.diagnostics.sort(
      (a, b) => severityToNumber(a.severity) - severityToNumber(b.severity),
    );

    // Cap per file
    if (file.diagnostics.length > MAX_DIAGNOSTICS_PER_FILE) {
      truncatedCount += file.diagnostics.length - MAX_DIAGNOSTICS_PER_FILE;
      file.diagnostics = file.diagnostics.slice(0, MAX_DIAGNOSTICS_PER_FILE);
    }

    // Cap total
    const remainingCapacity = MAX_TOTAL_DIAGNOSTICS - totalDiagnostics;
    if (file.diagnostics.length > remainingCapacity) {
      truncatedCount += file.diagnostics.length - remainingCapacity;
      file.diagnostics = file.diagnostics.slice(0, remainingCapacity);
    }

    totalDiagnostics += file.diagnostics.length;
  }

  // Filter out files that ended up with no diagnostics after limiting
  dedupedFiles = dedupedFiles.filter((f) => f.diagnostics.length > 0);

  if (truncatedCount > 0) {
    logForDebugging(
      `LSP Diagnostics: Volume limiting removed ${truncatedCount} diagnostic(s) (max ${MAX_DIAGNOSTICS_PER_FILE}/file, ${MAX_TOTAL_DIAGNOSTICS} total)`,
    );
  }

  // Track delivered diagnostics for cross-turn deduplication
  for (const file of dedupedFiles) {
    if (!deliveredDiagnostics.has(file.uri)) {
      deliveredDiagnostics.set(file.uri, new Set());
    }
    const delivered = deliveredDiagnostics.get(file.uri)!;
    for (const diag of file.diagnostics) {
      try {
        delivered.add(createDiagnosticKey(diag));
      } catch (error: unknown) {
        // Log but continue - failure to track shouldn't prevent delivery
        const truncatedMessage =
          diag.message?.substring(0, 100) || '<no message>';
        logError(
          `Failed to track delivered diagnostic in ${file.uri}: ${errorMessage(error)}. Diagnostic message: ${truncatedMessage}`,
          error as Error,
        );
      }
    }
  }

  const finalCount = dedupedFiles.reduce(
    (sum, f) => sum + f.diagnostics.length,
    0,
  );

  // Return empty if no diagnostics to deliver (all filtered by deduplication)
  if (finalCount === 0) {
    logForDebugging(
      `LSP Diagnostics: No new diagnostics to deliver (all filtered by deduplication)`,
    );
    return [];
  }

  logForDebugging(
    `LSP Diagnostics: Delivering ${dedupedFiles.length} file(s) with ${finalCount} diagnostic(s) from ${serverNames.size} server(s)`,
  );

  // Return single result with all deduplicated diagnostics
  return [
    {
      serverName: Array.from(serverNames).join(', '),
      files: dedupedFiles,
    },
  ];
}

/**
 * Clear all pending diagnostics. Does NOT clear deliveredDiagnostics LRU.
 *
 */
export function clearAllLSPDiagnostics(): void {
  logForDebugging(
    `LSP Diagnostics: Clearing ${pendingDiagnostics.size} pending diagnostic(s)`,
  );
  pendingDiagnostics.clear();
}

/**
 * Reset all diagnostic state including cross-turn tracking (session reset).
 *
 */
export function resetAllLSPDiagnosticState(): void {
  logForDebugging(
    `LSP Diagnostics: Resetting all state (${pendingDiagnostics.size} pending, ${deliveredDiagnostics.size} files tracked)`,
  );
  pendingDiagnostics.clear();
  deliveredDiagnostics.clear();
}

/**
 * Clear delivered diagnostics for a specific file.
 * Called when a file is edited so new diagnostics will be shown even if they
 * match previously delivered ones.
 *
 */
export function clearDeliveredDiagnosticsForFile(fileUri: string): void {
  if (deliveredDiagnostics.has(fileUri)) {
    logForDebugging(
      `LSP Diagnostics: Clearing delivered diagnostics for ${fileUri}`,
    );
    deliveredDiagnostics.delete(fileUri);
  }
}

/**
 * Get count of pending diagnostics (for monitoring/testing).
 *
 */
export function getPendingLSPDiagnosticCount(): number {
  return pendingDiagnostics.size;
}
