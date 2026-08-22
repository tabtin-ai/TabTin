/**
 * 子 Agent 交付物收集—— **host delivery 产品语义**，不进 agent-runtime。
 *
 * 数据源对齐 「方案 A」：子 `persist_message` 落在**父会话**
 * `message-blocks.jsonl`，记录带 `subagent_run_id`。子 sidechain 目录只有
 * messages/events/snapshots 三件套，**没有** message-blocks——勿读错路径。
 *
 * 复用  allowlist +  路径净算语义，供：
 *   1. 父 `agent` tool_result 结构化回报（主代理知情）
 *   2. 前端「本轮产物」按派发轮合并（不依赖子消息进主流）
 *
 * Host 包装层 / 完成回调 enrich 调用本模块；runtime 不认 `artifact_kind`。
 */

import {
  MessageBlockStorage,
  type MessageBlockRecord,
  type SessionConfig,
} from '@tabtin/agent-runtime'

/** 与 Electron `DELIVERABLE_ARTIFACT_KINDS` / host delivery 对齐。 */
export const CHILD_DELIVERABLE_ARTIFACT_KINDS = [
  'local_file',
  'oss_file',
  'platform_resource',
] as const;

export type ChildDeliverableArtifactKind = (typeof CHILD_DELIVERABLE_ARTIFACT_KINDS)[number];

const DELIVERABLE_KIND_SET: ReadonlySet<string> = new Set(CHILD_DELIVERABLE_ARTIFACT_KINDS);

/** 与前端 TEMP_DIR_SEGMENTS 对齐。 */
const TEMP_DIR_SEGMENTS: ReadonlySet<string> = new Set(['tmp', 'temp', '.tmp', '.temp']);

const FILE_MUTATION_TOOLS = new Set(['write_file', 'edit_file', 'delete_file']);
const TERMINAL_TOOL = 'run_terminal_command';

/** tool_result 内嵌的机器可读交付物标签（前端 parse；模型也能看见）。 */
export const CHILD_DELIVERABLES_TAG = 'tabtin-subagent-deliverables';

export type ChildDeliverable =
  | {
      artifact_kind: 'local_file';
      relative_path: string;
      filename: string;
      file_size?: number;
    }
  | {
      artifact_kind: 'oss_file';
      file_id?: string;
      filename: string;
      url: string;
      file_size?: number;
    }
  | {
      artifact_kind: 'platform_resource';
      resource_type: string;
      resource_id: string;
      resource_name: string;
      url: string;
      space_id?: string;
    }
  | {
      kind: 'widget';
      widget_id: string;
      title: string;
    };

interface PathOp {
  path: string;
  deleted: boolean;
  fileSize?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stripShellPathQuotes(input: string): string {
  const trimmed = input.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
    || (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function canonicalizeDeliverableRelativePath(input: string): string | null {
  const cleaned = stripShellPathQuotes(String(input ?? '')).trim();
  if (!cleaned) return null;
  if (
    cleaned.startsWith('/')
    || cleaned.startsWith('~')
    || /^[a-zA-Z]:[\\/]/.test(cleaned)
  ) {
    return null;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(cleaned)) return null;

  const segments = cleaned.replace(/\\/g, '/').split('/');
  const out: string[] = [];
  for (const seg of segments) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  if (out.length === 0) return null;
  return out.join('/');
}

export function isDeliverableRelativePath(p: string): boolean {
  const canonical = canonicalizeDeliverableRelativePath(p) ?? p.replace(/\\/g, '/');
  const segments = canonical.split('/').filter(Boolean);
  if (segments.length === 0) return false;
  const first = segments[0]!.toLowerCase();
  if (TEMP_DIR_SEGMENTS.has(first)) return false;
  if (segments.some((seg) => seg.startsWith('.'))) return false;
  const filename = segments[segments.length - 1]!;
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return false;
  return true;
}

function basename(filePath: string): string {
  const parts = filePath.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? filePath;
}

function survivingPathOps(ops: PathOp[]): PathOp[] {
  const surviving = new Map<string, PathOp>();
  for (const op of ops) {
    const canonical = canonicalizeDeliverableRelativePath(op.path) ?? op.path;
    const key = canonical.toLowerCase();
    if (op.deleted) {
      surviving.delete(key);
      continue;
    }
    const prev = surviving.get(key);
    surviving.set(key, {
      ...op,
      path: canonical,
      fileSize: op.fileSize ?? prev?.fileSize,
    });
  }
  return [...surviving.values()];
}

function readArtifactKind(block: Record<string, unknown>): string {
  const payload = asRecord(block.payload) ?? {};
  if (typeof block.artifact_kind === 'string' && block.artifact_kind) return block.artifact_kind;
  if (typeof payload.artifact_kind === 'string' && payload.artifact_kind) return payload.artifact_kind;
  return '';
}

function flattenRich(block: Record<string, unknown>): Record<string, unknown> {
  if (block.type === 'rich_content') return block;
  if (block.type === 'tabtin_rich_content') {
    const payload = asRecord(block.payload) ?? {};
    return {
      ...payload,
      type: 'rich_content',
      kind: block.kind,
      summary: typeof block.summary === 'string' ? block.summary : '',
    };
  }
  return block;
}

function widgetHasDeliverableContent(block: Record<string, unknown>): boolean {
  const hasCode = typeof block.code === 'string' && block.code.trim().length > 0;
  const hasRendered = typeof block.rendered_code === 'string' && block.rendered_code.trim().length > 0;
  const hasImage = typeof block.image_url === 'string' && block.image_url.length > 0;
  return hasCode || hasRendered || hasImage;
}

function ossFileUrl(block: Record<string, unknown>): string | null {
  if (block.artifact_kind !== 'oss_file') return null;
  const fileId = typeof block.file_id === 'string' ? block.file_id.trim() : '';
  if (typeof block.url === 'string' && block.url.startsWith('tabtin://resource/file/')) {
    return block.url;
  }
  if (!fileId) return null;
  const params = new URLSearchParams({ hint: 'tabfiles' });
  const title = (typeof block.filename === 'string' && stripShellPathQuotes(block.filename))
    || (typeof block.summary === 'string' ? block.summary : null);
  if (title) params.set('title', title);
  return `tabtin://resource/file/${encodeURIComponent(fileId)}?${params.toString()}`;
}

function platformResourceUrl(block: Record<string, unknown>): string | null {
  if (typeof block.url === 'string' && block.url.startsWith('tabtin://')) return block.url;
  const resourceType = typeof block.resource_type === 'string' ? block.resource_type : '';
  const resourceId = typeof block.resource_id === 'string' ? block.resource_id : '';
  if (!resourceType || !resourceId) return null;
  const base = `tabtin://resource/${resourceType}/${encodeURIComponent(resourceId)}`;
  const hint = typeof block.hint_carrier_app_id === 'string' ? block.hint_carrier_app_id : null;
  return hint ? `${base}?hint=${encodeURIComponent(hint)}` : base;
}

function deliverableKey(d: ChildDeliverable): string {
  if ('artifact_kind' in d) {
    if (d.artifact_kind === 'local_file') return `local:${d.relative_path.toLowerCase()}`;
    if (d.artifact_kind === 'oss_file') return `oss:${d.url}`;
    return `platform:${d.url}`;
  }
  return `widget:${d.widget_id}`;
}

function pushUnique(out: ChildDeliverable[], seen: Set<string>, item: ChildDeliverable): void {
  const key = deliverableKey(item);
  if (seen.has(key)) return;
  seen.add(key);
  out.push(item);
}

function parseToolResultContent(content: unknown): Record<string, unknown> | null {
  if (typeof content !== 'string' || !content.trim()) return null;
  try {
    return asRecord(JSON.parse(content.trim()));
  } catch {
    return null;
  }
}

function isSuccessfulToolResult(block: Record<string, unknown>): boolean {
  if (block.is_error === true) return false;
  const parsed = parseToolResultContent(block.content);
  if (parsed?.success === false) return false;
  return true;
}

function extractTerminalPaths(content: unknown): { created: string[]; deleted: string[] } {
  const outer = typeof content === 'string' ? parseToolResultContent(content) : asRecord(content);
  if (!outer) return { created: [], deleted: [] };
  const fileHistory = asRecord(outer.file_history);
  const created = [
    ...(Array.isArray(fileHistory?.created_paths) ? fileHistory!.created_paths : []),
    ...(Array.isArray(fileHistory?.modified_paths) ? fileHistory!.modified_paths : []),
  ].filter((p): p is string => typeof p === 'string');
  const deleted = (Array.isArray(fileHistory?.deleted_paths) ? fileHistory!.deleted_paths : [])
    .filter((p): p is string => typeof p === 'string');
  const exitCode = typeof outer.exit_code === 'number'
    ? outer.exit_code
    : (typeof outer.exitCode === 'number' ? outer.exitCode : null);
  const ok = exitCode !== null ? exitCode === 0 : outer.success === true;
  return { created: ok ? created : [], deleted };
}

function collectFromRichBlock(
  raw: Record<string, unknown>,
  pathOps: PathOp[],
  deliverables: ChildDeliverable[],
  seen: Set<string>,
): void {
  const flat = flattenRich(raw);
  const artifactKind = readArtifactKind(raw) || readArtifactKind(flat);
  if (DELIVERABLE_KIND_SET.has(artifactKind)) {
    if (artifactKind === 'local_file') {
      const relative = typeof flat.relative_path === 'string'
        ? canonicalizeDeliverableRelativePath(flat.relative_path)
        : null;
      if (!relative || !isDeliverableRelativePath(relative)) return;
      const fileSize = typeof flat.file_size === 'number' && Number.isFinite(flat.file_size)
        ? flat.file_size
        : undefined;
      pathOps.push({ path: relative, deleted: false, fileSize });
      return;
    }
    if (artifactKind === 'oss_file') {
      const url = ossFileUrl({ ...flat, artifact_kind: 'oss_file' });
      if (!url) return;
      const filename = (typeof flat.filename === 'string' && stripShellPathQuotes(flat.filename))
        || (typeof flat.summary === 'string' ? flat.summary : 'File');
      const fileSize = typeof flat.file_size === 'number' && Number.isFinite(flat.file_size)
        ? flat.file_size
        : undefined;
      pushUnique(deliverables, seen, {
        artifact_kind: 'oss_file',
        ...(typeof flat.file_id === 'string' ? { file_id: flat.file_id } : {}),
        filename,
        url,
        ...(fileSize != null ? { file_size: fileSize } : {}),
      });
      return;
    }
    if (artifactKind === 'platform_resource') {
      const url = platformResourceUrl(flat);
      if (!url) return;
      const resourceType = typeof flat.resource_type === 'string' ? flat.resource_type : 'resource';
      const resourceId = typeof flat.resource_id === 'string' ? flat.resource_id : '';
      if (!resourceId) return;
      const resourceName = (typeof flat.resource_name === 'string' && flat.resource_name)
        || (typeof flat.summary === 'string' ? flat.summary : resourceType);
      const spaceId = typeof flat.space_id === 'string'
        ? flat.space_id
        : (typeof flat.resource_space_id === 'string' ? flat.resource_space_id : undefined);
      pushUnique(deliverables, seen, {
        artifact_kind: 'platform_resource',
        resource_type: resourceType,
        resource_id: resourceId,
        resource_name: resourceName,
        url,
        ...(spaceId ? { space_id: spaceId } : {}),
      });
    }
    return;
  }

  const kind = typeof flat.kind === 'string' ? flat.kind : '';
  if (kind === 'widget' && widgetHasDeliverableContent(flat)) {
    const widgetId = typeof flat.widget_id === 'string' ? flat.widget_id : '';
    if (!widgetId || widgetId.startsWith('pending:')) return;
    const title = (typeof flat.title === 'string' && flat.title)
      || (typeof flat.summary === 'string' ? flat.summary : 'Widget');
    pushUnique(deliverables, seen, { kind: 'widget', widget_id: widgetId, title });
  }
}

function collectFromToolUsePair(
  toolUse: Record<string, unknown>,
  toolResult: Record<string, unknown> | undefined,
  pathOps: PathOp[],
): void {
  const name = typeof toolUse.name === 'string' ? toolUse.name : '';
  const input = asRecord(toolUse.input);

  if (FILE_MUTATION_TOOLS.has(name)) {
    if (!toolResult || !isSuccessfulToolResult(toolResult)) return;
    const rawPath = typeof input?.path === 'string' ? input.path : '';
    const filePath = rawPath ? canonicalizeDeliverableRelativePath(rawPath) : null;
    if (!filePath) return;
    if (name !== 'delete_file' && !isDeliverableRelativePath(filePath)) return;
    pathOps.push(
      name === 'delete_file'
        ? { path: filePath, deleted: true }
        : { path: filePath, deleted: false },
    );
    return;
  }

  if (name !== TERMINAL_TOOL || !toolResult) return;
  const { created, deleted } = extractTerminalPaths(toolResult.content);
  for (const raw of created) {
    const filePath = canonicalizeDeliverableRelativePath(raw);
    if (!filePath || !isDeliverableRelativePath(filePath)) continue;
    pathOps.push({ path: filePath, deleted: false });
  }
  for (const raw of deleted) {
    const filePath = canonicalizeDeliverableRelativePath(raw);
    if (!filePath) continue;
    pathOps.push({ path: filePath, deleted: true });
  }
}

/** 纯函数：从已加载的 message-block 记录收集交付物（便于单测）。 */
export function collectDeliverablesFromRecords(records: MessageBlockRecord[]): ChildDeliverable[] {
  const pathOps: PathOp[] = [];
  const deliverables: ChildDeliverable[] = [];
  const seen = new Set<string>();

  for (const record of records) {
    const blocks = Array.isArray(record.blocks_json) ? record.blocks_json : [];
    const resultById = new Map<string, Record<string, unknown>>();
    for (const raw of blocks) {
      const block = asRecord(raw);
      if (!block || block.type !== 'tool_result') continue;
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
      if (id) resultById.set(id, block);
    }

    for (const raw of blocks) {
      const block = asRecord(raw);
      if (!block) continue;
      if (block.type === 'tabtin_rich_content' || block.type === 'rich_content') {
        collectFromRichBlock(block, pathOps, deliverables, seen);
        continue;
      }
      if (block.type === 'tool_use') {
        const id = typeof block.id === 'string' ? block.id : '';
        collectFromToolUsePair(block, id ? resultById.get(id) : undefined, pathOps);
      }
    }
  }

  for (const op of survivingPathOps(pathOps)) {
    pushUnique(deliverables, seen, {
      artifact_kind: 'local_file',
      relative_path: op.path,
      filename: basename(op.path),
      ...(typeof op.fileSize === 'number' ? { file_size: op.fileSize } : {}),
    });
  }
  return deliverables;
}

/** 从父会话 blocks 中筛出属于某子 run 的记录（ 方案 A）。 */
export function filterRecordsBySubagentRunId(
  records: readonly MessageBlockRecord[],
  childId: string,
): MessageBlockRecord[] {
  if (!childId) return [];
  return records.filter((record) => record.subagent_run_id === childId);
}

export interface CollectChildDeliverablesOptions {
  /**
   * 读盘前 flush 父会话 `MessageBlockStorage` 缓冲（与 host 同一实例）。
   * 未注入时仅依赖新实例 `load()` 自带的空 buffer flush——赶不上 host 未落盘行。
   */
  flushParentMessageBlocks?: () => Promise<void>;
}

/**
 * 读父会话 message-blocks，按 `subagent_run_id` 过滤后收集交付物。
 * 文件不存在 / 无匹配记录 → []。
 */
export async function collectChildDeliverables(
  sessionConfig: SessionConfig,
  childId: string,
  options?: CollectChildDeliverablesOptions,
): Promise<ChildDeliverable[]> {
  if (!childId) return [];
  try {
    if (options?.flushParentMessageBlocks) {
      await options.flushParentMessageBlocks();
    }
    const storage = new MessageBlockStorage(
      sessionConfig.sessionDir,
      sessionConfig.threadId,
    );
    const records = await storage.load();
    return collectDeliverablesFromRecords(
      filterRecordsBySubagentRunId(records, childId),
    );
  } catch {
    return [];
  }
}

function formatDeliverableLine(d: ChildDeliverable): string {
  if ('artifact_kind' in d) {
    if (d.artifact_kind === 'local_file') return `- local_file: ${d.relative_path}`;
    if (d.artifact_kind === 'oss_file') return `- oss_file: ${d.filename} (${d.url})`;
    return `- platform_resource: ${d.resource_name} (${d.url})`;
  }
  return `- widget: ${d.title} (${d.widget_id})`;
}

/**
 * 把交付物嵌进父 agent tool_result 文本：
 * - 人类可读列表给主代理编排
 * - `<tabtin-subagent-deliverables>` JSON 给前端本轮产物解析
 */
export function appendDeliverablesToToolResultContent(
  content: string,
  deliverables: readonly ChildDeliverable[],
): string {
  if (deliverables.length === 0) return content;
  const human = `交付物：\n${deliverables.map(formatDeliverableLine).join('\n')}`;
  const machine = `<${CHILD_DELIVERABLES_TAG}>\n${JSON.stringify(deliverables)}\n</${CHILD_DELIVERABLES_TAG}>`;
  return `${content}\n\n${human}\n\n${machine}`;
}

function isChildDeliverable(item: unknown): item is ChildDeliverable {
  const rec = asRecord(item);
  if (!rec) return false;
  if (typeof rec.artifact_kind === 'string') return DELIVERABLE_KIND_SET.has(rec.artifact_kind);
  return rec.kind === 'widget' && typeof rec.widget_id === 'string';
}

/** 从前端 / 测试解析 tool_result 文本中的交付物 JSON（支持 wait 多段标签）。 */
export function parseDeliverablesFromToolResultContent(content: string): ChildDeliverable[] {
  const open = `<${CHILD_DELIVERABLES_TAG}>`;
  const close = `</${CHILD_DELIVERABLES_TAG}>`;
  const out: ChildDeliverable[] = [];
  const seen = new Set<string>();
  let cursor = 0;
  while (cursor < content.length) {
    const start = content.indexOf(open, cursor);
    if (start < 0) break;
    const jsonStart = start + open.length;
    const end = content.indexOf(close, jsonStart);
    if (end < 0) break;
    cursor = end + close.length;
    try {
      const parsed = JSON.parse(content.slice(jsonStart, end).trim()) as unknown;
      if (!Array.isArray(parsed)) continue;
      for (const item of parsed) {
        if (!isChildDeliverable(item)) continue;
        pushUnique(out, seen, item);
      }
    } catch {
      // skip malformed segment
    }
  }
  return out;
}
