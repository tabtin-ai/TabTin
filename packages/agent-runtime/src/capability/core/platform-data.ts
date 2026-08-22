import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  Tool,
  ToolContext,
  ToolResult,
} from '../../engine/contracts/tools.js';
import type { CapabilityCategory } from '../capability.js';
import { CapabilityBase } from '../base.js';
import {
  applyGrep,
  clampMaxChars,
  isPathInside,
  isSafePathSegment,
  jsonResult,
  permissionDenied,
  readInteger,
  readString,
} from './bounded-read.js';

export interface PlatformDataCapConfig {
  archiveDir: string;
  toolLogsDir: string;
  archiveSessionId: string;
  toolLogsSessionId: string;
}

type PlatformDataRecordType = 'messages' | 'events' | 'snapshots' | 'tool_logs';

const DEFAULT_MAX_CHARS = 8_000;
const HARD_MAX_CHARS = 40_000;
const TOOL_LOG_INDEX_LIMIT = 200;

function readRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
}

function readRecordType(input: unknown): PlatformDataRecordType | undefined {
  if (input === 'messages' || input === 'events' || input === 'snapshots' || input === 'tool_logs') {
    return input;
  }
  return undefined;
}

function sliceContent(content: string, offset: number, maxChars: number): { content: string; truncated: boolean } {
  const safeOffset = Math.max(0, offset);
  const sliced = content.slice(safeOffset, safeOffset + maxChars);
  return {
    content: sliced,
    truncated: safeOffset + maxChars < content.length,
  };
}

/**
 * 在**已解析为真实路径**的 session 根目录下校验单个记录文件。
 *
 * 调用方先经 `resolveSessionDir` 拿到 `sessionRealDir`（已做 realpath + 软链 +
 * 越界校验），这里只需确认目标文件本身是常规文件、不是软链、且 realpath 后仍落在
 * 该根目录内（防软链逃逸）。
 */
async function resolveRegularFileUnder(sessionRealDir: string, filePath: string): Promise<string | ToolResult> {
  try {
    const fileStat = await fs.promises.lstat(filePath);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      return permissionDenied('platform data record must be a regular file.');
    }

    const fileReal = await fs.promises.realpath(filePath);
    if (!isPathInside(sessionRealDir, fileReal)) {
      return permissionDenied('platform data record resolved outside its root.');
    }
    return fileReal;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return jsonResult({
        success: false,
        error_kind: 'not_found',
        error: 'platform data record does not exist on this execution device.',
      }, true);
    }
    return jsonResult({
      success: false,
      error_kind: 'read_failed',
      error: 'failed to resolve platform data record.',
    }, true);
  }
}

async function resolveSessionDir(parent: string, sessionId: string): Promise<string | ToolResult> {
  if (!isSafePathSegment(sessionId)) {
    return jsonResult({
      success: false,
      error_kind: 'invalid_session_id',
      error: 'configured session id is not safe for platform data reads.',
    }, true);
  }

  const root = path.resolve(parent);
  const sessionDir = path.resolve(root, sessionId);
  if (!isPathInside(root, sessionDir)) {
    return permissionDenied('platform data session path escaped its root.');
  }

  try {
    const [rootReal, sessionStat] = await Promise.all([
      fs.promises.realpath(root),
      fs.promises.lstat(sessionDir),
    ]);
    if (sessionStat.isSymbolicLink() || !sessionStat.isDirectory()) {
      return permissionDenied('platform data session must be a real directory.');
    }

    const sessionReal = await fs.promises.realpath(sessionDir);
    if (!isPathInside(rootReal, sessionReal)) {
      return permissionDenied('platform data session resolved outside its root.');
    }
    return sessionReal;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return jsonResult({
        success: false,
        error_kind: 'not_found',
        error: 'platform data session does not exist on this execution device.',
      }, true);
    }
    return jsonResult({
      success: false,
      error_kind: 'read_failed',
      error: 'failed to resolve platform data session.',
    }, true);
  }
}

function archiveFilename(recordType: PlatformDataRecordType): string | undefined {
  if (recordType === 'messages') return 'messages.jsonl';
  if (recordType === 'events') return 'events.jsonl';
  if (recordType === 'snapshots') return 'snapshots.jsonl';
  return undefined;
}

async function readBoundedFile(params: {
  sessionRealDir: string;
  filePath: string;
  recordType: PlatformDataRecordType;
  grep: string | undefined;
  offset: number;
  maxChars: number;
}): Promise<ToolResult> {
  const resolved = await resolveRegularFileUnder(params.sessionRealDir, params.filePath);
  if (typeof resolved !== 'string') return resolved;

  let raw: string;
  try {
    raw = await fs.promises.readFile(resolved, 'utf-8');
  } catch {
    return jsonResult({
      success: false,
      error_kind: 'read_failed',
      error: 'failed to read platform data record.',
    }, true);
  }
  const filtered = applyGrep(raw, params.grep);
  const sliced = sliceContent(filtered, params.offset, params.maxChars);
  return jsonResult({
    success: true,
    record_type: params.recordType,
    grep: params.grep,
    offset: params.offset,
    max_chars: params.maxChars,
    truncated: sliced.truncated,
    content: sliced.content,
  });
}

export class PlatformDataCap extends CapabilityBase {
  readonly type = 'platform_data';
  readonly category: CapabilityCategory = 'core';

  constructor(private readonly config: PlatformDataCapConfig) {
    super();
  }

  tools(): Tool[] {
    return [
      {
        name: 'read_platform_data',
        policyActionKind: 'object_read',
        isReadOnly: true,
        description:
          'Read a bounded slice of current-session platform-managed conversation records without exposing local paths. ' +
          'Supports messages, events, snapshots, and tool_logs. Use grep, offset, and max_chars to keep reads narrow.',
        inputSchema: {
          type: 'object',
          properties: {
            record_type: {
              type: 'string',
              enum: ['messages', 'events', 'snapshots', 'tool_logs'],
              description: 'Current-session record kind.',
            },
            tool_log_id: {
              type: 'string',
              maxLength: 160,
              description: 'For tool_logs; omit to list ids.',
            },
            grep: {
              type: 'string',
              maxLength: 500,
              description: 'Case-insensitive line filter.',
            },
            offset: {
              type: 'integer',
              minimum: 0,
              description: 'Character offset after filtering.',
            },
            max_chars: {
              type: 'integer',
              minimum: 1,
              maximum: HARD_MAX_CHARS,
              description: `Max returned chars; default ${DEFAULT_MAX_CHARS}, cap ${HARD_MAX_CHARS}.`,
            },
          },
          required: ['record_type'],
          additionalProperties: false,
        } as Tool['inputSchema'],
        execute: async (input: unknown, _context: ToolContext): Promise<ToolResult> => {
          const record = readRecord(input);
          const recordType = readRecordType(record.record_type);
          if (!recordType) {
            return jsonResult({
              success: false,
              error_kind: 'invalid_param_format',
              error: 'record_type must be one of messages, events, snapshots, or tool_logs.',
            }, true);
          }

          const grep = readString(record.grep);
          const offset = readInteger(record.offset) ?? 0;
          const maxChars = clampMaxChars(record.max_chars, DEFAULT_MAX_CHARS, HARD_MAX_CHARS);

          if (recordType !== 'tool_logs') {
            const filename = archiveFilename(recordType);
            if (!filename) {
              return jsonResult({
                success: false,
                error_kind: 'invalid_param_format',
                error: 'unsupported platform data record type.',
              }, true);
            }
            const sessionDir = await resolveSessionDir(this.config.archiveDir, this.config.archiveSessionId);
            if (typeof sessionDir !== 'string') return sessionDir;
            return readBoundedFile({
              sessionRealDir: sessionDir,
              filePath: path.join(sessionDir, filename),
              recordType,
              grep,
              offset,
              maxChars,
            });
          }

          const toolLogId = readString(record.tool_log_id);
          if (toolLogId && !isSafePathSegment(toolLogId)) {
            return jsonResult({
              success: false,
              error_kind: 'invalid_param_format',
              error: 'tool_log_id is not a safe platform data id.',
            }, true);
          }

          const toolLogsSessionDir = await resolveSessionDir(this.config.toolLogsDir, this.config.toolLogsSessionId);
          if (typeof toolLogsSessionDir !== 'string') return toolLogsSessionDir;

          if (!toolLogId) {
            let entries: fs.Dirent[];
            try {
              entries = await fs.promises.readdir(toolLogsSessionDir, { withFileTypes: true });
            } catch {
              return jsonResult({
                success: false,
                error_kind: 'read_failed',
                error: 'failed to list platform tool logs.',
              }, true);
            }
            const toolLogIds = entries
              .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
              .map((entry) => entry.name.slice(0, -'.md'.length))
              .filter((id) => isSafePathSegment(id))
              .sort()
              .slice(0, TOOL_LOG_INDEX_LIMIT);
            return jsonResult({
              success: true,
              record_type: recordType,
              mode: 'index',
              tool_log_ids: toolLogIds,
              truncated: entries.length > TOOL_LOG_INDEX_LIMIT,
            });
          }

          return readBoundedFile({
            sessionRealDir: toolLogsSessionDir,
            filePath: path.join(toolLogsSessionDir, `${toolLogId}.md`),
            recordType,
            grep,
            offset,
            maxChars,
          });
        },
      },
    ];
  }
}
