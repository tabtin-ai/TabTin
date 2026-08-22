/**
 * path-normalize.ts — 路径规范化（v3 §3.6）
 *
 * 工作区判定的前提是路径等价类一致。两条规则：
 *   1. WorkspaceTracker 入账时规范化（host 侧调用 `normalize()`）
 *   2. judge 判决时同样规范化（必须同源同函数，禁止字符串 startsWith 比较）
 *
 * 核心行为：
 *   - realpath 解决 symlink / Windows junction / macOS firmlink
 *   - `(dev, inode)` 缓存避免每次 judge 抖磁盘（LRU + TTL 双重失效）
 *   - symlink 深度上限 40（防 loop），超限视为"无法解析"
 *   - tilde / `%USERPROFILE%` / `~` 展开
 *   - Windows 反斜杠归一为正斜杠（POSIX 风格）
 *   - Unicode NFC 归一
 *   - 路径不存在（ENOENT）/ 权限不足（EACCES）/ iCloud 占位符 → fallback：路径字面量 + 标记 `unresolved`
 *
 * 跨平台：
 *   - Unix（macOS / Linux）：POSIX path + NFC
 *   - Windows：归一为正斜杠 + 盘符大写化（Drive letter）+ NFC + `%USERPROFILE%` 展开
 */

import * as nodePath from 'node:path';
import * as nodeOs from 'node:os';
import * as nodeFs from 'node:fs';

import type { WorkspaceSnapshot } from './types-v3.js';

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

/** symlink 解析深度上限；超过视为 loop 或异常嵌套 */
export const MAX_SYMLINK_DEPTH = 40;

/** LRU 缓存最大条目数（避免无界增长占用内存） */
const CACHE_MAX_ENTRIES = 4096;

/** 缓存 TTL（毫秒）；过期重新 realpath 检查 dev/inode 是否仍一致 */
const CACHE_TTL_MS = 60_000;

// ─────────────────────────────────────────────────────────────
// 缓存
// ─────────────────────────────────────────────────────────────

interface CacheEntry {
  /** 规范化后的字符串 */
  normalized: string;
  /** 设备号（POSIX）；Windows / 不可获取时 undefined */
  dev?: number;
  /** inode（POSIX）；Windows / 不可获取时 undefined */
  ino?: number;
  /** 是否 realpath 解析成功（不存在 / loop / 占位符 → false） */
  resolved: boolean;
  /** 入缓存时间戳（ms），用于 TTL 判定 */
  cachedAt: number;
}

/** 测试可LRU 缓存（外部用 `__createLRUForTesting` 实例化小阈值版本） */
export class LRUCache<K, V> {
  private map = new Map<K, V>();
  constructor(private readonly maxEntries: number) {}

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    // LRU touch：删了再设到末尾
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.maxEntries) {
      // 删最旧的（Map 迭代顺序 = 插入顺序）
      const firstKey = this.map.keys().next().value as K | undefined;
      /* v8 ignore next */
      if (firstKey !== undefined) this.map.delete(firstKey);
    }
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

const normalizeCache = new LRUCache<string, CacheEntry>(CACHE_MAX_ENTRIES);

/** 测试 / 排障用：清空缓存 */
export function __clearNormalizeCache(): void {
  normalizeCache.clear();
}

/** 测试 / 排障用：当前缓存大小 */
export function __debugNormalizeCacheSize(): number {
  return normalizeCache.size;
}

// ─────────────────────────────────────────────────────────────
// 跨平台 helpers
// ─────────────────────────────────────────────────────────────

const IS_WINDOWS = process.platform === 'win32';

/**
 * 把 Windows 反斜杠归一为正斜杠；POSIX 系统不动。
 * 同时把 Windows 盘符大写化（`c:/` → `C:/`），避免 case 抖动。
 */
function toPosixSlashes(p: string): string {
  if (!IS_WINDOWS) return p;
  /* v8 ignore start */
  let s = p.replace(/\\/g, '/');
  // 盘符大写化：仅匹配开头 `<letter>:`
  if (/^[a-z]:/.test(s)) {
    s = s.charAt(0).toUpperCase() + s.slice(1);
  }
  return s;
  /* v8 ignore end */
}

/**
 * 展开 `~` / `%USERPROFILE%` 到 home 目录。
 * 不依赖 process.env：home 由调用方通过参数注入（或退化到 os.homedir）。
 */
function expandTilde(p: string, homeDir?: string): string {
  const home = homeDir ?? safeHomeDir();
  if (!home) return p;

  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return nodePath.join(home, p.slice(2));
  }
  /* v8 ignore next 3 -- Windows-only branch */
  if (IS_WINDOWS && /^%USERPROFILE%/i.test(p)) {
    return nodePath.join(home, p.replace(/^%USERPROFILE%[\\/]?/i, ''));
  }
  return p;
}

function safeHomeDir(): string {
  try {
    return nodeOs.homedir();
  } catch {
    /* v8 ignore next -- os.homedir 实践中不会抛 */
    return '';
  }
}

/** Unicode NFC 归一 */
function nfc(s: string): string {
  try {
    return s.normalize('NFC');
  } catch {
    /* v8 ignore next -- String.normalize 在主流 Node 不会抛 */
    return s;
  }
}

// ─────────────────────────────────────────────────────────────
// realpath（带深度上限）
// ─────────────────────────────────────────────────────────────

/**
 * 自实现 realpath：手动解析 symlink，深度上限 40 防 loop。
 *
 * 相比 Node 内置 `fs.realpathSync`：
 *   - Node 内置遇到 symlink loop 会抛 ELOOP（OS 级），但深度限制由内核决定
 *     （Linux 默认 40，macOS 32），不可配
 *   - 我们要确定深度上限 = 40，跨平台一致
 *   - 任何中间节点不存在（ENOENT）/ 不可访问（EACCES）→ 视为"无法完全解析"，
 *     返回最近一级能解析的路径作为 fallback
 *
 * 返回 `{ resolved, path }`：
 *   - resolved=true 表示完整解析到一个真实存在的路径
 *   - resolved=false 表示中途遇到不存在 / loop / 权限不足，path 是 fallback
 */
function safeRealpath(input: string): { resolved: boolean; path: string } {
  // 先尝试 Node 内置 realpath，快路径
  try {
    const p = nodeFs.realpathSync.native ? nodeFs.realpathSync.native(input) : nodeFs.realpathSync(input);
    return { resolved: true, path: p };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') {
      return { resolved: false, path: input };
    }
    // ENOENT / EACCES / EPERM / EINVAL（iCloud 占位符常见）→ 走 fallback：
    // 逐段解析，能走到哪算哪
    return manualRealpath(input);
  }
}

/**
 * 手动逐段解析 realpath。
 *
 * 算法：
 *   1. 把路径拆成 tokens
 *   2. 从根开始累加，每层 lstat 看是否 symlink
 *      - 是 symlink：readlink，深度 +1，超过 MAX_SYMLINK_DEPTH 返回当前累加结果（resolved=false）
 *      - 不是 symlink：累加路径继续
 *   3. 任一层 ENOENT / EACCES / EINVAL：返回当前已累加路径（resolved=false）
 */
function manualRealpath(input: string): { resolved: boolean; path: string } {
  const isAbs = nodePath.isAbsolute(input);
  const startBase = isAbs ? '' : process.cwd();
  let acc = startBase;
  const tokens = input.split(/[/\\]+/).filter(Boolean);
  let depth = 0;

  // POSIX：根从 '/' 开始
  if (isAbs && !IS_WINDOWS) acc = '/';

  for (let i = 0; i < tokens.length; i++) {
    const seg = tokens[i] ?? '';
    if (seg === '.') continue;
    if (seg === '..') {
      acc = nodePath.dirname(acc) || (IS_WINDOWS ? acc : '/');
      continue;
    }

    const candidate = nodePath.join(acc || '/', seg);
    let stats: nodeFs.Stats | undefined;
    try {
      stats = nodeFs.lstatSync(candidate);
    } catch {
      // 不存在 / 不可访问 → 把剩余段拼接后返回 fallback
      const rest = tokens.slice(i).join(IS_WINDOWS ? '\\' : '/');
      const tail = nodePath.join(acc || (IS_WINDOWS ? '' : '/'), rest);
      return { resolved: false, path: tail };
    }

    if (stats.isSymbolicLink()) {
      depth += 1;
      if (depth > MAX_SYMLINK_DEPTH) {
        return { resolved: false, path: candidate };
      }
      let target: string;
      try {
        target = nodeFs.readlinkSync(candidate);
      } catch {
        return { resolved: false, path: candidate };
      }
      // 解析 symlink target（绝对 or 相对）后，把它替换回 tokens 重走
      const resolvedTarget = nodePath.isAbsolute(target)
        ? target
        : nodePath.join(acc || '/', target);
      // 把当前段替换为 symlink target，重新 tokenize 余下部分
      const remaining = tokens.slice(i + 1).join(IS_WINDOWS ? '\\' : '/');
      const merged = remaining ? nodePath.join(resolvedTarget, remaining) : resolvedTarget;
      // 递归调一次（深度已 +1）
      return manualRealpathFromString(merged, depth);
    }

    acc = candidate;
  }

  return { resolved: true, path: acc };
}

function manualRealpathFromString(
  input: string,
  startDepth: number,
): { resolved: boolean; path: string } {
  const tokens = input.split(/[/\\]+/).filter(Boolean);
  let acc = nodePath.isAbsolute(input) ? (IS_WINDOWS ? '' : '/') : process.cwd();
  let depth = startDepth;

  for (let i = 0; i < tokens.length; i++) {
    const seg = tokens[i] ?? '';
    if (seg === '.') continue;
    if (seg === '..') {
      acc = nodePath.dirname(acc) || (IS_WINDOWS ? acc : '/');
      continue;
    }
    const candidate = nodePath.join(acc || '/', seg);
    let stats: nodeFs.Stats | undefined;
    try {
      stats = nodeFs.lstatSync(candidate);
    } catch {
      const rest = tokens.slice(i).join(IS_WINDOWS ? '\\' : '/');
      const tail = nodePath.join(acc || (IS_WINDOWS ? '' : '/'), rest);
      return { resolved: false, path: tail };
    }
    if (stats.isSymbolicLink()) {
      depth += 1;
      if (depth > MAX_SYMLINK_DEPTH) {
        return { resolved: false, path: candidate };
      }
      let target: string;
      try {
        target = nodeFs.readlinkSync(candidate);
      } catch {
        return { resolved: false, path: candidate };
      }
      const resolvedTarget = nodePath.isAbsolute(target)
        ? target
        : nodePath.join(acc || '/', target);
      const remaining = tokens.slice(i + 1).join(IS_WINDOWS ? '\\' : '/');
      const merged = remaining ? nodePath.join(resolvedTarget, remaining) : resolvedTarget;
      return manualRealpathFromString(merged, depth);
    }
    acc = candidate;
  }
  return { resolved: true, path: acc };
}

// ─────────────────────────────────────────────────────────────
// 主入口：normalize
// ─────────────────────────────────────────────────────────────

export interface NormalizeResult {
  /** 规范化后的路径字符串（POSIX 斜杠，NFC） */
  path: string;
  /** realpath 是否完全解析成功 */
  resolved: boolean;
  /** POSIX 设备号 / inode（仅 resolved=true 时有效） */
  dev?: number;
  ino?: number;
}

/**
 * 规范化路径。
 *
 * 行为契约（v3 §3.6 严格版）：
 *   1. tilde / 环境变量展开
 *   2. realpath 解析（含 symlink，深度上限 40）
 *   3. POSIX 斜杠归一
 *   4. Unicode NFC 归一
 *   5. 失败 / 不存在 → 返回字面量（仍归一斜杠 + NFC + 展开 tilde），resolved=false
 *
 * 性能：所有结果走 LRU + TTL 缓存，重复同 input 不抖磁盘。
 */
export function normalize(input: string, homeDir?: string): NormalizeResult {
  if (typeof input !== 'string' || input.length === 0) {
    return { path: '', resolved: false };
  }

  // 缓存 key：原始字符串 + homeDir，避免不同用户 home 上下文的污染
  const cacheKey = (homeDir ?? '') + '\u0000' + input;
  const cached = normalizeCache.get(cacheKey);
  if (cached) {
    if (Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      const result: NormalizeResult = {
        path: cached.normalized,
        resolved: cached.resolved,
      };
      if (cached.dev !== undefined) result.dev = cached.dev;
      if (cached.ino !== undefined) result.ino = cached.ino;
      return result;
    }
    normalizeCache.delete(cacheKey);
  }

  const expanded = expandTilde(input, homeDir);
  const { resolved, path: realed } = safeRealpath(expanded);

  let normalizedPath = toPosixSlashes(realed);
  // 路径解析后做一次 path.normalize 收掉冗余 '.' / '..' / 双斜杠
  // POSIX 上 '/' 保留为根；Windows 上盘符保留
  try {
    /* v8 ignore next 3 -- Windows-only branch on POSIX CI */
    normalizedPath = IS_WINDOWS
      ? toPosixSlashes(nodePath.win32.normalize(normalizedPath))
      : nodePath.posix.normalize(normalizedPath);
  } catch {
    /* v8 ignore next -- path.normalize 在 Node 不会抛 */
  }
  // 去掉末尾斜杠（除根 '/' 与 'C:/' 这种）
  if (normalizedPath.length > 1 && normalizedPath.endsWith('/')) {
    /* v8 ignore next 3 -- Windows-only drive letter case */
    if (!(IS_WINDOWS && /^[A-Z]:\/$/.test(normalizedPath))) {
      normalizedPath = normalizedPath.replace(/\/+$/, '');
    }
  }
  normalizedPath = nfc(normalizedPath);

  const entry: CacheEntry = {
    normalized: normalizedPath,
    resolved,
    cachedAt: Date.now(),
  };

  if (resolved) {
    try {
      const stats = nodeFs.statSync(realed);
      entry.dev = stats.dev;
      entry.ino = stats.ino;
    } catch {
      /* v8 ignore next -- race: realpath 后 stat 前文件被删，仅调试期可见 */
    }
  }

  normalizeCache.set(cacheKey, entry);
  const result: NormalizeResult = {
    path: entry.normalized,
    resolved: entry.resolved,
  };
  if (entry.dev !== undefined) result.dev = entry.dev;
  if (entry.ino !== undefined) result.ino = entry.ino;
  return result;
}

// ─────────────────────────────────────────────────────────────
// 过宽路径防护（M3.1 硬化补丁）
// ─────────────────────────────────────────────────────────────

/**
 * POSIX 顶级系统目录的精确字面量。allowedPath **整条等于这些字面量**
 * 时视为"过宽"——把这些目录当作 workspace 等于把整盘暴露给 Agent。
 *
 * 子路径不受影响：`/Users/developer/dev/midscene` / `/Volumes/外接盘/项目` /
 * `/private/tmp/sandbox-xxx` / `/Library/CustomApp/data` / `/snap/myapp/current`
 * 等深层路径不在此列、不会被挡。
 *
 * 注意 macOS `/private`：`/tmp` 实际是 symlink 到 `/private/tmp`，
 * realpath 后会变成 `/private/tmp` —— 我们要拦的是 allowedPath = `/private`
 * 这种把整台机器都纳入工作区的情况，不是 `/private/tmp/sandbox-xxx`
 * 这种合法子路径。
 *
 * **M3.1 review 第 1 轮补**：加 macOS / Linux 常见的"半台机器"整段：
 *   - `/Volumes`（macOS 外置盘根）/ `/Applications`（macOS 应用根）
 *   - `/srv` `/mnt` `/media`（Linux 服务 / 挂载点根）
 *   - `/proc` `/sys` `/dev`（虚拟 / 设备文件系统根）
 *
 * **M3.1.1 review 第 2 轮 R3-1 补**：再加更多 OS 服务根：
 *   - `/snap`（Ubuntu 包根）
 *   - `/System`（macOS 系统根）
 *   - `/Library`（macOS 库根）
 *   - `/boot`（Linux 引导）
 *   - `/run`（Linux 运行时）
 *
 * 这些字面量整段当 allowedPath 都是把整树纳入工作区；**子路径仍合法**。
 *
 * **`/Users` / `/home` 仍保留**：这两条是"跨用户家根"，整段当 allowedPath
 * 等于把多用户机器上的所有人 home 暴露给 Agent，仍要拦。但**单用户家目录**
 * `/Users/<name>` / `/home/<name>` 在 M3.1.1 起视为合法 workspace（用户拍板
 * 方向 C：放宽家目录但用 `sensitive_path_list` 把 `~/.ssh/`、`~/.aws/`、
 * `~/Library/Keychains/`、`~/Library/Application Support/{1Password,...}` 等
 * 凭据级敏感子目录敲门补回；详见 `hardline-v3-rules.json` + spec §3.3）。
 */
const DANGEROUS_TOPLEVEL_DIRS: ReadonlyArray<string> = [
  '/',
  '/Users', // 跨用户家根（单用户 /Users/<name> 整段在 M3.1.1 起放宽为合法 workspace）
  '/home', // 跨用户家根（同上）
  '/tmp',
  '/var',
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/opt',
  '/root',
  '/private', // macOS firmlink 根
  '/Volumes', // macOS 外置盘 / 网络挂载根
  '/Applications', // macOS 应用根
  '/srv',
  '/mnt',
  '/media',
  '/proc', // Linux 虚拟文件系统
  '/sys',
  '/dev',
  '/System', // M3.1.1 R3-1：macOS 系统根
  '/Library', // M3.1.1 R3-1：macOS 库根（root /Library；~/Library 是用户级、不在此列）
  '/boot', // M3.1.1 R3-1：Linux 引导
  '/run', // M3.1.1 R3-1：Linux 运行时
  '/snap', // M3.1.1 R3-1：Ubuntu 包根
];

/**
 * Windows 等价的"整盘根"。规范化后可能是 `C:/` / `C:\` /（少数 case）`/C:/`。
 * security-policy 包跨端，加上不亏。
 */
const DANGEROUS_WINDOWS_ROOTS: ReadonlyArray<RegExp> = [
  /^[A-Z]:[/\\]?$/i, // C: / C:/ / C:\
  /^\/[A-Z]:[/\\]?$/i, // /C:/ / /C:\
];

/**
 * 检查 `allowedPath` 是否"过宽到危险" —— 把它当 workspace = 把整个 OS 顶级目录
 * / 跨用户家根 / 整盘暴露给 Agent。
 *
 * 这个 helper 在 `isInWorkspace` 的循环里 / `decodeWorkspaceSnapshot` 的
 * decode 出口里 / 上层 build-policy 装配里 fail-closed 兜底使用。
 *
 * **判定策略（M3.1.1 二轮补丁，方向 C：放宽家目录）**：
 *   - 空字符串 / 全空白 → true（**异常**：合法 allowedPath 不可能是空串）
 *   - `/` 字面量 → true（整盘）
 *   - POSIX 顶级目录字面量（`/Users` `/home` `/tmp` `/var` `/etc` `/usr` `/bin`
 *     `/sbin` `/opt` `/root` `/private` `/Volumes` `/Applications` `/srv` `/mnt`
 *     `/media` `/proc` `/sys` `/dev` `/System` `/Library` `/boot` `/run` `/snap`）
 *     → true（跨用户/跨服务边界，整段当 workspace 等于把整树暴露）
 *   - 单用户家目录本身（`/Users/<name>` / `/home/<name>`）→ **false（M3.1.1 起放行）**。
 *     用户拍板方向 C：`/Users/developer` 整段是合法工作区（M3 之前的 `isUserHomeRoot`
 *     启发挡掉它属于过度防御）；凭据级敏感子目录的敲门由 `hardline-v3-rules.json`
 *     的 `sensitive_path_list`（`~/.ssh/` `~/.aws/` `~/Library/Keychains/`
 *     `~/Library/Application Support/{1Password,Bitwarden,...}` 等）补回。
 *   - Windows `C:/` / `C:\` / `/C:/` 等盘符根 → true
 *   - 非绝对路径（相对路径、`../`、`~`、空段开头）→ true（按 §3.6 规范，
 *     allowedPaths 应**全部是 realpath 后的绝对路径**；进来就是上游 bug）
 *   - 其他（`/Users/developer/dev/midscene` / `/tmp/tabtin-sandbox/space-xxx`
 *     / `/Users/developer/Documents/work` / `/Users/developer` 家目录本身）→ false
 *
 * 与 `normalize()` 的关系：本函数**期望输入已经被 `normalize()` 过**（NFC +
 * POSIX 斜杠 + realpath 兜底），但即使没规范化也能正确判（按字面量比对）。
 *
 * **不在这里做**：是否该 deny 整个 snapshot vs 仅过滤这条 entry —— 那是调用方
 * 决策。本函数只回答"这条 path 是否危险"。
 *
 * @param allowedPath 单条 allowedPath / sandbox / allowedFile 字符串
 * @returns true = 该路径过宽，调用方应过滤掉
 */
export function isDangerouslyBroadPath(allowedPath: unknown): boolean {
  if (typeof allowedPath !== 'string') return true;
  const trimmed = allowedPath.trim();
  if (trimmed.length === 0) return true;
  // NFC 归一保证 Unicode 等价（与 normalize 一致），用 trimmed 字面量比对
  let p: string;
  try {
    p = trimmed.normalize('NFC');
  } catch {
    /* v8 ignore next -- normalize 在主流 Node 不会抛 */
    p = trimmed;
  }

  // 反斜杠归一（让 Windows 形式在 POSIX 测试也能命中）
  const posix = p.replace(/\\/g, '/');

  // 1. POSIX 绝对路径必须以 `/` 开头；不是绝对路径（相对 / `~` / 空段）→ 危险
  //    Windows 盘符路径在下面单独判
  const isPosixAbs = posix.startsWith('/');
  const isWindowsAbs = /^[A-Z]:[/\\]/i.test(p) || /^[A-Z]:$/i.test(p);
  if (!isPosixAbs && !isWindowsAbs) return true;

  // 2. Windows 盘符根 / 顶级
  for (const re of DANGEROUS_WINDOWS_ROOTS) {
    if (re.test(p)) return true;
  }

  // 3. POSIX 顶级目录字面量（含尾部斜杠也认）
  // 收掉末尾 `/`（保留单 `/` 根）以便比较
  let stripped = posix;
  if (stripped.length > 1 && stripped.endsWith('/')) {
    stripped = stripped.replace(/\/+$/, '');
  }
  // 按字面量比对顶级目录
  for (const top of DANGEROUS_TOPLEVEL_DIRS) {
    if (stripped === top) return true;
  }

  // M3.1.1 起：单用户家目录 `/Users/<name>` / `/home/<name>` 视为合法 workspace
  // （用户拍板方向 C）。凭据级敏感子目录由 sensitive_path_list 敲门兜底。
  return false;
}

// ─────────────────────────────────────────────────────────────
// 工作区判定
// ─────────────────────────────────────────────────────────────

/**
 * 检查规范化后的路径是否落在工作区内（前缀匹配）。
 *
 * 行为：
 *   - 输入应已规范化（NFC + POSIX 斜杠 + realpath 后），调用方负责
 *   - 同样对 workspace 中每条 allowedPath 做前缀比较；workspace.allowedPaths
 *     约定也是已规范化的
 *   - 前缀匹配的语义是"path 是 allowed 的子路径或相等"，而不是字符串前缀
 *     —— 用 `path === allowed` 或 `path.startsWith(allowed + '/')` 双重判定，
 *     避免 `/foo/barx` 误判落在 `/foo/bar` 里
 *   - allowedFiles 也参与匹配：path 精确等于某条 allowedFile → 在内
 *
 * **M3.1 硬化补丁（过宽路径防护）**：在循环内对每条 allowedPath /
 * allowedFile 调用 `isDangerouslyBroadPath`，命中则 `continue` 跳过。
 * 即使主控端代码 bug / 远程 Daemon 收到畸形 wire payload / 测试 fixture
 * 泄漏让 `/` 进了数组，这一层也兜底拦掉，不会让任意绝对路径都判成
 * workspace_in。
 *
 * 实现策略选择（循环内逐条 vs 入口处一次过过滤）：
 *   - 选**循环内逐条**。理由：`isInWorkspace` 是热路径，可能被高频调用；
 *     入口处一次过过滤会创建中间数组（拷贝代价 O(n) + GC 压力）。
 *     `isDangerouslyBroadPath` 本身是字符串字面量比对，常数级别开销，
 *     循环内多调一次几乎无感。
 *   - decode 层（一次性入口）已经做了一次过滤 + 警告日志，这里仅作
 *     "深度防御"兜底，不再发警告（避免每次工具调用都打印）。
 */
export function isInWorkspace(
  normalizedPath: string,
  workspace: WorkspaceSnapshot,
): boolean {
  return isPathInAllowedRoots(normalizedPath, workspace.allowedPaths, workspace.allowedFiles);
}

function looksWindowsBoundaryPath(p: string): boolean {
  const slashNormalized = p.replace(/\\/g, '/');
  return /^[A-Z]:($|\/)/i.test(slashNormalized) || /^\/\/[^/]+\/[^/]+/.test(slashNormalized);
}

/**
 * WorkspaceSnapshot 约定 allowedPaths 已规范化，但真实 Windows 链路里
 * working_dir 可能以 `E:\foo` 入账，而 cwd/file path 经 normalize 后变成
 * `E:/foo`。这里仅做字符串比较所需的轻量归一化，不触盘 realpath。
 */
function normalizeBoundaryComparablePath(p: string): string {
  const windowsLike = looksWindowsBoundaryPath(p);
  let comparable = windowsLike
    ? nodePath.win32.normalize(p).replace(/\\/g, '/')
    : p;

  if (comparable.length > 1 && comparable.endsWith('/')) {
    const isWindowsDriveRoot = windowsLike && /^[A-Z]:\/$/i.test(comparable);
    const isWindowsShareRoot = windowsLike && /^\/\/[^/]+\/[^/]+\/$/i.test(comparable);
    if (!isWindowsDriveRoot && !isWindowsShareRoot) {
      comparable = comparable.replace(/\/+$/, '');
    }
  }

  if (windowsLike) {
    comparable = comparable.toLowerCase();
  }
  return nfc(comparable);
}

/**
 * 路径权限治理 Wave 1：「这条路径在不在 allowedPaths / allowedFiles 集合内」的
 * 通用判定函数（与 `isInWorkspace` 共享同一份实现）。
 *
 * 给那些已经从 `WorkspaceSnapshot` 取出 `string[]` 的调用方使用，
 * 典型如 `@tabtin/action-tools` 的 `checkFilePathSecurity`：tool-adapter
 * 注入到 action-tool payload 的字段是 `_allowed_paths` / `_allowed_files`
 * 数组，没有完整 snapshot——直接调本函数即可与 `isInWorkspace` 共享同一
 * 套过宽路径过滤 + 文件精确匹配 + 目录前缀匹配语义，避免在 action-tools
 * 内重复实现一遍判定逻辑导致两份语义漂移。
 *
 * `allowedFiles` 缺省为空数组——多数 file/shell 工具调用方只传目录列表，
 * 文件级附件名单是 `WorkspaceSnapshot.attachedFiles` 衍生品，未在此粒度
 * 用上。
 */
export function isPathInAllowedRoots(
  normalizedPath: string,
  allowedPaths: readonly string[],
  allowedFiles: readonly string[] = [],
): boolean {
  if (!normalizedPath) return false;
  const pathForCompare = normalizeBoundaryComparablePath(normalizedPath);

  // 文件级精确匹配（也过滤过宽 allowedFile，譬如有人误把 `/` 塞到 attachedFiles）
  for (const f of allowedFiles) {
    if (isDangerouslyBroadPath(f)) continue;
    if (normalizeBoundaryComparablePath(f) === pathForCompare) return true;
  }

  // 目录前缀匹配
  for (const dir of allowedPaths) {
    if (!dir) continue;
    if (isDangerouslyBroadPath(dir)) continue;
    const dirForCompare = normalizeBoundaryComparablePath(dir);
    if (pathForCompare === dirForCompare) return true;
    // 经过 isDangerouslyBroadPath 过滤后，dir 不再是单 `/`，可以安全 + '/'
    const sep = dirForCompare.endsWith('/') ? '' : '/';
    if (pathForCompare.startsWith(dirForCompare + sep)) return true;
  }
  return false;
}

/**
 * cwd 工作区判定（语义同 isInWorkspace；命名仅为可读性）。
 * shell 类工具用 cwd 作为工作区判定依据。
 */
export function isCwdInWorkspace(
  normalizedCwd: string,
  workspace: WorkspaceSnapshot,
): boolean {
  return isInWorkspace(normalizedCwd, workspace);
}
