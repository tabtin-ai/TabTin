/**
 * remote-fs-handlers — 远程文件浏览的执行侧实现（Daemon 端）。
 *
 * 与 Electron 端 `remote-fs-actions.ts` 同构：
 *   - action：`fs.list_dir` / `fs.read_file_preview`（wire 契约见
 *     docs/prd/remote-file-browse-v1.md §五）
 *   - boundary：Django 注入的服务端权威 `params._working_dir`（唯一根），
 *     红线/敏感路径由 `checkDaemonPathAccess` 内置；
 *   - 体积：结果过 action-bridge 的 256KB WS guard（truncateResult 对嵌套
 *     string 100k chars 截断会**打碎 base64**），所以文本/图片上限收紧到
 *     与 Electron 端相同的常量，保证结果 JSON 恒 < 256KB。
 *
 * 预览分类比 Electron 端简化：图片按扩展名，文本按「头 8KB 无 NUL 字节」
 * 嗅探，其余 kind 一律 binary（pdf/office/音视频远端本来就不支持预览，
 * 前端按 kind 显示占位即可）。
 */
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkDaemonPathAccess } from '../../application/security/path-access.js';

export const REMOTE_FS_ACTIONS = ['fs.list_dir', 'fs.read_file_preview'] as const;

export const REMOTE_TEXT_PREVIEW_MAX_BYTES = 128 * 1024;
export const REMOTE_IMAGE_PREVIEW_MAX_BYTES = 160 * 1024;
export const REMOTE_LIST_DIR_MAX_ENTRIES = 2000;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

interface RemoteFsResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
  error_code?: string;
}

/**
 * 远程浏览的 deny read 列表，与 Electron 端 `DEFAULT_DENY_READ_PATTERNS`
 * 对齐（path-access-checker.ts）。daemon 的 `checkSensitivePath` 是四态
 * 判决——「读敏感 + 工作区内 → allow」，即 working_dir 覆盖 home 时这批
 * 凭据文件会被放行；Electron 端有独立 deny read 层挡住。此处补齐同一层，
 * 避免两端泄露口径漂移。只作用于远程浏览，不影响 Agent 本机工具链路。
 */
const REMOTE_DENY_READ_PREFIXES: readonly string[] = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.netrc',
  '.kube',
  '.config/gcloud',
  '.config/op',
  '.config/gh',
  '.docker/config.json',
  '.npmrc',
  '.pypirc',
];

function isDeniedSensitiveRead(realPath: string): boolean {
  const home = process.env.HOME || os.homedir();
  if (!home) return false;
  const rel = path.relative(home, realPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const normalized = rel.split(path.sep).join('/');
  return REMOTE_DENY_READ_PREFIXES.some(
    (p) => normalized === p || normalized.startsWith(`${p}/`),
  );
}

async function resolveGuardedPath(
  params: Record<string, any>,
): Promise<{ resolved: string } | { error: RemoteFsResult }> {
  const workingDir = typeof params._working_dir === 'string' ? params._working_dir : '';
  const rawPath = typeof params.path === 'string' ? params.path : '';
  if (!workingDir) {
    return { error: { success: false, error: 'missing authoritative working_dir', error_code: 'INVALID_REQUEST' } };
  }
  if (!rawPath) {
    return { error: { success: false, error: 'path is required', error_code: 'INVALID_REQUEST' } };
  }
  // symlink 防逃逸：边界判定用 realpath（root 和 target 都要），否则
  // working_dir 内一条指向外部的软链字符串前缀判定放行、实际读取却
  // follow 到边界外。realpath 失败（不存在等）与拒绝统一 PATH_DENIED
  // 口径（防目录结构探测）。
  let realRoot: string;
  let resolved: string;
  try {
    realRoot = await fsPromises.realpath(path.resolve(workingDir));
    resolved = await fsPromises.realpath(path.resolve(rawPath));
  } catch {
    return { error: { success: false, error: 'path is not accessible', error_code: 'PATH_DENIED' } };
  }
  const access = checkDaemonPathAccess(resolved, 'read', {
    snapshot: null,
    fallbackRoots: [realRoot],
  });
  if (!access.allowed || isDeniedSensitiveRead(resolved)) {
    // 拒绝与不存在统一口径（防目录结构探测），细节只留 daemon 日志侧
    return { error: { success: false, error: 'path is not accessible', error_code: 'PATH_DENIED' } };
  }
  return { resolved };
}

function mapFsError(err: unknown): RemoteFsResult {
  const message = err instanceof Error ? err.message : String(err);
  if (/ENOENT/i.test(message)) {
    return { success: false, error: 'path is not accessible', error_code: 'PATH_DENIED' };
  }
  return { success: false, error: message, error_code: 'FS_ERROR' };
}

export async function executeRemoteFsListDir(params: Record<string, any>): Promise<RemoteFsResult> {
  const guarded = await resolveGuardedPath(params);
  if ('error' in guarded) return guarded.error;
  const { resolved } = guarded;
  try {
    const dirents = await fsPromises.readdir(resolved, { withFileTypes: true });
    const entries = await Promise.all(dirents.map(async (entry) => {
      const entryPath = path.join(resolved, entry.name);
      try {
        const stat = await fsPromises.stat(entryPath);
        return {
          name: entry.name,
          path: entryPath,
          isDirectory: entry.isDirectory(),
          size: stat.size,
          modifiedAt: stat.mtimeMs,
        };
      } catch {
        return { name: entry.name, path: entryPath, isDirectory: entry.isDirectory(), size: 0, modifiedAt: null };
      }
    }));
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const truncated = entries.length > REMOTE_LIST_DIR_MAX_ENTRIES;
    return {
      success: true,
      data: {
        entries: truncated ? entries.slice(0, REMOTE_LIST_DIR_MAX_ENTRIES) : entries,
        truncated,
      },
    };
  } catch (err) {
    return mapFsError(err);
  }
}

export async function executeRemoteFsPreview(params: Record<string, any>): Promise<RemoteFsResult> {
  const guarded = await resolveGuardedPath(params);
  if ('error' in guarded) return guarded.error;
  const { resolved } = guarded;
  try {
    const stat = await fsPromises.stat(resolved);
    if (stat.isDirectory()) {
      return { success: false, error: 'path is a directory', error_code: 'EISDIR' };
    }

    const ext = path.extname(resolved).toLowerCase();
    const imageMime = IMAGE_MIME_BY_EXT[ext];
    if (imageMime) {
      if (stat.size > REMOTE_IMAGE_PREVIEW_MAX_BYTES) {
        return { success: true, data: { kind: 'binary', size: stat.size, truncated: true } };
      }
      const buffer = await fsPromises.readFile(resolved);
      return {
        success: true,
        data: {
          kind: 'image',
          content: buffer.toString('base64'),
          size: stat.size,
          truncated: false,
          mime: imageMime,
        },
      };
    }

    // 文本嗅探：读取截断窗口，头 8KB 出现 NUL 字节按二进制处理
    const handle = await fsPromises.open(resolved, 'r');
    try {
      const previewSize = Math.min(stat.size, REMOTE_TEXT_PREVIEW_MAX_BYTES);
      const buffer = Buffer.alloc(previewSize);
      await handle.read(buffer, 0, previewSize, 0);
      const sniffWindow = buffer.subarray(0, Math.min(8192, previewSize));
      if (sniffWindow.includes(0)) {
        return { success: true, data: { kind: 'binary', size: stat.size, truncated: false } };
      }
      return {
        success: true,
        data: {
          kind: 'text',
          content: buffer.toString('utf8'),
          size: stat.size,
          truncated: stat.size > REMOTE_TEXT_PREVIEW_MAX_BYTES,
        },
      };
    } finally {
      await handle.close();
    }
  } catch (err) {
    return mapFsError(err);
  }
}
