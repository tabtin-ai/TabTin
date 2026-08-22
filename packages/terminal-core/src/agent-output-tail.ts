/**
 * Agent Output Tail — bridge 层「持续写盘」+ GC 共用实现（WP2 落地）。
 *
 * **业务定位**：`PtyManagerBridge.spawnAgentSessionDetached` 把 PTY 输出
 * 持续 tail 到一份磁盘副本（路径 `{tmpdir}/tabtin-agent-tasks/{sessionId}.log`），
 * 让本地 LLM 走 `read_file` 工具就能拉 background 命令进度，不必为它
 * 单独发明 `read_terminal_output` 等新工具（参见 agent-bridge.ts L320-357 JSDoc）。
 *
 * **为什么放共享 helper**：Electron / Daemon 两端 bridge 行为必须一致，
 * 写盘 / GC 策略由两端各自实现意味着双源——本文件让两端 import 同一份，
 * 避免漂移（与 `packages/pty-core` 中 PtySessionStore / PtyCommandRunner 共享
 * 模式一致）。
 *
 * **磁盘 GC 策略**（agent-bridge.ts JSDoc L341-353 硬契约）：
 *   - 单文件上限 100MB：超出 → truncate 头部、保留尾部 50MB
 *     （LLM 看 background 命令的"最近输出"才有意义）
 *   - 老文件 7 天过期 → 删除
 *   - 调用方决定何时跑 `runAgentOutputTailGC`（推荐：PtyManager 启动时跑一次）
 *
 * **路径 realpath 兜底**（agent-bridge.ts JSDoc L350-353 硬契约）：
 *   返回 `outputFilePath` 前先做 `fs.realpathSync`，把 macOS
 *   `/var/folders/...` → `/private/var/folders/...` 等 symlink 形态展平。
 *   与 `packages/agent-runtime/src/tools/read-file-state.ts` 中
 *   `canonicalizePath` 行为对齐（同款 try realpath → catch 父目录 realpath
 *   + basename fallback），保证 LLM 后续 `read_file` dedup key 命中。
 *
 * **不再二次 realpath**：ShellCap 拿到 outputFilePath 后**不需要**自己
 * canonicalize——责任前移到 bridge 单点。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ==================== Constants ====================

/** GC 策略：单文件磁盘上限 100MB（超出 truncate 头部）。 */
export const AGENT_OUTPUT_TAIL_MAX_FILE_BYTES = 100 * 1024 * 1024;

/** GC 截断后保留尾部字节数（LLM 关心的是最近输出）。 */
export const AGENT_OUTPUT_TAIL_KEEP_BYTES = 50 * 1024 * 1024;

/** GC 策略：老文件 7 天过期。 */
export const AGENT_OUTPUT_TAIL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** 共享子目录名（不带 tmpdir 前缀）。 */
const AGENT_OUTPUT_DIR_NAME = 'tabtin-agent-tasks';

// ==================== Path Helpers ====================

/**
 * 拼出 agent task 写盘的目录绝对路径（不创建，仅返回字符串）。
 *
 * @param tmpdir 测试用 override，缺省取 `os.tmpdir()`。
 */
export function tabtinAgentTasksDir(tmpdir?: string): string {
  return path.join(tmpdir ?? os.tmpdir(), AGENT_OUTPUT_DIR_NAME);
}

/**
 * 单 session 的写盘文件路径（不创建文件，仅返回字符串）。
 * 路径形态见 agent-bridge.ts L331。
 */
export function tabtinAgentTaskLogPath(sessionId: string, tmpdir?: string): string {
  return path.join(tabtinAgentTasksDir(tmpdir), `${sessionId}.log`);
}

/**
 * 单 session 的 Layer 2 退出码 sidecar 文件路径（与 `.log` **同目录、同 basename**，
 * 仅扩展名换成 `.status`）。
 *
 * 终端假运行根治 v3 / 治 F9（host 崩溃兜底）：detached 后台命令 spawn 时，bridge 用
 * 本 helper 分配 statusfile 路径，传给 `spawnAgentShellProcess({ statusFilePath })`——
 * shell 进程退出前 `echo $? > <path>` 落退出码盘；host 崩溃 / `kill -9` 后启动对账
 * 读它恢复真实退出码（缺失 / 损坏 → 诚实标 unknown）。
 *
 * **不创建文件**——仅返回路径字符串（由 shell 进程写入）。
 */
export function tabtinAgentTaskStatusPath(sessionId: string, tmpdir?: string): string {
  return path.join(tabtinAgentTasksDir(tmpdir), `${sessionId}.status`);
}

/**
 * 同 `read-file-state.ts:canonicalizePath` 的轻量版本：try realpath →
 * catch 父目录 realpath + basename。本 helper 不展开 `~`，因为 bridge
 * 自产的路径永远是 `{tmpdir}/...` 形式，不会带家目录前缀。
 */
function realpathBestEffort(abs: string): string {
  try {
    return fs.realpathSync(abs);
  } catch {
    try {
      const parent = fs.realpathSync(path.dirname(abs));
      return path.join(parent, path.basename(abs));
    } catch {
      return abs;
    }
  }
}

// ==================== Tail Writer ====================

/**
 * 单 session 写盘句柄。
 *
 * **生命周期**：
 *   1. `AgentOutputTail.create(sessionId)` —— 同步建文件 + realpath
 *   2. PTY onData 回调里调 `tail.write(chunk)` —— 异步 append，内部 backpressure
 *   3. session cleanup 时调 `tail.close()` —— flush + close fd，**不删除文件**
 *
 * **错误恢复**：
 *   - write stream 报 'error'（磁盘满 / EACCES / EIO 等）→ 标记降级，
 *     后续 write 静默 no-op；session 继续跑命令不崩
 *   - logger 回调（可选）记录降级原因
 *
 * **不变量**：
 *   - 不实现"自截断"——单文件 100MB 限制由 `runAgentOutputTailGC`
 *     启动时统一处理；运行时持续 write 不会主动判断大小（避免每次
 *     write 都 stat 文件的开销）
 *   - `getFilePath()` 在 `create()` 完成后立即可用，且返回的路径**已经
 *     是 realpath 形态**（macOS `/var` → `/private/var` 已展平）
 */
/**
 * P1-G 运行时检查频率：每 N 次 write 调一次 stat 检查文件大小；超阈值 truncate。
 * 256 个 chunk 间隔在 PTY 输出场景约几 KB 到几 MB 之间触发一次 stat，开销可控。
 */
const RUNTIME_SIZE_CHECK_INTERVAL = 256;

export class AgentOutputTail {
  private stream: fs.WriteStream | null;
  private degraded = false;
  private writeCounter = 0;
  /** P1-G：累计写入字节数（粗估，用于 trigger stat 检查频率，不要求精确）。 */
  private estimatedBytes = 0;
  private readonly logger?: AgentOutputTailLogger;

  private constructor(
    private readonly realPath: string,
    stream: fs.WriteStream | null,
    logger?: AgentOutputTailLogger,
    private readonly maxFileBytes: number = AGENT_OUTPUT_TAIL_MAX_FILE_BYTES,
    private readonly keepBytes: number = AGENT_OUTPUT_TAIL_KEEP_BYTES,
  ) {
    this.stream = stream;
    this.logger = logger;
    if (stream) {
      stream.on('error', (err) => {
        this.degraded = true;
        this.logger?.warn(
          `[AgentOutputTail] write stream error for ${path.basename(this.realPath)}: ${err.message}`,
        );
        try {
          stream.end();
        } catch {
          /* best-effort */
        }
        this.stream = null;
      });
    }
  }

  /**
   * 创建一个新的 tail writer。**同步**完成目录创建 + 文件创建 +
   * realpath，让 bridge 能立即拿到稳定的 `outputFilePath` 字段。
   *
   * 错误路径：
   *   - 目录创建失败 / 文件创建失败 → throw（让 bridge 自己决定怎么处理）
   *   - realpath 失败 → fallback 到原路径（不 throw）
   */
  static create(
    sessionId: string,
    options?: {
      tmpdir?: string;
      logger?: AgentOutputTailLogger;
    },
  ): AgentOutputTail {
    const dir = tabtinAgentTasksDir(options?.tmpdir);
    fs.mkdirSync(dir, { recursive: true });

    const filePath = path.join(dir, `${sessionId}.log`);

    // **同步建文件**（'a' flag：不存在则创建、存在则追加）—— Node
    // `fs.createWriteStream` 的 open 是 async，realpathSync 紧接调用会
    // race 拿到 ENOENT；这里先 openSync+closeSync 物理 create 空文件，
    // 再让 createWriteStream 接管 append。这样 realpath 一定能拿到真路径。
    try {
      fs.closeSync(fs.openSync(filePath, 'a'));
    } catch (err) {
      options?.logger?.warn(
        `[AgentOutputTail] failed to ensure file exists for ${sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // 文件创建失败 → 降级：用字面路径返回（不 throw 让 bridge 继续跑命令）
      return new AgentOutputTail(filePath, null, options?.logger);
    }

    let stream: fs.WriteStream | null = null;
    try {
      stream = fs.createWriteStream(filePath, { flags: 'a' });
    } catch (err) {
      options?.logger?.warn(
        `[AgentOutputTail] failed to open write stream for ${sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      stream = null;
    }

    // realpath 兜底：现在文件已物理存在（上面 openSync 同步创建），可安全
    // 解析 symlink；理论上仍可能因极端 race（被其他进程 unlink）失败，
    // realpathBestEffort 自带 catch 兜底到父目录 realpath + basename。
    const realPath = realpathBestEffort(filePath);

    return new AgentOutputTail(realPath, stream, options?.logger);
  }

  /**
   * 返回 LLM read_file 用的绝对路径（已 realpath 兜底）。
   *
   * **bridge 实现层把本方法的返回值填进 `AgentSpawnDetachedResult.outputFilePath`**
   * 字段。
   */
  getFilePath(): string {
    return this.realPath;
  }

  /**
   * 追加一段 PTY 输出到磁盘。
   *
   * **不变量**：
   *   - 异步 write（依赖 Node WriteStream 内部 backpressure 处理 burst）
   *   - 降级后静默 no-op，不影响 session 持续跑命令
   *   - 不返回 Promise——调用方（PTY onData）是同步 fire-and-forget 语义
   *
   * **P1-G 运行时大小检查**：每 RUNTIME_SIZE_CHECK_INTERVAL 次 write 调一次
   * stat；超 maxFileBytes 触发 close + truncate 头部 + 重新 open append——避免
   * "GC 只在启动跑、长跑 session 文件无限增长"的虚假承诺。
   */
  write(data: string): void {
    if (this.degraded || !this.stream) return;
    try {
      this.stream.write(data);
      this.estimatedBytes += Buffer.byteLength(data, 'utf-8');
      this.writeCounter++;
      // 周期检查避免 stat 开销；阈值跨越触发 truncate
      if (this.writeCounter >= RUNTIME_SIZE_CHECK_INTERVAL) {
        this.writeCounter = 0;
        if (this.estimatedBytes >= this.maxFileBytes) {
          // fire-and-forget 异步 truncate（不阻塞 write）
          void this.runtimeTruncateIfOversized().catch((err) => {
            this.logger?.warn(
              `[AgentOutputTail] runtime truncate failed for ${path.basename(this.realPath)}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
        }
      }
    } catch (err) {
      // write 同步抛错（通常 ERR_STREAM_DESTROYED 等）→ 走降级路径
      this.degraded = true;
      this.logger?.warn(
        `[AgentOutputTail] write threw for ${path.basename(this.realPath)}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      try {
        this.stream.end();
      } catch {
        /* best-effort */
      }
      this.stream = null;
    }
  }

  /**
   * P1-G 运行时 truncate：close stream → truncate 头部 → 重 open append。
   * 期间到达的 write 走 stream=null 路径短暂丢失（极少数 chunk），换来文件
   * 不无限增长。**Race**：本函数执行期间 stream 暂时为 null，调用方继续 write
   * 会 no-op；可接受（vs OOM / 撑爆磁盘）。
   */
  private async runtimeTruncateIfOversized(): Promise<void> {
    const oldStream = this.stream;
    this.stream = null;
    if (oldStream) {
      await new Promise<void>((resolve) => {
        try {
          oldStream.end(() => resolve());
        } catch {
          resolve();
        }
      });
    }

    try {
      const stat = await fs.promises.stat(this.realPath);
      if (stat.size >= this.maxFileBytes) {
        const fh = await fs.promises.open(this.realPath, 'r+');
        try {
          const buf = Buffer.alloc(this.keepBytes);
          const startOffset = stat.size - this.keepBytes;
          const { bytesRead } = await fh.read(buf, 0, this.keepBytes, startOffset);
          if (bytesRead > 0) {
            await fh.truncate(0);
            await fh.write(buf, 0, bytesRead, 0);
          }
        } finally {
          await fh.close();
        }
        this.estimatedBytes = this.keepBytes;
        this.logger?.warn(
          `[AgentOutputTail] runtime truncated ${path.basename(this.realPath)}: kept tail ${this.keepBytes}B / was ${stat.size}B`,
        );
      }
    } catch (err) {
      this.logger?.warn(
        `[AgentOutputTail] runtime truncate stat/read failed for ${path.basename(this.realPath)}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // 重 open append（即便 truncate 失败也尝试 reopen 让后续 write 继续）
    try {
      this.stream = fs.createWriteStream(this.realPath, { flags: 'a' });
      this.stream.on('error', (err) => {
        this.degraded = true;
        this.logger?.warn(
          `[AgentOutputTail] reopen write stream error for ${path.basename(this.realPath)}: ${err.message}`,
        );
        try {
          this.stream?.end();
        } catch {
          /* best-effort */
        }
        this.stream = null;
      });
    } catch (err) {
      this.degraded = true;
      this.logger?.warn(
        `[AgentOutputTail] reopen failed for ${path.basename(this.realPath)}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      this.stream = null;
    }
  }

  /**
   * 关闭写盘 fd（保留磁盘文件——LLM 在 session cleanup 后仍能 read_file）。
   *
   * 幂等：重复 close 安全。
   */
  async close(): Promise<void> {
    const stream = this.stream;
    this.stream = null;
    if (!stream) return;
    return new Promise<void>((resolve) => {
      stream.end(() => resolve());
    });
  }

  /** 测试 / 诊断用：当前是否处于降级状态（磁盘满 / IO 错误后 write 不再 flush）。 */
  isDegraded(): boolean {
    return this.degraded;
  }
}

export interface AgentOutputTailLogger {
  warn(message: string): void;
}

// ==================== GC ====================

export interface AgentOutputTailGCOptions {
  /** 测试 override：缺省取 `os.tmpdir()`。 */
  tmpdir?: string;
  /** 测试 override：缺省 `Date.now()`。 */
  now?: number;
  /** 文件大小上限（字节）；缺省 100MB。 */
  maxFileBytes?: number;
  /** 截断后保留尾部字节数；缺省 50MB。 */
  keepBytes?: number;
  /** 文件年龄上限（毫秒）；缺省 7 天。 */
  maxAgeMs?: number;
  logger?: AgentOutputTailLogger;
}

export interface AgentOutputTailGCResult {
  scannedDir: string;
  /** 由于目录不存在直接 return。 */
  skipped: boolean;
  deletedExpired: string[];
  truncatedOversize: string[];
  errors: Array<{ file: string; message: string }>;
}

/**
 * 扫描 `tabtin-agent-tasks/` 目录跑一轮 GC：
 *   - 老文件（>= maxAgeMs）→ unlink
 *   - 大文件（>= maxFileBytes）→ truncate 头部、保留尾部 keepBytes
 *
 * **设计原则**：
 *   - 静态函数 + 显式 result，便于测试断言"删了哪些 / 截了哪些"
 *   - errors 收集而不 throw——GC 是 best-effort，单文件失败不阻塞其他
 *   - **不会**清理"正在被 AgentOutputTail 持有的 fd"指向的文件——
 *     调用契约是 PtyManager 启动时跑一次（此时上次进程已退出、所有
 *     残留文件无 fd 占用）；运行中绝不调
 *
 * **典型调用点**（bridge 实现层负责）：
 *   - Electron `PtyManager` 构造时（getOrCreateElectronPtyManagerBridge 首次 init）
 *   - Daemon `DaemonPtyManager.initialize()` 成功后
 */
export async function runAgentOutputTailGC(
  options?: AgentOutputTailGCOptions,
): Promise<AgentOutputTailGCResult> {
  const dir = tabtinAgentTasksDir(options?.tmpdir);
  const now = options?.now ?? Date.now();
  const maxFileBytes = options?.maxFileBytes ?? AGENT_OUTPUT_TAIL_MAX_FILE_BYTES;
  const keepBytes = options?.keepBytes ?? AGENT_OUTPUT_TAIL_KEEP_BYTES;
  const maxAgeMs = options?.maxAgeMs ?? AGENT_OUTPUT_TAIL_MAX_AGE_MS;
  const logger = options?.logger;

  const result: AgentOutputTailGCResult = {
    scannedDir: dir,
    skipped: false,
    deletedExpired: [],
    truncatedOversize: [],
    errors: [],
  };

  // 目录不存在 → 安静返回（首次启动 / 测试环境）
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      result.skipped = true;
      return result;
    }
    result.errors.push({
      file: dir,
      message: err instanceof Error ? err.message : String(err),
    });
    return result;
  }

  for (const name of entries) {
    // `.log` = tail 输出；`.status` = Layer 2 退出码 sidecar（治 F9）。两者都按 7 天
    // 过期清理（对称，避免崩溃 + 无 owner / 持久化关闭时 sidecar 永久残留 tmpdir）；
    // 仅 `.log` 还做超大截断（sidecar 是个位/三位数小文件，不需要）。
    const isLog = name.endsWith('.log');
    const isStatus = name.endsWith('.status');
    if (!isLog && !isStatus) continue;
    const filePath = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch (err) {
      result.errors.push({
        file: filePath,
        message: `stat failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    if (!stat.isFile()) continue;

    const age = now - stat.mtimeMs;
    if (age >= maxAgeMs) {
      try {
        await fs.promises.unlink(filePath);
        result.deletedExpired.push(filePath);
      } catch (err) {
        result.errors.push({
          file: filePath,
          message: `unlink failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      continue;
    }

    if (isLog && stat.size >= maxFileBytes) {
      try {
        await truncateHeadKeepTail(filePath, keepBytes);
        result.truncatedOversize.push(filePath);
      } catch (err) {
        result.errors.push({
          file: filePath,
          message: `truncate failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  if (logger && (result.deletedExpired.length > 0 || result.truncatedOversize.length > 0 || result.errors.length > 0)) {
    logger.warn(
      `[AgentOutputTail] GC ran: deleted=${result.deletedExpired.length} truncated=${result.truncatedOversize.length} errors=${result.errors.length}`,
    );
  }

  return result;
}

/**
 * 把一个文件截断到只保留尾部 keepBytes 字节。
 *
 * 策略：
 *   1. open(r+) → 读 tail 到 buffer
 *   2. ftruncate(0) → 清空
 *   3. write(buffer, 0, keepBytes, 0) → 把 tail 重新写到头部
 *
 * 注意：原子性靠 fd 短期持有 + 同进程串行 GC（GC 只在启动时跑一次，
 * 上次进程已退出、没有运行中 fd 持有此文件）。
 */
async function truncateHeadKeepTail(filePath: string, keepBytes: number): Promise<void> {
  const fh = await fs.promises.open(filePath, 'r+');
  try {
    const stat = await fh.stat();
    if (stat.size <= keepBytes) return;
    const buf = Buffer.alloc(keepBytes);
    const startOffset = stat.size - keepBytes;
    const { bytesRead } = await fh.read(buf, 0, keepBytes, startOffset);
    if (bytesRead <= 0) return;
    await fh.truncate(0);
    await fh.write(buf, 0, bytesRead, 0);
  } finally {
    await fh.close();
  }
}
