/**
 * 编辑工具行级补丁（ 候选 B）。
 *
 * 在 `edit_file` / `write_file` / `delete_file` 写盘同一临界区捕获操作前后完整文件，
 * 经 `ToolResult.hostMetadata.fileEditPatch` 交给宿主 afterToolResult 落本机账本。
 * hunk 级 `before`/`after` 仍保留（edit_file 为匹配片段）以兼容旧账本。
 * 不进 LLM、不落后端；`run_terminal_command` 不产生本结构。
 */
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

export const FILE_EDIT_PATCH_HOST_KEY = 'fileEditPatch';

export const FILE_EDIT_PATCH_TOOL_NAMES = [
  'edit_file',
  'write_file',
  'delete_file',
] as const;

export type FileEditPatchToolName = (typeof FILE_EDIT_PATCH_TOOL_NAMES)[number];

export const FILE_EDIT_PATCH_TOOL_NAME_SET: ReadonlySet<string> = new Set(
  FILE_EDIT_PATCH_TOOL_NAMES,
);

/** 单侧正文保护上限：超限标 unreadable，不伪造 Diff。 */
export const MAX_FILE_EDIT_PATCH_CHARS = 400_000;
export const MAX_FILE_EDIT_PATCH_BYTES = 400_000;

export type FileEditPatchStatus = 'modified' | 'added' | 'deleted' | 'unreadable';

export interface FileEditPatch {
  toolName: FileEditPatchToolName;
  relativePath: string;
  status: FileEditPatchStatus;
  /** edit_file 为匹配片段；write/delete 为整文件。旧账本兼容字段。 */
  before?: string;
  after?: string;
  /** 写盘前完整文件正文；新建文件省略。 */
  beforeFull?: string;
  /** 写盘后完整文件正文；删除文件省略。 */
  afterFull?: string;
  binary?: boolean;
  truncated?: boolean;
}

export type FileBeforeSnapshot =
  | { kind: 'absent' }
  | { kind: 'text'; text: string }
  | { kind: 'binary' }
  | { kind: 'too_large' }
  | { kind: 'unreadable' };

function isEnoent(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT',
  );
}

function bufferLooksBinary(buf: Buffer): boolean {
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return false;
  }
  if (
    buf.length >= 2
    && ((buf[0] === 0xFF && buf[1] === 0xFE) || (buf[0] === 0xFE && buf[1] === 0xFF))
  ) {
    return false;
  }
  const checkLen = Math.min(8000, buf.length);
  for (let i = 0; i < checkLen; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function normalizeCapturedText(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function stringArrayField(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((item) => typeof item === 'string')) return null;
  return value;
}

function withinPatchLimit(text: string): boolean {
  return text.length <= MAX_FILE_EDIT_PATCH_CHARS
    && Buffer.byteLength(text, 'utf8') <= MAX_FILE_EDIT_PATCH_BYTES;
}

function unreadablePatch(
  toolName: FileEditPatchToolName,
  relativePath: string,
  flags?: { binary?: boolean; truncated?: boolean },
): FileEditPatch {
  return {
    toolName,
    relativePath,
    status: 'unreadable',
    ...(flags?.binary ? { binary: true } : {}),
    ...(flags?.truncated ? { truncated: true } : {}),
  };
}

export function isFileEditPatchToolName(name: string): name is FileEditPatchToolName {
  return FILE_EDIT_PATCH_TOOL_NAME_SET.has(name);
}

export function relativizeWorkspacePath(absPath: string, wsRoot: string): string {
  const relative = path.relative(wsRoot, absPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return absPath.split(path.sep).join('/');
  }
  return relative.split(path.sep).join('/');
}

/** 读完整文件快照（写前 / 写后共用）。 */
export async function captureFileBeforeSnapshot(absPath: string): Promise<FileBeforeSnapshot> {
  try {
    const stat = await fsPromises.stat(absPath);
    if (!stat.isFile()) return { kind: 'unreadable' };
    if (stat.size > MAX_FILE_EDIT_PATCH_BYTES) return { kind: 'too_large' };
    const buf = await fsPromises.readFile(absPath);
    if (bufferLooksBinary(buf)) return { kind: 'binary' };
    const text = normalizeCapturedText(buf.toString('utf8'));
    if (!withinPatchLimit(text)) return { kind: 'too_large' };
    return { kind: 'text', text };
  } catch (error) {
    if (isEnoent(error)) return { kind: 'absent' };
    return { kind: 'unreadable' };
  }
}

function attachFullSnapshots(
  patch: FileEditPatch,
  before: FileBeforeSnapshot,
  after: FileBeforeSnapshot | undefined,
): FileEditPatch {
  if (patch.status === 'unreadable') return patch;

  const next: FileEditPatch = { ...patch };
  if (before.kind === 'text') next.beforeFull = before.text;

  if (patch.toolName === 'delete_file') {
    return next;
  }

  if (after?.kind === 'text') {
    next.afterFull = after.text;
    return next;
  }
  if (after?.kind === 'binary') {
    next.binary = true;
    return next;
  }
  if (after?.kind === 'too_large') {
    next.truncated = true;
    return next;
  }

  // write_file 的 hunk 已是全文：无写后快照时与 before/after 对齐。
  if (patch.toolName === 'write_file' && typeof patch.after === 'string') {
    next.afterFull = patch.after;
    if (typeof patch.before === 'string') next.beforeFull = patch.before;
  }
  return next;
}

export function buildFileEditPatch(args: {
  toolName: FileEditPatchToolName;
  relativePath: string;
  before: FileBeforeSnapshot;
  input: Record<string, unknown>;
  data?: Record<string, unknown>;
  after?: FileBeforeSnapshot;
}): FileEditPatch {
  const relativePath = args.relativePath.trim() || String(args.input.path ?? '');
  if (!relativePath) {
    return unreadablePatch(args.toolName, '');
  }

  if (args.before.kind === 'binary') {
    return unreadablePatch(args.toolName, relativePath, { binary: true });
  }
  if (args.before.kind === 'too_large') {
    return unreadablePatch(args.toolName, relativePath, { truncated: true });
  }
  if (args.before.kind === 'unreadable') {
    return unreadablePatch(args.toolName, relativePath);
  }

  let patch: FileEditPatch;
  if (args.toolName === 'edit_file') {
    const oldLines = stringArrayField(args.data?.old_lines);
    const newLines = stringArrayField(args.data?.new_lines);
    if (!oldLines || !newLines) {
      return unreadablePatch(args.toolName, relativePath);
    }
    const before = oldLines.join('\n');
    const after = newLines.join('\n');
    if (!withinPatchLimit(before) || !withinPatchLimit(after)) {
      return unreadablePatch(args.toolName, relativePath, { truncated: true });
    }
    patch = {
      toolName: 'edit_file',
      relativePath,
      status: 'modified',
      before,
      after,
    };
  } else if (args.toolName === 'write_file') {
    const contents = args.input.contents;
    if (typeof contents !== 'string') {
      return unreadablePatch(args.toolName, relativePath);
    }
    const append = Boolean(args.input.append);
    if (append) {
      const before = args.before.kind === 'text' ? args.before.text : '';
      const after = `${before}${contents}`;
      if (!withinPatchLimit(before) || !withinPatchLimit(after)) {
        return unreadablePatch(args.toolName, relativePath, { truncated: true });
      }
      patch = {
        toolName: 'write_file',
        relativePath,
        status: args.before.kind === 'absent' ? 'added' : 'modified',
        ...(args.before.kind === 'text' ? { before } : {}),
        after,
      };
    } else if (!withinPatchLimit(contents)) {
      return unreadablePatch(args.toolName, relativePath, { truncated: true });
    } else if (args.before.kind === 'absent') {
      patch = {
        toolName: 'write_file',
        relativePath,
        status: 'added',
        after: contents,
      };
    } else if (!withinPatchLimit(args.before.text)) {
      return unreadablePatch(args.toolName, relativePath, { truncated: true });
    } else {
      patch = {
        toolName: 'write_file',
        relativePath,
        status: 'modified',
        before: args.before.text,
        after: contents,
      };
    }
  } else if (args.before.kind === 'absent') {
    patch = {
      toolName: 'delete_file',
      relativePath,
      status: 'deleted',
    };
  } else if (!withinPatchLimit(args.before.text)) {
    return unreadablePatch(args.toolName, relativePath, { truncated: true });
  } else {
    patch = {
      toolName: 'delete_file',
      relativePath,
      status: 'deleted',
      before: args.before.text,
    };
  }

  return attachFullSnapshots(patch, args.before, args.after);
}

export function readFileEditPatch(
  hostMetadata: Record<string, unknown> | undefined,
): FileEditPatch | null {
  if (!hostMetadata) return null;
  const raw = hostMetadata[FILE_EDIT_PATCH_HOST_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const patch = raw as Record<string, unknown>;
  if (!isFileEditPatchToolName(String(patch.toolName ?? ''))) return null;
  if (typeof patch.relativePath !== 'string' || !patch.relativePath.trim()) return null;
  const status = patch.status;
  if (
    status !== 'modified'
    && status !== 'added'
    && status !== 'deleted'
    && status !== 'unreadable'
  ) {
    return null;
  }
  const result: FileEditPatch = {
    toolName: patch.toolName as FileEditPatchToolName,
    relativePath: patch.relativePath,
    status,
  };
  if (typeof patch.before === 'string') result.before = patch.before;
  if (typeof patch.after === 'string') result.after = patch.after;
  if (typeof patch.beforeFull === 'string') result.beforeFull = patch.beforeFull;
  if (typeof patch.afterFull === 'string') result.afterFull = patch.afterFull;
  if (patch.binary === true) result.binary = true;
  if (patch.truncated === true) result.truncated = true;
  return result;
}
