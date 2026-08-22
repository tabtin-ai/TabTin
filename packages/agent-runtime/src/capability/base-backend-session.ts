/**
 * BaseBackendSession 抽象基类（厚基类 + 薄子类）—— M1 §3.2.2。
 *
 * **设计哲学**：
 *   - 子类只需实现 6 个抽象方法即可拥有完整 BackendSession 能力：
 *     `exec / read / write / running / persistWorkspace / hydrateWorkspace`
 *   - 基类基于 `exec` 组合提供 `ls / mkdir / rm / exists / apply_patch / extract`
 *   - Native Backend 可 override 这些组合方法用 `fs.promises` 拿性能；
 *     LocalVM / Cloud 用基类默认（一次 exec 代替一次独立 IPC），减少
 *     90% 的 per-session 代码量
 *
 * **职责边界**（M1 §2.3）：
 *   - 做：执行原生操作 + 关卡 1 地板（env-sanitize + 高危命令识别）
 *   - 不做：路径翻译 / 可见性校验 / HITL 审批 / 行为观察
 *
 * **persistWorkspace / hydrateWorkspace 在 Native 中的处理**：M2
 * NativeBackendSession 不需要持久化（家目录就是宿主磁盘），可以用
 * "throw new Error('not supported')" 占位实现 + capabilities.supportsPersistence = false，
 * 让 Capability 用能力标记决策"是否调用"。
 */

import type {
  AgentHomeLayout,
  BackendSession,
  BackendSessionCapabilities,
  BackendType,
  ExecOptions,
  ExecResult,
  FileStat,
  InteractiveSession,
  SessionPersistState,
} from './backend-session.js';
import type { Manifest } from './manifest.js';

/**
 * POSIX shell 单引号转义 —— 把任意字符串包成 shell 安全的单引号字面量。
 *
 * 实现细节：单引号内不能转义任何字符，所以 `it's` 要变成
 * `'it'\''s'`（结束引号 → 转义单引号 → 重新开引号）。
 *
 * **生产注意**：本函数对路径足够安全，但**不要用于命令拼接**（命令
 * 拼接应该用 child_process spawn 的 args 数组，不走 shell）。
 */
export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * 抽象基类。子类必须 implements `BackendSession` 并 extends 本基类，
 * 实现 6 个抽象方法即可。
 */
export abstract class BaseBackendSession implements BackendSession {
  abstract readonly sessionId: string;
  abstract readonly backendType: BackendType;
  abstract readonly capabilities: BackendSessionCapabilities;
  abstract readonly agentHome: AgentHomeLayout;
  /** Native 默认 undefined；LocalVM / Cloud 在 constructor 里赋值 */
  readonly manifest?: Manifest;

  // ── 6 个抽象方法（子类必须实现）──────────────────────────────────

  /**
   * 执行命令并等待退出。
   *
   * **关卡 1 地板**（子类必须保证）：env-sanitize + 高危命令识别。
   * Native：直接调 CommandExecutor.executeStreaming 即可（已内嵌）。
   */
  abstract exec(command: string, opts?: ExecOptions): Promise<ExecResult>;

  /**
   * 读取文件全部内容为 Buffer。
   *
   * **Native**：fs.promises.readFile(path)
   * **LocalVM / Cloud**：通过控制通道（9p / HTTP / IPC）读
   *
   * 大文件场景：调用方应自行做流式读取（M1 不约束）。
   */
  abstract read(path: string): Promise<Buffer>;

  /**
   * 写入文件全部内容（覆盖）。父目录不存在会失败 —— 调用方负责先 mkdir。
   *
   * 如果传入字符串，按 utf-8 编码（与 fs.promises.writeFile 默认行为一致）。
   */
  abstract write(path: string, data: Buffer | string): Promise<void>;

  /** session 是否仍在运行（Cloud 可能因 hibernate / VM crash 等返回 false） */
  abstract running(): Promise<boolean>;

  /**
   * 把 workspace 序列化成可重建的状态（M3 / M4 实现）。
   *
   * **Native** 不需要持久化（家目录就是宿主磁盘）。M2 NativeBackendSession
   * 应抛 `Error('persistence not supported on native backend')` 并设置
   * `capabilities.supportsPersistence = false`，调用方用能力标记决策。
   */
  abstract persistWorkspace(): Promise<SessionPersistState>;

  /**
   * 从持久化状态恢复 workspace（M3 / M4 实现）。
   * Native 同 persistWorkspace，应抛 not supported。
   */
  abstract hydrateWorkspace(state: SessionPersistState): Promise<void>;

  // ── 基类组合实现（子类可 override 优化）──────────────────────────

  /**
   * 列目录条目名（**不含** `.` 与 `..`）。
   *
   * 默认基于 `ls -1a` exec 实现 —— LocalVM / Cloud 一次 exec 代替一次
   * 独立 IPC。Native 可 override 用 `fs.promises.readdir` 拿性能。
   */
  async ls(path: string): Promise<string[]> {
    const result = await this.exec(`ls -1a ${shellEscape(path)}`);
    if (result.exitCode !== 0) {
      throw new Error(`ls failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    return result.stdout
      .split('\n')
      .map((s) => s.replace(/\r$/, ''))
      .filter((s) => s.length > 0 && s !== '.' && s !== '..');
  }

  /**
   * 创建目录。`recursive: true` 等价于 `mkdir -p`（默认 false）。
   *
   * 默认 exec 实现；Native 可 override 用 `fs.promises.mkdir`。
   */
  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    const flag = opts?.recursive ? '-p ' : '';
    const result = await this.exec(`mkdir ${flag}${shellEscape(path)}`);
    if (result.exitCode !== 0) {
      throw new Error(`mkdir failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
  }

  /**
   * 删除文件 / 目录。
   *
   * - `recursive: true` → `-r`
   * - `force: true` → `-f`（不存在时不抛错）
   *
   * **force 语义**：force=true 时**任何**非零退出码都不抛错 —— 包括
   * "不存在"（GNU rm -f 行为）以及"权限失败 / 设备占用"等真实失败。
   * 调用方语义应是"best-effort 清理"。**如需区分"真失败"，请改用
   * `exists() + rm({ force: false })` 模式**，或在调用前后用 stat 验证。
   */
  async rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void> {
    // 空格分隔多个 short option（'-r -f'）—— 比合并形式（'-rf'）跨工具
    // 兼容性更好（busybox / 嵌入式 sh 也接受），且日志可读性高。
    const flags: string[] = [];
    if (opts?.recursive) flags.push('-r');
    if (opts?.force) flags.push('-f');
    const flagStr = flags.length > 0 ? `${flags.join(' ')} ` : '';
    const result = await this.exec(`rm ${flagStr}${shellEscape(path)}`);
    if (result.exitCode !== 0 && !opts?.force) {
      throw new Error(`rm failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
  }

  /**
   * 路径是否存在（文件 / 目录均可）。
   *
   * 默认基于 `test -e`（POSIX 标准）；Native 可 override 用 `fs.promises.access`。
   */
  async exists(path: string): Promise<boolean> {
    const result = await this.exec(`test -e ${shellEscape(path)}`);
    return result.exitCode === 0;
  }

  // ── 默认生命周期（子类可 override）────────────────────────────────

  /**
   * 主动关闭并释放资源。基类无状态默认实现 —— 子类有资源（PTY 池、
   * IPC 连接、Cloud session 句柄）应 override 做清理。
   *
   * **幂等约定**：可被多次调用而不抛错（与 GC、shutdown hook 配合用）。
   */
  async shutdown(): Promise<void> {
    // 基类默认无资源；子类按需 override
  }

  // ── Optional：默认不实现（保留 undefined） ──────────────────────────
  // stat?(path) / execInteractive?(...) 由子类按 capabilities 选择性实现；
  // 不在基类预占位避免出现"看似已实现实际是 stub"的误导。

  // ── 共用组合工具：基类提供，子类复用 ──────────────────────────────

  /**
   * apply_patch —— 应用 unified diff 补丁到一个文件。
   *
   * **重要：本方法不在 BackendSession interface 契约中**（仅 BaseBackendSession
   * 提供）。原因：Cloud Backend 可能用 ACS 的 patch API 而非本地 diff，
   * 强行入接口会造成"假实现"。Capability tool handler 想用 apply_patch
   * 应在 handler 内部断言 session instanceof BaseBackendSession，或自己
   * 组合 read + diff + write。
   *
   * **M1 范围**：基础 unified-diff 解析 + 写回。**不支持**：
   *   - 多文件 patch（git apply 全格式）
   *   - binary diff
   *   - git extended headers（rename / mode change）
   *   - hunk 之间的 git 元数据
   *   M5 / M6 / M8 按需扩展或替换为 `git apply` 子进程实现。
   *
   * **算法**：
   *   1. read(path) 拿原文
   *   2. 按 patch hunk 一段一段定位 + 替换
   *   3. write(path, newContent) 写回
   *
   * **错误**：patch 与原文不匹配 → 抛 Error，包含定位信息。
   */
  async apply_patch(path: string, patch: string): Promise<void> {
    const original = (await this.read(path)).toString('utf8');
    const patched = applyUnifiedDiff(original, patch);
    await this.write(path, patched);
  }

  /**
   * extract —— 从 tar/zip 文件解压到 destDir。
   *
   * 默认基于 `tar -xf` 组合实现（自动识别 .tar / .tar.gz / .tgz）；
   * .zip 文件需要子类 override 或调用方显式用 unzip。
   */
  async extract(archivePath: string, destDir: string): Promise<void> {
    await this.mkdir(destDir, { recursive: true });
    const result = await this.exec(
      `tar -xf ${shellEscape(archivePath)} -C ${shellEscape(destDir)}`,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `extract failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
  }

  // ── stat / execInteractive 是 optional，让子类自己声明 ─────────────
  /**
   * Optional 占位 —— 子类如果支持 stat 应在 class 体显式声明：
   *
   * ```ts
   * async stat(path: string): Promise<FileStat> { ... }
   * ```
   *
   * 基类不预占位 method，避免出现"基类返回 undefined 但接口标 required"。
   */
  stat?(path: string): Promise<FileStat>;

  /**
   * Optional 占位 —— PTY 交互式 session（capabilities.supportsInteractive
   * = true 的 Backend 才实现）。
   */
  execInteractive?(command: string, opts?: ExecOptions): Promise<InteractiveSession>;
}

/**
 * 极简 unified-diff 应用器 —— 仅服务于 BaseBackendSession.apply_patch
 * 的 M1 默认实现。
 *
 * **支持**：单文件 unified-diff 的 `@@ -a,b +c,d @@` 块格式。
 * **不支持**：multi-file patch、binary diff、git extended headers。
 *
 * 找不到 hunk 上下文 → 抛错。
 */
function applyUnifiedDiff(original: string, patch: string): string {
  const origLines = original.split('\n');
  const patchLines = patch.split('\n');
  let result = origLines.slice();

  let i = 0;
  // 跳过文件头（--- / +++）
  while (i < patchLines.length && !patchLines[i].startsWith('@@')) {
    i++;
  }

  // 累积 hunk 偏移（删除 / 新增行数差）
  let hunkOffset = 0;

  while (i < patchLines.length) {
    const hunkHeader = patchLines[i];
    const m = hunkHeader.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!m) {
      i++;
      continue;
    }
    const origStart = parseInt(m[1], 10);
    const origCount = m[2] !== undefined ? parseInt(m[2], 10) : 1;
    i++;

    // 收集本 hunk 的 body
    const body: string[] = [];
    while (i < patchLines.length && !patchLines[i].startsWith('@@')) {
      body.push(patchLines[i]);
      i++;
    }

    // 在原文 origStart-1 + hunkOffset 位置应用 hunk
    const insertAt = origStart - 1 + hunkOffset;
    const remove: string[] = [];
    const add: string[] = [];
    for (const line of body) {
      if (line.startsWith('-')) {
        remove.push(line.slice(1));
      } else if (line.startsWith('+')) {
        add.push(line.slice(1));
      } else if (line.startsWith(' ')) {
        const ctx = line.slice(1);
        remove.push(ctx);
        add.push(ctx);
      }
      // '\\' (no newline at eof) 忽略
    }

    // 验证 remove 与原文匹配
    for (let k = 0; k < remove.length; k++) {
      if (result[insertAt + k] !== remove[k]) {
        throw new Error(
          `apply_patch: hunk context mismatch at line ${insertAt + k + 1}: ` +
            `expected "${remove[k]}", got "${result[insertAt + k]}"`,
        );
      }
    }

    result = result
      .slice(0, insertAt)
      .concat(add, result.slice(insertAt + remove.length));

    hunkOffset += add.length - origCount;
  }

  return result.join('\n');
}
