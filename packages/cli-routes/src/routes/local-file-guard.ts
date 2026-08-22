/**
 * cli-server 本地路径上传共用护栏（oss / drive 复用）。
 *
 * 规则与产品 UI 对齐：只允许 home / tmp 下的真实文件，拒绝 symlink，单文件 100MB。
 */

import { lstatSync, readdirSync, type Stats } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * 文件夹上传扩展名白名单。
 * SSoT：`apps/tabtin-electron/.../cloudFolderUpload.ts` 的 CLOUD_FOLDER_UPLOAD_EXTENSIONS。
 * 变更时两边一起改，避免 CLI 与 UI 漂移。
 */
export const CLOUD_FOLDER_UPLOAD_EXTENSIONS = [
  'doc',
  'docx',
  'pdf',
  'md',
  'markdown',
  'mark',
  'txt',
  'xlsx',
  'csv',
  'tsv',
  'pptx',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
] as const;

const FOLDER_UPLOAD_ALLOWED = new Set<string>(CLOUD_FOLDER_UPLOAD_EXTENSIONS);

const ALLOWED_PATH_PREFIXES = [
  homedir(),
  tmpdir(),
  '/tmp',
];

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.mark': 'text/markdown',
  '.html': 'text/html',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

export type LocalPathGuardError = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

export type GuardedLocalFile = {
  ok: true;
  resolved: string;
  fileName: string;
  size: number;
  lstat: Stats;
};

export type GuardedLocalDirectory = {
  ok: true;
  resolved: string;
  folderName: string;
};

export type CloudFolderSkipReason =
  | 'nested'
  | 'unsupported_type'
  | 'duplicate'
  | 'empty'
  | 'too_large';

export type CloudFolderFilePlan = {
  folderName: string;
  accepted: Array<{ resolved: string; fileName: string; size: number }>;
  skipped: Array<{ fileName: string; reason: CloudFolderSkipReason }>;
  skippedNestedCount: number;
  skippedTypeCount: number;
  skippedDuplicateCount: number;
  skippedEmptyCount: number;
  skippedTooLargeCount: number;
};

export function guessMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_MAP[ext] ?? 'application/octet-stream';
}

export function isPathAllowed(resolved: string): boolean {
  return ALLOWED_PATH_PREFIXES.some((prefix) => resolved.startsWith(prefix));
}

export function guardLocalFile(filePath: string): GuardedLocalFile | LocalPathGuardError {
  if (!filePath || typeof filePath !== 'string') {
    return { ok: false, status: 400, code: 'MISSING_PARAM', message: 'file_path is required' };
  }
  const resolved = resolve(filePath);
  if (!isPathAllowed(resolved)) {
    return {
      ok: false,
      status: 403,
      code: 'PATH_FORBIDDEN',
      message: 'File path must be under home or tmp directory',
    };
  }

  const lstat = lstatSync(resolved, { throwIfNoEntry: false });
  if (!lstat) {
    return { ok: false, status: 400, code: 'FILE_NOT_FOUND', message: `File not found: ${filePath}` };
  }
  if (lstat.isSymbolicLink()) {
    return { ok: false, status: 403, code: 'SYMLINK_FORBIDDEN', message: 'Symbolic links are not allowed' };
  }
  if (!lstat.isFile()) {
    return { ok: false, status: 400, code: 'NOT_A_FILE', message: `Not a regular file: ${filePath}` };
  }
  if (lstat.size > MAX_UPLOAD_BYTES) {
    const sizeMB = (lstat.size / (1024 * 1024)).toFixed(1);
    return {
      ok: false,
      status: 400,
      code: 'FILE_TOO_LARGE',
      message: `File is ${sizeMB}MB, max is 100MB`,
    };
  }

  return {
    ok: true,
    resolved,
    fileName: basename(resolved),
    size: lstat.size,
    lstat,
  };
}

export function guardLocalDirectory(dirPath: string): GuardedLocalDirectory | LocalPathGuardError {
  if (!dirPath || typeof dirPath !== 'string') {
    return { ok: false, status: 400, code: 'MISSING_PARAM', message: 'directory is required' };
  }
  const resolved = resolve(dirPath);
  if (!isPathAllowed(resolved)) {
    return {
      ok: false,
      status: 403,
      code: 'PATH_FORBIDDEN',
      message: 'Directory path must be under home or tmp directory',
    };
  }

  const lstat = lstatSync(resolved, { throwIfNoEntry: false });
  if (!lstat) {
    return { ok: false, status: 400, code: 'DIR_NOT_FOUND', message: `Directory not found: ${dirPath}` };
  }
  if (lstat.isSymbolicLink()) {
    return { ok: false, status: 403, code: 'SYMLINK_FORBIDDEN', message: 'Symbolic links are not allowed' };
  }
  if (!lstat.isDirectory()) {
    return { ok: false, status: 400, code: 'NOT_A_DIRECTORY', message: `Not a directory: ${dirPath}` };
  }

  return {
    ok: true,
    resolved,
    folderName: basename(resolved) || 'Folder',
  };
}

/**
 * 对齐 Electron `planCloudFolderUpload`：只收一级白名单文件，跳过子目录/空/超限/不支持类型。
 */
export function planLocalCloudFolderUpload(
  directoryPath: string,
  maxSizeBytes: number = MAX_UPLOAD_BYTES,
): CloudFolderFilePlan | LocalPathGuardError {
  const guarded = guardLocalDirectory(directoryPath);
  if (!guarded.ok) return guarded;

  const entries = readdirSync(guarded.resolved, { withFileTypes: true });
  const accepted: CloudFolderFilePlan['accepted'] = [];
  const skipped: CloudFolderFilePlan['skipped'] = [];
  const seenFileNames = new Set<string>();
  let skippedNestedCount = 0;
  let skippedTypeCount = 0;
  let skippedDuplicateCount = 0;
  let skippedEmptyCount = 0;
  let skippedTooLargeCount = 0;

  for (const entry of entries) {
    const fileName = entry.name;
    const fullPath = resolve(guarded.resolved, fileName);

    if (entry.isSymbolicLink()) {
      skippedTypeCount += 1;
      skipped.push({ fileName, reason: 'unsupported_type' });
      continue;
    }

    if (entry.isDirectory()) {
      skippedNestedCount += 1;
      skipped.push({ fileName: `${fileName}/`, reason: 'nested' });
      continue;
    }

    if (!entry.isFile()) {
      skippedTypeCount += 1;
      skipped.push({ fileName, reason: 'unsupported_type' });
      continue;
    }

    const lstat = lstatSync(fullPath, { throwIfNoEntry: false });
    if (!lstat || !lstat.isFile()) {
      skippedTypeCount += 1;
      skipped.push({ fileName, reason: 'unsupported_type' });
      continue;
    }

    if (lstat.size === 0) {
      skippedEmptyCount += 1;
      skipped.push({ fileName, reason: 'empty' });
      continue;
    }

    if (lstat.size > maxSizeBytes) {
      skippedTooLargeCount += 1;
      skipped.push({ fileName, reason: 'too_large' });
      continue;
    }

    const ext = extname(fileName).toLowerCase().replace(/^\./, '');
    if (!FOLDER_UPLOAD_ALLOWED.has(ext)) {
      skippedTypeCount += 1;
      skipped.push({ fileName, reason: 'unsupported_type' });
      continue;
    }

    const dedupeKey = fileName.toLowerCase();
    if (seenFileNames.has(dedupeKey)) {
      skippedDuplicateCount += 1;
      skipped.push({ fileName, reason: 'duplicate' });
      continue;
    }
    seenFileNames.add(dedupeKey);

    accepted.push({ resolved: fullPath, fileName, size: lstat.size });
  }

  return {
    folderName: guarded.folderName,
    accepted,
    skipped,
    skippedNestedCount,
    skippedTypeCount,
    skippedDuplicateCount,
    skippedEmptyCount,
    skippedTooLargeCount,
  };
}

/** 把 uploadFileToOSS 的 errorCode 映射为 HTTP 状态码 + envelope 错误码。 */
export function mapUploadErrorCode(errorCode?: string): { status: number; code: string } {
  switch (errorCode) {
    case 'no-auth':
    case 'auth-expired':
      return { status: 401, code: 'UNAUTHORIZED' };
    case 'permission-denied':
      return { status: 403, code: 'PERMISSION_DENIED' };
    case 'rate-limit':
      return { status: 429, code: 'RATE_LIMIT_EXCEEDED' };
    case 'quota-exceeded':
      return { status: 400, code: 'STORAGE_QUOTA_EXCEEDED' };
    case 'billing-blocked':
      return { status: 402, code: 'BILLING_BLOCKED' };
    case 'context-id-required':
      return { status: 400, code: 'VALIDATION_ERROR' };
    case 'no-api-base':
      return { status: 503, code: 'UNAVAILABLE' };
    default:
      return { status: 500, code: 'UPLOAD_FAILED' };
  }
}
