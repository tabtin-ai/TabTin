/**
 * read-before-edit 共享工具集（PRD 08 W1 / W2）
 *
 * 集中两个能力：
 *   1. `recordReadFileState`：read 路径成功后写入快照（共用 capability +
 *      tabcode-adapter 两端，CRLF normalize 行为一致）。
 *   2. `validateReadBeforeWrite`：write/edit 路径执行前的 stale-read
 *      校验（共用 tabcode-adapter `edit_file` / `write_file`）。
 *
 * 抽到共享模块的原因：readFileState + error kind 是 LLM 看到错误后的
 * "自我纠正信号"——文案 / kind 的微差异会让 LLM 在"下一步该做什么"上迷糊，
 * 反而绕远。capability 与 tabcode-adapter 两端必须同款。
 *
 * **W2（2026-05-10）**：删除 READ_REQUIRED 整套自创"必须先 read"协议。
 * LLM 即便没读过文件直接 edit，错误的 old_string 会被
 * `old_string_not_found` 拦截；多匹配会被 `old_string_not_unique` 拦截。
 * "读没读过 / 读全没读全"完全不再卡 edit 链路。配套：删除
 * `ReadFileStateEntry.isPartialView` 字段——曾表达"partial range read"，
 * 与"system 自动注入的 strip 内容"语义易混淆，留着只造成歧义，删除最干净。
 * dedup 入口靠 `(offset, limit, mtime)` 三元组比对完全够用。
 *
 * **保留**：`error_kind=tool_stale_read`——文件 mtime 漂移且内容不同时拒绝，
 * LLM 收到后会重读文件再 edit。
 */

import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

// Wave 1.5（2026-05-13）：canonicalizePath 下沉到 @tabtin/action-tools/headless。
// 本文件保留 re-export 桥接，对调用方零改动；详见模块底部 re-export 段。
import { canonicalizePath } from '@tabtin/action-tools/headless';

import type {
  ReadFileState,
  ToolContext,
  ToolResult,
} from '@tabtin/agent-runtime';
import {
  jsonError,
  INVALID_PARAM_FORMAT,
  MISSING_REQUIRED_PARAM,
  PERMISSION_DENIED,
  RATE_LIMITED,
  REQUEST_TIMEOUT,
  UPSTREAM_ERROR,
  NETWORK_FAILED as NETWORK_FAILED_KIND,
  OLD_STRING_NOT_FOUND as OLD_STRING_NOT_FOUND_KIND,
  OLD_STRING_NOT_UNIQUE as OLD_STRING_NOT_UNIQUE_KIND,
  TOOL_STALE_READ,
  // W1 file pipeline 8 类 + W5 L38 IMAGE_RESIZE_FAILED 共 9 类
  // （与 `@tabtin/file-pipeline-errors` SSoT 对齐）
  FILE_NOT_FOUND as FILE_NOT_FOUND_KIND,
  FILE_TOO_LARGE as FILE_TOO_LARGE_KIND,
  UNSUPPORTED_FORMAT as UNSUPPORTED_FORMAT_KIND,
  // W5 L38,
} from '@tabtin/agent-runtime/tools';
import {
  FilePipelineErrorCode,
  formatFilePipelineError,
  isFilePipelineErrorCode,
} from '@tabtin/file-pipeline-errors';
// host 可依赖 @tabtin/*；runtime 生产侧禁止 re-export tool-errors（AH-005）
import { bridgeBrowserErrorCodeToRuntimeKind } from '@tabtin/tool-errors';

const READ_FILE_STATE_MAX_ENTRIES = 500;

/**
 * STALE_READ envelope hint 字面（文件并发安全 Wave 2 / 2026-05-13）。
 *
 * **L-23 (Round 1 自修)**：提取为常量避免双轨/三轨漂移 —— 早期版本里以下
 * 4 处都硬编码同样字面：
 *   1. `validateReadBeforeWrite` 异步入口校验（行 ~622）—— 通过参数构造同款
 *      文案（`readToolName`='read_file' 拼装），现统一引用本常量
 *   2. `validateReadBeforeWriteSync` 没读过分支（B6-1）
 *   3. `validateReadBeforeWriteSync` mtime 漂移分支
 *   4. `mapActionErrorToRuntimeKind` 的 `'stale_read'` case 提供给跨包 envelope
 *      的最终 hint
 *
 * **任一处改动都该改本常量**，避免「同样的 stale 状态在不同入口看到不同 hint」
 * 让 LLM 自纠路径分叉。验证：`grep "Re-read the file with read_file"` 应只
 * 命中本常量定义 + 测试 fixture（端到端测试断言文案稳定）。
 */
export const STALE_READ_HINT =
  'Re-read the file with read_file to refresh the in-memory snapshot, then retry.';

/**
 * 单个 ReadFileState 内累计快照的字节体积上限（默认 25 MB）。
 *
 * 历史实现只按数量驱逐（500 条），但单条 entry 内 `content` 字段是文件全文。
 * Daemon 24/7 长会话场景下，LLM 反复读 200 KB 量级的大文件，500 条远没满
 * （只用了几十条）但 in-memory 实际体积已经达到 100 MB+ 量级 —— 数量层防御
 * 完全不起作用。
 *
 * 25 MB 的取值依据：
 * - 单个对话场景里 LLM 真正需要保留的"已读全文"通常 < 10 MB（少量代码文件
 *   + 配置 + README + 几个关键 doc）。
 * - 25 MB 给突发大文件（巨型生成物 / 大日志）留缓冲，触发驱逐时也只是丢掉
 *   最久未访问的 entry，不影响活跃读 / 编辑链路。
 * - 与历史默认 25 MB 上限一致（v2.1.89 修复参考）。
 */
const READ_FILE_STATE_MAX_BYTES = 25 * 1024 * 1024;

/**
 * 单条 entry 的固定 overhead 估算（canonical key 字符串 + ReadFileStateEntry
 * 对象元数据 + V8 隐式开销）。256 字节是粗略上界，宁可高估让驱逐略激进。
 */
const READ_FILE_STATE_ENTRY_OVERHEAD_BYTES = 256;

/**
 * Sidecar 字节统计。**WeakMap 设计**：
 *
 * 1. 公开类型 `ReadFileState = Map<string, ReadFileStateEntry>` 不变 ——
 *    宿主端（Electron / Daemon / fork-query / tests）继续用 `new Map()`
 *    构造，零改动。
 * 2. 字节统计存在模块级 WeakMap 里，以 ReadFileState 实例为 key —— 当
 *    宿主丢弃 Map 时，sidecar 自动 GC，无需显式 dispose。
 * 3. 所有 set/delete 都已经收口在本文件 (`recordReadFileState` /
 *    `clearReadFileState` / `evictLRU`)，sidecar 不会因为外部直接操作
 *    Map 而失同步 —— monorepo grep 验证 `state.set` / `state.delete`
 *    只出现在本文件。
 *
 * 字节统计仅用于 `evictLRU` 的驱逐判断。计数偏差不影响正确性，只影响驱逐
 * 时机（fork 子 agent 拿到拷贝 Map 时 sidecar 会重新初始化为 0，子 agent
 * 内字节累计从拷贝后的 record 开始计，不影响安全性）。
 */
interface SizeStats {
  totalBytes: number;
  bytesByKey: Map<string, number>;
}

const sizeStatsByState = new WeakMap<ReadFileState, SizeStats>();

function getOrInitStats(state: ReadFileState): SizeStats {
  let stats = sizeStatsByState.get(state);
  if (!stats) {
    stats = { totalBytes: 0, bytesByKey: new Map() };
    sizeStatsByState.set(state, stats);
  }
  return stats;
}

function estimateEntryBytes(content: string): number {
  // V8 字符串内部 UTF-16 时是 2 字节/char，ASCII 优化时是 1 字节/char —— 这里
  // 取 char count 作为保守下界（实际占用通常更高，宁可激进一点驱逐）。
  // overhead 覆盖 canonical key + ReadFileStateEntry 字段元数据。
  return content.length + READ_FILE_STATE_ENTRY_OVERHEAD_BYTES;
}

/**
 * Wave 3：失败 envelope 只发 `error_kind`（生成式字符串）+ `hint`。
 * 数字 `TabcodeErrorCode` / 结构化 `error_code` 兼容轨已删除；browser/action
 * `ToolErrorCode` 经 `@tabtin/tool-errors` bridge 映射为 runtime kind。
 * 不合并 `network_error` / `network_failed` 字面值——bridge 保留二者差异。
 */

/**
 * 把 action-tools `ToolError.code`（string enum）+ message 映射成 runtime
 * `error_kind`。优先走 Wave2 generated bridge；映射不存在时用既有安全
 * fallback（`upstream_error` / phrase / 结构化特例），不发明新字面值。
 */
export function mapActionErrorToRuntimeKind(
  err: { code?: string; message?: string } | undefined | null,
): { errorKind: string; message: string; suggestion?: string } {
  const code = err && typeof err.code === 'string' ? err.code : undefined;
  const rawMessage = err?.message ?? '';
  const lower = rawMessage.toLowerCase();

  const precise = mapPreciseActionErrorKind(code, rawMessage);
  if (precise) return precise;

  const phraseMatch = mapActionErrorPhrase(lower, rawMessage);
  if (phraseMatch) return phraseMatch;

  const structured = mapStructuredActionErrorKind(code, rawMessage);
  if (structured) return structured;

  if (code) {
    const bridged = bridgeBrowserErrorCodeToRuntimeKind(code);
    if (bridged) {
      return { errorKind: bridged, message: rawMessage || 'Unknown error' };
    }
  }

  return { errorKind: UPSTREAM_ERROR, message: rawMessage || 'Unknown error' };
}

const OLD_STRING_NOT_UNIQUE_SUGGESTION =
  'Provide more surrounding context to make old_string unique. ' +
  'If you intended to replace every occurrence and your old_string is byte-exact ' +
  'from the file (no whitespace/quote differences), set replace_all=true—otherwise ' +
  'copy old_string verbatim from read_file output first.';

const OLD_STRING_NOT_FOUND_SUGGESTION =
  'First use grep_search with output_mode:"content" and path set to this file. ' +
  'Search for an escaped single-line distinctive snippet from old_string (not the whole multi-line old_string). ' +
  'If grep returns "No matches found.", the snippet may be absent or the regex may be wrong—re-check from a fresh read instead of retrying blindly. ' +
  'Otherwise re-read the matched region with explicit offset/limit, then copy old_string verbatim. ' +
  'Note: read_file output is line-prefixed (e.g. "1\\tcontent") for display only — ' +
  'strip the "N\\t" prefix before passing to old_string.';

const OLD_NEW_IDENTICAL_SUGGESTION =
  'Change new_string so it differs from old_string, or skip the edit if no change is needed.';

function mapPreciseActionErrorKind(
  code: string | undefined,
  rawMessage: string,
): { errorKind: string; message: string; suggestion?: string } | null {
  if (code === 'stale_read') {
    return { errorKind: TOOL_STALE_READ, message: rawMessage, suggestion: STALE_READ_HINT };
  }
  if (code === 'old_string_not_unique') {
    return {
      errorKind: OLD_STRING_NOT_UNIQUE_KIND,
      message: rawMessage,
      suggestion: OLD_STRING_NOT_UNIQUE_SUGGESTION,
    };
  }
  if (code === 'file_too_large') return mapExplicitFileTooLarge(rawMessage);
  if (code === 'file_not_found') {
    return { errorKind: FILE_NOT_FOUND_KIND, message: rawMessage, suggestion: undefined };
  }
  if (code === 'network_error') {
    return { errorKind: NETWORK_FAILED_KIND, message: rawMessage, suggestion: undefined };
  }
  if (code === 'old_string_not_found') {
    return {
      errorKind: OLD_STRING_NOT_FOUND_KIND,
      message: rawMessage,
      suggestion: OLD_STRING_NOT_FOUND_SUGGESTION,
    };
  }
  return null;
}

function mapExplicitFileTooLarge(
  rawMessage: string,
): { errorKind: string; message: string; suggestion?: string } {
  const isImage = /^Image exceeds/i.test(rawMessage);
  if (!isImage) {
    return {
      errorKind: FILE_TOO_LARGE_KIND,
      message: rawMessage,
      suggestion: undefined,
    };
  }
  const formatted = formatFilePipelineError(
    FilePipelineErrorCode.FILE_TOO_LARGE,
    { subject: 'image', rawMessage },
  );
  return {
    errorKind: FILE_TOO_LARGE_KIND,
    message: rawMessage,
    suggestion: formatted.suggestion,
  };
}

function mapActionErrorPhrase(
  lower: string,
  rawMessage: string,
): { errorKind: string; message: string; suggestion?: string } | null {
  if (lower.includes('matches of the string to replace')) {
    return {
      errorKind: OLD_STRING_NOT_UNIQUE_KIND,
      message: rawMessage,
      suggestion: OLD_STRING_NOT_UNIQUE_SUGGESTION,
    };
  }
  if (lower.includes('not found in file')) {
    return {
      errorKind: OLD_STRING_NOT_FOUND_KIND,
      message: rawMessage,
      suggestion: OLD_STRING_NOT_FOUND_SUGGESTION,
    };
  }
  if (lower.includes('original and edited file match exactly')) {
    return {
      errorKind: OLD_STRING_NOT_FOUND_KIND,
      message: rawMessage,
      suggestion:
        'Your new_string evaluates to the same content as the matched region in the ' +
        'file (no-op edit). Re-read the target region with explicit offset/limit and ' +
        'provide a new_string that meaningfully differs from the matched content.',
    };
  }
  if (lower.includes('old_string and new_string must be different')) {
    return {
      errorKind: INVALID_PARAM_FORMAT,
      message: rawMessage,
      suggestion: OLD_NEW_IDENTICAL_SUGGESTION,
    };
  }
  if (isFileTooLargeMessage(lower)) return mapPhraseFileTooLarge(rawMessage);
  if (lower.includes('file does not exist') || lower.includes('file not found')) {
    const formatted = formatFilePipelineError(FilePipelineErrorCode.FILE_NOT_FOUND, { rawMessage });
    return {
      errorKind: FILE_NOT_FOUND_KIND,
      message: rawMessage,
      suggestion: formatted.suggestion,
    };
  }
  return null;
}

function isFileTooLargeMessage(lower: string): boolean {
  return lower.includes('too large')
    || lower.includes('exceeds maximum')
    || lower.includes('file content (');
}

function mapPhraseFileTooLarge(
  rawMessage: string,
): { errorKind: string; message: string; suggestion?: string } {
  const isImage = /^Image exceeds/i.test(rawMessage);
  const formatted = formatFilePipelineError(
    FilePipelineErrorCode.FILE_TOO_LARGE,
    { subject: isImage ? 'image' : 'document', rawMessage },
  );
  return {
    errorKind: FILE_TOO_LARGE_KIND,
    message: rawMessage,
    suggestion: formatted.suggestion,
  };
}

function mapStructuredActionErrorKind(
  code: string | undefined,
  rawMessage: string,
): { errorKind: string; message: string; suggestion?: string } | null {
  if (code === 'permission_denied' || code === 'policy_blocked') {
    return { errorKind: PERMISSION_DENIED, message: rawMessage };
  }
  if (code === 'unsupported_operation') {
    return { errorKind: 'unsupported_operation', message: rawMessage };
  }
  if (code === 'invalid_parameter' || code === 'missing_required_param') {
    const bridged = bridgeBrowserErrorCodeToRuntimeKind(code) ?? INVALID_PARAM_FORMAT;
    return { errorKind: bridged, message: rawMessage };
  }
  return null;
}

// Wave 1.5（2026-05-13）：canonicalizePath 实现已下沉到
// @tabtin/action-tools/utils/canonical-path（通过 /headless 出口）。本文件
// re-export 保证调用方零改动；adapter / read-file-state / file-lock / lock-map
// 全 4 个入口共享同一份 realpath 解析，跨入口 key 必然一致。
export { canonicalizePath };

/**
 * 错误结果 envelope（统一 shape）。
 *
 * Wave 3：只发 `error_kind` + `hint`（及可选 op/context/path）。数字
 * `error_code` / `TabcodeErrorCode` 已删除，无双读 fallback。
 */
export function errorResultEnvelope(params: {
  errorKind: string;
  message: string;
  /** 给 LLM 的"下一步动作"提示（如"先调 read_file 再 edit_file"）。 */
  suggestion?: string;
  /** 涉及路径（便于日志 + 未来 PolicyEvaluator 取证）。向后兼容入参，等价于 `context: { path }`。 */
  path?: string;
  /**
   * 操作名（canonical tool name，如 'write_file' / 'delete_file' / 'edit_file' /
   * 'read_file'）。用于日志聚合 + partial_success 结果面板按 op 分组渲染。
   * 不传时不进 metadata（兼容旧 caller）。
   */
  op?: string;
  /**
   * 结构化错误上下文，**给 LLM 看 + 给前端 UI 看的稳定字段**。
   *
   * 典型字段：
   *   - `path`：操作目标（path 入参语义等价，但更结构化）
   *   - `reason`：错误细分类（如 'outside_workspace' / 'not_a_file' / 'symlink_target_blocked'）
   *   - `target`：symlink 实际指向（symlink 检查命中时）
   *   - `actual_path` / `expected_path`：路径漂移类错误的对照
   *
   * **不要塞**：原始 fs error message（已在 message 字段）、敏感凭证、
   * 用户层产品名（"Super Permissions" 等——那些是 UI 文案不是工具协议）。
   */
  context?: Record<string, unknown>;
}): ToolResult {
  return jsonError(params.message, toTabcodeJsonErrorMetadata(params));
}

function toTabcodeJsonErrorMetadata(params: {
  errorKind: string;
  suggestion?: string;
  path?: string;
  message?: string;
  op?: string;
  context?: Record<string, unknown>;
}): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    error_kind: params.errorKind,
    hint:
      params.suggestion
      ?? defaultTabcodeHint(params.errorKind, {
        path: params.path,
        rawMessage: params.message,
      }),
  };
  if (params.op) metadata.op = params.op;
  if (params.context || params.path) {
    const merged: Record<string, unknown> = { ...(params.context ?? {}) };
    if (params.path && merged.path === undefined) {
      merged.path = params.path;
    }
    if (Object.keys(merged).length > 0) {
      metadata.context = merged;
    }
  }
  if (params.path) metadata.path = params.path;
  return metadata;
}

interface DefaultHintContext {
  path?: string;
  rawMessage?: string;
}

const USER_CANCEL_TABCODE_HINT =
  'The user cancelled this operation. Respect the user choice; do not auto-retry.';
const GENERIC_UPSTREAM_TABCODE_HINT =
  'The file operation failed with an unexpected upstream error. Tell the user the issue and consider retrying once.';

function filePipelineTabcodeHint(
  errorKind: string,
  ctx: DefaultHintContext,
): string | undefined {
  if (!isFilePipelineErrorCode(errorKind)) return undefined;
  const filename = ctx.path ? path.basename(ctx.path) : undefined;
  const ext = ctx.path ? path.extname(ctx.path).toLowerCase() : undefined;
  const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.heic', '.heif']);
  const subject = ext && IMAGE_EXTS.has(ext) ? 'image' as const : undefined;
  const formatted = formatFilePipelineError(errorKind, {
    filename,
    format: ext || undefined,
    rawMessage: ctx.rawMessage,
    ...(subject ? { subject } : {}),
  });
  return formatted.suggestion ?? GENERIC_UPSTREAM_TABCODE_HINT;
}

function defaultTabcodeHint(
  errorKind: string,
  ctx: DefaultHintContext = {},
): string {
  switch (errorKind) {
    case TOOL_STALE_READ:
      return STALE_READ_HINT;
    case OLD_STRING_NOT_UNIQUE_KIND:
      return 'Provide more surrounding context so old_string matches exactly one location. If old_string is byte-exact from the file (no whitespace/quote differences), set replace_all=true to replace all occurrences; otherwise copy it verbatim from read_file output first.';
    case OLD_STRING_NOT_FOUND_KIND:
      return 'First use grep_search with output_mode:"content" and path set to this file. Search for an escaped single-line distinctive snippet from old_string (not the whole multi-line old_string). If grep returns "No matches found.", the snippet may be absent or the regex may be wrong—re-check from a fresh read instead of retrying blindly. Otherwise re-read the matched region with explicit offset/limit and copy old_string verbatim before retrying.';
    case INVALID_PARAM_FORMAT:
      return 'Correct the invalid parameter value or format, then retry the tool call.';
    case MISSING_REQUIRED_PARAM:
      return 'Provide the missing required parameter, then retry the tool call.';
    case REQUEST_TIMEOUT:
      return 'Retry once or increase the timeout if the tool supports it.';
    case RATE_LIMITED:
      return 'Wait briefly before retrying, and reduce request frequency if the limit persists.';
  }

  // USER_ABORTED 复用顶层 kind `'aborted'`；SSoT suggestion 故意为空。
  // 必须在 file-pipeline 分支之前显式分流，避免无 suggestion 时把其他
  // pipeline 错误误标成用户取消。
  if (errorKind === 'aborted') {
    return USER_CANCEL_TABCODE_HINT;
  }

  return filePipelineTabcodeHint(errorKind, ctx) ?? GENERIC_UPSTREAM_TABCODE_HINT;
}

/** 把文本里的 CRLF / CR 统一成 LF（写盘前匹配用）。 */
export function normalizeLineEndings(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * read 成功后写 readFileState。如果 ctx.readFileState 未注入则 no-op
 * （兼容旧测试 / 未启用加固的宿主）。
 *
 * **W2（2026-05-10）**：删除 `isPartialView` 参数。TabTin 没有 nested memory
 * 自动注入路径，该字段无合理用途。partial vs full read 的语义靠
 * `(offset, limit)` 元组区分：read 写入时 `offset` 总有值（默认 1）；
 * edit/write 后的 `refreshSnapshot` 不传 offset/limit（隐式 reset 为
 * full state：`offset: undefined, limit: undefined`）。
 *
 * @param ctxOrState - 直接传 Map 也可以（adapter 内部已解构出来时方便）。
 */
export function recordReadFileState(
  ctxOrState: ToolContext | ReadFileState | undefined,
  filePath: string,
  content: string,
  options?: {
    mtimeMs?: number;
    offset?: number;
    limit?: number;
    /** 相对路径解析基准（默认 ctx.workspaceRoot → process.cwd()）。 */
    baseDir?: string;
  },
): void {
  const state = resolveState(ctxOrState);
  if (!state) return;
  const baseDir =
    options?.baseDir ?? (ctxOrState as ToolContext | undefined)?.workspaceRoot;
  const key = canonicalizePath(filePath, baseDir);
  const normalized = normalizeLineEndings(content);

  // 字节统计：覆盖写时先扣老 entry，再加新 entry
  const stats = getOrInitStats(state);
  const oldBytes = stats.bytesByKey.get(key);
  if (oldBytes !== undefined) {
    stats.totalBytes -= oldBytes;
  }
  const newBytes = estimateEntryBytes(normalized);
  stats.bytesByKey.set(key, newBytes);
  stats.totalBytes += newBytes;

  state.set(key, {
    content: normalized,
    timestamp: options?.mtimeMs ?? Date.now(),
    readAt: Date.now(),
    offset: options?.offset,
    limit: options?.limit,
  });
  evictLRU(state);
}

/** 删除 readFileState 中对应路径的快照（delete_file 后调用）。 */
export function clearReadFileState(
  ctxOrState: ToolContext | ReadFileState | undefined,
  filePath: string,
  options?: { baseDir?: string },
): void {
  const state = resolveState(ctxOrState);
  if (!state) return;
  const baseDir =
    options?.baseDir ?? (ctxOrState as ToolContext | undefined)?.workspaceRoot;
  const key = canonicalizePath(filePath, baseDir);
  if (state.delete(key)) {
    const stats = getOrInitStats(state);
    const removedBytes = stats.bytesByKey.get(key);
    if (removedBytes !== undefined) {
      stats.totalBytes -= removedBytes;
      stats.bytesByKey.delete(key);
    }
  }
}

function resolveState(
  ctxOrState: ToolContext | ReadFileState | undefined,
): ReadFileState | undefined {
  if (!ctxOrState) return undefined;
  if (ctxOrState instanceof Map) return ctxOrState;
  return (ctxOrState as ToolContext).readFileState;
}

/**
 * stale-read 检查（W2 后的极简形态）。
 *
 * **行为矩阵**：
 *   - state 未注入（undefined）→ 静默放行（兼容性）；
 *   - 文件不存在（fileExists=false）→ 静默放行（新建无需检查）；
 *   - state 存在但无该 path 快照 → 静默放行（"没读过"不再阻断 edit；
 *     LLM 写错的 old_string 会被 `old_string_not_found` 拦截）；
 *   - 文件 mtime > 快照 timestamp 且内容不同 → `tool_stale_read`；
 *   - 文件 mtime 抖动但内容相同（macOS iCloud / Windows AV）→ 放行；
 *   - 其他情况（mtime 一致或快照新于 mtime）→ 放行。
 *
 * **W2 删除（2026-05-10）**：READ_REQUIRED 的两个分支
 * （没 snapshot / partial view）整体下线。dogfood 死循环根因之一是
 * "先 full read → 再 partial read 看局部 → snapshot 被覆盖为 partial →
 * edit 被拒"，删除后 partial read 不再阻断 edit，精确字符串 kind 兜底
 * "瞎 edit"场景。
 *
 * @returns null 表示通过；ToolResult 表示拒绝（调用方直接 return）。
 */
export async function validateReadBeforeWrite(
  ctxOrState: ToolContext | ReadFileState | undefined,
  filePath: string,
  options: {
    /** 文件是否已存在；不存在则跳过检查。 */
    fileExists: boolean;
    /** 工具名（用在 suggestion 文案，让 LLM 知道下一步该调什么）。 */
    readToolName: string;
    /** 当前文件 mtime（毫秒）。可由调用方提供，避免重复 stat。 */
    currentMtimeMs?: number;
    /** 当前文件内容（已读到时传入，避免再 read 一次）。 */
    currentContent?: string;
    /** 相对路径解析基准（默认 ctx.workspaceRoot → process.cwd()）。 */
    baseDir?: string;
  },
): Promise<ToolResult | null> {
  const state = resolveState(ctxOrState);
  if (!state) return null;
  if (!options.fileExists) return null;

  const baseDir =
    options.baseDir ?? (ctxOrState as ToolContext | undefined)?.workspaceRoot;
  const canonical = canonicalizePath(filePath, baseDir);
  const snapshot = state.get(canonical);

  // W2：没读过文件不再阻断 edit——仅在已读过时校验 stale；没读过直接放行。
  // LLM 写错的 old_string 会被下游 findActualString 返 `old_string_not_found` 拦下。
  if (!snapshot) return null;

  const currentMtimeMs = options.currentMtimeMs ?? (await safeMtime(canonical));
  if (currentMtimeMs == null) return null;

  if (currentMtimeMs <= snapshot.timestamp + 1) {
    // mtime 一致（+1ms 容忍：部分文件系统 stat 精度只到秒），快照仍有效
    return null;
  }

  // mtime 漂移 → 比对内容；相同则 macOS iCloud / Windows AV 之类的抖动
  let currentContent = options.currentContent;
  if (currentContent == null) {
    try {
      currentContent = await fsPromises.readFile(canonical, 'utf8');
    } catch {
      return null;
    }
  }
  const currentNormalized = normalizeLineEndings(currentContent);
  if (currentNormalized === snapshot.content) {
    return null;
  }

  return errorResultEnvelope({
    errorKind: TOOL_STALE_READ,
    message:
      `File has been modified externally since you last read it (${canonical}). ` +
      `Your snapshot is stale.`,
    // Wave 2 Round 2 harness 收口（2026-05-13）：异步入口校验 suggestion 旧实现
    // 用 `${options.readToolName}` 字面拼接，跟同步版本（行 758）+ defaultTabcodeHint
    // STALE_READ case（行 452）+ mapActionErrorToRuntimeKind 'stale_read' case（行 218）
    // 的 STALE_READ_HINT 常量字面**一致但脱离单一源**。统一用常量收口，让全链路
    // 5 处 STALE_READ hint 字面单一源（基线 B5-1 / Wave 2 独立 reviewer L-33）。
    // **readToolName 参数标 @deprecated**（caller 未破坏，整体收尾时统一删）。
    suggestion: STALE_READ_HINT,
    path: canonical,
  });
}

/**
 * stale-read 校验同步版本（文件并发安全 Wave 2 / 写盘前 TOCTOU 校验用，2026-05-13）。
 *
 * **跟异步版本 `validateReadBeforeWrite` 行为关系（两处字面偏离）**：
 *
 *   1. **没读过快照 → throw**（不放行），跟入口校验「没读过放行」字面偏离 ——
 *      写盘前严格于入口的双段不对称设计：入口宽松（检查协议，给
 *      `old_string_not_found` 兜底）写盘前严格（最后闸口的 mtime + 内容比对，
 *      断 LLM「不读也能 edit」的反向激励）。基线 B6-1 决策
 *      2026-05-13 23:30 harness 拍板。
 *   2. **isFullRead + content 严格判定**（基线 A1-6 + A1-7）：
 *      partial read（offset !== undefined || limit !== undefined）+ mtime 漂移
 *      → throw（不享受 content 兜底）。异步入口校验只看 content 字面相等就放
 *      行（不要求 isFullRead），是 W2「软放行」语义。
 *      TabTin `read_file` 默认场景 entry 写入 `offset=1` 而非 undefined，导致
 *      read 后云盘抖动场景下入口放行、写盘前会拦 —— 是有意的 trade-off
 *      （Wave 2 Round 1 reviewer 1 抓到，登记到「实施记录」+「已知风险」段）。
 *
 *   **其他分支字面一致**：mtime +1ms 容忍（基线 A1-5）+ snapshot 命中后跟
 *   isFullRead 判定（A1-6）+ content `===` 比对（A1-7）逻辑层字面对齐，
 *   Wave 2 单测对照断言保护。
 *
 *   **实现差异**：caller 必须传入已 normalize 的 `currentMtimeMs`（Math.floor）
 *   + `currentContent`（normalizeLineEndings + stripBOM），内部不调任何 fs.*
 *   异步 API ——「临界区禁 await」不变量收口到本函数（基线 B2-3）。
 *
 * **mtime 量化用 Math.floor**（基线 A1-4 + B3-1）：caller 必须 Math.floor，
 * 跟 `recordTextReadSnapshot` + `refreshSnapshot` 字面对齐统一 —— 否则跨平台
 * stat 精度漂移（macOS 微秒级 vs Linux 毫秒级）会让「刚 read 完写盘前」
 * 假阳性撞 stale。
 *
 * **错误信号字节对齐入口校验**（基线 B5-1）：error_kind / message / suggestion
 * 完全一致；caller throw 后通过 ToolStaleReadError 携带本函数构造的 envelope
 * 字段 → action-tools `standardizeLegacyResult` → adapter `mapActionErrorToRuntimeKind`
 * 的 `code === 'stale_read'` 显式 case → LLM 看到的最终 envelope 字节一致。
 *
 * @returns null 表示通过；ToolResult 表示拒绝（caller 应 throw ToolStaleReadError
 *          携带本结果让 action-tools 一侧 catch 后 envelope 化）。
 */
export function validateReadBeforeWriteSync(
  state: ReadFileState | undefined,
  filePath: string,
  options: {
    /** 当前文件 mtime（毫秒，**caller 必须 Math.floor 后**）。 */
    currentMtimeMs: number;
    /** 当前文件内容（**caller 必须 normalizeLineEndings + stripBOM 后**）。 */
    currentContent: string;
    /** 相对路径解析基准（默认 process.cwd()）。 */
    baseDir?: string;
  },
): ToolResult | null {
  // state 未注入 → 静默放行（兼容 Memory 模式 / 旧测试）。**注意**：这是「state
  // 整个不存在」的 fail-open 兜底，跟「state 存在但 path 没读过」是两回事 ——
  // 后者由 B6-1 严格 throw（见下方）。
  if (!state) return null;

  const canonical = canonicalizePath(filePath, options.baseDir);
  const snapshot = state.get(canonical);

  // **B6-1（写盘前严格）**：没读过快照 → throw STALE_READ。偏离入口校验
  // （行 574 `if (!snapshot) return null` 放行）——双段不对称：入口宽松写盘前严格。
  // 理由：给 Agent 留「不读也能 edit」会形成反向激励，让 LLM 跳过 read 直接试
  // edit（dogfood 撞到时整段写错全靠 OLD_STRING_NOT_FOUND 兜底，比读再写多走
  // 1-2 轮死循环）。
  if (!snapshot) {
    return errorResultEnvelope({
      errorKind: TOOL_STALE_READ,
      message:
        `File has been modified externally since you last read it (${canonical}). ` +
        `Your snapshot is stale.`,
      suggestion: STALE_READ_HINT,
      path: canonical,
    });
  }

  // mtime +1ms 容忍（基线 A1-5）：部分文件系统 stat 精度只到秒；保留 +1ms 是
  // 入口校验已有的兜底（read-file-state.ts:579），写盘前同步版本保持一致。
  // caller 已 Math.floor 跟 snapshot.timestamp（记录时也是 Math.floor）量化对齐。
  if (options.currentMtimeMs <= snapshot.timestamp + 1) {
    return null;
  }

  // **isFullRead 字段判定**（基线 A1-6 + A1-7）：
  // `snapshot.offset === undefined && snapshot.limit === undefined`。
  // refreshSnapshot 之后两字段都是 undefined（write/edit 后 reset 为 full state）；
  // read_file 后 offset 总有值（默认 1）—— 所以 isFullRead 等价「最近一次状态
  // 变更来自 write/edit 的 refreshSnapshot」。
  const isFullRead =
    snapshot.offset === undefined && snapshot.limit === undefined;

  // **content 字面相等放行**（基线 A1-7）：Windows 云同步 / 杀软触摸 mtime
  // 但不改内容的假阳性防御。两侧都是 normalize 后形态（caller
  // normalizeLineEndings + stripBOM）。
  // **A2-4 OR 不变量**：partial read（!isFullRead）即便 content 字面相等也
  // throw —— `!isFullRead || content !== snapshot.content` 是 OR，partial read
  // 任何变化都不放行（不享受 isFullRead 兜底）。本函数判定路径：
  // isFullRead && content 相等 → 放行；任一不满足 → throw，等价 OR 条件。
  if (isFullRead && options.currentContent === snapshot.content) {
    return null;
  }

  // 真撞 stale → envelope 化让 caller throw（ToolStaleReadError）。
  return errorResultEnvelope({
    errorKind: TOOL_STALE_READ,
    message:
      `File has been modified externally since you last read it (${canonical}). ` +
      `Your snapshot is stale.`,
    suggestion: STALE_READ_HINT,
    path: canonical,
  });
}

/**
 * 双重 LRU 驱逐：数量 ≤ MAX_ENTRIES 且 累计字节 ≤ MAX_BYTES。
 *
 * 任一维度超限就按 readAt 升序（最老优先）驱逐，直到两个维度都回到上限内。
 *
 * 复杂度：每次驱逐 O(n log n) 的 sort，n ≤ MAX_ENTRIES（500）。LLM 工具
 * 调用频率下完全可忽略；优化空间留给真有性能信号时再换 lru-cache 包。
 */
function evictLRU(state: ReadFileState): void {
  const stats = getOrInitStats(state);
  if (
    state.size <= READ_FILE_STATE_MAX_ENTRIES &&
    stats.totalBytes <= READ_FILE_STATE_MAX_BYTES
  ) {
    return;
  }

  const entries = [...state.entries()].sort((a, b) => a[1].readAt - b[1].readAt);

  let i = 0;
  while (
    i < entries.length &&
    (state.size > READ_FILE_STATE_MAX_ENTRIES ||
      stats.totalBytes > READ_FILE_STATE_MAX_BYTES)
  ) {
    const [key] = entries[i];
    const removedBytes = stats.bytesByKey.get(key);
    if (removedBytes !== undefined) {
      stats.totalBytes -= removedBytes;
      stats.bytesByKey.delete(key);
    }
    state.delete(key);
    i++;
  }
}

/**
 * 测试与诊断用 —— 暴露当前 ReadFileState 的字节累计。
 *
 * 生产代码请勿依赖此函数：它只反映 sidecar 统计，不是直接对 Map 内容
 * 做实测，目的是让单测能验证驱逐行为是否符合预期。
 */
export function _internalGetSizeStats(
  state: ReadFileState,
): { totalBytes: number; entryCount: number } {
  const stats = sizeStatsByState.get(state);
  return {
    totalBytes: stats?.totalBytes ?? 0,
    entryCount: state.size,
  };
}

async function safeMtime(absPath: string): Promise<number | undefined> {
  try {
    const stat = await fsPromises.stat(absPath);
    // **L-12 修复对齐 Wave 2（2026-05-13）**：跨路径 mtime 量化用 Math.floor
    // 跟 `recordTextReadSnapshot` / `refreshSnapshot` / `validateReadBeforeWriteSync`
    // caller 三处统一（基线 A1-4 / B3-1）。Round 1 technical reviewer M-2 共识
    // 修复（跟 product reviewer M-4 联动）：避免「snapshot.timestamp 是 floored
    // 整毫秒、safeMtime 返回 raw 浮点」的跨平台精度不对称，让 +1ms 容忍未来收紧
    // 时不会先暴露这条路径。
    return Math.floor(stat.mtimeMs);
  } catch {
    return undefined;
  }
}
