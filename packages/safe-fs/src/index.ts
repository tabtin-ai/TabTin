/**
 * @tabtin/safe-fs — node:fs 的薄包装，统一抛 OSAccessError
 *
 * 设计意图：
 *   - 所有本地文件操作都过这一层 → 任何 OS 拦截（macOS TCC / Windows ACL / 杀软 /
 *     云盘占位）都被归一成 OSError + 抛 OSAccessError；
 *   - 调用方继续用熟悉的 async/await + try-catch；
 *   - 上层 Tool 层 catch 后用 toToolError() 序列化给 Agent，Agent 拿到的就是
 *     结构化错误 + 给用户的中文引导，无需现场翻译 errno。
 *
 * 不做什么：
 *   - 不缓存任何路径状态（避免误判失效）
 *   - 不主动 stat 试探权限（避免开 App 就触发系统弹窗）
 *   - 不重试 / 不 fallback —— 重试节流由 Agent runtime 做
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import {
  buildAVTimeoutError,
  classifyFsError,
  type OSError,
} from '@tabtin/os-errors';

/** 所有 safe-fs API 失败时抛的统一错误类型 */
export class OSAccessError extends Error {
  public readonly osError: OSError;
  constructor(osError: OSError) {
    super(`OSAccessError: ${osError.code} ${osError.path}`);
    this.name = 'OSAccessError';
    this.osError = osError;
    // 保留原始 stack
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, OSAccessError);
    }
  }
}

/** 检测某个错误是否 safe-fs 抛出 */
export function isOSAccessError(err: unknown): err is OSAccessError {
  return err instanceof OSAccessError;
}

interface SafeFsOptions {
  /**
   * Windows 上文件 IO 的超时时间 —— 杀软劫持时 read 调用会卡死，
   * 超过此时长就当作 OS_AV_BLOCKED 处理。默认 8 秒。
   *
   * 非 Windows 平台此选项被忽略（mac/Linux 上 errno 立即返回，无超时陷阱）。
   *
   * 0 或 undefined 表示禁用超时检测（适合大文件读写 / 远程挂载场景，
   * 调用方需自己保证不会卡死）。
   */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8000;

async function withTimeout<T>(
  fn: () => Promise<T>,
  path: string,
  opts: SafeFsOptions,
): Promise<T> {
  const t = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (t <= 0 || process.platform !== 'win32') return fn();

  let timer: NodeJS.Timeout | undefined;
  const timeoutP = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new OSAccessError(buildAVTimeoutError(path, t)));
    }, t);
    timer.unref?.();
  });

  try {
    return await Promise.race([fn(), timeoutP]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function wrap<T>(
  fn: () => Promise<T>,
  path: string,
  opts: SafeFsOptions = {},
): Promise<T> {
  try {
    return await withTimeout(fn, path, opts);
  } catch (rawErr) {
    if (rawErr instanceof OSAccessError) throw rawErr;
    const osErr = classifyFsError(rawErr, path);
    if (osErr) throw new OSAccessError(osErr);
    throw rawErr;
  }
}

// ─── 公共 API（异步） ──────────────────────────────────────────────────

export interface ReadFileBufferOptions extends SafeFsOptions {
  encoding?: null;
  flag?: string;
}
export interface ReadFileStringOptions extends SafeFsOptions {
  encoding: BufferEncoding;
  flag?: string;
}

export async function safeReadFile(p: string, opts: ReadFileStringOptions): Promise<string>;
export async function safeReadFile(p: string, opts?: ReadFileBufferOptions): Promise<Buffer>;
export async function safeReadFile(
  p: string,
  opts: { timeoutMs?: number; encoding?: BufferEncoding | null; flag?: string } = {},
): Promise<string | Buffer> {
  const { timeoutMs, encoding, flag } = opts;
  return wrap(
    () => fsp.readFile(p, { encoding, flag } as fs.ObjectEncodingOptions & { flag?: string }),
    p,
    { timeoutMs },
  );
}

export function safeReadDir(
  p: string,
  opts?: SafeFsOptions & { withFileTypes?: false },
): Promise<string[]>;
export function safeReadDir(
  p: string,
  opts: SafeFsOptions & { withFileTypes: true },
): Promise<fs.Dirent[]>;
export function safeReadDir(
  p: string,
  opts: SafeFsOptions & { withFileTypes?: boolean } = {},
): Promise<string[]> | Promise<fs.Dirent[]> {
  const { timeoutMs, withFileTypes } = opts;
  if (withFileTypes) {
    return wrap(() => fsp.readdir(p, { withFileTypes: true }), p, { timeoutMs });
  }
  return wrap(() => fsp.readdir(p), p, { timeoutMs });
}

export async function safeStat(p: string, opts: SafeFsOptions = {}): Promise<fs.Stats> {
  return wrap(() => fsp.stat(p), p, opts);
}

export async function safeAccess(
  p: string,
  mode?: number,
  opts: SafeFsOptions = {},
): Promise<void> {
  return wrap(() => fsp.access(p, mode), p, opts);
}

export async function safeWriteFile(
  p: string,
  data: string | Buffer | Uint8Array,
  opts: SafeFsOptions & {
    encoding?: BufferEncoding;
    mode?: number;
    flag?: string;
  } = {},
): Promise<void> {
  const { timeoutMs, ...fsOpts } = opts;
  return wrap(() => fsp.writeFile(p, data, fsOpts), p, { timeoutMs });
}

export async function safeUnlink(p: string, opts: SafeFsOptions = {}): Promise<void> {
  return wrap(() => fsp.unlink(p), p, opts);
}

/**
 * 删除文件或目录（fs.promises.rm 的等价物，递归 / 强制语义透传）。
 *
 * - `recursive: true` 等价 `rm -r`：删目录及内容
 * - `force: true` 等价 `rm -f`：路径不存在不抛错（注意：force 由 fs.rm
 *   原语在 EOENT 时静默吞掉，但 EPERM/EACCES 等真实权限错仍会抛——
 *   这正是我们想要的（杀软劫持 / TCC 拒绝必须归类成 OSError 让 Agent
 *   能识别，不能被 force=true 静默掩盖）。
 *
 * 与 safeUnlink 的区别：safeUnlink 只删文件；safeRm 通过 recursive
 * 支持删目录树。NativeBackendSession 的删工具走 safeRm（与 BaseBackendSession
 * 接口语义一致）。
 */
export async function safeRm(
  p: string,
  opts: SafeFsOptions & { recursive?: boolean; force?: boolean } = {},
): Promise<void> {
  const { timeoutMs, ...fsOpts } = opts;
  return wrap(() => fsp.rm(p, fsOpts), p, { timeoutMs });
}

export async function safeRename(
  oldPath: string,
  newPath: string,
  opts: SafeFsOptions = {},
): Promise<void> {
  // 用 newPath 作为错误归因 —— 大多数 rename 失败原因在目标路径权限
  return wrap(() => fsp.rename(oldPath, newPath), newPath, opts);
}

export async function safeMkdir(
  p: string,
  opts: SafeFsOptions & { recursive?: boolean; mode?: number } = {},
): Promise<string | undefined> {
  const { timeoutMs, ...fsOpts } = opts;
  return wrap(() => fsp.mkdir(p, fsOpts), p, { timeoutMs });
}

// ─── 同步版本（限定场景使用） ──────────────────────────────────────────
// 同步 API 不支持超时检测 —— Windows 上若被杀软劫持会卡死整个 Node 进程，
// 调用方应仅在启动期 / CLI 一次性场景使用，且优先用异步版本。

export function safeReadFileSync(p: string, opts?: { encoding: BufferEncoding }): string;
export function safeReadFileSync(p: string, opts?: { encoding?: null }): Buffer;
export function safeReadFileSync(p: string, opts: { encoding?: BufferEncoding | null } = {}): string | Buffer {
  try {
    return fs.readFileSync(p, opts as fs.EncodingOption);
  } catch (rawErr) {
    const osErr = classifyFsError(rawErr, p);
    if (osErr) throw new OSAccessError(osErr);
    throw rawErr;
  }
}

export function safeStatSync(p: string): fs.Stats {
  try {
    return fs.statSync(p);
  } catch (rawErr) {
    const osErr = classifyFsError(rawErr, p);
    if (osErr) throw new OSAccessError(osErr);
    throw rawErr;
  }
}

export function safeAccessSync(p: string, mode?: number): void {
  try {
    return fs.accessSync(p, mode);
  } catch (rawErr) {
    const osErr = classifyFsError(rawErr, p);
    if (osErr) throw new OSAccessError(osErr);
    throw rawErr;
  }
}

// 重新导出 os-errors 类型，方便调用方仅依赖 @tabtin/safe-fs
export type { OSError, OSToolError } from '@tabtin/os-errors';
export { toToolError, renderForAgent } from '@tabtin/os-errors';
