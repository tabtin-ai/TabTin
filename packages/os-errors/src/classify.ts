/**
 * Node errno / Win32 error code → OSError 分类器。
 *
 * 这是 safe-fs / 后端 IPC 反序列化层的入口：捕获原始错误后调 classifyFsError
 * 拿到结构化 OSError；不是 OS 访问类错误返回 null，让上层原样抛。
 *
 * 平台判断分支统一在这里；模板渲染交给 templates.ts，路径分类交给 paths.ts。
 */

import type {
  OSError,
  OSErrorCategory,
  OSErrorCode,
} from './types.js';
import { inferCategoryFromPath } from './paths.js';
import { renderTemplate } from './templates.js';

// Node 的 ErrnoException 加 platform 特有的 raw 错误码字段
interface RawErr extends NodeJS.ErrnoException {
  /** Windows: GetLastError 数值；Node fs 不一定填，但 child_process / native bindings 可能有 */
  errno?: number;
  /** Windows ufs ext.：低位的 facility code，少数路径会暴露 */
  syscall?: string;
}

// ─── 工具函数 ──────────────────────────────────────────────────────────

/**
 * OS 访问类 errno 白名单 —— `classifyFsError` 判定入口认可的错误码。
 *
 * **为什么作为 public export**：`agent-runtime/tools/tabcode-adapter.ts` 的
 * `maybeRethrowAsOSAccessError` 需要先用 regex 从 action-tools 失败 envelope
 * 的 error message 里反推 errno，再传给 `classifyFsError` 二次判定。两边以前
 * 各维护一份白名单（adapter 的 `FS_ERRNO_RE` 多了 EISDIR，但 EISDIR 在这里
 * 不认，silent 退化）。W11 三视角 Review · 技术债 TD-W11-3 合并到单一源，
 * 避免下次加新 code 时两边同步失败。
 *
 * 维护规则：要加新 errno，先在 `classifyDarwin` / `classifyWin32` /
 * `classifyLinux` 的 switch 里补分支（决定映射到哪个 OSErrorCode），再把
 * code 加进这个列表。反过来"加在白名单但 switch 没分支"会让
 * `classifyFsError` 走 default → 错误地归类成 `OS_PERMISSION_DENIED`。
 */
export const OS_ACCESS_ERRNO_CODES = [
  'EPERM',
  'EACCES',
  'EROFS',
  'EBUSY',
  'ENOENT',
  'ENAMETOOLONG',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ENOTDIR',
] as const;

export type OSAccessErrno = (typeof OS_ACCESS_ERRNO_CODES)[number];

function isOSAccessLikeError(err: RawErr): boolean {
  if (!err || typeof err !== 'object') return false;
  if (typeof err.code !== 'string') return false;
  return (OS_ACCESS_ERRNO_CODES as readonly string[]).includes(err.code);
}

function build(
  code: OSErrorCode,
  category: OSErrorCategory,
  platform: NodeJS.Platform,
  path: string,
  rawDetail: string,
  terminal: boolean,
): OSError {
  const tpl = renderTemplate(code, { path, platform, category, rawDetail });
  return {
    code,
    category,
    platform,
    path,
    rawDetail,
    terminal,
    userGuidance: tpl.userGuidance,
    agentDirectives: tpl.agentDirectives,
    recoveryActions: tpl.recoveryActions,
  };
}

// ─── macOS 分类 ────────────────────────────────────────────────────────

function classifyDarwin(err: RawErr, p: string): OSError {
  const cat = inferCategoryFromPath(p, 'darwin');
  const detail = `${err.code} ${err.syscall ?? ''} ${err.message ?? ''}`.trim();

  switch (err.code) {
    case 'EPERM':
    case 'EACCES':
      return build('OS_PERMISSION_DENIED', cat, 'darwin', p, detail, /*terminal*/ true);
    case 'EBUSY':
      return build('TARGET_BUSY', cat, 'darwin', p, detail, /*terminal*/ false);
    case 'ENOENT':
      return build('TARGET_NOT_FOUND', cat, 'darwin', p, detail, /*terminal*/ true);
    case 'ENAMETOOLONG':
      return build('PATH_TOO_LONG', cat, 'darwin', p, detail, /*terminal*/ true);
    default:
      return build('OS_PERMISSION_DENIED', cat, 'darwin', p, detail, /*terminal*/ true);
  }
}

// ─── Windows 分类 ──────────────────────────────────────────────────────

/**
 * Windows 特有 HRESULT —— Node 的 fs 错误码（ENOENT/EACCES/...）覆盖不到这些，
 * 主要从 native binding / IPC 失败 message 字符串里 grep 出来。
 *
 * - 0x8007016A: ERROR_CLOUD_FILE_NOT_IN_SYNC（OneDrive 占位文件未下载）
 * - 0x8007016C: ERROR_CLOUD_FILE_UNSUCCESSFUL
 * - 0x8007016E: ERROR_CLOUD_FILE_PROVIDER_NOT_RUNNING
 * - 0x800704EC: ERROR_VIRUS_INFECTED（Defender 受控文件夹拦截 / 杀软误报）
 * - 0x80070079: ERROR_SEM_TIMEOUT（共享卷凭据问题或杀软劫持后无响应）
 */
const WINDOWS_HRESULT_PATTERNS: Array<{ re: RegExp; code: OSErrorCode; terminal: boolean }> = [
  { re: /0x8007016[ACE]/i, code: 'CLOUD_NOT_DOWNLOADED', terminal: true },
  { re: /0x800704EC/i, code: 'OS_AV_BLOCKED', terminal: true },
  { re: /0x80070079/i, code: 'NETWORK_CREDENTIAL_REQUIRED', terminal: true },
];

function classifyWin32(err: RawErr, p: string): OSError {
  const cat = inferCategoryFromPath(p, 'win32');
  const detail = `${err.code ?? ''} ${err.syscall ?? ''} ${err.message ?? ''}`.trim();

  // 先按消息里出现的 HRESULT 字符串匹配
  for (const { re, code, terminal } of WINDOWS_HRESULT_PATTERNS) {
    if (re.test(detail)) {
      return build(code, code === 'CLOUD_NOT_DOWNLOADED' ? 'CloudStorage' : cat, 'win32', p, detail, terminal);
    }
  }

  switch (err.code) {
    case 'EACCES':
    case 'EPERM':
      // CloudStorage 路径上的 EACCES 90% 是占位文件
      if (cat === 'CloudStorage') {
        return build('CLOUD_NOT_DOWNLOADED', cat, 'win32', p, detail, /*terminal*/ true);
      }
      return build('OS_PERMISSION_DENIED', cat, 'win32', p, detail, /*terminal*/ true);
    case 'EBUSY':
      return build('TARGET_BUSY', cat, 'win32', p, detail, /*terminal*/ false);
    case 'ETIMEDOUT':
      // Windows 上文件 IO 超时极可能是被杀软拦截（卡死 read 调用）
      return build('OS_AV_BLOCKED', cat, 'win32', p, detail, /*terminal*/ true);
    case 'ENAMETOOLONG':
      return build('PATH_TOO_LONG', cat, 'win32', p, detail, /*terminal*/ true);
    case 'ENOENT':
      return build('TARGET_NOT_FOUND', cat, 'win32', p, detail, /*terminal*/ true);
    default:
      return build('OS_PERMISSION_DENIED', cat, 'win32', p, detail, /*terminal*/ true);
  }
}

// ─── Linux 分类 ────────────────────────────────────────────────────────

function classifyLinux(err: RawErr, p: string): OSError {
  const cat = inferCategoryFromPath(p, 'linux');
  const detail = `${err.code ?? ''} ${err.syscall ?? ''} ${err.message ?? ''}`.trim();

  switch (err.code) {
    case 'EACCES':
    case 'EPERM':
      return build('OS_PERMISSION_DENIED', cat, 'linux', p, detail, /*terminal*/ true);
    case 'EBUSY':
      return build('TARGET_BUSY', cat, 'linux', p, detail, /*terminal*/ false);
    case 'ENOENT':
      return build('TARGET_NOT_FOUND', cat, 'linux', p, detail, /*terminal*/ true);
    case 'ENAMETOOLONG':
      return build('PATH_TOO_LONG', cat, 'linux', p, detail, /*terminal*/ true);
    default:
      return build('OS_PERMISSION_DENIED', cat, 'linux', p, detail, /*terminal*/ true);
  }
}

// ─── 主入口 ────────────────────────────────────────────────────────────

/**
 * 把任意文件操作捕获到的原始错误归一为 OSError；非 OS 访问异常返回 null。
 *
 * 调用方契约：
 *   - 永远先调 `classifyFsError(err, path)`
 *   - 返回非 null：抛出包了 osError 字段的复合错误（safe-fs 实现）
 *   - 返回 null：原样 throw err（可能是 EINVAL / EISDIR 等业务级错误）
 */
export function classifyFsError(
  err: unknown,
  path: string,
  platform: NodeJS.Platform = process.platform,
): OSError | null {
  if (!isOSAccessLikeError(err as RawErr)) return null;
  const raw = err as RawErr;
  switch (platform) {
    case 'darwin':
      return classifyDarwin(raw, path);
    case 'win32':
      return classifyWin32(raw, path);
    default:
      return classifyLinux(raw, path);
  }
}

/**
 * 杀软超时检测（Windows 专用）—— safe-fs 在 Promise.race 下被 timeout 截胡时，
 * 如果未拿到原始 errno，可以直接调这个函数构造 OS_AV_BLOCKED OSError。
 */
export function buildAVTimeoutError(path: string, timeoutMs: number): OSError {
  const detail = `operation_timeout_${timeoutMs}ms`;
  return build('OS_AV_BLOCKED', inferCategoryFromPath(path, 'win32'), 'win32', path, detail, true);
}
