import { spawn, type ChildProcess } from 'node:child_process';
import type { ExecuteOptions, ExecuteResult, ExecutorConfig, SandboxLevel, StreamingExecuteOptions, StreamingHandle, TerminalMode } from './types';
import { CommandValidator } from './commandValidator';
import { CommandValidationError } from './commandValidationError';
import { OutputCollector } from './outputCollector';
import { resolveCommandSandboxRoot, resolveWorkspaceRoot } from './pathUtils';
import { SandboxManager } from './sandboxManager';
import { createPlatformSandbox, type PlatformSandbox } from './platform';
import { getBwrapUnavailableReason } from './platform/detect';
import { resolveRelaxedRules } from './allowlist';
import { sanitizeEnv } from './sanitizeEnv';
import { t } from './i18n';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 100 * 1024;

interface SpawnContext {
  command: string;
  cwd: string;
  tmpDir?: string;
  env: Record<string, string>;
  mode: TerminalMode;
  sandboxLevel?: SandboxLevel;
  useOsSandbox: boolean;
  osSandboxDegraded: boolean;
  osSandboxDegradedReason?: string;
  timeoutMs: number;
  maxOutputBytes: number;
  relaxedUnknowns: string[];
  fallbackToUnsandboxed?: boolean;
  /** Network mode from policy (for OS sandbox buildSpawnArgs) */
  networkMode?: string;
  /** Extra env vars merged after sanitizeEnv (e.g. FORCE_COLOR for streaming) */
  extraEnv?: Record<string, string>;
}

/**
 * 调用方提供的 env 经过 sanitizeEnv 二次过滤后合并到子进程 env。
 *
 * **关卡 1 地板**：即使调用方主动传入危险变量（DYLD_INSERT_LIBRARIES /
 * LD_PRELOAD / SECRET / TOKEN 等），sanitizeEnv 都会将其剔除，避免外层
 * Backend 调用方误把宿主进程敏感变量回灌进 Agent 子进程。
 *
 * 调用方传入的同名安全变量覆盖 base（sanitizeEnv(process.env)）—— 这是
 * 期望行为，让 Agent 能用 callerEnv 覆写 PATH / HOME / NODE_OPTIONS 等
 * 显式声明的 SAFE_ALLOWLIST 变量，但绝不会引入危险变量。
 */
function mergeCallerEnv(
  base: Record<string, string>,
  callerEnv: Record<string, string> | undefined,
): Record<string, string> {
  if (!callerEnv) return base;
  const sanitized = sanitizeEnv(callerEnv);
  return { ...base, ...sanitized };
}

export class CommandExecutor {
  private readonly workspaceRoot: string;
  private readonly sandboxRoot: string;
  private readonly defaultTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly validator: CommandValidator;
  private readonly sandboxManager: SandboxManager;
  private readonly platformSandbox: PlatformSandbox;

  constructor(config: ExecutorConfig = {}) {
    this.workspaceRoot = resolveWorkspaceRoot(config.workspaceRoot);
    this.sandboxRoot = resolveCommandSandboxRoot(config.sandboxRoot);
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.validator = new CommandValidator(undefined, undefined, {
      requireApproval: config.requireApproval,
    });
    this.sandboxManager = new SandboxManager(this.sandboxRoot);
    this.platformSandbox = createPlatformSandbox();
  }

  /**
   * 清理指定 threadId 的沙箱目录（降级执行后调用，防止目录堆积）。
   */
  async cleanupSandbox(threadId: string): Promise<void> {
    await this.sandboxManager.cleanup(threadId);
  }

  async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    const ctx = await this._buildSpawnContext(options);
    return this._spawn(ctx);
  }

  async executeStreaming(options: StreamingExecuteOptions): Promise<StreamingHandle> {
    const ctx = await this._buildSpawnContext(options);
    ctx.timeoutMs = options.timeout ?? ctx.timeoutMs;
    ctx.extraEnv = {
      FORCE_COLOR: '1',
      TERM: 'xterm-256color',
    };

    let spawnedChild: ChildProcess | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    const clearForceKillTimer = () => {
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = null;
      }
    };

    // 统一的 graceful kill —— 与 handle.kill() / signal abort 共用，
    // 走 SIGTERM → 3s 后 SIGKILL 的两阶段流程。命令式 kill 与声明式
    // signal 走同一函数，确保行为一致（W1.2 P0：防止两条路径行为漂移）。
    const gracefulKill = () => {
      if (!spawnedChild) return;
      if (hasChildExited(spawnedChild)) return;

      clearForceKillTimer();
      killSpawnedProcess(spawnedChild, 'SIGTERM');
      forceKillTimer = setTimeout(() => {
        if (!spawnedChild || hasChildExited(spawnedChild)) return;
        killSpawnedProcess(spawnedChild, 'SIGKILL');
      }, 3000);
    };

    // signal abort 处理：先注册 abort listener（spawn 之前 / 之后都能
    // 触发），让 onAbort 总是有效闭包。spawn 后若 signal 已是 aborted
    // 立即 kill —— 覆盖 spawn 完成与 abort 同一事件循环的 race window。
    const signal = options.signal;
    const onAbort = signal ? () => gracefulKill() : undefined;
    if (signal && onAbort) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const result = this._spawn(ctx, options.onStdout, options.onStderr, (child) => {
      spawnedChild = child;
      child.once('close', clearForceKillTimer);
      child.once('exit', clearForceKillTimer);
      if (signal && onAbort) {
        // child 退出后 remove abort listener，避免长时间持有 signal 引用
        const off = () => {
          try { signal.removeEventListener('abort', onAbort); } catch { /* noop */ }
        };
        child.once('close', off);
        child.once('exit', off);
        // spawn 完成时若 signal 已经是 aborted（race），立即 kill
        if (signal.aborted) gracefulKill();
      }
    });

    return {
      result,
      kill: gracefulKill,
      pid: spawnedChild?.pid,
    };
  }

  /**
   * 将 ExecuteOptions 解析为 SpawnContext：包含验证、策略解析、沙箱准备等所有前置逻辑。
   */
  private async _buildSpawnContext(options: ExecuteOptions): Promise<SpawnContext> {
    const command = options.command?.trim();
    if (!command) {
      throw new Error(t('errors.commandRequired'));
    }

    const policy = options.policyOverrides;

    if (policy?.route === 'blocked') {
      throw new Error(policy.denyReason || 'Command blocked by sandbox policy.');
    }

    const { rules: relaxed, unknowns: relaxedUnknowns } = policy?.relaxedRules?.length
      ? resolveRelaxedRules(policy.relaxedRules)
      : { rules: [], unknowns: [] };
    const mergedAllowRules = relaxed.length
      ? [...(policy?.extraAllowRules ?? []), ...relaxed]
      : policy?.extraAllowRules;

    const validation = this.validator.validate(
      command,
      policy?.extraDenyRules,
      mergedAllowRules,
    );
    if (!validation.allowed) {
      throw new CommandValidationError(
        validation.reason || t('errors.commandDenied'),
        validation.ruleName,
      );
    }

    const effectiveMode: TerminalMode = policy?.route === 'sandbox'
      ? 'sandbox'
      : policy?.route === 'regular'
        ? 'regular'
        : (options.mode || 'regular');
    const mode = effectiveMode;

    const sandboxLevel: SandboxLevel | undefined =
      policy?.sandboxLevel || options.sandboxLevel;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const maxOutputBytes = options.maxOutputBytes ?? this.maxOutputBytes;

    let cwd = options.workingDirectory || this.workspaceRoot;
    let tmpDir: string | undefined;

    if (mode === 'sandbox') {
      const sandboxBase = options.workingDirectory || this.workspaceRoot;
      const sandbox = await this.sandboxManager.ensureSandbox(options.threadId || '', sandboxBase);
      cwd = sandbox.projectDir;
      tmpDir = sandbox.tmpDir;
    }

    const env: Record<string, string> = mergeCallerEnv(
      {
        ...sanitizeEnv(process.env),
        ...(tmpDir ? { TMPDIR: tmpDir } : {}),
      },
      options.env,
    );

    let useOsSandbox = false;
    let osSandboxDegraded = false;
    let osSandboxDegradedReason: string | undefined;

    if (mode === 'sandbox' && tmpDir && sandboxLevel) {
      const ok = await this.platformSandbox.isAvailable();
      if (ok) {
        useOsSandbox = true;
      } else {
        osSandboxDegraded = true;
        osSandboxDegradedReason =
          this.platformSandbox.platform === 'linux'
            ? (getBwrapUnavailableReason() ?? 'bwrap unavailable')
            : `${this.platformSandbox.platform} sandbox unavailable`;
      }
    }

    return {
      command,
      cwd,
      tmpDir,
      env,
      mode,
      sandboxLevel,
      useOsSandbox,
      osSandboxDegraded,
      osSandboxDegradedReason,
      timeoutMs,
      maxOutputBytes,
      relaxedUnknowns,
      fallbackToUnsandboxed: options.fallbackToUnsandboxed,
      networkMode: policy?.networkMode,
    };
  }

  /**
   * 核心 spawn 逻辑：创建子进程、收集输出、超时管理。
   * 可选的 onStdout/onStderr 回调用于流式输出。
   */
  private _spawn(
    ctx: SpawnContext,
    onStdout?: (chunk: string) => void,
    onStderr?: (chunk: string) => void,
    onSpawn?: (child: ChildProcess) => void,
  ): Promise<ExecuteResult> {
    const {
      command, cwd, tmpDir, mode, sandboxLevel,
      useOsSandbox, osSandboxDegraded, osSandboxDegradedReason,
      timeoutMs, maxOutputBytes, relaxedUnknowns, fallbackToUnsandboxed,
    } = ctx;

    const env: Record<string, string> = ctx.extraEnv
      ? { ...ctx.env, ...ctx.extraEnv }
      : ctx.env;

    // ── W1（路径含空格保护）────────────────────────────────────────
    //
    // 当 TABTIN_* 平台环境变量的值含有空格时（典型：macOS 的
    // `/Users/foo/Application Support/TabTin/spaces`），shell 对
    // 未加引号的变量引用（`$TABTIN_WORKSPACE`）会做 word-splitting，
    // 导致 `cp $TABTIN_WORKSPACE/file.txt /tmp/` 被拆成三个参数。
    //
    // **不修改用户命令字符串**——只在命令前拼接一段 shell 初始化
    // 导言（export VARNAME='...'），让变量在 shell 上下文内被重新
    // 以单引号形式赋值。shell 对已赋值变量的引用做 word-splitting
    // 时，使用的是变量「内容」，而非字面引号——但通过这个方式，
    // 我们确保了 cwd（spawn option）和 env 字典都是原始路径字符串，
    // 保证 Node.js 层面的正确性。
    //
    // **关于 word-splitting 的根因**：即使在 shell 级别重新 export
    // 了变量，`cp $TABTIN_WORKSPACE/file` 仍会 word-split，因为 shell
    // 是在命令执行前展开变量的。真正的兜底需要用户在命令中写
    // `"$TABTIN_WORKSPACE"`。但 runtime 层能做的是：当 cwd 含空格时，
    // 在命令前注入 `export TABTIN_WORKSPACE='...'`（单引号 POSIX 转义）
    // ——这不会修改用户命令，且是我们能在注入位置做到的最大保护。
    //
    // 注意范围：仅 TABTIN_* 前缀变量。用户自定义变量的 quoting
    // 习惯保持不变（不干涉）。
    const tabtinVarPreamble = buildTabtinVarPreamble(env);

    const outputCollector = new OutputCollector(maxOutputBytes);
    const startedAt = Date.now();
    let timedOut = false;

    return new Promise<ExecuteResult>((resolve, reject) => {
      let child: ChildProcess;

      if (useOsSandbox) {
        const spawnArgs = this.platformSandbox.buildSpawnArgs({
          command: tabtinVarPreamble ? `${tabtinVarPreamble}; ${command}` : command,
          cwd,
          tmpDir: tmpDir!,
          sandboxLevel: sandboxLevel!,
          env,
          networkMode: ctx.networkMode as any,
        });
        child = spawn(spawnArgs.file, spawnArgs.args, spawnArgs.options);
      } else if (process.platform === 'win32') {
        console.warn(
          '[terminal-core] WARNING: Windows 无沙箱降级模式执行命令，安全性仅由 denylist + allowlist 保障',
        );
        const psPreamble = buildPSTabtinVarPreamble(env);
        const psCommand = psPreamble ? `${psPreamble}; ${command}` : command;
        child = spawn('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy', 'Bypass',
          '-Command', psCommand,
        ], { cwd, shell: false, env });
      } else {
        const shellCommand = tabtinVarPreamble ? `${tabtinVarPreamble}; ${command}` : command;
        child = spawn('/bin/sh', ['-c', shellCommand], {
          cwd,
          shell: false,
          env,
          detached: true,
        });
      }

      onSpawn?.(child);

      const timer = setTimeout(() => {
        timedOut = true;
        killSpawnedProcess(child, 'SIGKILL');
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        outputCollector.appendStdout(chunk);
        onStdout?.(chunk.toString());
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        outputCollector.appendStderr(chunk);
        onStderr?.(chunk.toString());
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startedAt;

        const stderr = outputCollector.getStderr();
        const exitCode = code ?? -1;

        const sandboxRestricted = mode === 'sandbox' && useOsSandbox && exitCode !== 0
          && isSandboxRestrictionError(stderr);

        const sandboxFallbackRequested = sandboxRestricted
          && (fallbackToUnsandboxed === true);

        const warnings: string[] = [];
        if (osSandboxDegraded) {
          warnings.push(
            `OS sandbox degraded: ${osSandboxDegradedReason || 'sandbox binary unavailable'}. ` +
            `Command executed without OS-level sandbox protection.`,
          );
        }
        if (relaxedUnknowns.length > 0) {
          warnings.push(
            `Unknown relaxed_rules ignored: ${relaxedUnknowns.join(', ')}. ` +
            `Server expected these rules to be relaxed but client does not recognize them.`,
          );
        }

        resolve({
          stdout: outputCollector.getStdout(),
          stderr,
          exitCode,
          cwd,
          durationMs,
          truncated: outputCollector.isTruncated(),
          mode,
          timedOut,
          sandboxLevel,
          osSandbox: useOsSandbox,
          osSandboxDegraded,
          osSandboxDegradedReason,
          sandboxRestricted: sandboxRestricted || undefined,
          sandboxFallbackRequested: sandboxFallbackRequested || undefined,
          warnings: warnings.length > 0 ? warnings : undefined,
        });
      });
    });
  }
}

/**
 * W1（路径含空格保护）：为含空格路径的 TABTIN_* 环境变量生成
 * shell 初始化前缀，以 POSIX 单引号转义方式重新 export 变量。
 *
 * **目的**：当 TABTIN_WORKSPACE 等平台变量的值含空格时，在子进程
 * shell 内重新以 single-quote 形式赋值——这是"注入位置"能做的最大
 * 保护，确保如 `"$TABTIN_WORKSPACE"` 这类有意引用的场景能正确工作。
 *
 * **不修改用户原命令**：preamble 是 PREPEND（前缀），用户命令字符
 * 串本身不变。无空格的变量不会出现在 preamble 里，避免无谓开销。
 *
 * POSIX 单引号转义规则：在单引号内部无需转义，唯一的特殊字符是
 * 单引号本身，通过 `'\''`（结束单引号、插入字面单引号、重启单引号）
 * 来处理。
 *
 * 例：path = `/Users/foo/Application Support` →
 *   `export TABTIN_WORKSPACE='/Users/foo/Application Support'`
 *
 * @returns semicolon-separated shell statements, or empty string if no
 *          TABTIN_* var with spaces is present (caller skips the prefix).
 */
/**
 * POSIX shell 前导：为值含空格的 TABTIN_* 环境变量生成 `export KEY='value'` 语句。
 *
 * 使用 POSIX 单引号转义：每个 `'` 替换为 `'\''`（关闭引号 + 字面单引号 + 重新开引号）。
 * 导出后，shell 展开 `"$TABTIN_WORKSPACE"` 时不会再做 word-splitting。
 */
export function buildTabtinVarPreamble(env: Record<string, string>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('TABTIN_')) continue;
    if (!value.includes(' ')) continue;
    // POSIX single-quote escape: replace every ' with '\''
    const escaped = value.replace(/'/g, "'\\''");
    parts.push(`export ${key}='${escaped}'`);
  }
  return parts.join('; ');
}

/**
 * PowerShell 前导（Win32）：为值含空格的 TABTIN_* 环境变量生成 `$env:KEY = 'value'` 语句。
 *
 * PowerShell 单引号字符串是字面量，内部 `'` 需用 `''` 转义。
 */
export function buildPSTabtinVarPreamble(env: Record<string, string>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('TABTIN_')) continue;
    if (!value.includes(' ')) continue;
    // PowerShell single-quoted string escaping: ' → ''
    const escaped = value.replace(/'/g, "''");
    parts.push(`$env:${key} = '${escaped}'`);
  }
  return parts.join('; ');
}

/**
 * 检测 stderr 输出是否包含沙箱限制导致的错误特征。
 * 典型场景：文件访问被拒绝、网络不可用、权限不足（由沙箱引起）。
 */
function isSandboxRestrictionError(stderr: string): boolean {
  if (!stderr) return false;
  const lower = stderr.toLowerCase();
  const patterns = [
    // 文件系统限制
    'permission denied',
    'operation not permitted',
    'read-only file system',
    'no such file or directory',    // 沙箱挂载导致路径不可见
    // 网络限制
    'network is unreachable',
    'network unreachable',
    'name or service not known',
    'could not resolve host',
    'connection refused',           // 沙箱内网络被阻断
    'temporary failure in name resolution',
    // bwrap / sandbox-exec 特征
    'bwrap:',
    'sandbox-exec:',
    'not allowed by sandbox',
    // 通用沙箱限制
    'access denied',
    'socket operation on non-socket',
  ];
  return patterns.some(p => lower.includes(p));
}

function killSpawnedProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;

  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall through to direct child kill when no separate process group exists.
    }
  }

  try {
    child.kill(signal);
  } catch {
    // Best-effort kill only.
  }
}

function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}
