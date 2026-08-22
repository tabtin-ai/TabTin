/**
 * OSS 云端文件交付物 —— 从 `tabtin oss upload` 成功 stdout 解析并发布卡片。
 *
 * ：从 `capability/core/` 整文件迁到宿主共享位置（core 去业务化）。
 * upload 成功 → emit `artifact_kind: oss_file` → 流内 RichFile + 本轮产物。
 * 行为与迁移前**字节级一致**。
 *
 * @see GitHub  /
 */

import * as path from 'node:path';
import { splitShellCommandSegments } from './shell-command-segments.js';

const FILE_RECORD_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MIME_BY_EXTENSION: Record<string, string> = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf': 'application/pdf',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
};
const DEFAULT_MIME = 'application/octet-stream';

export interface ParsedOssUploadResult {
  fileId: string;
  accessUrl: string;
  filename: string;
  mimeType: string;
  fileType: string;
  fileSize?: number;
}

function makeAutoOpenToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unwrapEnvelope(parsed: unknown, depth = 0): unknown {
  if (depth > 3) return parsed;
  if (!isRecord(parsed)) return parsed;
  if ((parsed.ok === true || parsed.success === true) && 'data' in parsed) {
    return unwrapEnvelope(parsed.data, depth + 1);
  }
  return parsed;
}

/** 是否为 `tabtin oss upload`(允许 `cd ... &&` / env 前缀)。 */
export function isOssUploadCommand(command: string): boolean {
  if (typeof command !== 'string' || !command.trim()) return false;
  const segments = splitShellCommandSegments(command);
  for (const seg of segments) {
    const tokens = seg.split(/\s+/).filter((t) => t.length > 0);
    let i = 0;
    while (
      i < tokens.length
      && (/^[A-Z_][A-Z0-9_]*=/.test(tokens[i]) || tokens[i] === 'sudo' || tokens[i] === 'exec')
    ) {
      i++;
    }
    if (tokens[i] === 'cd') continue;
    if (tokens[i] === 'tabtin' && tokens[i + 1] === 'oss' && tokens[i + 2] === 'upload') {
      return true;
    }
  }
  return false;
}

/** 从 `tabtin oss upload <path>` 抽出本地路径 basename。 */
export function extractOssUploadFilename(command: string): string | null {
  if (!isOssUploadCommand(command)) return null;
  const segments = splitShellCommandSegments(command);
  for (const seg of segments) {
    const tokens = seg.split(/\s+/).filter((t) => t.length > 0);
    let i = 0;
    while (
      i < tokens.length
      && (/^[A-Z_][A-Z0-9_]*=/.test(tokens[i]) || tokens[i] === 'sudo' || tokens[i] === 'exec')
    ) {
      i++;
    }
    if (tokens[i] !== 'tabtin' || tokens[i + 1] !== 'oss' || tokens[i + 2] !== 'upload') continue;
    // 位置参数或 --file-path
    for (let j = i + 3; j < tokens.length; j++) {
      const t = tokens[j];
      if (t === '--file-path' || t === '--file_path') {
        const next = tokens[j + 1];
        if (next && !next.startsWith('-')) {
          return path.posix.basename(next.replace(/\\/g, '/'));
        }
        continue;
      }
      if (t.startsWith('--file-path=') || t.startsWith('--file_path=')) {
        const v = t.slice(t.indexOf('=') + 1);
        if (v) return path.posix.basename(v.replace(/\\/g, '/'));
        continue;
      }
      if (t.startsWith('-')) {
        // flag with optional value
        if (
          t === '--folder'
          || t === '--module'
          || t === '--mime-type'
          || t === '--mime_type'
          || t === '--format'
          || t === '-o'
          || t === '--context-id'
          || t === '--organization-id'
        ) {
          j++; // skip value
        }
        continue;
      }
      return path.posix.basename(t.replace(/\\/g, '/'));
    }
  }
  return null;
}

function guessMimeAndType(filename: string): { mimeType: string; fileType: string } {
  const ext = path.posix.extname(filename).toLowerCase();
  return {
    mimeType: MIME_BY_EXTENSION[ext] ?? DEFAULT_MIME,
    fileType: ext ? ext.slice(1) : 'bin',
  };
}

function readOssFields(data: Record<string, unknown>): {
  fileId: string;
  accessUrl: string;
  fileSize?: number;
  mimeType?: string;
  filename?: string;
} | null {
  const fileId = normalizeOptionalText(data.file_id) ?? normalizeOptionalText(data.fileId);
  const accessUrl =
    normalizeOptionalText(data.cdn_url)
    ?? normalizeOptionalText(data.cdnUrl)
    ?? normalizeOptionalText(data.url)
    ?? normalizeOptionalText(data.access_url)
    ?? normalizeOptionalText(data.accessUrl);
  if (!fileId || !FILE_RECORD_ID_RE.test(fileId) || !accessUrl) return null;
  const sizeRaw = data.file_size ?? data.fileSize ?? data.size;
  const fileSize =
    typeof sizeRaw === 'number' && Number.isFinite(sizeRaw) && sizeRaw >= 0
      ? Math.floor(sizeRaw)
      : undefined;
  return {
    fileId,
    accessUrl,
    fileSize,
    mimeType: normalizeOptionalText(data.mime_type) ?? normalizeOptionalText(data.mimeType),
    filename:
      normalizeOptionalText(data.filename)
      ?? normalizeOptionalText(data.file_name)
      ?? normalizeOptionalText(data.fileName),
  };
}

/** 尝试从 stdout 抽出 JSON 对象(支持纯 JSON / 前后噪音中的首个 `{...}`)。 */
function tryExtractJsonObject(stdout: string): unknown | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  if (trimmed[0] === '{') {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through to brace scan
    }
  }
  const start = trimmed.indexOf('{');
  if (start < 0) return null;
  // 粗扫描：从第一个 { 起找平衡括号(字符串内括号忽略不全,够用)
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * 解析 agent format 文本行(`file_id: uuid` / `url: https://...`)。
 * Go CLI 默认 format 可能不是 json,需兜底。
 */
function parseAgentTextOssFields(stdout: string): {
  fileId: string;
  accessUrl: string;
} | null {
  const fileIdMatch = stdout.match(/\bfile_id\s*[:=]\s*([0-9a-fA-F-]{36})\b/);
  const urlMatch =
    stdout.match(/\b(?:cdn_url|access_url|url)\s*[:=]\s*(https?:\/\/\S+)/i)
    ?? stdout.match(/\b(https?:\/\/\S+)/);
  if (!fileIdMatch || !urlMatch) return null;
  const fileId = fileIdMatch[1];
  const accessUrl = urlMatch[1].replace(/[,，。；;]+$/, '');
  if (!FILE_RECORD_ID_RE.test(fileId) || !accessUrl) return null;
  return { fileId, accessUrl };
}

/** 从 `tabtin oss upload` 的 command + stdout 解析交付物字段。 */
export function parseOssUploadResult(
  command: string,
  stdout: string,
): ParsedOssUploadResult | null {
  if (!isOssUploadCommand(command) || typeof stdout !== 'string') return null;

  let fields: ReturnType<typeof readOssFields> = null;
  const json = tryExtractJsonObject(stdout);
  if (json) {
    const unwrapped = unwrapEnvelope(json);
    if (isRecord(unwrapped)) {
      fields = readOssFields(unwrapped);
    }
  }
  if (!fields) {
    const agent = parseAgentTextOssFields(stdout);
    if (!agent) return null;
    fields = { fileId: agent.fileId, accessUrl: agent.accessUrl };
  }

  const filename =
    fields.filename
    ?? extractOssUploadFilename(command)
    ?? 'upload.bin';
  const guessed = guessMimeAndType(filename);
  return {
    fileId: fields.fileId,
    accessUrl: fields.accessUrl,
    filename,
    mimeType: fields.mimeType ?? guessed.mimeType,
    fileType: guessed.fileType,
    fileSize: fields.fileSize,
  };
}

/** 构造 oss_file artifact 的 rich content block(kind='file')。 */
export function buildOssFileArtifactBlock(args: {
  fileId: string;
  accessUrl: string;
  filename: string;
  mimeType: string;
  fileType: string;
  fileSize?: number;
  summary?: string;
  autoOpen?: boolean;
  autoOpenToken?: string;
  autoRegister?: boolean;
  autoRegisterToken?: string;
}): { kind: 'file'; summary: string; payload: Record<string, unknown> } {
  const filename = path.posix.basename(args.filename.replace(/\\/g, '/')) || 'upload.bin';
  const summary = normalizeOptionalText(args.summary) || filename;
  const params = new URLSearchParams({ hint: 'tabfiles', title: filename });
  if (args.autoOpen) params.set('auto_open', '1');
  const token = args.autoOpenToken ?? (args.autoOpen ? makeAutoOpenToken() : undefined);
  if (token) params.set('auto_open_token', token);
  const registerToken = args.autoRegisterToken
    ?? (args.autoRegister ? makeAutoOpenToken() : undefined);
  if (args.autoRegister) params.set('auto_register', '1');
  if (registerToken) params.set('auto_register_token', registerToken);

  return {
    kind: 'file',
    summary,
    payload: {
      artifact_kind: 'oss_file',
      file_id: args.fileId,
      file_type: args.fileType,
      filename,
      url: `tabtin://resource/file/${encodeURIComponent(args.fileId)}?${params.toString()}`,
      mime_type: args.mimeType,
      ...(typeof args.fileSize === 'number' ? { file_size: args.fileSize } : {}),
      access_url: args.accessUrl,
      ...(args.autoOpen
        ? { auto_open: true, auto_open_token: token }
        : {}),
      ...(args.autoRegister
        ? { auto_register: true, auto_register_token: registerToken }
        : {}),
      self_check: {
        status: 'passed',
        summary: 'OSS upload succeeded; FileRecord created.',
      },
    },
  };
}

/** 从 command + stdout 构建可 emit 的 block;失败返回 null。 */
export function buildOssFileArtifactBlockFromUpload(
  command: string,
  stdout: string,
): { kind: 'file'; summary: string; payload: Record<string, unknown> } | null {
  const parsed = parseOssUploadResult(command, stdout);
  if (!parsed) return null;
  return buildOssFileArtifactBlock({
    fileId: parsed.fileId,
    accessUrl: parsed.accessUrl,
    filename: parsed.filename,
    mimeType: parsed.mimeType,
    fileType: parsed.fileType,
    fileSize: parsed.fileSize,
    autoRegister: true,
  });
}
