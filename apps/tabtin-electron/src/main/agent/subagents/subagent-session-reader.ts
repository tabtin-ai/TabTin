/**
 * W2（2026-05-26）：子 session 三件套读取实现（IPC handler `agent-engine:read-subagent-session` 的核心逻辑）。
 *
 * **职责**：从父 session 的 `subagents.jsonl` 索引解析出子 Agent 三件套文件（messages / snapshots / events）
 * 的绝对路径，做安全防御后逐行读出（带行数上限 + truncated 标志）。
 *
 * **为什么独立文件**：
 * - ElectronAgentHost.ts 已经 6000+ 行；新增 IPC handler 应该把可测的纯函数拆出来
 * - 测试可以直接 mock 文件系统调本函数，不必构造整个 ElectronAgentHost（依赖太多）
 *
 * **路径解析铁律**：必须读父 session 的 `subagents.jsonl` 索引（SubagentIndexWriter SSoT）取
 * `paths.messagesPath` / `paths.snapshotsPath` / `paths.eventsPath`——这是子 Agent 落盘契约的
 * 入口。不要硬拼 `subagents/agent-{id}/messages.jsonl`，否则落盘 schema 演进时会断。
 *
 * **安全防御**：
 * 1) `subagentRunId` 必须是 UUID（36 字符 hex），防 path traversal
 * 2) 拼出的绝对路径必须在 `platformDataRoot` 子树内（兜底防御）
 * 3) parentSessionId / organizationId / spaceId 校验由 IPC handler 那一层做（取决于 host.sessions）
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  blockRecordsToTranscriptMessages,
  type MessageBlockRecord,
} from '@tabtin/agent-runtime';

export type SubagentSessionKind = 'messages' | 'snapshots' | 'events';

export interface ReadSubagentSessionInput {
  /**
   * 父 session 的根目录（譬如
   * `{dataRoot}/users/{userId}/organizations/{org}/workspaces/{ws}/conversations/sessions`）。
   * 由 caller 通过 `resolveWorkspaceSessionArchiveDir(dataRoot, userId, orgId, workspaceId)` 拼出后传入。
   */
  parentSessionDir: string;
  /** 父 session 的 sessionId（与 `subagents.jsonl` 第一段路径相符）。 */
  parentSessionId: string;
  /** 子 Agent 的 childId（raw UUID，无 `agent-` 前缀）。 */
  subagentRunId: string;
  kind: SubagentSessionKind;
  /**
   * 安全沙箱根——所有解析出的绝对路径必须 `startsWith(safeRoot)`，否则视为非法（path traversal /
   * 软链接攻击）。生产路径传 `resolveDataRoot()`；测试可传任意 tmpdir 子树。
   */
  safeRoot: string;
  /**
   * 单次读取上限（行数）。snapshots.jsonl 可能 MB 级，避免一次性塞爆 IPC 缓冲区。
   * 默认 5000；超出则返回前 N 行 + `truncated: true`。
   */
  maxLines?: number;
}

export type ReadSubagentSessionResult =
  | {
      ok: true;
      lines: unknown[];
      truncated?: boolean;
      format?: 'transcript' | 'envelopes';
    }
  | { ok: false; error: string };

/** UUID v4 + 通用 36 字符 hex-dash 形态严格校验（防 path traversal）。 */
export const SUBAGENT_RUN_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DEFAULT_MAX_LINES = 5000;

const KIND_TO_PATH_FIELD: Record<SubagentSessionKind, 'messagesPath' | 'snapshotsPath' | 'eventsPath'> = {
  messages: 'messagesPath',
  snapshots: 'snapshotsPath',
  events: 'eventsPath',
};

interface SubagentIndexStartedRow {
  phase: 'started';
  childId?: string;
  subSessionId?: string;
  paths?: {
    sessionDir?: string;
    messageBlocksPath?: string;
    messagesPath?: string;
    snapshotsPath?: string;
    eventsPath?: string;
  };
}

/**
 * 解析子 session 三件套文件的绝对路径。
 *
 * 失败原因都收敛成 `{ ok: false, error }`，error 取自一个固定枚举集合（让 renderer i18n 可识别）：
 * - `invalid_subagent_run_id`：UUID 格式校验失败
 * - `invalid_kind`：kind 参数非 messages/snapshots/events
 * - `subagents_index_missing`：父 session 没有 `subagents.jsonl`（譬如这条 session 从未派过子 Agent）
 * - `subagent_not_found`：索引里没有匹配的 childId entry
 * - `paths_missing_in_index`：索引 entry 缺 `paths.*Path` 字段（旧版索引兼容兜底）
 * - `path_traversal_detected`：拼出的绝对路径不在 safeRoot 子树内
 * - `file_missing`：解析出的文件路径不存在（可能子 Agent 跑到一半 crash 没落盘）
 * - `read_failed:{detail}`：实际 fs.readFile 报错
 */
export async function readSubagentSessionFile(
  input: ReadSubagentSessionInput,
): Promise<ReadSubagentSessionResult> {
  const {
    parentSessionDir,
    parentSessionId,
    subagentRunId,
    kind,
    safeRoot,
    maxLines = DEFAULT_MAX_LINES,
  } = input;

  if (!SUBAGENT_RUN_ID_REGEX.test(subagentRunId)) {
    return { ok: false, error: 'invalid_subagent_run_id' };
  }
  if (kind !== 'messages' && kind !== 'snapshots' && kind !== 'events') {
    return { ok: false, error: 'invalid_kind' };
  }

  const parentSessionAbsDir = path.join(parentSessionDir, parentSessionId);
  const indexPath = path.join(parentSessionAbsDir, 'subagents.jsonl');

  if (!fs.existsSync(indexPath)) {
    return { ok: false, error: 'subagents_index_missing' };
  }

  let entry: SubagentIndexStartedRow | null = null;
  try {
    const raw = await fs.promises.readFile(indexPath, 'utf-8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let row: SubagentIndexStartedRow;
      try {
        row = JSON.parse(line) as SubagentIndexStartedRow;
      } catch {
        continue;
      }
      // 只看 started 行——ended 行不带 paths。childId 与 subSessionId 任一匹配都算
      // 命中：前端传的 subagentRunId 通常 == childId（无前缀 UUID），但兼容传
      // childThreadId（'agent-' + childId）的旧路径。
      if (row.phase !== 'started') continue;
      const matches =
        row.childId === subagentRunId ||
        row.subSessionId === subagentRunId ||
        row.subSessionId === `agent-${subagentRunId}`;
      if (matches) {
        entry = row;
        break;
      }
    }
  } catch (err) {
    return {
      ok: false,
      error: `index_read_failed:${(err as Error)?.message ?? String(err)}`,
    };
  }

  if (!entry) {
    return { ok: false, error: 'subagent_not_found' };
  }

  const messageBlocksPath = kind === 'messages' ? entry.paths?.messageBlocksPath : undefined;
  const relPath = messageBlocksPath ?? entry.paths?.[KIND_TO_PATH_FIELD[kind]];
  if (!relPath || typeof relPath !== 'string') {
    return { ok: false, error: 'paths_missing_in_index' };
  }

  // path.join 不防 `../` —— 必须再过一次 path.normalize + startsWith 校验。
  const targetAbs = path.normalize(path.join(parentSessionAbsDir, relPath));
  const safeRootNormalized = path.normalize(safeRoot);
  if (!targetAbs.startsWith(safeRootNormalized + path.sep) && targetAbs !== safeRootNormalized) {
    return { ok: false, error: 'path_traversal_detected' };
  }

  if (!fs.existsSync(targetAbs)) {
    if (messageBlocksPath && entry.paths?.messagesPath) {
      const legacyTargetAbs = path.normalize(path.join(parentSessionAbsDir, entry.paths.messagesPath));
      if (
        !legacyTargetAbs.startsWith(safeRootNormalized + path.sep)
        && legacyTargetAbs !== safeRootNormalized
      ) {
        return { ok: false, error: 'path_traversal_detected' };
      }
      if (
        fs.existsSync(legacyTargetAbs)
      ) {
        return readJsonLines(legacyTargetAbs, maxLines, 'envelopes');
      }
    }
    return { ok: false, error: 'file_missing' };
  }

  if (messageBlocksPath) {
    const result = await readJsonLines(targetAbs, maxLines);
    if (!result.ok) return result;
    const records = result.lines.filter(isMessageBlockRecord);
    return {
      ...result,
      lines: blockRecordsToTranscriptMessages(records),
      format: 'transcript',
    };
  }

  return readJsonLines(targetAbs, maxLines, kind === 'messages' ? 'envelopes' : undefined);
}

function isMessageBlockRecord(value: unknown): value is MessageBlockRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<MessageBlockRecord>;
  return typeof record.message_id === 'string'
    && (record.role === 'user' || record.role === 'assistant' || record.role === 'system')
    && Array.isArray(record.blocks_json);
}

async function readJsonLines(
  targetAbs: string,
  maxLines: number,
  format?: 'transcript' | 'envelopes',
): Promise<ReadSubagentSessionResult> {

  let rawContent: string;
  try {
    rawContent = await fs.promises.readFile(targetAbs, 'utf-8');
  } catch (err) {
    return {
      ok: false,
      error: `read_failed:${(err as Error)?.message ?? String(err)}`,
    };
  }

  const rawLines = rawContent.split('\n').filter(Boolean);
  const truncated = rawLines.length > maxLines;
  const sliced = truncated ? rawLines.slice(0, maxLines) : rawLines;
  const parsed: unknown[] = [];
  for (const line of sliced) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      // 行级 JSON parse 失败——保留 raw 字符串让 UI 决定如何展示，比丢掉好。
      parsed.push({ __raw__: line });
    }
  }

  return {
    ok: true,
    lines: parsed,
    ...(truncated ? { truncated: true } : {}),
    ...(format ? { format } : {}),
  };
}
