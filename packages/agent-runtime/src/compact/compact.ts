/**
 * LLM-based conversation compaction.
 *
 * Progressive summarization: only summarizes the oldest portion of the
 * conversation, preserving recent messages verbatim. Includes structured
 * summary template and transcript path reference to avoid "amnesia".
 *
 * Auto-compacts when pressure crosses threshold.
 */

import type {
  Message,
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
} from '../engine/contracts/conversation.js';
import type {
  LLMRequest,
  LLMResponseChunk,
  LLMProvider,
} from '../engine/contracts/model-llm.js';
import type {
  ToolProvider,
} from '../engine/contracts/tools.js';
import type {
  EnginePermissionHandler,
} from '../engine/contracts/hitl.js';
import type {
  SessionConfig,
  CompactResult,
  SummaryReuseEntry,
  SummaryReuseFallbackReason,
  SummaryReuseInfo,
} from '../engine/contracts/context-capability.js';
import {
  ensureToolResultPairing,
  normalizeMessages,
  validateToolPairing,
} from '../engine/context/message-normalizer.js';
import { estimateTokens, truncateHead, TokenEstimator } from '../engine/context/token-budget.js';
import { slimMessagesForSummaryInput } from './summary-input-slim.js';
import {
  buildTaskContinuitySection,
  type TaskContinuityPlan,
  type TaskContinuityTodo,
} from '../prompts/compact/task-continuity.js';
import { extractLatestUnfinishedTodos } from '../todo/todo-replay.js';
import { buildIncrementalCompactSystemPrompt } from '../prompts/compact/incremental-system.js';
import { INCREMENTAL_COMPACT_USER_INSTRUCTION } from '../prompts/compact/incremental-user.js';
import { COMPACT_SYSTEM_PROMPT } from '../prompts/compact/system.js';
import { COMPACT_USER_PROMPT } from '../prompts/compact/user.js';
import { CONTINUING_ACK, UNDERSTOOD_ACK } from '../prompts/compact/inline-acks.js';
import {
  RECENT_CONVERSATION_MARKER,
  SUMMARY_HEADER_MARKER,
  buildCompactedSummaryWrapper,
} from '../prompts/compact/wrapper.js';
import { buildCompactFocusInstruction } from '../prompts/compact/focus.js';
import { CHUNK_TOO_LARGE_MARKER } from '../prompts/compact/fallbacks.js';
import {
  buildRestoredFileContext,
  type RestoredFileEntry,
} from '../prompts/compact/file-restore.js';
import { CONTEXT_TRUNCATED_PLACEHOLDER } from '../prompts/compact/truncation-placeholder.js';

// ─── Constants ───────────────────────────────────────────────────────

const SUMMARY_MAX_OUTPUT_TOKENS = 8192;
const MAX_SUMMARY_INPUT_TOKENS = 100_000;

const DEFAULT_KEEP_LAST_N = 4;
/** Keep at least ~30% of context window as raw messages */
const KEEP_RATIO = 0.3;

/**
 *  第二波：摘要请求自身报"提示过长"时，按调用轮次截头重试的次数上限。
 * 按约定实现 `MAX_PTL_RETRIES = 3`（compact.ts:231）。重试耗尽后回落
 * 分块摘要（chunkedCompact）。
 */
const MAX_SUMMARY_PTL_RETRIES = 3;

/**
 * Config for isolated summary generation via an alternative LLM provider.
 * When provided, compactConversation will first try to generate the summary
 * via a direct LLM call using this provider, falling back to the main
 * callModel on failure. Only `provider` is used (for createStream);
 * `tools`, `permissionHandler`, and `sessionConfig` are retained for
 * interface compatibility but are NOT used by the summary path.
 */
export interface ForkCompactConfig {
  provider: LLMProvider;
  tools: ToolProvider;
  permissionHandler: EnginePermissionHandler;
  sessionConfig: SessionConfig;
}

// ─── Compact Usage Capture ───────────────────────────────────────────
// PRD-04 Phase 2 T2.7: compact 路径的 LLM 调用 usage 不能丢弃。
// 通过 wrapper 在不改变 collectStreamText 的前提下拦截 usage chunk。

export interface CompactUsage {
  input_tokens: number;
  output_tokens: number;
  model?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────

async function collectStreamText(
  stream: AsyncIterable<LLMResponseChunk>,
): Promise<string> {
  let text = '';
  for await (const chunk of stream) {
    if (chunk.type === 'text_delta' && chunk.text) {
      text += chunk.text;
    }
  }
  return text;
}

async function collectStreamTextWithUsage(
  stream: AsyncIterable<LLMResponseChunk>,
): Promise<{ text: string; usage: CompactUsage }> {
  let text = '';
  const usage: CompactUsage = { input_tokens: 0, output_tokens: 0 };
  for await (const chunk of stream) {
    if (chunk.type === 'text_delta' && chunk.text) {
      text += chunk.text;
    }
    if (chunk.type === 'usage' && chunk.usage) {
      usage.input_tokens += chunk.usage.input_tokens ?? 0;
      usage.output_tokens += chunk.usage.output_tokens ?? 0;
    }
  }
  return { text, usage };
}

/**
 * Check whether a user message consists entirely of tool_result blocks.
 */
function isToolResultOnlyMessage(msg: Message): boolean {
  if (msg.role !== 'user' || typeof msg.content === 'string') return false;
  return msg.content.length > 0 && msg.content.every((b) => b.type === 'tool_result');
}

function hasToolUse(msg: Message): boolean {
  if (typeof msg.content === 'string') return false;
  return msg.content.some((b) => b.type === 'tool_use');
}

/**
 * Safe split point: a user text message that does not sit between a
 * tool_use and its tool_result.
 */
function isSafeSplitPoint(messages: Message[], idx: number): boolean {
  const msg = messages[idx];
  if (msg.role !== 'user') return false;
  if (isToolResultOnlyMessage(msg)) return false;

  if (idx > 0) {
    const prev = messages[idx - 1];
    if (prev.role === 'assistant' && hasToolUse(prev)) return false;
  }

  return true;
}

/**
 * Find a safe index to split "to-summarize" vs "to-keep".
 * Never splits inside a tool_use / tool_result pair.
 */
function findSplitPoint(messages: Message[], keepLastN: number): number {
  const raw = Math.max(2, messages.length - keepLastN);

  for (let idx = raw; idx < messages.length - 2; idx++) {
    if (isSafeSplitPoint(messages, idx)) return idx;
  }

  for (let idx = raw - 1; idx >= 2; idx--) {
    if (isSafeSplitPoint(messages, idx)) return idx;
  }

  return Math.min(raw, messages.length - 2);
}

function isPromptTooLongError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const m = error.message.toLowerCase();
  return (
    m.includes('413') ||
    m.includes('prompt is too long') ||
    m.includes('prompt_too_long') ||
    m.includes('context_length_exceeded') ||
    m.includes('too many tokens') ||
    m.includes('request too large')
  );
}

function getToolInputObject(block: ToolUseBlock): Record<string, unknown> | null {
  const input = block.input;
  if (!input || typeof input !== 'object') return null;
  return input as Record<string, unknown>;
}

function getToolUseFilePath(block: ToolUseBlock): string | null {
  const inputObj = getToolInputObject(block);
  const filePath = inputObj
    ? (inputObj.path ?? inputObj.file_path ?? inputObj.filePath)
    : undefined;
  return typeof filePath === 'string' && filePath.length > 0 ? filePath : null;
}

function recordFileAction(
  fileActions: Map<string, 'read' | 'modified'>,
  filePath: string,
  toolName: string,
): void {
  if (/write|edit|create|patch|update|save|replace|delete|remove/.test(toolName)) {
    fileActions.delete(filePath);
    fileActions.set(filePath, 'modified');
    return;
  }
  const prev = fileActions.get(filePath);
  if (prev) {
    fileActions.delete(filePath);
    fileActions.set(filePath, prev);
    return;
  }
  fileActions.set(filePath, 'read');
}

/**
 * ：摘要 LLM 出口的统一输入整备闸。
 *
 * 摘要请求直发 provider，不经过主循环 beforeModel 的 message-governance
 * 治理（normalizeMessages + ensureToolResultPairing）——截头 / 分块 / 增量
 * 切片都可能产出孤儿 tool_use / tool_result 或相邻同角色消息，provider 会
 * 以 400 拒绝。此前顺序契约靠各路径"记得手动调 repairOrphanToolCalls"维护，
 * 现在收口到本函数：**所有摘要 LLM 出口**在拼 scaffolding（CONTINUING_ACK /
 * 摘要指令 user 消息）**之前**先过这道整备。
 *
 * 顺序要求：先整备历史切片，再 append ack / 指令——否则 normalize 的
 * "合并相邻同角色消息"会把指令消息合进历史末条 user。
 *
 * 契约（继承自两个内部函数）：
 * - **纯函数**：不 mutate 输入、不发 telemetry（conservative 级别）。
 * - **幂等**：对已治理输入（如主循环 beforeModel 治理过的 `state.messages`）
 *   再过一遍产出内容等价的消息——`callCacheFriendlyFullSummary` 依赖这一点
 *   保证 prompt cache 前缀 byte 不变（测试锁定）。
 */
export function sanitizeSummaryInput(messages: Message[]): Message[] {
  const normalized = normalizeMessages(messages, { level: 'conservative' });
  return ensureToolResultPairing(normalized.messages).messages;
}

/**
 * PRD-04 T2.7: 包装 callModel 以收集 compact 路径的 usage。
 * 所有收集到的 usage 累加到共享的 accumulator 中。
 */
function wrapCallModelForUsage(
  callModel: (req: LLMRequest) => AsyncIterable<LLMResponseChunk>,
  accumulator: CompactUsage,
): (req: LLMRequest) => AsyncIterable<LLMResponseChunk> {
  return (req: LLMRequest) => {
    const original = callModel(req);
    return (async function* () {
      for await (const chunk of original) {
        if (chunk.type === 'usage' && chunk.usage) {
          accumulator.input_tokens += chunk.usage.input_tokens ?? 0;
          accumulator.output_tokens += chunk.usage.output_tokens ?? 0;
        }
        yield chunk;
      }
    })();
  };
}

async function compactSingleChunk(
  chunk: Message[],
  params: {
    systemPrompt: string;
    model: string;
    callModel: (req: LLMRequest) => AsyncIterable<LLMResponseChunk>;
    summaryFocus?: string;
  },
): Promise<string> {
  const { systemPrompt, model, callModel } = params;
  // ：先整备历史切片（normalize+pairing），再 append ack / 摘要指令。
  const msgs: Message[] = [...sanitizeSummaryInput(chunk)];
  const last = msgs[msgs.length - 1];
  if (last && last.role === 'user') {
    msgs.push({
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: CONTINUING_ACK }],
    });
  }
  msgs.push({ role: 'user' as const, content: COMPACT_USER_PROMPT + buildCompactFocusInstruction(params.summaryFocus) });

  const sys = systemPrompt
    ? `${COMPACT_SYSTEM_PROMPT}\n\nOriginal system prompt for context:\n${systemPrompt}`
    : COMPACT_SYSTEM_PROMPT;

  return collectStreamText(
    callModel({
      model,
      messages: msgs,
      system: sys,
      maxTokens: SUMMARY_MAX_OUTPUT_TOKENS,
      temperature: 0.3,
      requestSource: '_compact',
    }),
  );
}

/**
 * 缓存友好的全量摘要调用。
 *
 * 性能根因：旧 `compactSingleChunk` 把 `COMPACT_SYSTEM_PROMPT`
 * 拼到 system 最前面，并只发历史切片——这让压缩请求的 prompt 前缀从 token 0
 * 起就跟常规调用的缓存前缀不一致，整条 prompt cache 全 miss，模型要把整段历史
 * 从头 prefill，因此压缩比一次常规调用还慢。
 *
 * 修法（按约定实现 /compact）：
 * - **保持原始 system prompt 不变**（复用常规调用缓存的 system 断点 BP2/BP3）；
 * - **发送完整对话历史**（与上一轮常规调用同一前缀，命中最后一条 user 消息的
 *   BP4 缓存）；
 * - 摘要指令（原 COMPACT_SYSTEM_PROMPT 的指导 + COMPACT_USER_PROMPT 的 9 段要求）
 *   改放到**末尾 user 消息**，只有这条尾部指令 + 摘要输出是“新”token。
 *
 * 这样压缩调用的输入绝大部分命中缓存，速度与一次常规调用相当。摘要覆盖范围变成
 * 整段对话（含保留尾部），与 `buildCompactedMessages` 拼回的 `[摘要, ...保留尾部]`
 * 略有重叠，但语义无损（保留尾部仍逐字带上），换来的是缓存命中。
 */
async function callCacheFriendlyFullSummary(
  messages: Message[],
  params: {
    systemPrompt: string;
    model: string;
    callModel: (req: LLMRequest) => AsyncIterable<LLMResponseChunk>;
    summaryFocus?: string;
  },
): Promise<string> {
  // ：整备幂等——主循环 beforeModel 治理过的 messages 再过一遍产出
  // 内容等价消息，缓存前缀 byte 不变（见 sanitizeSummaryInput 注释）。
  const msgs: Message[] = [...sanitizeSummaryInput(messages)];
  const last = msgs[msgs.length - 1];
  if (last && last.role === 'user') {
    msgs.push({
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: CONTINUING_ACK }],
    });
  }
  const instruction = [
    COMPACT_SYSTEM_PROMPT,
    '',
    COMPACT_USER_PROMPT + buildCompactFocusInstruction(params.summaryFocus),
  ].join('\n');
  msgs.push({ role: 'user' as const, content: instruction });

  return collectStreamText(
    params.callModel({
      model: params.model,
      // 关键：保持原始 system prompt 不变，复用常规调用的缓存前缀。
      // systemPrompt 为空时省略，避免发一个空 system 块。
      system: params.systemPrompt || undefined,
      messages: msgs,
      maxTokens: SUMMARY_MAX_OUTPUT_TOKENS,
      temperature: 0.3,
      requestSource: '_compact',
    }),
  );
}

function buildCompactedMessages(
  summary: string,
  messagesToKeep: Message[],
  transcriptPath?: string,
): Message[] {
  const summaryMsg: Message = {
    role: 'user' as const,
    content: buildCompactedSummaryWrapper(summary, transcriptPath),
  };

  if (messagesToKeep[0]?.role === 'assistant') {
    return [summaryMsg, ...messagesToKeep];
  }
  const ack: Message = {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text: UNDERSTOOD_ACK }],
  };
  return [summaryMsg, ack, ...messagesToKeep];
}

const MAX_ACTIVE_FILES = 10;

/**
 * Extract file paths recently accessed via tool calls.
 *
 * Scans `tool_use` blocks for file-operation tools, extracts `input.path` /
 * `input.file_path` / `input.filePath`, deduplicates, and returns the most
 * recent N paths (Map insertion order = encounter order, so last entries are
 * most recent).
 */
export function extractActiveFiles(messages: Message[]): string[] {
  const fileActions = new Map<string, 'read' | 'modified'>();

  for (const msg of messages) {
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type !== 'tool_use') continue;
      const filePath = getToolUseFilePath(block as ToolUseBlock);
      if (!filePath) continue;
      recordFileAction(fileActions, filePath, block.name.toLowerCase());
    }
  }

  const entries = [...fileActions.entries()];
  const recent = entries.slice(-MAX_ACTIVE_FILES);
  return recent.map(([p]) => p);
}

function formatActiveFilesHint(messages: Message[]): string {
  const fileActions = new Map<string, 'read' | 'modified'>();

  for (const msg of messages) {
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type !== 'tool_use') continue;
      const filePath = getToolUseFilePath(block as ToolUseBlock);
      if (!filePath) continue;
      recordFileAction(fileActions, filePath, block.name.toLowerCase());
    }
  }

  if (fileActions.size === 0) return '';

  const entries = [...fileActions.entries()].slice(-MAX_ACTIVE_FILES);
  const modified = entries.filter(([, a]) => a === 'modified').map(([p]) => p);
  const read = entries.filter(([, a]) => a === 'read').map(([p]) => p);

  const parts: string[] = [];
  if (modified.length > 0) parts.push(`Modified: ${modified.join(', ')}`);
  if (read.length > 0) parts.push(`Read: ${read.join(', ')}`);
  return `[Files recently accessed — ${parts.join(' | ')}]`;
}

// ─── Post-Compact File Attachments ───────────────────────────────────
// PRD §5.4 + Wave 8：压缩后注入文件内容 attachment，让 Agent 不需要
// "压缩后第一件事是重新 read_file" 才能继续工作。
// 与既有约定 `createPostCompactFileAttachments` 同思路，但从
// 压缩前 messages 的 tool_result 提取内容，不读磁盘。

export const POST_COMPACT_ATTACHMENT_BUDGET = 20_000;

// Includes legacy transcript / external-agent names so old history compacts
// correctly; current TabTin file tools are read_file/write_file/edit_file/delete_file.
const FILE_READ_TOOLS = /^(file_read|read_file|read|cat|view_file)$/i;
const FILE_WRITE_TOOLS = /^(file_write|write_file|write|edit_file|edit|create_file|str_replace_editor|patch|update_file|save_file|replace|delete_file|remove_file)$/i;

// 仅 `[旧工具结果内容已清除]`（time-based microcompact 占位，阶段 5 中文化）是当前
// runtime 会产生的占位；其余 3 条是历史风格占位的防御性匹配，当前全仓
// 无产生点（保留作向后兼容，永不命中亦无害）。
const PLACEHOLDER_PATTERNS = [
  /^\[Content trimmed/,
  /^\[Tool result:/,
  /^\[旧工具结果内容已清除\]/,
  /^\[Content archived/,
];

function isPlaceholderContent(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 30) return false;
  return PLACEHOLDER_PATTERNS.some(p => p.test(trimmed));
}

function extractToolResultContent(block: ToolResultBlock): string | null {
  if (typeof block.content === 'string') {
    if (block.content.trim().length === 0) return null;
    if (isPlaceholderContent(block.content)) return null;
    return block.content;
  }
  const texts: string[] = [];
  for (const sub of block.content) {
    if (sub.type === 'text' && sub.text) texts.push(sub.text);
  }
  const joined = texts.join('\n');
  if (joined.trim().length === 0) return null;
  if (isPlaceholderContent(joined)) return null;
  return joined;
}

export interface FileAttachment {
  path: string;
  content: string;
  action: 'read' | 'modified';
  tokens: number;
}

function buildToolResultMap(messages: Message[]): Map<string, ToolResultBlock> {
  const toolResultMap = new Map<string, ToolResultBlock>();
  for (const msg of messages) {
    if (msg.role !== 'user' || typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type === 'tool_result') {
        toolResultMap.set(block.tool_use_id, block as ToolResultBlock);
      }
    }
  }
  return toolResultMap;
}

function collectLatestFileReads(
  messages: Message[],
  toolResultMap: Map<string, ToolResultBlock>,
): Map<string, { content: string; action: 'read' | 'modified' }> {
  const fileMap = new Map<string, { content: string; action: 'read' | 'modified' }>();
  const modifiedPaths = new Set<string>();

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;

    for (let j = msg.content.length - 1; j >= 0; j--) {
      recordFileReadCandidate({
        block: msg.content[j],
        toolResultMap,
        fileMap,
        modifiedPaths,
      });
    }
  }

  return fileMap;
}

function recordFileReadCandidate(params: {
  block: ContentBlock;
  toolResultMap: Map<string, ToolResultBlock>;
  fileMap: Map<string, { content: string; action: 'read' | 'modified' }>;
  modifiedPaths: Set<string>;
}): void {
  const { block, toolResultMap, fileMap, modifiedPaths } = params;
  if (block.type !== 'tool_use') return;
  const tu = block as ToolUseBlock;
  const filePath = getToolUseFilePath(tu);
  if (!filePath) return;

  if (FILE_WRITE_TOOLS.test(tu.name)) {
    modifiedPaths.add(filePath);
    return;
  }

  if (!FILE_READ_TOOLS.test(tu.name) || fileMap.has(filePath)) return;

  const result = toolResultMap.get(tu.id);
  if (!result || result.is_error) return;

  const content = extractToolResultContent(result);
  if (!content) return;

  const action = modifiedPaths.has(filePath) ? 'modified' : 'read';
  fileMap.set(filePath, { content, action });
}

function sortFileAttachmentEntries(
  fileMap: Map<string, { content: string; action: 'read' | 'modified' }>,
): Array<[string, { content: string; action: 'read' | 'modified' }]> {
  const entries = [...fileMap.entries()];
  entries.sort(([, a], [, b]) => {
    if (a.action === 'modified' && b.action !== 'modified') return -1;
    if (a.action !== 'modified' && b.action === 'modified') return 1;
    return 0;
  });
  return entries;
}

function fitAttachmentContentToBudget(
  content: string,
  tokens: number,
  maxPerFile: number,
  estimator?: TokenEstimator,
): { content: string; tokens: number } {
  if (tokens <= maxPerFile) return { content, tokens };

  const charBudget = Math.floor(content.length * (maxPerFile / tokens));
  const headSize = Math.floor(charBudget * 0.7);
  const tailSize = charBudget - headSize;
  const fittedContent =
    content.slice(0, headSize) +
    CONTEXT_TRUNCATED_PLACEHOLDER +
    content.slice(-tailSize);

  return {
    content: fittedContent,
    tokens: estimateTokens([{ role: 'user', content: fittedContent }], estimator),
  };
}

/**
 * 从压缩前的 messages 中提取文件内容 attachment。
 *
 * 核心设计：只从 read 工具的 tool_result 提取内容（write 工具的 result
 * 通常是操作确认，不是文件内容）。同时追踪 write 操作，如果某文件在
 * read 之后被 write 过，标记 action='modified'。
 *
 * 逻辑（倒序遍历）：
 * 1. 遇到 write 工具 → 记录该路径被 modified（但不提取 result 内容）
 * 2. 遇到 read 工具 → 提取 result 内容；若该路径之前被标记 modified 则继承
 * 3. 同路径只保留最新一次的 read 内容
 * 4. modified 文件优先级 > read 文件
 * 5. 按 token 预算截取；单文件超 budget/3 时截取头尾
 */
export function extractFileAttachments(
  messages: Message[],
  budget: number = POST_COMPACT_ATTACHMENT_BUDGET,
  estimator?: TokenEstimator,
): FileAttachment[] {
  const toolResultMap = buildToolResultMap(messages);
  const fileMap = collectLatestFileReads(messages, toolResultMap);

  if (fileMap.size === 0) return [];

  const entries = sortFileAttachmentEntries(fileMap);
  const maxPerFile = Math.floor(budget / 3);
  const attachments: FileAttachment[] = [];
  let totalTokens = 0;

  for (const [path, entry] of entries) {
    const initialTokens = estimateTokens(
      [{ role: 'user', content: entry.content }],
      estimator,
    );
    const { content, tokens } = fitAttachmentContentToBudget(
      entry.content,
      initialTokens,
      maxPerFile,
      estimator,
    );

    if (totalTokens + tokens > budget) break;

    attachments.push({ path, content, action: entry.action, tokens });
    totalTokens += tokens;
  }

  return attachments;
}

async function chunkedCompact(
  rawMessagesToSummarize: Message[],
  messagesToKeep: Message[],
  params: {
    systemPrompt: string;
    model: string;
    callModel: (req: LLMRequest) => AsyncIterable<LLMResponseChunk>;
  },
  tokensBefore: number,
  transcriptPath?: string,
  estimator?: TokenEstimator,
): Promise<CompactResult> {
  //  第二波·摘要输入瘦身：分块摘要的切片前缀本来就不与提示词缓存对齐
  // （见 summary-input-slim.ts 缓存约束），瘦身是纯收益——旧白名单工具输出
  // 换占位后分块数大幅下降。只改本函数内的拷贝，不动调用方数组。
  const messagesToSummarize = slimMessagesForSummaryInput(rawMessagesToSummarize).messages;
  const chunkCount = Math.max(
    2,
    Math.ceil(estimateTokens(messagesToSummarize, estimator) / MAX_SUMMARY_INPUT_TOKENS),
  );
  const baseSize = Math.ceil(messagesToSummarize.length / chunkCount);
  const summaries: string[] = [];

  let start = 0;
  while (start < messagesToSummarize.length) {
    let end = Math.min(start + baseSize, messagesToSummarize.length);
    // Avoid splitting tool_use / tool_result pairs within chunks
    while (
      end < messagesToSummarize.length &&
      messagesToSummarize[end - 1].role === 'assistant' &&
      hasToolUse(messagesToSummarize[end - 1])
    ) {
      end++;
    }
    end = Math.min(end, messagesToSummarize.length);

    const chunk = messagesToSummarize.slice(start, end);
    try {
      summaries.push(await compactSingleChunk(chunk, params));
    } catch {
      summaries.push(CHUNK_TOO_LARGE_MARKER);
    }
    start = end;
  }

  let combined = summaries.join('\n\n---\n\n');
  if (!combined.trim()) {
    return {
      // 注意用 raw 原文回拼——瘦身拷贝只允许进摘要请求，永不写回历史。
      compactedMessages: [...rawMessagesToSummarize, ...messagesToKeep],
      summary: '',
      tokensFreed: 0,
      mode: 'native',
    };
  }

  const chunkedActiveHint = formatActiveFilesHint(messagesToKeep);
  if (chunkedActiveHint) {
    combined += '\n\n' + chunkedActiveHint;
  }

  const compactedMessages = buildCompactedMessages(combined, messagesToKeep, transcriptPath);
  const tokensAfter = estimateTokens(compactedMessages, estimator);
  return {
    compactedMessages,
    summary: combined,
    tokensFreed: Math.max(0, tokensBefore - tokensAfter),
    mode: 'native',
    keptTailCount: messagesToKeep.length,
  };
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Attempt to generate a compact summary using an isolated LLM call
 * via the fork provider. Does NOT use forkQuery — avoids the boilerplate
 * format conflict (Scope:/Result: vs plain summary text).
 */
async function forkCompactSummary(
  messagesToSummarize: Message[],
  params: {
    systemPrompt: string;
    model: string;
    forkConfig: ForkCompactConfig;
    summaryFocus?: string;
  },
): Promise<string | null> {
  try {
    const sys = params.systemPrompt
      ? `${COMPACT_SYSTEM_PROMPT}\n\nOriginal system prompt for context:\n${params.systemPrompt}`
      : COMPACT_SYSTEM_PROMPT;

    //  第二波·摘要输入瘦身：fork provider 是独立调用、无共享缓存前缀，
    // 瘦身纯收益（只改本地拷贝，不写回历史）。#3984：瘦身后过统一整备闸，
    // 再 append ack / 摘要指令。
    const msgs: Message[] = [
      ...sanitizeSummaryInput(slimMessagesForSummaryInput(messagesToSummarize).messages),
    ];
    const last = msgs[msgs.length - 1];
    if (last && last.role === 'user') {
      msgs.push({
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: CONTINUING_ACK }],
      });
    }
    msgs.push({ role: 'user' as const, content: COMPACT_USER_PROMPT + buildCompactFocusInstruction(params.summaryFocus) });

    const stream = params.forkConfig.provider.createStream({
      model: params.model,
      messages: msgs,
      system: sys,
      maxTokens: SUMMARY_MAX_OUTPUT_TOKENS,
      temperature: 0.3,
      requestSource: '_compact',
    });

    const summary = await collectStreamText(stream);

    if (!validateSummaryQuality(summary)) {
      return null;
    }
    return summary;
  } catch {
    return null;
  }
}

/**
 * Basic quality gate for generated summaries.
 * Rejects outputs that are too short, use the wrong format, or are single-line garbage.
 */
function validateSummaryQuality(summary: string): boolean {
  const trimmed = summary.trim();
  if (trimmed.length <= 50) return false;
  if (trimmed.startsWith('范围：')) return false;
  if (!trimmed.includes('\n')) return false;
  return true;
}

/**
 * Compact a conversation by summarizing old messages with the LLM.
 *
 * Progressive: only summarizes the oldest portion; recent messages are
 * preserved verbatim. When `forkConfig` is provided, first attempts to
 * generate summary via an isolated LLM call using the fork provider.
 *
 * **FR-16 H3-B — Summary reuse**：当 `previousSummary` 存在且条件满足时（详
 * 见 `evaluateReusePath`），仅把"PRIOR_SUMMARY + 新增消息"喂给 LLM 做增量
 * 摘要，节省 ≥ 30% 输入 token。reuse 失败 / 跳过时**自动回落**到全量路径，
 * 调用方无需感知差异——可通过返回值的 `reuseInfo` 字段观察实际行为。
 */
export async function compactConversation(params: {
  messages: Message[];
  systemPrompt: string;
  model: string;
  callModel: (req: LLMRequest) => AsyncIterable<LLMResponseChunk>;
  keepLastN?: number;
  contextWindowTokens?: number;
  transcriptPath?: string;
  /** Fork config for isolated LLM-based compaction */
  forkConfig?: ForkCompactConfig;
  /** Token estimator for calibrated estimation */
  estimator?: TokenEstimator;
  /**
   * FR-16 H3-B：上次 compact 输出的 summary 缓存。当 reuse 条件满足时走"PRIOR_SUMMARY +
   * 新增消息"的增量摘要 prompt；不满足时静默回落全量。
   */
  previousSummary?: SummaryReuseEntry;
  /** FR-16 H3-B：reuse 总开关。`undefined` 等价于 `true`（默认开启）。 */
  enableSummaryReuse?: boolean;
  /** FR-16 H3-B：previousSummary 最大年龄（ms），超过则不 reuse；`undefined` 不限。 */
  summaryReuseMaxAgeMs?: number;
  /**
   * FR-16 H3-B：触发 reuse 的最小增量消息条数（H3-B Review 加）。少于 N 条新增
   * 消息时跳过 reuse 走全量，避免短消息高频对话场景下"reuse 反而比全量贵"。
   * 默认 3。
   */
  summaryReuseMinAddedMessages?: number;
  /**
   * FR-16 H3-B：上游已"决策"本轮强制走 fallback——通常是上一轮 judge 窗口触发了
   * fallback。compactConversation 仍走全量路径，只是在 reuseInfo.fallbackReason
   * 里写入 `judge_window_fallback`，方便宿主统一发埋点。
   */
  forceFallbackReason?: SummaryReuseFallbackReason;
  /**
   * Wave 8：压缩后注入文件内容 attachment 的 token 预算。
   * 默认 POST_COMPACT_ATTACHMENT_BUDGET (20k)。设为 0 禁止注入
   * （emergency / hardTrim 调用方应传 0）。
   */
  postCompactAttachmentBudget?: number;
  /**
   * 手动 /compact 可传入用户指定的摘要侧重。仅影响摘要 prompt，不改变保留尾部、
   * 文件恢复和工具配对等 compact 不变量。
   */
  summaryFocus?: string;
  /**
   *  第二波·任务连续性：当前会话的 active plan 指针。压缩成功后与
   * 未完成待办（从压缩前消息的 todo 调用回放得出）一起注入 summary
   * 消息，防止长任务压缩后丢进度。`undefined` = 无活跃计划。
   */
  activePlanRef?: TaskContinuityPlan;
}): Promise<CompactResult> {
  // PRD-04 T2.7: 包装 callModel 收集 compact 路径所有 LLM 调用的 usage
  const _compactUsageAcc: CompactUsage = { input_tokens: 0, output_tokens: 0 };
  const wrappedCallModel = wrapCallModelForUsage(params.callModel, _compactUsageAcc);
  const result = await _compactConversationInner({
    ...params,
    callModel: wrappedCallModel,
  });

  // Wave 8: inject restored file content attachments into the summary message.
  // Only on normal paths (summary non-empty = real compaction happened).
  // Emergency / hardTrim callers pass postCompactAttachmentBudget=0 to skip.
  const attachmentBudget = params.postCompactAttachmentBudget ?? POST_COMPACT_ATTACHMENT_BUDGET;
  if (attachmentBudget > 0 && result.summary.trim().length > 0) {
    const attachments = extractFileAttachments(params.messages, attachmentBudget, params.estimator);
    if (attachments.length > 0) {
      injectFileAttachmentsIntoSummary(result, attachments);
    }
  }

  //  第二波·任务连续性：压缩点往往是长任务中途——把 active plan 指针
  // 与最近一次未完成待办注入 summary 消息（`[最近对话如下]` 之前，与文件
  // 重注入同位置），让智能体压缩后不用从摘要里"猜"自己干到哪了。
  // 段落极小（计划一行 + 待办若干行），emergency 路径也注入。
  if (result.summary.trim().length > 0) {
    const continuitySection = buildTaskContinuitySection({
      plan: params.activePlanRef ?? null,
      todos: extractLatestUnfinishedTodos(params.messages),
    });
    if (continuitySection) {
      injectSectionIntoSummary(result, continuitySection);
    }
  }

  if (_compactUsageAcc.input_tokens > 0 || _compactUsageAcc.output_tokens > 0) {
    result.compactUsage = { ..._compactUsageAcc, model: params.model };
  }
  return result;
}

/**
 * 找到 compactedMessages 中的 summary message，把文件内容插入到
 * `[Recent conversation follows]` 之前。嵌入同一条 user message 中
 * 避免 role alternation 问题。
 *
 * Markers / 段拼装由 `prompts/compact/wrapper.ts` + `prompts/compact/file-restore.ts`
 * 持有 SSoT，本函数只决策"插入位置"。
 */
function injectFileAttachmentsIntoSummary(
  result: CompactResult,
  attachments: FileAttachment[],
): void {
  const restoreEntries: RestoredFileEntry[] = attachments.map((att) => ({
    path: att.path,
    action: att.action,
    content: att.content,
  }));
  const section = buildRestoredFileContext(restoreEntries);

  if (injectSectionIntoSummary(result, section)) {
    result.attachmentsInjected = attachments.length;
    result.attachmentTokens = attachments.reduce((sum, a) => sum + a.tokens, 0);
  }
}

/**
 * 把一段文本插入 summary user message 的 `[最近对话如下]` marker 之前
 * （无 marker 则追加到末尾）。文件重注入与任务连续性注入共用本 helper。
 * 返回是否找到了 summary 消息并完成插入。
 */
function injectSectionIntoSummary(result: CompactResult, section: string): boolean {
  if (!section) return false;
  for (let i = 0; i < result.compactedMessages.length; i++) {
    const msg = result.compactedMessages[i];
    if (msg.role !== 'user' || typeof msg.content !== 'string') continue;
    if (!msg.content.includes(SUMMARY_HEADER_MARKER)) continue;

    result.compactedMessages[i] = {
      ...msg,
      content: msg.content.includes(RECENT_CONVERSATION_MARKER)
        ? msg.content.replace(RECENT_CONVERSATION_MARKER, section + RECENT_CONVERSATION_MARKER)
        : msg.content + section,
    };
    return true;
  }
  return false;
}

async function _compactConversationInner(params: Parameters<typeof compactConversation>[0]): Promise<CompactResult> {
  const { messages, systemPrompt, model, callModel, transcriptPath, estimator } = params;

  let keepLastN = params.keepLastN ?? DEFAULT_KEEP_LAST_N;
  if (!params.keepLastN && params.contextWindowTokens) {
    const targetKeepTokens = Math.floor(params.contextWindowTokens * KEEP_RATIO);
    let tokenAcc = 0;
    let dynamicKeep = 0;
    for (let i = messages.length - 1; i >= 0 && tokenAcc < targetKeepTokens; i--) {
      tokenAcc += estimateTokens([messages[i]], estimator);
      dynamicKeep++;
    }
    keepLastN = Math.max(DEFAULT_KEEP_LAST_N, dynamicKeep);
  }

  if (messages.length <= keepLastN + 1) {
    return { compactedMessages: messages, summary: '', tokensFreed: 0, mode: 'native' };
  }

  const tokensBefore = estimateTokens(messages, estimator);
  const splitIdx = findSplitPoint(messages, keepLastN);
  const messagesToSummarize = messages.slice(0, splitIdx);
  const messagesToKeep = messages.slice(splitIdx);
  const compactParams = { systemPrompt, model, callModel, summaryFocus: params.summaryFocus };

  if (estimateTokens(messagesToSummarize, estimator) > MAX_SUMMARY_INPUT_TOKENS) {
    const result = await chunkedCompact(
      messagesToSummarize,
      messagesToKeep,
      compactParams,
      tokensBefore,
      transcriptPath,
      estimator,
    );
    return withReuseInfo(result, {
      reused: false,
      // H3-B Review fix：原文超大走 chunked 是"消息体积问题"，与 reuse LLM
      // 调用失败语义不同——独立 reason 避免 dashboard 误归质量问题。
      // forceFallbackReason 优先级最高（上一轮 judge 触发的 fallback）。
      fallbackReason: params.forceFallbackReason ?? 'oversize_no_reuse',
      coveredMsgsBefore: params.previousSummary?.msgsCovered,
      coveredMsgsAfter: splitIdx,
    });
  }

  // ── FR-16: Summary reuse path ──
  // Single source of truth for"该不该 reuse"; downstream paths only care
  // about a `null` (= go full) vs a SummaryReuseEvaluation (= attempt reuse).
  const reuseDecision = evaluateReusePath({
    enableSummaryReuse: params.enableSummaryReuse,
    previousSummary: params.previousSummary,
    summaryReuseMaxAgeMs: params.summaryReuseMaxAgeMs,
    summaryReuseMinAddedMessages: params.summaryReuseMinAddedMessages,
    splitIdx,
    forceFallbackReason: params.forceFallbackReason,
  });

  if (reuseDecision.action === 'reuse') {
    // Try the incremental path; if anything goes wrong (LLM error / empty
    // response / pairing post-check fails) we fall through to the full
    // path with reuseInfo.fallbackReason='incremental_call_failed'.
    const reuseAttempt = await tryReuseSummary({
      previousSummary: reuseDecision.previousSummary,
      addedMessages: messagesToSummarize.slice(reuseDecision.previousSummary.msgsCovered),
      messagesToKeep,
      messagesToSummarize,
      messages,
      keepLastN,
      transcriptPath,
      params: compactParams,
      tokensBefore,
      estimator,
    });
    if (reuseAttempt) {
      return reuseAttempt;
    }
    // Fall through to full path; mark fallback reason for upstream emit.
    return runFullCompactWithFallback({
      messages,
      messagesToSummarize,
      messagesToKeep,
      keepLastN,
      compactParams,
      forkConfig: params.forkConfig,
      transcriptPath,
      estimator,
      tokensBefore,
      reuseInfo: {
        reused: false,
        fallbackReason: 'incremental_call_failed',
        coveredMsgsBefore: reuseDecision.previousSummary.msgsCovered,
        coveredMsgsAfter: splitIdx,
      },
    });
  }

  // ── Full compact path ──
  return runFullCompactWithFallback({
    messages,
    messagesToSummarize,
    messagesToKeep,
    keepLastN,
    compactParams,
    forkConfig: params.forkConfig,
    transcriptPath,
    estimator,
    tokensBefore,
    reuseInfo: {
      reused: false,
      fallbackReason: reuseDecision.fallbackReason,
      coveredMsgsBefore: params.previousSummary?.msgsCovered,
      coveredMsgsAfter: splitIdx,
    },
  });
}

// ─── Reuse helpers ───────────────────────────────────────────────────

interface SummaryReuseEvaluation {
  action: 'reuse' | 'full';
  previousSummary: SummaryReuseEntry;
  fallbackReason: SummaryReuseFallbackReason;
}

/**
 * 决策"本次 compact 是否走 reuse"。返回的 `action` 由
 * `compactConversation` 主体消费——`reuse` 走增量摘要 prompt，`full` 走原全量
 * 路径。`fallbackReason` 在 `action='full'` 时有意义。
 *
 * 决策顺序：disabled → judge_window_fallback → no_previous_summary → summary_too_old
 * → no_new_messages → reuse。
 */
function evaluateReusePath(params: {
  enableSummaryReuse?: boolean;
  previousSummary?: SummaryReuseEntry;
  summaryReuseMaxAgeMs?: number;
  summaryReuseMinAddedMessages?: number;
  splitIdx: number;
  forceFallbackReason?: SummaryReuseFallbackReason;
}): SummaryReuseEvaluation {
  const enabled = params.enableSummaryReuse !== false;
  if (!enabled) {
    return { action: 'full', previousSummary: makeStubEntry(), fallbackReason: 'disabled' };
  }

  if (params.forceFallbackReason) {
    return {
      action: 'full',
      previousSummary: params.previousSummary ?? makeStubEntry(),
      fallbackReason: params.forceFallbackReason,
    };
  }

  const prev = params.previousSummary;
  if (!prev || prev.content.trim().length === 0) {
    return { action: 'full', previousSummary: makeStubEntry(), fallbackReason: 'no_previous_summary' };
  }

  if (typeof params.summaryReuseMaxAgeMs === 'number' && params.summaryReuseMaxAgeMs > 0) {
    const age = Date.now() - prev.generatedAt;
    if (age > params.summaryReuseMaxAgeMs) {
      return { action: 'full', previousSummary: prev, fallbackReason: 'summary_too_old' };
    }
  }

  // H3-B Review fix：增量必须够大才走 reuse（防短消息高频负收益）。
  // splitIdx <= prev.msgsCovered 时新增 = 0；< minAdded 时新增不够。
  // 默认 minAdded=3：avoid "1 条新消息触发 reuse" 这种反而比全量贵的场景。
  const addedCount = params.splitIdx - prev.msgsCovered;
  const minAdded = Math.max(1, params.summaryReuseMinAddedMessages ?? 3);
  if (addedCount < minAdded) {
    return { action: 'full', previousSummary: prev, fallbackReason: 'no_new_messages' };
  }

  return { action: 'reuse', previousSummary: prev, fallbackReason: 'no_previous_summary' };
}

function makeStubEntry(): SummaryReuseEntry {
  return { content: '', generatedAt: 0, msgsCovered: 0, tokensCovered: 0 };
}

async function tryReuseSummary(input: {
  previousSummary: SummaryReuseEntry;
  addedMessages: Message[];
  messagesToKeep: Message[];
  messagesToSummarize: Message[];
  messages: Message[];
  keepLastN: number;
  transcriptPath?: string;
  params: { systemPrompt: string; model: string; callModel: (req: LLMRequest) => AsyncIterable<LLMResponseChunk> };
  tokensBefore: number;
  estimator?: TokenEstimator;
}): Promise<CompactResult | null> {
  const {
    previousSummary,
    addedMessages,
    messagesToKeep,
    messagesToSummarize,
    messages,
    keepLastN,
    transcriptPath,
    params,
    tokensBefore,
    estimator,
  } = input;

  let summary: string;
  try {
    summary = await callIncrementalSummary(previousSummary, addedMessages, params);
  } catch (error) {
    // 413 inside reuse path → bubble up as null so caller falls through to
    // chunked full path; transient LLM errors → also fall back.
    if (isPromptTooLongError(error)) return null;
    return null;
  }

  if (!summary.trim()) return null;

  const activeFilesHint = formatActiveFilesHint(messagesToKeep);
  if (activeFilesHint) {
    summary += '\n\n' + activeFilesHint;
  }

  let compactedMessages = buildCompactedMessages(summary, messagesToKeep, transcriptPath);
  let keptTailCount = messagesToKeep.length;
  if (!validateToolPairing(compactedMessages)) {
    const widerIdx = findSplitPoint(messages, keepLastN + 4);
    let pairingFixed = false;
    if (widerIdx !== messages.length - messagesToKeep.length) {
      const widerKeep = messages.slice(widerIdx);
      const fixed = buildCompactedMessages(summary, widerKeep, transcriptPath);
      if (validateToolPairing(fixed)) {
        compactedMessages = fixed;
        keptTailCount = widerKeep.length;
        pairingFixed = true;
      }
    }
    if (!pairingFixed) return null;
  }

  const tokensAfter = estimateTokens(compactedMessages, estimator);

  // tokens_saved 估算：与"假设走全量 compact 时 LLM input"对比节省值。
  // 全量 LLM input ≈ tokensCovered（前次覆盖范围）+ addedMessagesTokens
  // reuse LLM input ≈ previousSummaryTokens + addedMessagesTokens
  // 差值 = tokensCovered - previousSummaryTokens（≥ 0；若 summary 不小于原文则 0）
  //
  // H3-B Review 已知偏差：tokensCovered 实际写的是 estimateTokens(messagesAfter)
  // 即"summary message + 保留尾部"，比"被替换的原始消息"多算了尾部那一截。
  // 这导致 tokensSaved **趋势可信但绝对值偏乐观**。下一次重构时把 tokensCovered
  // 改成"真正被替换的消息原文 token"会让此估算精确化（见遗留项）。
  const previousSummaryTokens = estimateTokens(
    [{ role: 'user', content: previousSummary.content }],
    estimator,
  );
  const tokensSaved = Math.max(0, previousSummary.tokensCovered - previousSummaryTokens);

  return withReuseInfo(
    {
      compactedMessages,
      summary,
      tokensFreed: Math.max(0, tokensBefore - tokensAfter),
      mode: 'native',
      keptTailCount,
    },
    {
      reused: true,
      previousAgeMs: Math.max(0, Date.now() - previousSummary.generatedAt),
      tokensSaved,
      msgsAdded: addedMessages.length,
      coveredMsgsBefore: previousSummary.msgsCovered,
      coveredMsgsAfter: messagesToSummarize.length,
    },
  );
}

async function callIncrementalSummary(
  previousSummary: SummaryReuseEntry,
  addedMessages: Message[],
  params: {
    systemPrompt: string;
    model: string;
    callModel: (req: LLMRequest) => AsyncIterable<LLMResponseChunk>;
  },
): Promise<string> {
  // Rebuild a coherent message stream:
  //   - addedMessages prefix (real assistant + user / tool turns)
  //   - if last is user we add an "ack" assistant to keep role alternation
  //   - finally append the user instruction asking for the updated summary
  //
  //  第二波·摘要输入瘦身：增量摘要的 system prompt 内嵌 PRIOR_SUMMARY，
  // 前缀必然与常规调用缓存分叉——瘦身纯收益（只改本地拷贝，不写回历史）。
  // ：增量切片从 msgsCovered 处切开，起首可能是孤儿 tool_result——
  // 瘦身后过统一整备闸，再 append ack / 摘要指令。
  const msgs: Message[] = [
    ...sanitizeSummaryInput(slimMessagesForSummaryInput(addedMessages).messages),
  ];
  const last = msgs[msgs.length - 1];
  if (last && last.role === 'user') {
    msgs.push({
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: CONTINUING_ACK }],
    });
  }
  msgs.push({ role: 'user' as const, content: INCREMENTAL_COMPACT_USER_INSTRUCTION });

  const sys = buildIncrementalCompactSystemPrompt(previousSummary.content, params.systemPrompt);

  return collectStreamText(
    params.callModel({
      model: params.model,
      messages: msgs,
      system: sys,
      maxTokens: SUMMARY_MAX_OUTPUT_TOKENS,
      temperature: 0.3,
      requestSource: '_compact',
    }),
  );
}

async function runFullCompactWithFallback(input: {
  messages: Message[];
  messagesToSummarize: Message[];
  messagesToKeep: Message[];
  keepLastN: number;
  compactParams: {
    systemPrompt: string;
    model: string;
    callModel: (req: LLMRequest) => AsyncIterable<LLMResponseChunk>;
    summaryFocus?: string;
  };
  forkConfig?: ForkCompactConfig;
  transcriptPath?: string;
  estimator?: TokenEstimator;
  tokensBefore: number;
  reuseInfo: SummaryReuseInfo;
}): Promise<CompactResult> {
  const {
    messages,
    messagesToSummarize,
    messagesToKeep,
    keepLastN,
    compactParams,
    forkConfig,
    transcriptPath,
    estimator,
    tokensBefore,
    reuseInfo,
  } = input;

  let summary: string | null = null;

  if (forkConfig) {
    summary = await forkCompactSummary(messagesToSummarize, {
      systemPrompt: compactParams.systemPrompt,
      model: compactParams.model,
      forkConfig,
      summaryFocus: compactParams.summaryFocus,
    });
  }

  if (!summary) {
    try {
      // 缓存友好：发完整历史 + 原 system + 尾部摘要指令，复用常规调用的 prompt
      // cache（详见 callCacheFriendlyFullSummary 注释）。**这里刻意不瘦身**——
      // 瘦身会让前缀与缓存分叉，缓存命中时原样发送反而更便宜。
      summary = await callCacheFriendlyFullSummary(messages, compactParams);
    } catch (error) {
      if (!isPromptTooLongError(error)) throw error;
      //  第二波：摘要请求自身超长——缓存已然没救，进入瘦身 + 按调用
      // 轮次截头的重试链（按约定实现 truncateHeadForPTLRetry），
      // 重试耗尽再回落分块摘要。
      summary = await retrySummaryAfterPromptTooLong(
        messagesToSummarize,
        compactParams,
        estimator,
      );
      if (!summary) {
        const result = await chunkedCompact(
          messagesToSummarize,
          messagesToKeep,
          compactParams,
          tokensBefore,
          transcriptPath,
          estimator,
        );
        return withReuseInfo(result, reuseInfo);
      }
    }
  }

  if (!summary.trim()) {
    return withReuseInfo(
      { compactedMessages: messages, summary: '', tokensFreed: 0, mode: 'native' },
      reuseInfo,
    );
  }

  const activeFilesHint = formatActiveFilesHint(messagesToKeep);
  if (activeFilesHint) {
    summary += '\n\n' + activeFilesHint;
  }

  let compactedMessages = buildCompactedMessages(summary, messagesToKeep, transcriptPath);
  let keptTailCount = messagesToKeep.length;

  if (!validateToolPairing(compactedMessages)) {
    const widerIdx = findSplitPoint(messages, keepLastN + 4);
    if (widerIdx !== messages.length - messagesToKeep.length) {
      const widerKeep = messages.slice(widerIdx);
      const fixed = buildCompactedMessages(summary, widerKeep, transcriptPath);
      if (validateToolPairing(fixed)) {
        compactedMessages = fixed;
        keptTailCount = widerKeep.length;
      }
    }
  }

  const tokensAfter = estimateTokens(compactedMessages, estimator);
  return withReuseInfo(
    {
      compactedMessages,
      summary,
      tokensFreed: Math.max(0, tokensBefore - tokensAfter),
      mode: 'native',
      keptTailCount,
    },
    reuseInfo,
  );
}

function withReuseInfo(result: CompactResult, info: SummaryReuseInfo): CompactResult {
  return { ...result, reuseInfo: info };
}

/**
 *  第二波：摘要请求报"提示过长"后的重试链。
 *
 * 第 1 次重试：只瘦身（白名单工具旧结果换占位 + 剥图片）；
 * 第 2、3 次重试：在瘦身基础上按完整调用轮次从头部截掉一段。
 *
 * 截头会拆散跨组的 tool_use/tool_result 配对（`truncateHead` 的轮次分组按
 * user 消息开新组，而工具循环里「user(tool_result) + assistant(下一个
 * tool_use)」跨组）——#3984 后截头即走统一整备闸 `sanitizeSummaryInput`
 * （替代原路径专用的 `repairOrphanToolCalls`），让下一次 `truncateHead`
 * 始终在整备后的列表上分组（与旧行为一致）；`compactSingleChunk` 入口
 * 还会幂等再过一遍，孤儿在发 provider 前必然被修复。
 *
 * 全部失败返回 `null`，调用方回落分块摘要。非"提示过长"类错误原样上抛。
 */
async function retrySummaryAfterPromptTooLong(
  messagesToSummarize: Message[],
  compactParams: {
    systemPrompt: string;
    model: string;
    callModel: (req: LLMRequest) => AsyncIterable<LLMResponseChunk>;
    summaryFocus?: string;
  },
  estimator?: TokenEstimator,
): Promise<string | null> {
  let retryMessages = slimMessagesForSummaryInput(messagesToSummarize).messages;

  for (let attempt = 1; attempt <= MAX_SUMMARY_PTL_RETRIES; attempt++) {
    if (attempt > 1) {
      const truncated = truncateHead(retryMessages, undefined, estimator);
      // 截不动了（只剩一轮），继续重试没有意义。
      if (truncated.length >= retryMessages.length) return null;
      // 截头后立即整备（见函数头注释）：保证下一轮 truncateHead 在
      // 整备后的列表上分组，不留跨 attempt 的孤儿状态。
      retryMessages = sanitizeSummaryInput(truncated);
    }
    if (retryMessages.length === 0) return null;

    try {
      const summary = await compactSingleChunk(retryMessages, compactParams);
      if (summary.trim().length > 0) return summary;
    } catch (error) {
      if (!isPromptTooLongError(error)) throw error;
    }
  }
  return null;
}
