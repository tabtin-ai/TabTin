import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
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

export interface RawRefCapConfig {
  toolLogsDir: string;
  sessionId: string;
  toolResultsDir?: string;
}

const RAW_REF_RE = /^tool-log:\/\/([^/]+)\/([^/]+)$/;
const DEFAULT_MAX_CHARS = 4_000;
const HARD_MAX_CHARS = 20_000;

function readRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined;
}

function readInputRecord(input: unknown): Record<string, unknown> {
  return readRecord(input) ?? {};
}

function parseJsonRecord(input: string | undefined): Record<string, unknown> | undefined {
  if (!input) return undefined;
  try {
    return readRecord(JSON.parse(input.trim()));
  } catch {
    return undefined;
  }
}

function parseRawRef(rawRef: string): { sessionId: string; toolCallId: string } | null {
  const match = RAW_REF_RE.exec(rawRef);
  if (!match) return null;
  const [, sessionId, toolCallId] = match;
  if (
    !sessionId ||
    !toolCallId ||
    !isSafePathSegment(sessionId) ||
    !isSafePathSegment(toolCallId)
  ) {
    return null;
  }
  return { sessionId, toolCallId };
}

function extractMarkdownSection(content: string, heading: string): string | undefined {
  const lines = content.split(/\r?\n/);
  const marker = `## ${heading}`;
  const start = lines.findIndex((line) => line.trim() === marker);
  if (start < 0) return undefined;

  const end = lines.findIndex((line, index) => index > start && /^##\s+/.test(line.trim()));
  const sectionLines = lines.slice(start + 1, end < 0 ? undefined : end);
  const section = sectionLines.join('\n').trim();
  return section.length > 0 ? section : undefined;
}

function extractTerminalFullOutputPath(toolLogContent: string): string | undefined {
  const outputSection = extractMarkdownSection(toolLogContent, 'Output');
  const output = parseJsonRecord(outputSection);
  return readString(output?.full_output_path) ?? readString(output?.persisted_output_path);
}

function defaultToolResultsDir(): string {
  return path.join(tmpdir(), 'tabtin-tool-results');
}

function isExpectedTerminalStdoutFile(candidatePath: string, toolCallId: string): boolean {
  return path.basename(candidatePath) === `shell-${toolCallId}-stdout.log`;
}

async function resolveTerminalFullOutputFile(params: {
  candidatePath: string | undefined;
  toolResultsDir: string;
  sessionId: string;
  toolCallId: string;
}): Promise<string | undefined> {
  const { candidatePath, toolResultsDir, sessionId, toolCallId } = params;
  if (!candidatePath || !path.isAbsolute(candidatePath)) return undefined;
  if (!isExpectedTerminalStdoutFile(candidatePath, toolCallId)) return undefined;

  const toolResultsRoot = path.resolve(toolResultsDir);
  const sessionDir = path.resolve(toolResultsRoot, sessionId);
  if (!fs.existsSync(toolResultsRoot) || !fs.existsSync(sessionDir) || !fs.existsSync(candidatePath)) {
    return undefined;
  }

  try {
    const [rootReal, sessionStat, fileStat] = await Promise.all([
      fs.promises.realpath(toolResultsRoot),
      fs.promises.lstat(sessionDir),
      fs.promises.lstat(candidatePath),
    ]);
    if (sessionStat.isSymbolicLink() || fileStat.isSymbolicLink() || !fileStat.isFile()) {
      return undefined;
    }

    const [sessionReal, fileReal] = await Promise.all([
      fs.promises.realpath(sessionDir),
      fs.promises.realpath(candidatePath),
    ]);
    if (!isPathInside(rootReal, sessionReal)) return undefined;
    if (!isPathInside(sessionReal, fileReal)) return undefined;
    return fileReal;
  } catch {
    return undefined;
  }
}

type RawRefRequest =
  | {
      ok: true;
      record: Record<string, unknown>;
      rawRef: string;
      parsed: { sessionId: string; toolCallId: string };
    }
  | { ok: false; result: ToolResult };

function parseRawRefRequest(input: unknown, currentSessionId: string): RawRefRequest {
  const record = readInputRecord(input);
  const rawRef = readString(record.raw_ref);
  if (!rawRef) {
    return {
      ok: false,
      result: jsonResult({
        success: false,
        error_kind: 'missing_required_param',
        error: 'raw_ref is required.',
      }, true),
    };
  }

  const parsed = parseRawRef(rawRef);
  if (!parsed) {
    return {
      ok: false,
      result: jsonResult({
        success: false,
        error_kind: 'invalid_param_format',
        error: 'raw_ref must use tool-log://<session_id>/<tool_call_id>.',
      }, true),
    };
  }

  if (parsed.sessionId !== currentSessionId) {
    return {
      ok: false,
      result: jsonResult({
        success: false,
        error_kind: 'permission_denied',
        error: 'raw_ref belongs to a different session.',
        current_session_id: currentSessionId,
      }, true),
    };
  }
  return { ok: true, record, rawRef, parsed };
}

type EvidenceFileResolution =
  | { ok: true; fileReal: string }
  | { ok: false; result: ToolResult };

async function resolveCurrentSessionEvidenceFile(
  config: RawRefCapConfig,
  toolCallId: string,
  rawRef: string,
): Promise<EvidenceFileResolution> {
  const toolLogsRoot = path.resolve(config.toolLogsDir);
  const sessionDir = path.resolve(toolLogsRoot, config.sessionId);
  if (!isPathInside(toolLogsRoot, sessionDir)) {
    return { ok: false, result: permissionDenied('raw_ref session path escaped the tool logs root.') };
  }

  const filePath = path.resolve(sessionDir, `${toolCallId}.md`);
  if (!isPathInside(sessionDir, filePath)) {
    return { ok: false, result: permissionDenied('raw_ref path escaped the current session.') };
  }
  if (!fs.existsSync(filePath)) {
    return {
      ok: false,
      result: jsonResult({
        success: false,
        error_kind: 'not_found',
        error: 'raw_ref evidence file does not exist on this execution device.',
        raw_ref: rawRef,
      }, true),
    };
  }

  const [rootReal, sessionStat, fileStat] = await Promise.all([
    fs.promises.realpath(toolLogsRoot),
    fs.promises.lstat(sessionDir),
    fs.promises.lstat(filePath),
  ]);
  if (sessionStat.isSymbolicLink()) {
    return { ok: false, result: permissionDenied('raw_ref session directory must not be a symbolic link.') };
  }
  if (fileStat.isSymbolicLink()) {
    return { ok: false, result: permissionDenied('raw_ref evidence file must not be a symbolic link.') };
  }

  const [sessionReal, fileReal] = await Promise.all([
    fs.promises.realpath(sessionDir),
    fs.promises.realpath(filePath),
  ]);
  if (!isPathInside(rootReal, sessionReal)) {
    return { ok: false, result: permissionDenied('raw_ref session resolved outside the tool logs root.') };
  }
  if (!isPathInside(sessionReal, fileReal)) {
    return { ok: false, result: permissionDenied('raw_ref evidence resolved outside the current session.') };
  }
  return { ok: true, fileReal };
}

export class RawRefCap extends CapabilityBase {
  readonly type = 'raw_ref';
  readonly category: CapabilityCategory = 'core';

  constructor(private readonly config: RawRefCapConfig) {
    super();
  }

  tools(): Tool[] {
    return [
      {
        name: 'read_raw_ref',
        policyActionKind: 'object_read',
        isReadOnly: true,
        description:
          'Read a bounded slice of an archived tool result (e.g. the part beyond the inline truncation limit, ' +
          'or evidence referenced by a raw_ref pointer in history). ' +
          'Only tool-log:// refs for the current session are allowed. Use grep, offset, and max_chars to avoid loading full logs.',
        inputSchema: {
          type: 'object',
          properties: {
            raw_ref: {
              type: 'string',
              maxLength: 360,
              description: 'Raw evidence reference, e.g. tool-log://<session_id>/<tool_call_id>.',
            },
            grep: {
              type: 'string',
              maxLength: 500,
              description: 'Optional case-insensitive substring filter applied line-by-line before slicing.',
            },
            offset: {
              type: 'integer',
              minimum: 0,
              description: 'Optional character offset after grep filtering.',
            },
            max_chars: {
              type: 'integer',
              minimum: 1,
              maximum: HARD_MAX_CHARS,
              description: `Maximum characters to return. Defaults to ${DEFAULT_MAX_CHARS}; capped at ${HARD_MAX_CHARS}.`,
            },
          },
          required: ['raw_ref'],
          additionalProperties: false,
        } as Tool['inputSchema'],
        execute: async (input: unknown, _context: ToolContext): Promise<ToolResult> => {
          const request = parseRawRefRequest(input, this.config.sessionId);
          if (!request.ok) return request.result;

          const evidence = await resolveCurrentSessionEvidenceFile(
            this.config,
            request.parsed.toolCallId,
            request.rawRef,
          );
          if (!evidence.ok) return evidence.result;

          const toolLogContent = await fs.promises.readFile(evidence.fileReal, 'utf-8');
          const fullOutputPath = await resolveTerminalFullOutputFile({
            candidatePath: extractTerminalFullOutputPath(toolLogContent),
            toolResultsDir: this.config.toolResultsDir ?? defaultToolResultsDir(),
            sessionId: this.config.sessionId,
            toolCallId: request.parsed.toolCallId,
          });

          const maxChars = clampMaxChars(request.record.max_chars, DEFAULT_MAX_CHARS, HARD_MAX_CHARS);
          const offset = Math.max(0, readInteger(request.record.offset) ?? 0);
          const grep = readString(request.record.grep);
          const source = fullOutputPath ? 'full_output_path' : 'tool_log';
          const full = fullOutputPath
            ? await fs.promises.readFile(fullOutputPath, 'utf-8')
            : toolLogContent;
          const filtered = applyGrep(full, grep);
          const sliced = filtered.slice(offset, offset + maxChars);
          return jsonResult({
            success: true,
            raw_ref: request.rawRef,
            grep,
            offset,
            max_chars: maxChars,
            source,
            chars_returned: sliced.length,
            truncated: offset + maxChars < filtered.length,
            content: sliced,
          });
        },
      },
    ];
  }
}
