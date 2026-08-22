/**
 * 本机 SessionStorage 分叉：复制归档目录并 remap sessionId / tool_use id。
 *
 * 与云端 fork（Django）双端对齐——#7033。
 * 源目录不存在或为空时返回 skipped（非错误）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { validate as isUuid, v5 as uuidv5 } from 'uuid';

import { ToolIdMapper } from '../engine/context/tool-id-mapper.js';
import {
  createForkToolIdMapper,
  remapToolIdsInValue,
} from './fork-tool-id-remap.js';

export interface ForkLocalSessionParams {
  sessionArchiveDir: string;
  toolLogsDir?: string;
  sourceSessionId: string;
  newSessionId: string;
  /** Agent Host transcript 中的分叉锚点 message_id（含），之后的本机正文不进入子会话 */
  forkAnchorMessageId?: string;
  /** 云端同步 fork 返回的旧 id → tu_*；有则本机共用，避免双端分叉 */
  toolIdRemap?: Readonly<Record<string, string>>;
}

export interface ForkLocalSessionResult {
  copied: boolean;
  skipped: boolean;
  reason?: string;
  remappedToolIds: number;
  remappedMessageIds: number;
  /** message-blocks 是否按 fork 点截断成功 */
  truncatedAtForkPoint?: boolean;
}

const JSONL_CANDIDATES = [
  'messages.jsonl',
  'message-blocks.jsonl',
  'events.jsonl',
  'snapshots.jsonl',
  'model-projections.jsonl',
  'subagents.jsonl',
] as const;

function replaceSessionIdInValue<T>(
  value: T,
  sourceSessionId: string,
  newSessionId: string,
): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (value === sourceSessionId) return newSessionId as T;
    if (value.startsWith(`${sourceSessionId}:`)) {
      return `${newSessionId}${value.slice(sourceSessionId.length)}` as T;
    }
    // tool-logs 相对路径：tool-logs/{sessionId}/...
    const prefix = `tool-logs/${sourceSessionId}/`;
    if (value.startsWith(prefix)) {
      return `tool-logs/${newSessionId}/${value.slice(prefix.length)}` as T;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      replaceSessionIdInValue(item, sourceSessionId, newSessionId),
    ) as T;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = replaceSessionIdInValue(v, sourceSessionId, newSessionId);
    }
    return out as T;
  }
  return value;
}

function collectMessageIdsInValue(
  value: unknown,
  messageIds: Set<string>,
): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectMessageIdsInValue(item, messageIds);
    return;
  }
  if (typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      (key === 'message_id' || key === 'messageId')
      && typeof child === 'string'
      && isUuid(child)
    ) {
      messageIds.add(child);
    }
    collectMessageIdsInValue(child, messageIds);
  }
}

function collectMessageIdsFromJsonl(filePaths: readonly string[]): Set<string> {
  const messageIds = new Set<string>();
  for (const filePath of filePaths) {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) continue;
    for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        collectMessageIdsInValue(JSON.parse(line) as unknown, messageIds);
      } catch {
        // malformed lines are preserved verbatim by rewriteJsonlFile
      }
    }
  }
  return messageIds;
}

const MESSAGE_ID_FIELDS = new Set([
  'message_id',
  'messageId',
  'message_ids',
  'messageIds',
]);

function isMessageIdField(fieldName?: string): boolean {
  if (!fieldName) return false;
  return MESSAGE_ID_FIELDS.has(fieldName)
    || ['_message_id', 'MessageId'].some((suffix) => fieldName.endsWith(suffix));
}

function replaceMessageIdsInValue<T>(
  value: T,
  messageIdRemap: ReadonlyMap<string, string>,
  fieldName?: string,
): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return (isMessageIdField(fieldName) ? messageIdRemap.get(value) ?? value : value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      replaceMessageIdsInValue(item, messageIdRemap, fieldName),
    ) as T;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = replaceMessageIdsInValue(child, messageIdRemap, key);
    }
    return out as T;
  }
  return value;
}

function rewriteJsonlFile(
  filePath: string,
  sourceSessionId: string,
  newSessionId: string,
  mapper: ToolIdMapper,
  messageIdRemap: ReadonlyMap<string, string>,
): void {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) return;
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      out.push(line);
      continue;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      const withTools = remapToolIdsInValue(parsed, mapper);
      const withMessages = replaceMessageIdsInValue(withTools, messageIdRemap);
      const withSession = replaceSessionIdInValue(
        withMessages,
        sourceSessionId,
        newSessionId,
      );
      out.push(JSON.stringify(withSession));
    } catch {
      out.push(line);
    }
  }
  fs.writeFileSync(filePath, out.join('\n'), 'utf8');
}

/**
 * 去掉 message-blocks 尾部未配对的 user 行，使归档以最后一条 assistant 结尾。
 * 与云端「fork 点必须是 assistant」对齐，避免子会话出现相邻用户消息。
 */
export function trimTrailingUserMessageBlocks(filePath: string): boolean {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    return false;
  }
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const records: { index: number; role: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as { role?: unknown };
      if (typeof parsed.role === 'string') {
        records.push({ index: i, role: parsed.role });
      }
    } catch {
      // skip
    }
  }
  if (records.length === 0) return false;

  let lastAssistantIdx = -1;
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i]!.role === 'assistant') {
      lastAssistantIdx = records[i]!.index;
      break;
    }
  }
  if (lastAssistantIdx < 0) return false;

  const lastRecord = records[records.length - 1]!;
  if (lastRecord.index <= lastAssistantIdx) return false;

  const kept = lines.slice(0, lastAssistantIdx + 1);
  const body = kept.join('\n');
  fs.writeFileSync(filePath, body.endsWith('\n') || body.length === 0 ? body : `${body}\n`, 'utf8');
  return true;
}

/**
 * 按 fork 点截断 message-blocks.jsonl（ 权威正文）。
 * 找不到 fork 点时不截断，返回 false。
 */
export function truncateMessageBlocksAtForkPoint(
  filePath: string,
  forkPointMessageId: string,
): boolean {
  if (!forkPointMessageId || !fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    return false;
  }
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as { message_id?: unknown };
      if (parsed.message_id === forkPointMessageId) cut = i;
    } catch {
      // skip malformed
    }
  }
  if (cut < 0) return false;
  const kept = lines.slice(0, cut + 1);
  // 保留文件末尾换行风格
  const body = kept.join('\n');
  fs.writeFileSync(filePath, body.endsWith('\n') || body.length === 0 ? body : `${body}\n`, 'utf8');
  return true;
}

/**
 * 六件套 messages.jsonl：按 payload / 顶层 message_id 截到 fork 点（含其后同轮事件尽力保留困难，
 * 保守只保留出现 fork message_id 及之前的行）。
 */
function truncateMessagesJsonlAtForkPoint(
  filePath: string,
  forkPointMessageId: string,
): boolean {
  if (!forkPointMessageId || !fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    return false;
  }
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const payload = (parsed.payload && typeof parsed.payload === 'object')
        ? parsed.payload as Record<string, unknown>
        : undefined;
      const messageId = parsed.message_id ?? payload?.message_id ?? payload?.messageId;
      if (messageId === forkPointMessageId) cut = i;
    } catch {
      // skip malformed
    }
  }
  if (cut < 0) return false;
  const kept = lines.slice(0, cut + 1);
  const body = kept.join('\n');
  fs.writeFileSync(filePath, body.endsWith('\n') || body.length === 0 ? body : `${body}\n`, 'utf8');
  return true;
}

/** 读 message-blocks.jsonl 最后一条带 message_id 的行（裁尾后对齐 messages.jsonl）。 */
function readLastMessageIdFromBlocks(filePath: string): string | undefined {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    return undefined;
  }
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as { message_id?: unknown };
      if (typeof parsed.message_id === 'string' && parsed.message_id) {
        return parsed.message_id;
      }
    } catch {
      // skip
    }
  }
  return undefined;
}

function forkToolLogsDir(
  toolLogsDir: string,
  sourceSessionId: string,
  newSessionId: string,
  mapper: ToolIdMapper,
  messageIdRemap: ReadonlyMap<string, string>,
): void {
  const src = path.join(toolLogsDir, sourceSessionId);
  const dest = path.join(toolLogsDir, newSessionId);
  if (!fs.existsSync(src)) return;
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.cpSync(src, dest, { recursive: true });

  for (const name of fs.readdirSync(dest)) {
    if (!name.endsWith('.md')) continue;
    const oldId = name.slice(0, -3);
    const newId = mapper.allocate(oldId);
    if (newId === oldId) continue;
    const from = path.join(dest, name);
    const to = path.join(dest, `${newId}.md`);
    if (fs.existsSync(to)) fs.rmSync(to, { force: true });
    fs.renameSync(from, to);
  }

  const indexPath = path.join(dest, '_index.jsonl');
  rewriteJsonlFile(
    indexPath,
    sourceSessionId,
    newSessionId,
    mapper,
    messageIdRemap,
  );
}

/**
 * 将本机 session 归档复制到新 sessionId，并 remap tool / session 作用域 id。
 */
export function forkLocalSessionArchive(
  params: ForkLocalSessionParams,
): ForkLocalSessionResult {
  const {
    sessionArchiveDir,
    toolLogsDir,
    sourceSessionId,
    newSessionId,
    forkAnchorMessageId,
    toolIdRemap,
  } = params;
  if (!sourceSessionId || !newSessionId || sourceSessionId === newSessionId) {
    return {
      copied: false,
      skipped: true,
      reason: 'invalid_session_ids',
      remappedToolIds: 0,
      remappedMessageIds: 0,
    };
  }

  const srcDir = path.join(sessionArchiveDir, sourceSessionId);
  const destDir = path.join(sessionArchiveDir, newSessionId);
  if (!fs.existsSync(srcDir)) {
    return {
      copied: false,
      skipped: true,
      reason: 'source_missing',
      remappedToolIds: 0,
      remappedMessageIds: 0,
    };
  }

  const hasContent = JSONL_CANDIDATES.some((name) => {
    const p = path.join(srcDir, name);
    return fs.existsSync(p) && fs.statSync(p).size > 0;
  });
  if (!hasContent) {
    return {
      copied: false,
      skipped: true,
      reason: 'source_empty',
      remappedToolIds: 0,
      remappedMessageIds: 0,
    };
  }

  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
  fs.cpSync(srcDir, destDir, { recursive: true });

  // 截断必须在 remap 前做（文件里仍是源 session 的 message_id）
  const blocksPath = path.join(destDir, 'message-blocks.jsonl');
  const messagesPath = path.join(destDir, 'messages.jsonl');
  let truncatedAtForkPoint = false;
  if (forkAnchorMessageId) {
    truncatedAtForkPoint = truncateMessageBlocksAtForkPoint(
      blocksPath,
      forkAnchorMessageId,
    );
    truncateMessagesJsonlAtForkPoint(messagesPath, forkAnchorMessageId);
  }
  // 整会话 fork 或截断后仍可能带着尾部孤儿 user —— 收束到最后一条 assistant
  if (trimTrailingUserMessageBlocks(blocksPath)) {
    truncatedAtForkPoint = true;
    // message-blocks 是权威正文；裁尾后按末条 message_id 对齐六件套
    const lastKeptId = readLastMessageIdFromBlocks(blocksPath);
    if (lastKeptId) {
      truncateMessagesJsonlAtForkPoint(messagesPath, lastKeptId);
    }
  }

  const archiveJsonlPaths = JSONL_CANDIDATES.map((name) =>
    path.join(destDir, name),
  );
  const subagentJsonlPaths: string[] = [];
  const subagentsDir = path.join(destDir, 'subagents');
  if (fs.existsSync(subagentsDir)) {
    for (const child of fs.readdirSync(subagentsDir, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const childDir = path.join(subagentsDir, child.name);
      for (const name of JSONL_CANDIDATES) {
        subagentJsonlPaths.push(path.join(childDir, name));
      }
    }
  }

  const messageIds = collectMessageIdsFromJsonl([
    ...archiveJsonlPaths,
    ...subagentJsonlPaths,
  ]);
  const messageIdRemap = new Map(
    [...messageIds].map((messageId) => [
      messageId,
      uuidv5(`${newSessionId}:${messageId}`, newSessionId),
    ]),
  );

  const mapper = createForkToolIdMapper(toolIdRemap);
  for (const filePath of archiveJsonlPaths) {
    rewriteJsonlFile(
      filePath,
      sourceSessionId,
      newSessionId,
      mapper,
      messageIdRemap,
    );
  }

  // 子 Agent 目录内也可能有 jsonl
  for (const filePath of subagentJsonlPaths) {
    rewriteJsonlFile(
      filePath,
      sourceSessionId,
      newSessionId,
      mapper,
      messageIdRemap,
    );
  }

  if (toolLogsDir) {
    forkToolLogsDir(
      toolLogsDir,
      sourceSessionId,
      newSessionId,
      mapper,
      messageIdRemap,
    );
  }

  return {
    copied: true,
    skipped: false,
    remappedToolIds: mapper.size,
    remappedMessageIds: messageIdRemap.size,
    truncatedAtForkPoint,
  };
}
