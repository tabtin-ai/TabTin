/**
 * OS 错误黑名单
 *
 * 当工具返回 terminal=true 的 OS 错误（macOS TCC 拒绝、Windows 杀软拦截、
 * 云盘占位等）后，runtime 把 (path, code) 加入黑名单，避免 Agent 在用户
 * 还没处理时反复重试同一路径浪费 token。
 *
 * 不在工具调用前拦截工具（那会破坏 Agent 推理），仅在工具内部访问该
 * 路径前主动 isBlocked() 检查时短路返回缓存的 OSToolError。
 *
 * ：模型工具 `clear_os_error_blacklist` 已退役，Electron 也不再把
 * 本 store 注入编排层。本模块仅保留给测试与尚未改完的宿主；生产路径
 * 不再写入、不再短路。
 *
 * 注意：宿主应通过 getSharedOSErrorBlacklist(organizationId) 注入 Organization
 * 级共享实例；生命周期仅限当前进程，不跨进程广播，也不做磁盘持久化。
 * 如果宿主无法从认证上下文确认 organizationId，必须使用独立实例，不能落到
 * 全局公共桶。
 */

export interface OSErrorBlacklistEntry {
  /**
   * 内部索引键：path 维度调用时是真实路径；toolCall 维度调用时是
   * `__tool__:<toolName>:<inputHash>` 合成键。
   *
   * 历史问题：早期版本 `clear(path)` 仅按本字段匹配，对 toolCall 维度
   * 写入的条目永远 0 命中（合成键 ≠ 真实路径）→ Agent 调
   * `clear_os_error_blacklist({path})` 后短路依然命中（"清完了
   * 还短路"），造成"用户授权后 Agent 仍说没权限"的死循环。修复后增加
   * `originalPath` 字段，并由 `clearByOriginalPath(path)` 专门处理 toolCall
   * 维度的真实路径解封。
   */
  path: string;
  /**
   * 触发该条目时 OSError 携带的真实文件系统路径（如 `/Users/foo/Desktop`）。
   *
   * 在 toolCall 维度写入时（`blockToolCall`）由调用方显式传入，让
   * `clearByOriginalPath(path)` 能按用户/LLM 自然认知的路径解封——而不是
   * 要求 LLM 反算当时的 toolName + input hash。
   *
   * path 维度写入时（`block`）省略此字段，靠 `path` 字段本身就是真实路径。
   */
  originalPath?: string;
  /** OSErrorCode 字符串 —— 这里不强类型依赖 @tabtin/os-errors 以避免循环 */
  code: string;
  blockedAt: number;
  expiresAt: number;
  /** 触发时给 Agent 的 llm_message，命中时短路返回 */
  cachedToolErrorMessage: string;
}

export interface OSErrorBlacklistOptions {
  /**
   * 默认 TTL（毫秒）。undefined / 0 表示当前 store 生命周期内有效。
   * 调用方可在 block() 时按错误码覆盖。
   */
  defaultTtlMs?: number;
}

const sharedOSErrorBlacklistsByOrganization = new Map<string, OSErrorBlacklist>();

function normalizeOrganizationId(organizationId: string | null | undefined): string | null {
  const normalized = typeof organizationId === 'string' ? organizationId.trim() : '';
  return normalized.length > 0 ? normalized : null;
}

/**
 * 取当前进程内的 Organization 级 OS 错误黑名单。
 *
 * - organizationId 必须来自宿主认证上下文（Electron owner / Daemon config 等）；
 * - 同一 Organization 复用同一实例，使 block 与 clear 在不同 runtime / Space 间同源；
 * - 不同 Organization 分桶隔离，避免路径、错误文案和短路状态跨租户泄漏；
 * - organizationId 缺失时返回新的独立实例，保守退回本地单实例行为。
 */
export function getSharedOSErrorBlacklist(
  organizationId: string | null | undefined,
): OSErrorBlacklist {
  const normalizedOrganizationId = normalizeOrganizationId(organizationId);
  if (!normalizedOrganizationId) {
    return new OSErrorBlacklist();
  }

  let store = sharedOSErrorBlacklistsByOrganization.get(normalizedOrganizationId);
  if (!store) {
    store = new OSErrorBlacklist();
    sharedOSErrorBlacklistsByOrganization.set(normalizedOrganizationId, store);
  }
  return store;
}

export class OSErrorBlacklist {
  private readonly entries = new Map<string, OSErrorBlacklistEntry>();
  private readonly defaultTtlMs: number;

  constructor(opts: OSErrorBlacklistOptions = {}) {
    this.defaultTtlMs = opts.defaultTtlMs ?? 0;
  }

  private static makeKey(path: string, code: string): string {
    return `${code}::${path}`;
  }

  private static isSamePathOrDescendant(candidatePath: string, rootPath: string): boolean {
    const sep = rootPath.includes('\\') && !rootPath.includes('/') ? '\\' : '/';
    const prefix =
      rootPath.endsWith('/') || rootPath.endsWith('\\')
        ? rootPath
        : rootPath + sep;
    return candidatePath === rootPath || candidatePath.startsWith(prefix);
  }

  /** 把 (path, code) 加入黑名单 */
  block(
    path: string,
    code: string,
    cachedToolErrorMessage: string,
    ttlMs?: number,
  ): void {
    const blockedAt = Date.now();
    const ttl = ttlMs ?? this.defaultTtlMs;
    const expiresAt = ttl > 0 ? blockedAt + ttl : Number.POSITIVE_INFINITY;
    this.entries.set(OSErrorBlacklist.makeKey(path, code), {
      path,
      code,
      blockedAt,
      expiresAt,
      cachedToolErrorMessage,
    });
  }

  /**
   * 按真实文件系统路径解封（toolCall 维度写入的条目也命中）。
   *
   * 不同于 `clear(path)`：`clear` 同时按内部 key (`entry.path`) 匹配——
   * path 维度调用时该字段就是真实路径所以能命中；toolCall 维度调用时该
   * 字段是合成键所以漏命中（历史 bug）。本方法专门解决 toolCall 维度
   * 命中问题：仅匹配 `entry.originalPath`。
   *
   * 用例：`clear_os_error_blacklist({ path })` 工具——LLM 收到的
   * `path` 是用户语义里的真实路径（如 `~/Desktop`），不是合成 key。
   *
   * **路径前缀语义（Wave 1 第二轮 Review M-5 修订）**：
   *   匹配规则是 `entry.originalPath === realPath` **或** `entry.originalPath`
   *   位于 `realPath` 的子树内（路径前缀 + 路径分隔符）。
   *
   *   理由：用户在系统设置授权一个文件夹（如 `~/Desktop`）后，OS POSIX
   *   权限本身是子树继承的——`~/Desktop` 下的所有文件 / 子目录都解封了。
   *   用户在对话里说"我授权了 Desktop"时，预期是子树都解封，而不是
   *   "我得逐个把 Desktop/file1.txt / Desktop/file2.txt ... 都告诉 Agent"。
   *
   *   匹配示例（`realPath = '/Users/foo/Desktop'`，路径分隔符 `/`）：
   *   - `entry.originalPath = '/Users/foo/Desktop'` → 命中（精确）
   *   - `entry.originalPath = '/Users/foo/Desktop/a.png'` → 命中（前缀+分隔符）
   *   - `entry.originalPath = '/Users/foo/Desktop/sub/b.txt'` → 命中（深层子路径）
   *   - `entry.originalPath = '/Users/foo/DesktopX'` → **不**命中（仅字符串前缀，无分隔符边界）
   *   - `entry.originalPath = '/Users/foo'` → 不命中（这是父路径，不在 realPath 子树内）
   *
   * 返回清除条目数（含已过期被顺手清理的）。
   */
  clearByOriginalPath(realPath: string): number {
    let count = 0;
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt < now) {
        this.entries.delete(key);
        continue;
      }
      const op = entry.originalPath;
      if (op === undefined) continue;
      const matches = OSErrorBlacklist.isSamePathOrDescendant(op, realPath);
      if (matches) {
        this.entries.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * 查询某路径是否被某 code 拦截。
   *
   * - `code` 给定时按精确 (path, code) 命中
   * - `code` 省略时按 path 一切 code 命中即返回（表示"这条路径还有效阻塞中"）
   *
   * 命中时顺手清理已过期条目。
   */
  isBlocked(path: string, code?: string): OSErrorBlacklistEntry | null {
    const now = Date.now();
    if (code) {
      const key = OSErrorBlacklist.makeKey(path, code);
      const entry = this.entries.get(key);
      if (!entry) return null;
      if (entry.expiresAt < now) {
        this.entries.delete(key);
        return null;
      }
      return entry;
    }
    for (const [key, entry] of this.entries) {
      if (entry.path !== path) continue;
      if (entry.expiresAt < now) {
        this.entries.delete(key);
        continue;
      }
      return entry;
    }
    return null;
  }

  /**
   * 清掉黑名单条目。
   *
   * - `path` 省略 → 全清
   * - `path` 给定 → 清该路径及其子树所有 code 的条目
   * - `path` + `code` → 清单条
   *
   * 返回清除条目数。
   */
  clear(path?: string, code?: string): number {
    if (!path) {
      const n = this.entries.size;
      this.entries.clear();
      return n;
    }
    if (code) {
      const key = OSErrorBlacklist.makeKey(path, code);
      return this.entries.delete(key) ? 1 : 0;
    }
    let count = 0;
    for (const [key, entry] of this.entries) {
      if (OSErrorBlacklist.isSamePathOrDescendant(entry.path, path)) {
        this.entries.delete(key);
        count++;
      }
    }
    return count;
  }

  /** 列出当前活跃条目（已过期的会被清理） */
  list(): OSErrorBlacklistEntry[] {
    const now = Date.now();
    const result: OSErrorBlacklistEntry[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt < now) {
        this.entries.delete(key);
        continue;
      }
      result.push(entry);
    }
    return result;
  }

  size(): number {
    return this.list().length;
  }

  // ── Tool 调用维度（path 不可知时使用） ─────────────────────────────
  //
  // path 维度（block/isBlocked）适合 safe-fs 调用方真路径已知的场景。
  // Tool 调度层（tool-orchestration）在调 executeTool 前没有 path —— 工具
  // input schema 各异、path 字段位置不固定 —— 但仍想拦住 LLM 用相同 input
  // 反复调失败工具的死循环。
  //
  // 解决：用 `__tool__:<toolName>:<inputHash>` 作为内部 key，复用既有的
  // (path, code) 索引结构。toolName + 稳定 input hash 唯一确定一次调用，
  // 不同输入自动分开拦截。

  blockToolCall(
    toolName: string,
    input: unknown,
    code: string,
    cachedToolErrorMessage: string,
    ttlMs?: number,
    /**
     * 触发该条目的真实文件系统路径（来自 OSError.path），用于让
     * `clearByOriginalPath` / `clear_os_error_blacklist` 能按
     * 用户语义路径解封 toolCall 维度的条目。
     */
    originalPath?: string,
  ): void {
    const internalKey = OSErrorBlacklist.toolCallKey(toolName, input);
    const blockedAt = Date.now();
    const ttl = ttlMs ?? this.defaultTtlMs;
    const expiresAt = ttl > 0 ? blockedAt + ttl : Number.POSITIVE_INFINITY;
    this.entries.set(OSErrorBlacklist.makeKey(internalKey, code), {
      path: internalKey,
      originalPath,
      code,
      blockedAt,
      expiresAt,
      cachedToolErrorMessage,
    });
  }

  isToolCallBlocked(
    toolName: string,
    input: unknown,
    code?: string,
  ): OSErrorBlacklistEntry | null {
    return this.isBlocked(OSErrorBlacklist.toolCallKey(toolName, input), code);
  }

  clearToolCall(toolName: string, input: unknown, code?: string): number {
    return this.clear(OSErrorBlacklist.toolCallKey(toolName, input), code);
  }

  /**
   * 把 (toolName, input) 编码成稳定字符串。
   *
   * - 用 FNV-1a 32-bit 散列 input 的 JSON 字面量，碰撞概率对进程内黑名单可忽略；
   * - JSON.stringify 失败（循环引用等）退化到 String(input)；
   * - key 显式带 `__tool__:` 前缀，避免与 path 维度的真路径冲突。
   */
  private static toolCallKey(toolName: string, input: unknown): string {
    let s: string;
    try {
      s = JSON.stringify(input ?? null);
    } catch {
      s = String(input);
    }
    return `__tool__:${toolName}:${OSErrorBlacklist.fnv1a32(s)}`;
  }

  private static fnv1a32(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }
}

/**
 * 不同错误码的默认 TTL 策略 —— 调用方在 block() 时可参考。
 *
 * 设计原则：
 *   - 用户必须主动操作才能解决的错误（PERMISSION_DENIED、AV_BLOCKED）→ store 生命周期内有效
 *   - 可能自愈的错误（CLOUD_NOT_DOWNLOADED 同步完成、TARGET_BUSY 进程释放）→ 短 TTL
 *   - 系统状态相关（DISK_LOCKED）→ 中等 TTL
 */
export const OS_ERROR_DEFAULT_TTL_MS: Record<string, number> = {
  OS_PERMISSION_DENIED: 0, // 当前 store 生命周期内有效
  OS_AV_BLOCKED: 0, // 当前 store 生命周期内有效
  CLOUD_NOT_DOWNLOADED: 5 * 60 * 1000, // 5 分钟，可能在等同步
  NETWORK_CREDENTIAL_REQUIRED: 0, // 当前 store 生命周期内有效
  PATH_TOO_LONG: 0, // 路径不变就一直无效
  DISK_LOCKED: 2 * 60 * 1000, // 2 分钟，等用户解锁
  TARGET_BUSY: 30 * 1000, // 30 秒，等其他进程释放
  TARGET_NOT_FOUND: 0, // 路径错就是错
};
