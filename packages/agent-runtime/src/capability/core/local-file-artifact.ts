/**
 * LocalFileArtifact —— 工作目录本地文件交付卡片的协议 helper。
 *
 * runtime 只收口「识别 / 展示 / 打开」协议，不提供文件生成实现。文件内容
 * 由 Agent 先通过 CLI / shell / 专用工具生成；交付时由 present_to_user 的
 * `local_file` item 复用这里的校验和 rich block 构造。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const MISSING_WORKSPACE_ERROR =
  '当前 Agent 没有可用工作目录，不能把本地产物写到临时目录伪装成持久文件。请先设置或创建默认 Agent 工作目录。';

// 仅用于给 artifact payload 填 mime_type（协议要求非空）；不是文件类型能力表，
// 未知扩展名一律兜底 application/octet-stream。前端能不能预览由前端 registry 决定。
const MIME_BY_EXTENSION: Record<string, string> = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf': 'application/pdf',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};
const DEFAULT_MIME = 'application/octet-stream';

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * 剥掉 LLM 从 shell / next_step `%q` 抄进来的路径引号。
 * 支持成对包裹与孤立首/尾 `"` / `'`（如 `foo.m4a"`）。
 */
export function stripShellPathQuotes(input: string): string {
  let s = input.trim();
  if (
    s.length >= 2
    && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    s = s.slice(1, -1).trim();
  }
  while (s.startsWith('"') || s.startsWith("'")) s = s.slice(1);
  while (s.endsWith('"') || s.endsWith("'")) s = s.slice(0, -1);
  return s.trim();
}

function makeAutoOpenToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 宿主注入：由工作目录相对路径构造 artifact 打开 URL。runtime 不内置具体 URI 协议。 */
export type BuildArtifactUrl = (relativePath: string) => string;

/** 构造 local_file artifact 的 rich content block（kind='file'）。 */
export function buildLocalFileArtifactBlock(args: {
  fileType: string;
  mimeType: string;
  relativePath: string;
  fileSize: number;
  buildUrl: BuildArtifactUrl;
  summary?: string;
  selfCheckSummary?: string;
  autoOpen?: boolean;
  autoOpenToken?: string;
  autoRegister?: boolean;
  autoRegisterToken?: string;
}): { kind: 'file'; summary: string; payload: Record<string, unknown> } {
  const filename = path.posix.basename(args.relativePath);
  const summary = normalizeOptionalText(args.summary) || filename;
  const selfCheckSummary =
    normalizeOptionalText(args.selfCheckSummary) ||
    `已确认文件存在、位于当前工作目录内（${args.fileType}）。`;

  return {
    kind: 'file',
    summary,
    payload: {
      artifact_kind: 'local_file',
      file_type: args.fileType,
      relative_path: args.relativePath,
      filename,
      url: args.buildUrl(args.relativePath),
      mime_type: args.mimeType,
      file_size: args.fileSize,
      ...(args.autoOpen
        ? { auto_open: true, auto_open_token: args.autoOpenToken ?? makeAutoOpenToken() }
        : {}),
      ...(args.autoRegister
        ? { auto_register: true, auto_register_token: args.autoRegisterToken ?? makeAutoOpenToken() }
        : {}),
      self_check: {
        status: 'passed',
        summary: selfCheckSummary,
      },
    },
  };
}

export function resolveLocalFileArtifactTarget(
  workspaceRoot: string | undefined,
  relativePathInput: unknown,
):
  | { ok: true; absolutePath: string; relativePath: string; fileType: string; mimeType: string }
  | { ok: false; error: string } {
  const normalizedWorkspaceRoot = normalizeOptionalText(workspaceRoot);
  if (!normalizedWorkspaceRoot) {
    return { ok: false, error: MISSING_WORKSPACE_ERROR };
  }

  if (typeof relativePathInput !== 'string' || relativePathInput.trim().length === 0) {
    return {
      ok: false,
      error: '缺少 relative_path，请传入工作目录内的相对文件路径，例如 artifacts/report.xlsx。',
    };
  }

  const raw = relativePathInput.trim().replace(/\\/g, '/');
  if (path.isAbsolute(raw) || raw.startsWith('~')) {
    return { ok: false, error: 'relative_path 必须是相对当前工作目录的路径，不能是绝对路径或 ~ 路径。' };
  }

  const normalized = path.posix.normalize(raw);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    return { ok: false, error: 'relative_path 不能跳出当前工作目录。' };
  }

  const ext = path.posix.extname(normalized).toLowerCase();
  if (!ext) {
    return { ok: false, error: 'relative_path 需要带文件扩展名，例如 artifacts/report.xlsx。' };
  }

  const root = path.resolve(normalizedWorkspaceRoot);
  const absolutePath = path.resolve(root, normalized);
  const relativeFromRoot = path.relative(root, absolutePath);
  if (
    relativeFromRoot === '' ||
    relativeFromRoot.startsWith('..') ||
    path.isAbsolute(relativeFromRoot)
  ) {
    return { ok: false, error: 'relative_path 解析后不在当前工作目录内。' };
  }

  return {
    ok: true,
    absolutePath,
    relativePath: normalized,
    fileType: ext.slice(1),
    mimeType: MIME_BY_EXTENSION[ext] ?? DEFAULT_MIME,
  };
}

export async function statLocalFileArtifact(
  workspaceRoot: string | undefined,
  relativePathInput: unknown,
):
  Promise<
    | {
      ok: true;
      absolutePath: string;
      relativePath: string;
      fileType: string;
      mimeType: string;
      fileSize: number;
    }
    | { ok: false; error: string }
  > {
  const rawInput =
    typeof relativePathInput === 'string' ? relativePathInput.trim() : '';
  const strippedInput = rawInput ? stripShellPathQuotes(rawInput.replace(/\\/g, '/')) : '';

  const candidates = Array.from(
    new Set([strippedInput, rawInput.replace(/\\/g, '/')].filter((p) => p.length > 0)),
  );

  let target:
    | { ok: true; absolutePath: string; relativePath: string; fileType: string; mimeType: string }
    | { ok: false; error: string }
    | null = null;

  for (const candidate of candidates) {
    const resolved = resolveLocalFileArtifactTarget(workspaceRoot, candidate);
    if (!resolved.ok) {
      target = resolved;
      continue;
    }
    try {
      const stat = await fs.stat(resolved.absolutePath);
      if (stat.isFile()) {
        return { ...resolved, fileSize: stat.size };
      }
      target = { ok: false, error: `目标路径不是文件：${resolved.relativePath}。` };
    } catch {
      target = { ok: false, error: `找不到文件：${resolved.relativePath}。请先用外部工具生成文件，再发布。` };
    }
  }

  return target && !target.ok
    ? target
    : { ok: false, error: '找不到文件。请先用外部工具生成文件，再发布。' };
}
