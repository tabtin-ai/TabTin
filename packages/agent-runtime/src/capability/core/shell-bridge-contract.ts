/**
 * ShellCap ↔ host PTY bridge 本地契约（ Stage 6e）。
 *
 * 生产路径不再 import `@tabtin/terminal-core`；实现仍由 Electron/Daemon
 * 注入的 bridge + ManagedTaskStore 提供。本文件只声明 ShellCap 实际用到的
 * 结构类型 / 常量 / 轻量 helper，须与 terminal-core 对应符号保持对齐。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 与 terminal-core `DEFAULT_AGENT_COMMAND_TIMEOUT_MS` 对齐。 */
export const DEFAULT_AGENT_COMMAND_TIMEOUT_MS = 120_000;

/** 与 terminal-core `DEDUP_WINDOW_MS` 对齐（同 thread 1s 内相同命令去重）。 */
export const DEDUP_WINDOW_MS = 1000;

/**
 * ShellCap 写入 mergedEnv 的内部 marker（逗号分隔 Skill 凭据键名）。
 * 必须与 terminal-core `agent-process-runner` `buildEnv` 字节级一致。
 */
export const SKILL_CREDENTIAL_PRESERVE_ENV_KEYS_MARKER =
  '__TABTIN_SKILL_CREDENTIAL_PRESERVE_KEYS__';

export type AgentShellKind = 'bash' | 'zsh' | 'sh' | 'powershell' | 'cmd' | 'other';

export interface AgentShellInfo {
  shell: string;
  kind: AgentShellKind;
  platform: NodeJS.Platform;
}

export interface UnquotedWorkspacePathHit {
  path: string;
  index: number;
  hint: string;
}

export interface AgentCommandProgressSnapshot {
  stdout: string;
  outputBytes: number;
  truncated: boolean;
  capturedAt: number;
}

export interface AgentCommandRequest {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  agentMeta: {
    toolUseId: string;
    spaceId: string;
    agentId: string;
    threadId?: string;
    notificationThreadId?: string;
    description?: string;
    originatedBy: 'local-llm-shellcap';
  };
  onProgress?: (snapshot: AgentCommandProgressSnapshot) => void;
  syncNotificationClaim?: boolean;
}

export interface AgentSpawnDetachedResult {
  sessionId: string;
  outputFilePath: string;
}

export interface AgentReadOptions {
  sinceByteOffset?: number;
  sinceCursor?: number;
}

export interface AgentReadResult {
  output: string;
  outputBytes: number;
  isRunning: boolean;
  exitCode: number | null;
  cwd: string;
  lastOutputAt: number;
  truncated: boolean;
  nextCursor?: number;
  exitedBy?: 'normal_exit' | 'exec_failure' | 'signal';
  pid?: number;
}

export type AgentKillSignal = 'SIGTERM' | 'SIGINT' | 'SIGKILL';

/** ShellCap 读 store 时用到的 record 字段子集。 */
export interface ShellManagedTaskRecord {
  session_id: string;
  pid?: number;
  stdout_byte_count: number;
  started_at: number;
  output_file_path?: string;
  hard_timeout_ms?: number;
  status: 'running' | 'completed' | 'failed' | 'killed' | string;
}

/**
 * ShellCap 对 ManagedTaskStore 的端口（duck-type；实现仍在 terminal-core）。
 */
export interface ShellManagedTaskStorePort {
  runSpawnSerialized<T>(
    keyInput: {
      command: string;
      cwd: string;
      env: Record<string, string> | undefined;
      threadId?: string;
    },
    fn: () => Promise<T>,
  ): Promise<T>;
  findDedupCandidate(input: {
    command: string;
    cwd: string;
    env: Record<string, string> | undefined;
    threadId?: string;
  }): ShellManagedTaskRecord | undefined;
  get(sessionId: string): ShellManagedTaskRecord | undefined;
  markBackgroundExposed(sessionId: string): void;
  markNotified(sessionId: string): void;
  /**
   * 将 running record 封成终态（幂等）。abort 出口须在返回 failed 前调用，
   * 否则 PendingTasksNotice 仍会按 status===running 展示「运行中」。
   */
  updateOnExit(
    sessionId: string,
    result: {
      status: 'completed' | 'killed' | 'failed';
      exit_code: number;
      exited_by: 'normal_exit' | 'exec_failure' | 'signal';
      killed_reason?: 'hard_timeout' | 'kill_tool' | 'user_interrupt' | 'app_exit';
    },
  ): void;
  releaseSyncNotificationClaim(sessionId: string): ShellManagedTaskRecord | undefined;
  consumeDetachRequest(sessionId: string): boolean;
  consumeKillRequest(sessionId: string): boolean;
}

/**
 * ShellCap 实际调用的 bridge 方法子集。宿主注入的完整 PtyManagerBridge
 * 在结构上可赋值给本类型。
 */
export interface PtyManagerBridge {
  spawnAgentSessionDetached(req: AgentCommandRequest): Promise<AgentSpawnDetachedResult>;
  readAgentSessionOutput(
    sessionId: string,
    opts?: AgentReadOptions,
  ): Promise<AgentReadResult>;
  killAgentSession?(sessionId: string, signal?: AgentKillSignal): Promise<void>;
  getManagedTaskStore?: () => ShellManagedTaskStorePort;
}

function shellBaseName(file: string): string {
  return path.basename(file).toLowerCase();
}

function classifyShellKind(shell: string): AgentShellKind {
  const base = shellBaseName(shell);
  if (base.includes('pwsh') || base.includes('powershell')) return 'powershell';
  if (base === 'cmd' || base === 'cmd.exe') return 'cmd';
  if (base.includes('bash')) return 'bash';
  if (base.includes('zsh')) return 'zsh';
  if (base === 'sh' || base === 'dash' || base === 'ksh') return 'sh';
  return 'other';
}

const ACCEPTABLE_POSIX_SHELLS = new Set(['bash', 'zsh', 'sh', 'dash', 'ksh']);
const ACCEPTABLE_WINDOWS_SHELLS = new Set([
  'pwsh.exe',
  'powershell.exe',
  'cmd.exe',
  'pwsh',
  'powershell',
  'cmd',
]);

function isAcceptableShell(file: string, platform: NodeJS.Platform): boolean {
  const base = shellBaseName(file);
  if (platform === 'win32') return ACCEPTABLE_WINDOWS_SHELLS.has(base);
  return ACCEPTABLE_POSIX_SHELLS.has(base);
}

let cachedWindowsPowerShell: string | null | undefined;

function discoverWindowsPowerShell(): string | null {
  if (cachedWindowsPowerShell !== undefined) return cachedWindowsPowerShell;
  cachedWindowsPowerShell = null;
  for (const candidate of ['pwsh.exe', 'powershell.exe']) {
    try {
      const res = spawnSync('where', [candidate], {
        windowsHide: true,
        timeout: 5_000,
        encoding: 'utf8',
      });
      if (res.status === 0 && typeof res.stdout === 'string') {
        const firstLine = res.stdout.trim().split(/\r?\n/)[0];
        if (firstLine && fs.existsSync(firstLine)) {
          cachedWindowsPowerShell = firstLine;
          return cachedWindowsPowerShell;
        }
      }
    } catch {
      // try next candidate
    }
  }
  return cachedWindowsPowerShell;
}

function resolveShell(platform: NodeJS.Platform): string {
  const configured = process.env.SHELL;
  if (configured && path.isAbsolute(configured) && isAcceptableShell(configured, platform)) {
    return configured;
  }
  if (platform === 'darwin') return '/bin/zsh';
  if (platform === 'win32') {
    const ps = discoverWindowsPowerShell();
    if (ps) return ps;
    const comspec = process.env.COMSPEC;
    return comspec && path.isAbsolute(comspec) && isAcceptableShell(comspec, platform)
      ? comspec
      : 'cmd.exe';
  }
  return fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
}

/** 解析当前 Agent shell（路径 + 类别）；须与 bridge 实际 spawn 的 shell 同源逻辑对齐。 */
export function resolveAgentShellInfo(
  platform: NodeJS.Platform = process.platform,
): AgentShellInfo {
  const shell = resolveShell(platform);
  return { shell, kind: classifyShellKind(shell), platform };
}

function buildQuotingHint(rawPath: string, shellKind: AgentShellKind | undefined): string {
  if (shellKind === 'powershell') {
    return (
      `Path \`${rawPath}\` contains spaces and was not wrapped in quotes in the command. ` +
      `PowerShell will treat it as multiple arguments. Wrap such paths in single quotes ` +
      `(literal string) — e.g. \`'${rawPath}/file.pdf'\` — or double quotes ` +
      `\`"${rawPath}/file.pdf"\`.`
    );
  }
  if (shellKind === 'cmd') {
    return (
      `Path \`${rawPath}\` contains spaces and was not wrapped in quotes in the command. ` +
      `cmd.exe will split it into multiple arguments. Wrap such paths in double quotes — ` +
      `e.g. \`"${rawPath}\\file.pdf"\`. Note: cmd.exe does not treat single quotes as quoting.`
    );
  }
  return (
    `Path \`${rawPath}\` contains spaces and was not wrapped in quotes ` +
    `in the command. Bash will split it into multiple argv tokens, which is ` +
    `usually NOT what you intended. Wrap such paths in single quotes — ` +
    `e.g. \`'${rawPath}/file.pdf'\` — or use \`"$TABTIN_WORKSPACE/file.pdf"\` ` +
    `(double-quoted variable expansion is also safe).`
  );
}

function isInsideQuotes(command: string, targetIndex: number): boolean {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let i = 0;
  while (i < targetIndex && i < command.length) {
    const ch = command[i];
    if (ch === '\\' && !inSingleQuote && i + 1 < command.length) {
      i += 2;
      continue;
    }
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    } else if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    }
    i++;
  }
  return inSingleQuote || inDoubleQuote;
}

/**
 * 检测命令中未引号包裹、且含空格的 workspace 路径前缀（算法对齐 terminal-core）。
 */
export function detectUnquotedWorkspacePath(
  command: string,
  protectedPaths: readonly (string | undefined)[] | undefined,
  shellKind?: AgentShellKind,
): UnquotedWorkspacePathHit[] {
  if (!command || !protectedPaths || protectedPaths.length === 0) return [];

  const hits: UnquotedWorkspacePathHit[] = [];
  const seenPaths = new Set<string>();

  for (const rawPath of protectedPaths) {
    if (!rawPath || typeof rawPath !== 'string') continue;
    if (!rawPath.includes(' ')) continue;
    if (seenPaths.has(rawPath)) continue;
    seenPaths.add(rawPath);

    let searchFrom = 0;
    while (searchFrom <= command.length - rawPath.length) {
      const idx = command.indexOf(rawPath, searchFrom);
      if (idx < 0) break;

      if (!isInsideQuotes(command, idx)) {
        hits.push({
          path: rawPath,
          index: idx,
          hint: buildQuotingHint(rawPath, shellKind),
        });
        break;
      }
      searchFrom = idx + 1;
    }
  }

  return hits;
}
