import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { sanitizeEnv } from './sanitizeEnv';
import type { AgentKillSignal } from './agent-bridge';

const DEFAULT_MAX_RESULT_BYTES = 4 * 1024 * 1024;
const DEFAULT_FORCE_KILL_AFTER_MS = 3_000;
const AGENT_FOREGROUND_OUTPUT_DIR_NAME = 'tabtin-agent-foreground';
const ACCEPTABLE_POSIX_SHELLS = new Set(['bash', 'zsh', 'sh', 'dash', 'ksh']);
const ACCEPTABLE_WINDOWS_SHELLS = new Set(['cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe']);

// ==================== Exit-timing probe（终端假运行根治 / 定位"退出滞后"潜伏 bug）====================

/**
 * 退出时序探针开关（默认关，零生产开销）。
 *
 * **要根治的潜伏现象**：detached 后台命令子进程**实际早已退出**（sidecar `.status`
 * mtime 实锤），但 bridge 过了约 60s 才观测到退出 → 前台 poll 跑满 `wait_ms` 误返回
 * `status:"running"`。机制尚未坐实：需分清是「`exit`/`close` 事件本身晚到」还是
 * 「事件到了但 `finish`/flush 卡了约 60s」。
 *
 * **怎么开**（在启动 Electron / Daemon 前 export，对生产链路零影响）：
 *   - `TABTIN_DEBUG_EXIT_TIMING=1`：打开，时间戳行同时写 stderr + 默认文件
 *     `{os.tmpdir()}/tabtin-exit-timing.log`。**推荐改用绝对路径形式**（见下）让文件好找。
 *   - `TABTIN_DEBUG_EXIT_TIMING=/abs/path.log`（或 `~/x.log`）：开探针，**且**值本身当落盘路径
 *     （如 `~/tabtin-exit-timing.log` → 落家目录，双击就能开）。
 *   - `TABTIN_DEBUG_EXIT_TIMING_FILE=/abs/path.log`：仅指定落盘文件。**必须配合主 flag**
 *     （主 flag 缺省时探针整体关闭，本变量被忽略）；同时设两者时本变量决定落盘路径。
 *   - 关（缺省 / `0` / `false` / `off`）：`createExitTimingProbe` 返回 no-op，
 *     不读文件 env、不 attach `close` 监听、不产生任何 IO。
 *
 * **每行格式**：`[TABTIN_EXIT_TIMING] corr=<pid.nonce> pid=<childPid> t+<Δms>ms <ISO> <event> <json?>`
 * `corr` 区分并发命令；`t+Δms` 是相对 spawn 的毫秒差。**怕读不懂时序就直接看 `result.verdict`
 * 那一行**——它已把「真实退出 / exit 事件 / resolve」三个时刻算成 `exitLagMs` / `flushLagMs`
 * 并给出 `verdict`（exit-late / flush-late / prompt），复制这一行回传即可定位。
 */
const EXIT_TIMING_ENV = 'TABTIN_DEBUG_EXIT_TIMING';
const EXIT_TIMING_FILE_ENV = 'TABTIN_DEBUG_EXIT_TIMING_FILE';

interface ExitTimingProbe {
  /** 关闭时为 false——调用方据此跳过「仅诊断用」的额外监听（如 `close`）以保零开销。 */
  readonly enabled: boolean;
  /** 打一条带时间戳的事件行（关闭时 no-op）。 */
  log(event: string, extra?: Record<string, unknown>): void;
  /**
   * best-effort 读取 sidecar(`.status`) mtime → 换算成相对 spawn 的毫秒差并落一行日志，
   * 同时**返回该毫秒差**给调用方算 verdict（缺路径 / 读不到时返回 null）。
   * 这是「子进程**真实**退出时刻」的盘上真相源（shell 退出前 `echo $? > .status`），
   * 与 `child.exit` 事件的 `t+` 一对照即知 exit 事件是否晚到。
   */
  observeSidecar(statusFilePath: string | undefined): number | null;
}

const NOOP_EXIT_TIMING_PROBE: ExitTimingProbe = {
  enabled: false,
  log() {},
  observeSidecar() {
    return null;
  },
};

/** 落盘文件 banner 只在进程内打一次，避免每条命令重复刷屏。 */
let exitTimingBannerShown = false;

function resolveExitTimingFile(raw: string): string {
  const explicit = process.env[EXIT_TIMING_FILE_ENV];
  if (explicit) return explicit;
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  if (path.isAbsolute(raw)) return raw;
  // 非绝对路径 / 非 `~/`（如 `1` / `true` / `foo.log`）一律落默认文件——避免相对
  // 路径在 Electron 主进程不确定的 cwd 下写到意料之外的位置。
  return path.join(os.tmpdir(), 'tabtin-exit-timing.log');
}

/**
 * @internal 导出仅供单测验证探针开关 / 落盘格式；非公共 API。
 */
export function createExitTimingProbe(
  startedAt: number,
  getPid: () => number | undefined,
): ExitTimingProbe {
  const raw = process.env[EXIT_TIMING_ENV];
  if (!raw || raw === '0' || raw === 'false' || raw === 'off') return NOOP_EXIT_TIMING_PROBE;

  const corr = `${process.pid}.${randomBytes(3).toString('hex')}`;
  const filePath = resolveExitTimingFile(raw);

  const write = (line: string) => {
    try {
      console.error(line);
    } catch {
      // 控制台不可用时不影响命令本身
    }
    try {
      fs.appendFileSync(filePath, `${line}\n`);
    } catch {
      // 落盘失败（磁盘满 / 权限）静默——探针绝不能弄崩命令
    }
  };

  if (!exitTimingBannerShown) {
    exitTimingBannerShown = true;
    try {
      console.error(`[TABTIN_EXIT_TIMING] enabled — appending timing lines to ${filePath}`);
    } catch {
      // ignore
    }
  }

  const log = (event: string, extra?: Record<string, unknown>): void => {
    // 整体兜错：探针是 opt-in 诊断，绝不能因序列化 / IO 异常冒泡到命令回调里。
    try {
      const now = Date.now();
      const head = `[TABTIN_EXIT_TIMING] corr=${corr} pid=${getPid() ?? '-'} t+${now - startedAt}ms ${new Date(now).toISOString()} ${event}`;
      write(extra ? `${head} ${JSON.stringify(extra)}` : head);
    } catch {
      // 探针失败静默
    }
  };

  return {
    enabled: true,
    log,
    observeSidecar(statusFilePath): number | null {
      if (!statusFilePath) {
        // 前台路径不传 statusfile——留一行痕迹解释「为何没有 sidecar 行」，避免误判。
        log('sidecar.skip', { reason: 'no-status-path' });
        return null;
      }
      try {
        const st = fs.statSync(statusFilePath);
        const deltaMs = Math.round(st.mtimeMs - startedAt);
        log('sidecar.observed', {
          statusFilePath,
          sidecarMtimeDeltaMs: deltaMs,
          sizeBytes: st.size,
        });
        return deltaMs;
      } catch (err) {
        log('sidecar.missing', {
          statusFilePath,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },
  };
}

export interface AgentShellProcessOptions {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  enforceTimeout?: boolean;
  signal?: AbortSignal;
  onOutput?: (data: string) => void;
  /**
   * 2026-05-18 review P0-8 + 上线必修：是否以新 session leader 启动子进程（POSIX `setsid`）。
   *
   * **必须按 host 显式区分**：
   *   - **Electron Unix 端**：传 `true`。Electron 主进程退出时子进程随 PTY fd 关联被 OS 回收，
   *     detached 让 process tree kill（`process.kill(-pid)`）能精准杀掉整个进程组。
   *   - **Electron Windows 端**：传 `false`。Windows `detached: true` 会给子进程分配
   *     独立控制台窗口，右侧 Agent/Chat 命令会弹出黑色命令框；且 Windows 路径也没有
   *     `process.kill(-pid)` 进程组收益。
   *   - **Daemon 端**：传 `false`。Daemon 进程可能被 kill -9 / crash / 重启 —— 如果子进程
   *     是新 session leader（detached: true），父进程死时子进程不会收 SIGHUP，会变成
   *     init 接管的孤儿（dev server 占端口、build 吃 CPU，用户感知"产品坏了"）。
   *     Daemon 端 dispose 时再主动 kill 所有 running record 的 pid 做兜底（macOS 没有
   *     Linux `PR_SET_PDEATHSIG` 等价机制，只能主动清）。
   *
   * **缺省**（不传）按原行为 `process.platform !== 'win32'`——保留向后兼容，
   * 但 ShellCap / bridge 调用路径都应显式传值。
   */
  detached?: boolean;
  maxResultBytes?: number;
  /**
   * Layer 2 退出码 sidecar 落盘路径（终端假运行根治 v3 / 治 F9：host 崩溃兜底）。
   *
   * 提供时，shell 脚本在进程退出前把命令退出码 echo 到该文件（与 pwd 探针**对称**）——
   * host 崩溃 / 断电 / `kill -9`（清理链路没机会跑）后，下次启动对账能从盘上读回
   * **真实退出码**（退出码写盘真相源）。
   *
   * **缺省（不传）→ 脚本不写 statusfile**，行为与旧版完全一致（前台 `executeAgentCommand`
   * 直接从子进程 `exit` 拿码、无需 sidecar；只有 detached 后台路径需要）。
   *
   * **调用方（bridge）负责分配路径**：与 `output_file` 同目录、命名 `<session>.status`
   * （见 `tabtinAgentTaskStatusPath`）。本 runner 只把路径嵌进脚本，不负责创建 /
   * 删除该文件（生命周期由 `ManagedTaskStore` / 启动对账管理）。
   */
  statusFilePath?: string;
}

export interface AgentShellProcessResult {
  output: string;
  exitCode: number | null;
  cwd: string;
  durationMs: number;
  timedOut: boolean;
  killed: boolean;
  outputBytes: number;
  truncated: boolean;
  /**
   * Raw merged stdout/stderr captured to disk for the caller to post-process.
   *
   * This file may contain unredacted command output. ShellCap must copy/redact it
   * into its own persisted_output_path before exposing any path to the LLM.
   */
  outputFilePath?: string;
  outputFileSize?: number;
}

export interface AgentShellProcessHandle {
  readonly pid: number | undefined;
  readonly result: Promise<AgentShellProcessResult>;
  kill: (signal?: AgentKillSignal) => void;
}

const LF_TO_CRLF = /(?<!\r)\n/g;

function toTerminal(data: string): string {
  return data.replace(LF_TO_CRLF, '\r\n');
}

// ==================== 命令输出解码（治中文/非 UTF-8 Windows 乱码 RT-6）====================
//
// **根因**：`spawnAgentShellProcess` 用 `child_process.spawn`（非 ConPTY，不做 UTF-8
// 转译）。Windows 下子 shell 的内建消息（如 cmd 的 `'x' 不是内部或外部命令`）与许多
// 原生 CLI 按**控制台/OEM 代码页**输出 —— 中文 Windows 是 CP936(GBK)、日文 CP932、
// 韩文 CP949 等。若一律 `chunk.toString('utf8')`，这些字节就被错当 UTF-8 解码成乱码。
//
// **为何不在 shell 端 `chcp 65001`**：实测 cmd.exe 在启动时即缓存输出代码页，事后
// `chcp 65001` 不改其内建消息编码（仍 GBK）——治不了。故在**解码端**根治：
//   1. 字节是合法 UTF-8 → 按 UTF-8 解（覆盖 node/git 等现代工具 + 纯 ASCII）；
//   2. 否则回退到**实测检测到的** OEM/控制台代码页（不写死中文，适配 932/949/950…）。
// 非 win32 保持原 `utf8` 行为不变。

/** Windows 代码页号 → WHATWG Encoding 标准 label（TextDecoder 可用的名字）。 */
const CODE_PAGE_TO_LABEL: Record<number, string> = {
  65001: 'utf-8',
  936: 'gbk',
  54936: 'gb18030',
  950: 'big5',
  932: 'shift_jis',
  949: 'euc-kr',
  874: 'windows-874',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258',
  866: 'ibm866',
  20866: 'koi8-r',
  21866: 'koi8-u',
  28591: 'iso-8859-1',
  28592: 'iso-8859-2',
  28595: 'iso-8859-5',
};

/** @internal 仅供单测：代码页号映射到 TextDecoder label（未知返回 undefined）。 */
export function mapCodePageToLabel(codePage: number): string | undefined {
  return CODE_PAGE_TO_LABEL[codePage];
}

// undefined = 尚未检测；null = 检测过但无可用 OEM label（含非 win32）。
let cachedOemDecoderLabel: string | null | undefined;

/** 检测当前 Windows 控制台/OEM 代码页（best-effort，进程内只跑一次并缓存）。 */
function detectOemDecoderLabel(): string | null {
  if (cachedOemDecoderLabel !== undefined) return cachedOemDecoderLabel;
  cachedOemDecoderLabel = null;
  if (process.platform !== 'win32') return cachedOemDecoderLabel;
  try {
    const res = spawnSync('cmd.exe', ['/d', '/s', '/c', 'chcp'], { windowsHide: true });
    // chcp 输出形如 `Active code page: 936` / `活动代码页: 936`，结尾恒为代码页号。
    const out = res.stdout ? Buffer.from(res.stdout).toString('latin1') : '';
    const match = out.match(/(\d+)\s*$/);
    if (match) {
      const label = CODE_PAGE_TO_LABEL[Number.parseInt(match[1], 10)];
      if (label) cachedOemDecoderLabel = label;
    }
  } catch {
    // 检测失败保持 null（回退仅按 UTF-8，不比现状更差）
  }
  return cachedOemDecoderLabel;
}

/** @internal 仅供单测重置检测缓存。 */
export function resetOemDecoderCacheForTest(): void {
  cachedOemDecoderLabel = undefined;
}

/**
 * @internal 仅供单测：字节合法 UTF-8 → UTF-8；否则用给定 OEM label 解；都不行回退 utf8。
 */
export function decodeWithFallback(buf: Buffer, oemLabel: string | null): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    if (oemLabel) {
      try {
        return new TextDecoder(oemLabel).decode(buf);
      } catch {
        // label 不被运行时支持（极少见）→ 落到最后的 lossy utf8
      }
    }
    return buf.toString('utf8');
  }
}

/** 解码一段子进程输出字节：非 win32 维持 utf8；win32 走 UTF-8 优先 + OEM 回退。 */
function decodeChildOutput(buf: Buffer): string {
  if (process.platform !== 'win32') return buf.toString('utf8');
  return decodeWithFallback(buf, detectOemDecoderLabel());
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resolveWorkingDirectory(cwd: string | undefined): string {
  if (!cwd) return process.cwd();
  try {
    return fs.realpathSync(cwd);
  } catch {
    return cwd;
  }
}

function shellBaseName(file: string): string {
  return path.basename(file).toLowerCase();
}

function isAcceptableShell(file: string, platform: NodeJS.Platform = process.platform): boolean {
  const base = shellBaseName(file);
  if (platform === 'win32') return ACCEPTABLE_WINDOWS_SHELLS.has(base);
  return ACCEPTABLE_POSIX_SHELLS.has(base);
}

// ：Windows PowerShell 发现。优先 pwsh（PS7+，跨平台、UTF-8 默认更好），
// 回退 Windows 内置 powershell.exe（PS5.1）。进程内只探一次并缓存。
// undefined = 尚未探测；null = 探过但无可用 PowerShell（含非 win32）。
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
      // 继续尝试下一个候选（where 不存在 / 超时等）
    }
  }
  return cachedWindowsPowerShell;
}

/** @internal 仅供单测重置 PowerShell 发现缓存。 */
export function resetWindowsPowerShellCacheForTest(): void {
  cachedWindowsPowerShell = undefined;
}

function resolveShell(platform: NodeJS.Platform = process.platform): string {
  const configured = process.env.SHELL;
  if (configured && path.isAbsolute(configured) && isAcceptableShell(configured, platform)) return configured;
  if (platform === 'darwin') return '/bin/zsh';
  if (platform === 'win32') {
    // ：Windows 主 shell 改为 PowerShell 一等公民。
    // cmd.exe 元字符语义差、cwd 探针不可靠；PowerShell 参数处理更安全、
    // UTF-8 友好。优先级：用户 SHELL > pwsh > powershell > cmd（兜底）。
    const ps = discoverWindowsPowerShell();
    if (ps) return ps;
    // [降级/兜底] 无任何 PowerShell 时退回 cmd.exe（COMSPEC）。
    const comspec = process.env.COMSPEC;
    return comspec && path.isAbsolute(comspec) && isAcceptableShell(comspec, platform)
      ? comspec
      : 'cmd.exe';
  }
  return fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
}

/** Agent 终端 shell 的归一化类别——供上层 prompt / 引号提示 / 白名单按类型适配。 */
export type AgentShellKind = 'bash' | 'zsh' | 'sh' | 'powershell' | 'cmd' | 'other';

export interface AgentShellInfo {
  /** 解析出的 shell 可执行路径或名（如 /bin/zsh、pwsh.exe）。 */
  shell: string;
  /** 归一化的 shell 类别。 */
  kind: AgentShellKind;
  platform: NodeJS.Platform;
}

/** @internal 把 shell 路径/名归类到 AgentShellKind（按 basename，大小写不敏感）。 */
export function classifyShellKind(shell: string): AgentShellKind {
  const base = shellBaseName(shell);
  if (base.includes('pwsh') || base.includes('powershell')) return 'powershell';
  if (base === 'cmd' || base === 'cmd.exe') return 'cmd';
  if (base.includes('bash')) return 'bash';
  if (base.includes('zsh')) return 'zsh';
  if (base === 'sh' || base === 'dash' || base === 'ksh') return 'sh';
  return 'other';
}

/**
 * 解析当前 Agent 终端的 shell 信息（路径 + 类别 + 平台）。
 *
 * 上层（`run_terminal_command` 描述 / 引号提示 / 受限白名单）用它知道实际 shell，
 * 避免各自硬编码 POSIX 假设。与 `spawnAgentShellProcess` 内部 `resolveShell` 同源，
 * 保证「告诉 LLM 的 shell」与「真正执行的 shell」一致。
 */
export function resolveAgentShellInfo(platform: NodeJS.Platform = process.platform): AgentShellInfo {
  const shell = resolveShell(platform);
  return { shell, kind: classifyShellKind(shell), platform };
}

function isPowerShell(shell: string): boolean {
  const base = path.basename(shell).toLowerCase();
  return base === 'pwsh' || base === 'powershell' || base === 'powershell.exe' || base === 'pwsh.exe';
}

function isCmd(shell: string): boolean {
  const base = path.basename(shell).toLowerCase();
  return base === 'cmd' || base === 'cmd.exe';
}

function buildCwdProbePath(): string {
  const nonce = `${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`;
  return path.join(os.tmpdir(), `tabtin-agent-cwd-${nonce}.txt`);
}

function realpathBestEffort(abs: string): string {
  try {
    return fs.realpathSync(abs);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
    } catch {
      return abs;
    }
  }
}

function buildOutputFilePath(): string | undefined {
  try {
    const dir = path.join(os.tmpdir(), AGENT_FOREGROUND_OUTPUT_DIR_NAME);
    fs.mkdirSync(dir, { recursive: true });
    const nonce = `${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`;
    const filePath = path.join(dir, `${nonce}.log`);
    fs.closeSync(fs.openSync(filePath, 'w'));
    return realpathBestEffort(filePath);
  } catch {
    return undefined;
  }
}

/**
 * @internal 导出仅供单测验证脚本生成（含 Layer 2 sidecar 行）；非公共 API
 * （`src/index.ts` 不 re-export，测试从模块路径直接 import）。
 */
export function buildPosixScript(command: string, cwdFilePath: string, statusFilePath?: string): string {
  const quotedCwdFile = shellQuote(cwdFilePath);
  const lines = [
    'exec 2>&1',
    command,
    '__tabtin_agent_status=$?',
    `pwd -P > ${quotedCwdFile} 2>/dev/null || pwd > ${quotedCwdFile} 2>/dev/null || true`,
  ];
  if (statusFilePath) {
    // Layer 2 sidecar（治 F9）：与 pwd 探针对称，把退出码落盘。`exec 2>&1` 已把
    // stderr 并入 stdout，故显式 `> statusfile` 不污染命令输出；失败吞错（|| true）
    // 不改变命令本身退出码。
    lines.push(`echo $__tabtin_agent_status > ${shellQuote(statusFilePath)} 2>/dev/null || true`);
  }
  lines.push('exit $__tabtin_agent_status');
  return lines.join('\n');
}

/** @internal 导出仅供单测（见 buildPosixScript 说明）。 */
export function buildPowerShellScript(command: string, cwdFilePath: string, statusFilePath?: string): string {
  const escapedCwdFile = cwdFilePath.replace(/'/g, "''");
  const lines = [
    // Windows PowerShell 5.1 defaults native-process pipeline input to ASCII.
    // Set this before the user command so stdin keeps non-ASCII text instead of replacing it with '?'.
    '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '& {',
    command,
    '}',
    '$__tabtin_agent_status = $LASTEXITCODE',
    'if ($null -eq $__tabtin_agent_status) { $__tabtin_agent_status = if ($?) { 0 } else { 1 } }',
    `try { (Get-Location).ProviderPath | Set-Content -LiteralPath '${escapedCwdFile}' -NoNewline -Encoding UTF8 } catch {}`,
  ];
  if (statusFilePath) {
    // Layer 2 sidecar（治 F9）：退出码落盘，与 cwd 探针对称；try/catch 吞错。
    const escapedStatusFile = statusFilePath.replace(/'/g, "''");
    lines.push(
      `try { $__tabtin_agent_status | Set-Content -LiteralPath '${escapedStatusFile}' -NoNewline -Encoding UTF8 } catch {}`,
    );
  }
  lines.push('exit $__tabtin_agent_status');
  return lines.join('\n');
}

/** @internal 导出仅供单测（见 buildPosixScript 说明）。 */
export function buildCmdScript(command: string, cwdFilePath: string, statusFilePath?: string): string {
  // cmd.exe cannot robustly preserve cwd across arbitrary batch syntax without
  // writing into the user's command. We still capture it for simple cases.
  // Layer 2 sidecar（治 F9）：**重定向必须放前面** `>"file" echo %var%`。
  // 若写成 `echo %var%> "file"`，cmd 会把紧贴 `>` 的数字当成重定向句柄
  // （`echo 0> file` = 重定向 stdin、文件写空；`echo 127> file` = `7>` 句柄、码残缺），
  // 导致 sidecar 恒写不出真实退出码（review 修复）。重定向前置则数字不再紧贴 `>`。
  const statusLine = statusFilePath
    ? `\r\n>"${statusFilePath}" echo %__tabtin_agent_status%`
    : '';
  return `${command}\r\nset __tabtin_agent_status=%ERRORLEVEL%\r\ncd > "${cwdFilePath}"${statusLine}\r\nexit /b %__tabtin_agent_status%`;
}

/** @internal 导出仅供单测验证 shell→args 选择 + sidecar 透传。 */
export function getSpawnCommand(
  shell: string,
  command: string,
  cwdFilePath: string,
  statusFilePath?: string,
): { file: string; args: string[] } {
  // ：按 shell **类别** 路由（不再用 process.platform 门控）——shell 名已
  // 隐含平台（pwsh/cmd 仅在 Windows 被 resolveShell 选中），这样单测可在任意
  // 平台注入 shell 验证 PS/cmd 分支。
  if (isPowerShell(shell)) {
    return {
      file: shell,
      // -ExecutionPolicy Bypass：避免受限执行策略拦截内联脚本。
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', buildPowerShellScript(command, cwdFilePath, statusFilePath)],
    };
  }
  if (isCmd(shell)) {
    return {
      file: shell,
      args: ['/d', '/s', '/c', buildCmdScript(command, cwdFilePath, statusFilePath)],
    };
  }

  const base = shellBaseName(shell);
  const args = base.includes('bash') || base.includes('zsh') || base.includes('ksh')
    ? ['-lc', buildPosixScript(command, cwdFilePath, statusFilePath)]
    : ['-c', buildPosixScript(command, cwdFilePath, statusFilePath)];
  return { file: shell, args };
}

/**
 * ShellCap 写入 mergedEnv 的内部 marker：逗号分隔的 Skill 凭据 env 键名。
 * buildEnv 读取后剥离 marker，并对列出的键绕过 sanitizeEnv 敏感过滤。
 * 仅 agent-runtime ShellCap 设置；LLM / 用户 env 不得注入此键。
 */
export const SKILL_CREDENTIAL_PRESERVE_ENV_KEYS_MARKER =
  '__TABTIN_SKILL_CREDENTIAL_PRESERVE_KEYS__';

function buildEnv(callerEnv: Record<string, string> | undefined): NodeJS.ProcessEnv {
  let caller = callerEnv;
  let preserveKeys: string[] | undefined;
  if (callerEnv?.[SKILL_CREDENTIAL_PRESERVE_ENV_KEYS_MARKER]) {
    preserveKeys = callerEnv[SKILL_CREDENTIAL_PRESERVE_ENV_KEYS_MARKER]
      .split(',')
      .map((key) => key.trim())
      .filter((key) => key.length > 0);
    caller = { ...callerEnv };
    delete caller[SKILL_CREDENTIAL_PRESERVE_ENV_KEYS_MARKER];
  }
  return {
    ...sanitizeEnv(process.env),
    ...sanitizeEnv(
      (caller ?? {}) as NodeJS.ProcessEnv,
      preserveKeys && preserveKeys.length > 0 ? { preserveKeys } : undefined,
    ),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TABTIN_AGENT: '1',
  };
}

function readCwdProbe(cwdFilePath: string, fallback: string): string {
  try {
    const value = fs.readFileSync(cwdFilePath, 'utf8').trim();
    return value || fallback;
  } catch {
    return fallback;
  } finally {
    try {
      fs.unlinkSync(cwdFilePath);
    } catch {
      // best effort
    }
  }
}

function mapKillSignal(signal: AgentKillSignal | undefined): NodeJS.Signals {
  if (signal === 'SIGINT') return 'SIGINT';
  if (signal === 'SIGKILL') return 'SIGKILL';
  return 'SIGTERM';
}

/**
 * 按 pid 杀掉**整棵进程树**。fire-and-forget，绝不抛错。
 *
 * - **POSIX**：spawn 时 `detached:true` 让 pid == 进程组组长，`process.kill(-pid)`
 *   精准杀整组（含 dev server / build 等子孙）；失败回退 `kill(pid)`。
 * - **Windows**：无 POSIX 进程组，改用 `taskkill /T` 杀整树，
 *   避免后台子孙进程变孤儿占端口。`SIGKILL → /F` 强杀；其余信号先请求优雅终止
 *   （不带 `/F`），由调用方 force-kill 定时器再升级到 `/F`。Windows 控制台进程对
 *   「优雅终止」支持有限，这里是 best-effort；taskkill 异步 spawn 不阻塞事件循环。
 *
 * 供 `spawnAgentShellProcess` 的 kill 路径与 host 退出清理（terminal-state-relay
 * 注入的 killProcessGroup）共用，保证 Windows 树杀语义一致。
 */
export function killProcessTreeByPid(
  pid: number | undefined,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
): void {
  if (typeof pid !== 'number' || pid <= 0) return;
  if (platform === 'win32') {
    const args = signal === 'SIGKILL'
      ? ['/F', '/T', '/PID', String(pid)]
      : ['/T', '/PID', String(pid)];
    try {
      // detached:true + unref()：app 退出 flush 路径
      // （terminal-state-relay）会同步 kill 后立刻退进程——非 detached 的 taskkill
      // 子进程可能在跑起来前随父进程一起死，导致 Windows 清理静默不生效。
      // detached 让它脱离父进程组存活；unref 让它不反过来吊住父进程退出。
      const tk = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true, detached: true });
      // taskkill 不可用（极少见）→ best-effort 放弃，不冒泡。
      tk.on('error', () => {});
      tk.unref();
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

/** spawn 路径用：优先按 pid 树杀；无 pid 时回退 `child.kill`。 */
function killChildProcessTree(child: ChildProcess, nodeSignal: NodeJS.Signals): void {
  if (child.pid) {
    killProcessTreeByPid(child.pid, nodeSignal);
    return;
  }
  try {
    child.kill(nodeSignal);
  } catch {
    /* already gone */
  }
}

/**
 * 执行根（Agent `working_dir` / 命令 cwd）在 spawn 时不可达——目录被删 / 移走 /
 * 改名，或外置盘 / 网络盘未挂载（RT-2，见 `docs/overview/ai-issues-overview.md`）。
 *
 * **为什么单独成类**：Node `child_process.spawn` 拿到不存在的 cwd 时，抛的是
 * **误导性**的 `spawn <shell> ENOENT`——`error.path` 指向 shell（如 `/bin/zsh`），
 * 真因却是 cwd 不在；而且这个 ENOENT 走**异步** `error` 事件，会被当成
 * 「命令 completed、exit 1、stdout 里塞着 cryptic 错误」，让上层 LLM 误判成
 * 「shell 缺失」、改用 `/bin/bash` 撞安全红线，整条死路（正是 RT-2 现场）。
 *
 * 本类在 spawn **前同步**抛出，让 ShellCap 能 duck-type 它的 `code`
 * （跨包 `instanceof` 不可靠）映射成既有 `cwd_not_found` envelope + 明确 hint，
 * 把「工作目录没了」如实告诉用户，而不是把锅甩给 shell。
 */
export class ExecutionRootUnreachableError extends Error {
  /** duck-typing 识别码（下游按 `code` 判定，不用 `instanceof`）。 */
  readonly code = 'EXECUTION_ROOT_UNREACHABLE' as const;
  constructor(
    readonly cwd: string,
    readonly reason: 'missing' | 'not_a_directory',
    cause?: unknown,
  ) {
    super(
      reason === 'not_a_directory'
        ? `Execution root is not a directory: ${cwd}`
        : `Execution root does not exist: ${cwd}`,
    );
    this.name = 'ExecutionRootUnreachableError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * spawn 前同步校验执行根可达性（RT-2）。
 *
 * 只在调用方**显式传了 cwd**（即 Agent 的 `workspaceRoot`）时校验——cwd 省略时
 * 回落 `process.cwd()`（宿主进程目录，恒有效），不在本检查范围。
 *
 * 不存在 → `reason: 'missing'`；存在但不是目录 → `reason: 'not_a_directory'`。
 * 任一不可达即抛 `ExecutionRootUnreachableError`，避免把无效 cwd 喂给 `spawn`
 * 触发误导性的 `spawn <shell> ENOENT`。
 */
function assertExecutionRootReachable(cwd: string | undefined): void {
  if (!cwd) return;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch (err) {
    throw new ExecutionRootUnreachableError(cwd, 'missing', err);
  }
  if (!stat.isDirectory()) {
    throw new ExecutionRootUnreachableError(cwd, 'not_a_directory');
  }
}

export function spawnAgentShellProcess(options: AgentShellProcessOptions): AgentShellProcessHandle {
  // RT-2：spawn 前同步校验执行根可达，避免把不存在的 cwd 喂给 child_process.spawn
  // 触发误导性的 `spawn <shell> ENOENT`（见 ExecutionRootUnreachableError JSDoc）。
  assertExecutionRootReachable(options.cwd);
  const startedAt = Date.now();
  const cwd = resolveWorkingDirectory(options.cwd);
  const shell = resolveShell();
  const cwdFilePath = buildCwdProbePath();
  const outputFilePath = buildOutputFilePath();
  let outputFileStream: fs.WriteStream | null = outputFilePath
    ? fs.createWriteStream(outputFilePath, { flags: 'a' })
    : null;
  const spawnCommand = getSpawnCommand(shell, options.command, cwdFilePath, options.statusFilePath);
  const maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;

  let child: ChildProcess;
  let timedOut = false;
  let killed = false;
  let settled = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let abortListener: (() => void) | null = null;
  // RT-6：保留原始字节（截断到 maxResultBytes 上限），到 finish 再整段解码——
  // 整段解码才能正确处理多字节字符跨 chunk 边界 + UTF-8/OEM 编码自动判别。
  const outputChunks: Buffer[] = [];
  let capturedBytes = 0;
  let outputBytes = 0;
  let truncated = false;
  let outputFileDegraded = !outputFilePath;
  let outputFileBackpressured = false;
  // 退出滞后判读用（仅探针开启时有意义）：记录三个关键时刻的相对 spawn 毫秒差，
  // 在 result resolve 时算出 exitLag / flushLag 并给 verdict。
  let exitEventDeltaMs: number | null = null;
  let sidecarDeltaMs: number | null = null;
  let closeEventDeltaMs: number | null = null;

  const resumeOutputStreams = () => {
    if (!outputFileBackpressured) return;
    outputFileBackpressured = false;
    child.stdout?.resume();
    child.stderr?.resume();
  };

  const degradeOutputFile = () => {
    outputFileDegraded = true;
    outputFileStream = null;
    resumeOutputStreams();
  };

  const maybePauseForOutputFile = (stream: fs.WriteStream, accepted: boolean) => {
    if (accepted || outputFileBackpressured) return;
    outputFileBackpressured = true;
    child.stdout?.pause();
    child.stderr?.pause();
    stream.once('drain', resumeOutputStreams);
  };

  const appendOutput = (chunk: Buffer | string) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    const chunkBytes = buf.length;
    if (!outputFileDegraded && outputFileStream) {
      maybePauseForOutputFile(outputFileStream, outputFileStream.write(buf));
    }
    outputBytes += chunkBytes;
    if (!truncated) {
      const remaining = maxResultBytes - capturedBytes;
      if (chunkBytes > remaining) {
        if (remaining > 0) {
          outputChunks.push(buf.subarray(0, remaining));
          capturedBytes += remaining;
        }
        truncated = true;
      } else {
        outputChunks.push(buf);
        capturedBytes += chunkBytes;
      }
    }
    // 流式回调按 chunk best-effort 解码（边界切分仅致 live 视图偶发瞬时乱码；
    // 返回给 LLM 的 result.output 在 finish 整段解码、保证最终正确）。
    if (options.onOutput) options.onOutput(toTerminal(decodeChildOutput(buf)));
  };

  const clearTimers = () => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    timeoutTimer = null;
    forceKillTimer = null;
  };

  const killProcess = (signal?: AgentKillSignal) => {
    if (!child || settled) return;
    killed = true;
    const nodeSignal = mapKillSignal(signal);
    killChildProcessTree(child, nodeSignal);
    if (nodeSignal !== 'SIGKILL') {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      forceKillTimer = setTimeout(() => {
        killChildProcessTree(child, 'SIGKILL');
      }, DEFAULT_FORCE_KILL_AFTER_MS);
    }
  };

  if (options.signal?.aborted) {
    throw new AbortError('Agent shell process signal already aborted');
  }

  // 2026-05-18 review P0-8 / 上线必修：detached 按 host 显式传值。
  // 缺省 = 旧行为（非 Win 平台 true），但 ShellCap / bridge 应显式区分：
  //   - Electron Unix 端传 true（PTY fd 关联兜底 + 进程组 kill）
  //   - Electron Windows 端传 false（避免弹出独立控制台窗口）
  //   - Daemon 传 false（避免 Daemon 退出后子进程变孤儿）
  const detachedValue = options.detached ?? (process.platform !== 'win32');
  child = spawn(spawnCommand.file, spawnCommand.args, {
    cwd,
    env: buildEnv(options.env),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: detachedValue,
    windowsHide: true,
  });

  const timingProbe = createExitTimingProbe(startedAt, () => child.pid);
  if (timingProbe.enabled) {
    // payload 构造（含 command.slice）只在开启时做，保证关闭时真零开销。
    timingProbe.log('spawn', {
      shell: spawnCommand.file,
      detached: detachedValue,
      hasStatusFile: Boolean(options.statusFilePath),
      outputFilePath,
      commandHead: options.command.slice(0, 120),
    });
    // `close` 仅作诊断观测（runner 行为仍以 `exit` 为准）：若 `exit` 准时但
    // `close` 晚到约 60s，说明 stdio 被孙进程占住（管道/login shell 后台进程）。
    child.once('close', (code, signal) => {
      closeEventDeltaMs = Date.now() - startedAt;
      timingProbe.log('child.close', { code, signal });
    });
  }

  outputFileStream?.on('error', degradeOutputFile);
  child.stdout?.on('data', appendOutput);
  child.stderr?.on('data', appendOutput);

  if (options.enforceTimeout !== false && options.timeoutMs && options.timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killProcess('SIGTERM');
    }, options.timeoutMs);
  }

  if (options.signal) {
    abortListener = () => killProcess('SIGTERM');
    options.signal.addEventListener('abort', abortListener, { once: true });
  }

  const result = new Promise<AgentShellProcessResult>((resolve) => {
    const resolveAfterOutputFileFlush = (result: Omit<AgentShellProcessResult, 'outputFilePath' | 'outputFileSize'>) => {
      const finalize = () => {
        let outputFileSize: number | undefined;
        if (!outputFileDegraded && outputFilePath) {
          try {
            outputFileSize = fs.statSync(outputFilePath).size;
          } catch {
            outputFileDegraded = true;
          }
        }
        // result promise 最终 resolve 时刻——与 `child.exit` 的 `t+` 一对照即知
        // 「exit 到 resolve 之间」是否被 flush 卡住约 60s。
        const resolveDeltaMs = Date.now() - startedAt;
        timingProbe.log('result.resolve', {
          durationMs: result.durationMs,
          resolveDeltaMs,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          killed: result.killed,
          outputFileSize,
          outputFileDegraded,
        });
        // **给非技术用户的一行判读**：把三个时刻折算成 exitLag / flushLag 并给 verdict。
        // 阈值 5s：本 bug 的滞后量级约 60s，远超 5s；正常路径只有几十 ms。
        if (timingProbe.enabled) {
          const LAG_THRESHOLD_MS = 5_000;
          const exitLagMs =
            sidecarDeltaMs != null && exitEventDeltaMs != null
              ? exitEventDeltaMs - sidecarDeltaMs
              : null;
          const flushLagMs =
            exitEventDeltaMs != null ? resolveDeltaMs - exitEventDeltaMs : null;
          let verdict: string;
          if (exitLagMs != null && exitLagMs >= LAG_THRESHOLD_MS) {
            verdict = 'exit-late: child.exit 事件比子进程真实退出晚到（卡在 exit/close 观测）';
          } else if (flushLagMs != null && flushLagMs >= LAG_THRESHOLD_MS) {
            verdict = 'flush-late: exit 事件已到，但 flush/resolve 卡住';
          } else {
            verdict =
              sidecarDeltaMs == null
                ? 'prompt?: runner 无明显滞后（无 sidecar，无法证实 exit-late；若仍 running 看下游 poll 层）'
                : 'prompt: runner 无明显滞后（若命令仍显示 running，滞后在 runner 下游 poll 层）';
          }
          timingProbe.log('result.verdict', {
            verdict,
            sidecarMtimeDeltaMs: sidecarDeltaMs,
            exitEventDeltaMs,
            closeEventDeltaMs,
            resolveDeltaMs,
            exitLagMs,
            flushLagMs,
          });
        }
        resolve({
          ...result,
          ...(outputFileDegraded || !outputFilePath
            ? {}
            : {
                outputFilePath,
                outputFileSize,
              }),
        });
      };

      const stream = outputFileStream;
      outputFileStream = null;
      if (!stream) {
        timingProbe.log('outputFile.flush.skip', { reason: 'no-stream' });
        finalize();
        return;
      }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        timingProbe.log('outputFile.flush.finish');
        finalize();
      };
      stream.once('finish', finish);
      stream.once('error', () => {
        outputFileDegraded = true;
        resumeOutputStreams();
        timingProbe.log('outputFile.flush.error');
        finish();
      });
      timingProbe.log('outputFile.flush.start', {
        backpressured: outputFileBackpressured,
        degraded: outputFileDegraded,
      });
      stream.end();
    };

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (options.signal && abortListener) {
        options.signal.removeEventListener('abort', abortListener);
      }
      // RT-6：整段解码累积的原始字节（UTF-8 优先 / OEM 回退），避免逐 chunk 解码
      // 把多字节字符切坏，并正确处理中文等非 UTF-8 控制台输出。
      let output = decodeChildOutput(Buffer.concat(outputChunks));
      if (truncated) {
        output += '\n...[output truncated by TabTin process runner]';
      }
      resolveAfterOutputFileFlush({
        output,
        exitCode: timedOut || killed ? null : exitCode,
        cwd: readCwdProbe(cwdFilePath, cwd),
        durationMs: Date.now() - startedAt,
        timedOut,
        killed,
        outputBytes,
        truncated,
      });
    };

    child.once('exit', (code, signal) => {
      // bridge 观测到退出的时刻。observeSidecar 同步读 `.status` mtime（子进程
      // 真实退出时刻），两者 `t+` 一比即知 exit 事件本身是否晚到约 60s。
      exitEventDeltaMs = Date.now() - startedAt;
      timingProbe.log('child.exit', { code, signal });
      sidecarDeltaMs = timingProbe.observeSidecar(options.statusFilePath);
      const exitCode = code ?? (signal ? 1 : 0);
      finish(exitCode);
    });
    child.once('error', (err) => {
      timingProbe.log('child.error', { error: err instanceof Error ? err.message : String(err) });
      appendOutput(`${err instanceof Error ? err.message : String(err)}\n`);
      finish(1);
    });
  });

  return {
    get pid() {
      return child.pid;
    },
    result,
    kill: killProcess,
  };
}

class AbortError extends Error {
  override readonly name = 'AbortError';
}
