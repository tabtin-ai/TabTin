import { CommandExecutor } from './commandExecutor';
import { toPolicyOverrides } from './policy';
import type { DegradationDecision } from './policy';
import type { ExecuteResult } from './types';
import { resolveCommandSandboxRoot } from './pathUtils';
import { degradedBanner, degradedFooter, degradedErrorFooter } from './i18n';
import { detectInteractiveCommand } from './interactive-detect';

const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576; // 1 MB

export interface DegradedExecuteOptions {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  degradation: DegradationDecision;
  /** ms, defaults to 120_000 */
  timeout?: number;
  threadId?: string;
  /** Unified output callback — callers route data to the appropriate channel (PTY emit / IPC / buffer). */
  onOutput?: (data: string) => void;
  /** Max bytes for returned stdout/stderr (onOutput still receives all data). Defaults to 1 MB. */
  maxOutputBytes?: number;
}

export interface DegradedExecuteResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  cwd: string;
  durationMs: number;
  timedOut: boolean;
  sandboxApplied: boolean;
  warnings: string[];
  /** 命令被检测为交互式，降级执行被阻断 */
  interactiveBlocked?: boolean;
  /** 交互式检测的原因描述，用于 HITL 提示 */
  interactiveReason?: string;
  /** 匹配到的交互式命令 */
  matchedCommand?: string;
}

const LF_TO_CRLF = /(?<!\r)\n/g;

function toTerminal(text: string): string {
  return text.replace(LF_TO_CRLF, '\r\n');
}

/**
 * Core degraded-execution logic shared across Electron PtyManager,
 * FrontendActionBridge, and Daemon PtyManager.
 *
 * When the interactive PTY cannot satisfy the requested security policy
 * (e.g. sandbox / network-restricted), we fall back to CommandExecutor
 * (spawn + OS sandbox) and stream output through the caller-supplied
 * `onOutput` callback.
 */
export async function executeDegraded(
  options: DegradedExecuteOptions,
): Promise<DegradedExecuteResult> {
  const {
    command,
    cwd,
    degradation,
    threadId: rawThreadId,
    timeout = 120_000,
    onOutput,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  } = options;

  const threadId = rawThreadId || `degraded-${Date.now()}`;

  const detection = detectInteractiveCommand(command);
  if (detection.isInteractive) {
    return {
      stdout: '',
      stderr: '',
      exitCode: -1,
      cwd,
      durationMs: 0,
      timedOut: false,
      sandboxApplied: false,
      warnings: [],
      interactiveBlocked: true,
      interactiveReason: detection.reason,
      matchedCommand: detection.matchedCommand,
    };
  }

  const { sandboxConfig } = degradation;

  const executor = new CommandExecutor({
    sandboxRoot: resolveCommandSandboxRoot(),
    workspaceRoot: cwd,
  });

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  const startedAt = Date.now();

  const emit = (data: string) => onOutput?.(data);

  emit(degradedBanner());

  let result: ExecuteResult;
  try {
    const handle = await executor.executeStreaming({
      command,
      mode: sandboxConfig.route === 'sandbox' ? 'sandbox' : 'regular',
      sandboxLevel: sandboxConfig.sandboxLevel,
      workingDirectory: cwd,
      threadId,
      timeout,
      policyOverrides: toPolicyOverrides({
        route: sandboxConfig.route,
        sandboxLevel: sandboxConfig.sandboxLevel,
        networkMode: sandboxConfig.networkMode,
        relaxedRules: sandboxConfig.relaxedRules,
      }),
      onStdout: (chunk) => {
        if (!stdoutTruncated) {
          const chunkBytes = Buffer.byteLength(chunk, 'utf8');
          if (stdoutBytes + chunkBytes > maxOutputBytes) {
            const remaining = maxOutputBytes - stdoutBytes;
            if (remaining > 0) stdoutChunks.push(chunk.slice(0, remaining));
            stdoutTruncated = true;
          } else {
            stdoutChunks.push(chunk);
            stdoutBytes += chunkBytes;
          }
        }
        emit(toTerminal(chunk));
      },
      onStderr: (chunk) => {
        if (!stderrTruncated) {
          const chunkBytes = Buffer.byteLength(chunk, 'utf8');
          if (stderrBytes + chunkBytes > maxOutputBytes) {
            const remaining = maxOutputBytes - stderrBytes;
            if (remaining > 0) stderrChunks.push(chunk.slice(0, remaining));
            stderrTruncated = true;
          } else {
            stderrChunks.push(chunk);
            stderrBytes += chunkBytes;
          }
        }
        emit(toTerminal(chunk));
      },
    });
    result = await handle.result;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    emit(degradedErrorFooter(errMsg));

    return {
      stdout: '',
      stderr: errMsg,
      exitCode: 1,
      cwd,
      durationMs: Date.now() - startedAt,
      timedOut: false,
      sandboxApplied: sandboxConfig.route === 'sandbox',
      warnings: [],
    };
  } finally {
    executor.cleanupSandbox(threadId).catch(() => {});
  }

  emit(degradedFooter(result.exitCode));

  const TRUNCATION_NOTICE = '\n...[输出已截断，超过 1MB 限制]';
  const stdout = stdoutChunks.join('') + (stdoutTruncated ? TRUNCATION_NOTICE : '');
  const stderr = stderrChunks.join('') + (stderrTruncated ? TRUNCATION_NOTICE : '');

  return {
    stdout,
    stderr,
    exitCode: result.exitCode,
    cwd: result.cwd,
    durationMs: Date.now() - startedAt,
    timedOut: result.timedOut,
    sandboxApplied: sandboxConfig.route === 'sandbox',
    warnings: result.warnings ?? [],
  };
}
