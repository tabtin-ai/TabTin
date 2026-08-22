/**
 * 跨轮记忆 · 历史装填选择器（宿主无关）。
 *
 * 从 Electron renderer 下沉而来。原位置：
 * apps/tabtin-electron/src/renderer/src/stores/chat/utils/selectRecentHistoryForRuntime.ts
 *
 * 核心变化：输入从 ChatMessage（@tabtin/chat-client）改为窄接口
 * HistorySourceMessage，不依赖任何 GUI 框架 / store / 环境变量。
 *
 * blocks_json → ContentBlock 的映射规则：
 * | blocks_json block | runtime message 产物                              |
 * |-------------------|---------------------------------------------------|
 * | text              | assistant content 加 TextBlock（**按 stream 出现位置**）|
 * | tool_call         | (1) assistant 加 ToolUseBlock（**按 stream 出现位置**） (2) 合成 user(ToolResultBlock) |
 * | thinking          | 丢弃（Anthropic 要求 signature 验证）              |
 * | rich_content / tabtin_rich_content | 历史 task_episode 降级为简短文本；其它丢弃 |
 * | 其它              | 丢弃                                               |
 *
 * **W4.3 P0 顺序保留修复**：旧实现把所有 text 收集到 textPieces，最后
 * `unshift({ type: 'text', text: textPieces.join('\n\n') })` 把整段 text
 * 顶到 assistantBlocks 头部——这导致：
 *
 *   blocks_json: [text("intent"), tool_call(read), text("final answer")]
 *
 * 旧实现输出：
 *
 *   assistant: [text("intent\n\nfinal answer"), tool_use(read)]   ← 顺序错位
 *   user:     [tool_result(read)]
 *
 * "final answer" 被错位到 tool_use 之前，配合 buildInitialMessages 拼成
 *   `[..., assistant [text+tool_use], user [tool_result], user "下一轮"]`
 * 中**没有任何 final answer assistant 把 user(tool_result) 跟 user("下一轮")
 * 隔开** → mergeConsecutiveMessages 把它们合并成一条 → LLM 在 turn N+1 看到
 * "工具结果之后用户立即又请求新事情" → thinking 出现"用户同时请求两件事"
 * （dogfood W4 第三轮显形 bug）。
 *
 * 新实现按 blocks_json 出现顺序逐块 push 到 assistantBlocks，**保留 text
 * 与 tool_use 的相对位置**——final answer text 还在 tool_use 之后，落盘形态：
 *
 *   assistant: [text("intent"), tool_use(read), text("final answer")]
 *   user:     [tool_result(read)]
 *
 * 后续 buildInitialMessages 拼出来 `[..., assistant 含末尾 final answer, user
 * tool_result, user "下一轮"]`——加上 mergeConsecutiveMessages 的跨语义保护
 * （`tool_result_only` 不跟 `other` 合并），整条链路都不会再吞跨轮 user。
 */

import { findAllUserContextWrappers } from '../engine/context/user-context-wrapper.js';
import type {
  ContentBlock,
} from '../engine/contracts/conversation.js';
import type {
  HistorySourceMessage,
  HistoryMessageBlock,
  RuntimeHistoryMessage,
  SelectRecentHistoryOptions,
} from './types.js';
import { TOOL_RESULT_MAX_CHARS, EXCLUDED_FROM_LLM_HISTORY_MESSAGE_KINDS } from './types.js';
import { filterUnresolvedToolUses } from './filter-unresolved-tool-uses.js';
import { buildCompactedSummaryWrapper } from '../prompts/compact/wrapper.js';

// ── 内部工具函数 ────────────────────────────────────────────────────

/**
 * LLM 上游对 tool name / tool_use.name 的硬正则约束：
 * `^[a-zA-Z0-9_-]{1,64}$`（OpenAI / Anthropic function name 规范，不允许点号 /
 * CJK / 空格）。
 *
 * **历史污染问题**：2026-04-30 之前注册过的工具（`system.relaunch_app` /
 * `plan.create` / `plan.update_todos` / `system.clear_os_error_blacklist`）
 * 名字都带点号；这些历史 tool_call block 仍会以 `block.tool_name="plan.create"`
 * 持久化在 `messages.jsonl` / `blocks_json` 里。跨轮装填时若把它们原样作为
 * `ToolUseBlock.name` 喂回 LLM，**LLM 上游会 400 reject**——尽管 proxy-provider
 * 出口校验只盯 `request.tools`（不查 messages 内的 tool_use.name）。
 *
 * 净化策略：把仍存在的点号旧名替换成当前 canonical 名；已退休的旧 FC 名
 * 收敛为 `unknown_tool`，避免跨轮历史继续把旧工具名教给模型。
 */
const TOOL_NAME_SAFE_RE = /^[a-zA-Z0-9_-]{1,64}$/;
/**
 * ⚠️ 只能收录**当前 registry 里不存在**的历史旧名（对照 ：
 * proxy-provider 出口名单曾误含在役名 `write_file`，把模型成功历史改写成
 * `unknown_tool` 造成纠错死循环）。`tool-description-audit.test.ts` 断言
 * 本名单与全量在役 registry 交集为空。
 *
 * @internal 导出仅供 audit 测试；业务代码不要直接引用。
 */
export const RETIRED_CURRENT_TOOL_NAMES = new Set([
  'bash',
  'web_fetch',
  'file_read',
  'file_edit',
  'file_write',
  'file_delete',
  'execute_command',
  'code_grep',
  'code_glob',
  'code_semantic_search',
  'read_diagnostics',
  'document_read',
  'system_relaunch_app',
  'system_clear_os_error_blacklist',
  'plan_exit',
]);

function sanitizeHistoricalToolName(rawName: string): string {
  if (!rawName) return rawName;
  if (TOOL_NAME_SAFE_RE.test(rawName)) {
    return RETIRED_CURRENT_TOOL_NAMES.has(rawName) ? 'unknown_tool' : rawName;
  }
  // 替换非法字符为 `_`；超长截到 64。
  const safe = rawName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  if (RETIRED_CURRENT_TOOL_NAMES.has(safe)) {
    console.info(
      `[cross-turn] retired historical tool name sanitized to unknown_tool: ${JSON.stringify(rawName)}`,
    );
    return 'unknown_tool';
  }
  if (safe !== rawName) {
    console.info(
      `[cross-turn] sanitized historical tool name: ${JSON.stringify(rawName)} → ${JSON.stringify(safe)}`,
    );
  }
  return safe || 'unknown_tool';
}

function isToolCallBlock(block: HistoryMessageBlock | null | undefined): block is HistoryMessageBlock & {
  type: 'tool_call';
  tool_call_id: string;
  tool_name: string;
} {
  return !!block
    && block.type === 'tool_call'
    && typeof block.tool_call_id === 'string'
    && block.tool_call_id.length > 0
    && typeof block.tool_name === 'string'
    && block.tool_name.length > 0;
}

/**
 * Anthropic content block 格式的 tool_use（与旧 `tool_call` 单块格式区分）。
 * 持久化 content_blocks_json 实际用的是这种：tool_use 与 tool_result 分两块。
 */
function isToolUseBlock(block: HistoryMessageBlock | null | undefined): block is HistoryMessageBlock & {
  type: 'tool_use';
  id: string;
  name: string;
} {
  return !!block
    && block.type === 'tool_use'
    && typeof block.id === 'string'
    && block.id.length > 0
    && typeof block.name === 'string'
    && block.name.length > 0;
}

/** Anthropic content block 格式的独立 tool_result（content + tool_use_id）。 */
function isToolResultBlock(block: HistoryMessageBlock | null | undefined): block is HistoryMessageBlock & {
  type: 'tool_result';
  tool_use_id: string;
} {
  return !!block
    && block.type === 'tool_result'
    && typeof block.tool_use_id === 'string'
    && block.tool_use_id.length > 0;
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === null || output === undefined) return '';
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

interface EpisodeContextIndex {
  summariesByCommand: Map<string, string>;
}

interface ModelProjectionIndex {
  toolTextByToolCallId: Map<string, string>;
}

function readRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined;
}

function readString(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim().length > 0 ? input.trim() : undefined;
}

function isTerminalEpisodeStatus(status: unknown): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function isSucceededEpisodeStatus(status: unknown): boolean {
  return status === 'succeeded';
}

function extractCommandFromToolInput(input: unknown): string | undefined {
  const record = readRecord(input);
  return readString(record?.command);
}

function isTaskEpisodeRichBlock(block: HistoryMessageBlock): boolean {
  return (
    (block.type === 'rich_content' || block.type === 'tabtin_rich_content')
    && block.kind === 'task_episode'
  );
}

function isModelProjectionBlock(block: HistoryMessageBlock): boolean {
  return block.type === 'metadata' && block.kind === 'model_projection';
}

function readProjectionText(block: HistoryMessageBlock): string | undefined {
  const directText = readString(block.text);
  if (directText) return directText;

  const summary = readString(block.summary);
  if (summary) return summary;

  const projection = readRecord(block.projection);
  const projectionText = readString(projection?.text);
  if (projectionText) return projectionText;

  const payload = readRecord(block.payload);
  return readString(payload?.text);
}

function collectModelProjectionIndex(blocks: HistoryMessageBlock[]): ModelProjectionIndex {
  const toolTextByToolCallId = new Map<string, string>();

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (!isModelProjectionBlock(block)) continue;
    if (block.projection_type !== 'tool') continue;

    const toolCallId = readString(block.tool_call_id);
    const text = readProjectionText(block);
    if (!toolCallId || !text) continue;
    toolTextByToolCallId.set(toolCallId, text);
  }

  return { toolTextByToolCallId };
}

function extractEpisodePayload(block: HistoryMessageBlock): Record<string, unknown> | undefined {
  if (!isTaskEpisodeRichBlock(block)) return undefined;
  const payload = readRecord(block.payload);
  if (!payload || !isTerminalEpisodeStatus(payload.status)) return undefined;
  return payload;
}

/**
 * 历史消息里仍可能残留 `task_episode` 块（ 起不再新发卡）。
 * 跨轮只保留短文本摘要，不再依赖已删除的 task-episode 工具模块。
 */
function summarizeLegacyTaskEpisode(
  payload: Record<string, unknown>,
  blockSummary?: unknown,
): string | null {
  const episodeType = readString(payload.episode_type) ?? 'task_episode';
  const status = readString(payload.status);
  const goal = readString(payload.goal) ?? readString(blockSummary) ?? readString(payload.summary);
  if (!status && !goal) return null;
  const lines = [`Task Episode Summary (${episodeType})`];
  if (status) lines.push(`status=${status}`);
  if (goal) lines.push(goal);
  return lines.join('\n');
}

function collectEpisodeContextIndex(messages: HistorySourceMessage[]): EpisodeContextIndex {
  const summariesByCommand = new Map<string, string>();
  const blockedCommands = new Set<string>();

  for (const message of messages) {
    const blocks = message.blocks_json;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      const payload = extractEpisodePayload(block);
      if (!payload) continue;
      const evidenceRefs = Array.isArray(payload.technical_evidence_refs)
        ? payload.technical_evidence_refs
        : [];
      for (const refInput of evidenceRefs) {
        const ref = readRecord(refInput);
        if (!ref || ref.kind !== 'terminal_command') continue;
        const command = readString(ref.ref);
        if (!command) continue;

        if (!isSucceededEpisodeStatus(payload.status)) {
          blockedCommands.add(command);
          summariesByCommand.delete(command);
          continue;
        }

        if (blockedCommands.has(command)) continue;
        const summary = summarizeLegacyTaskEpisode(payload, block.summary);
        if (summary) summariesByCommand.set(command, summary);
      }
    }
  }

  return { summariesByCommand };
}

/**
 * 判断一条 message 是不是"本轮的占位"——会被装填阶段剔除掉，避免把当前轮
 * 的 user input + 还没流完的 ai placeholder 当作 history 重复送给 LLM。
 *
 * **W4.3.2 P0 真根因层 2 修复**（dogfood W4 第二轮 history 完全丢失的关键原因）：
 *
 * 旧实现两条规则：
 *   (1) `id === currentUserMessageId` → 剔除（精确匹配本轮 user）
 *   (2) `id.startsWith('temp-')`     → 剔除（兜底：temp-* 都当本轮）
 *
 * 规则 (2) 过于激进——如果 turn N-1 已经完成但 server sync 还没回填 server_id
 * （sendMessageAction `aiMessageId = entry.server_id` 替换还没生效），那 turn N-1
 * 的 user/ai message id 仍是 `temp-user-*` / `temp-ai-*`。turn N 发送时 (2) 把
 * **整个 turn N-1 都当本轮占位排除**，history.length 直接归零 →
 * buildInitialMessages 只剩本轮 currentUser → context-injector 加 contextMsg
 * → mergeConsecutiveMessages 误合并（详见真根因层 1）→ LLM thinking "用户同时
 * 请求两件事"。
 *
 * 见 `docs/cross-turn-memory-decoupling.md` line 19——bug 在 2026-04-23 已记录，
 * 但当时只下沉了代码没修语义，dogfood W4 又复现。
 *
 * 新实现只保留规则 (1)：严格匹配 `currentUserMessageId`。`temp-ai-*` 当前轮空
 * placeholder 即使没被显式剔除，因为 `content === ''` + `blocks_json` 为空，
 * `expandAssistantFromBlocks` 自然返回 `[]` 不会污染 history。当前轮的 temp-user-*
 * 由 `currentUserMessageId` 精确匹配剔除——调用方必须传这个 id（见
 * `sendMessageAction.ts` line 1011）。
 *
 * **副作用风险评估**：保留 turn N-1 的 temp-* messages 后会出现的边界 case：
 * - turn N-1 ai 仍在 streaming（罕见 - 用户在 turn N-1 还没结束就发了 turn N）：
 *   blocks_json 可能为空但 content 是 streaming partial。装填后 history 含
 *   一条不完整的 assistant reply——LLM 看到也无伤大雅，反而是真实场景的合理
 *   表达（用户中断了上一轮）。
 * - turn N-1 完成但 ack 还没回（dogfood 现场最频繁）：blocks_json 完整，content
 *   完整 → 装填正常恢复 turn N-1 → ✅ 修复主目标。
 */
function isCurrentTurnPlaceholder(
  message: HistorySourceMessage,
  currentUserMessageId: string | undefined,
): boolean {
  const id = typeof message.id === 'string' ? message.id : '';
  // 严格匹配本轮 user：调用方必须传 currentUserMessageId
  if (currentUserMessageId && id === currentUserMessageId) return true;
  return false;
}

function findLatestCompactionCheckpoint(messages: HistorySourceMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.message_kind === 'compaction_summary') return i;
  }
  return -1;
}

function findCompactionBoundaryIndex(
  messages: HistorySourceMessage[],
  checkpointIndex: number,
): number {
  const metadata = readRecord(messages[checkpointIndex]?.metadata);
  const boundaryId = readString(metadata?.compacted_up_to_message_id);
  if (!boundaryId) return checkpointIndex;

  const index = messages.findIndex((message) => message.id === boundaryId);
  return index >= 0 ? index : checkpointIndex;
}

function buildCompactionSummaryHistoryMessage(
  checkpoint: HistorySourceMessage,
  includeSourceMessageIds: boolean,
): RuntimeHistoryMessage | null {
  const summary = extractUserText(checkpoint).trim();
  if (!summary) return null;
  const message: RuntimeHistoryMessage = {
    role: 'user',
    content: buildCompactedSummaryWrapper(summary),
  };
  if (includeSourceMessageIds) message.sourceMessageId = checkpoint.id;
  return message;
}

function extractUserText(message: HistorySourceMessage): string {
  const blocks = message.blocks_json;
  if (Array.isArray(blocks) && blocks.length > 0) {
    const textPieces: string[] = [];
    for (const block of blocks) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        textPieces.push(block.text);
      }
    }
    if (textPieces.length > 0) return textPieces.join('\n\n');
  }
  const raw = message.content;
  return typeof raw === 'string' ? raw : '';
}

const SKILL_INSTRUCTIONS_RE = /<skill_instructions\b([^>]*)>[\s\S]*?<\/skill_instructions>/g;

function parseXmlishAttrs(input: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /([a-zA-Z0-9_-]+)="([^"]*)"/g;
  for (const match of input.matchAll(attrRe)) {
    const key = match[1];
    const value = match[2];
    if (!key || value === undefined) continue;
    attrs[key] = value
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }
  return attrs;
}

function formatSkillInstructionSummary(attrs: Record<string, string>): string {
  const parts = [
    attrs.key ? `key=${attrs.key}` : undefined,
  ].filter((part): part is string => !!part);
  const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  return `[Skill instructions previously activated${suffix}. Full skill body is omitted from cross-turn history to save context. If exact wording is needed, use skills_read with the same key.]`;
}

function replaceHistoricalSkillInstructions(text: string): string {
  if (!text.includes('<skill_instructions')) return text;
  return text.replace(SKILL_INSTRUCTIONS_RE, (_full, rawAttrs: string) => (
    formatSkillInstructionSummary(parseXmlishAttrs(rawAttrs))
  ));
}

/**
 * 阶段 6 议题 2 —— 跨轮 stale 检测 + 替换。
 *
 * **要解决的 bug**：用户上午 9 点 @ 表问"销售数据"，Agent 拿到 schema + 采样。
 * 上午 10 点用户改了表（删列加行）。下午 3 点问"刚才那张表的平均值"——Agent
 * 看到的还是早上 9 点的 schema 快照（落盘在 ChatMessage.content_blocks_json
 * 里），算的是基于过时数据的均值，Agent 不知道。
 *
 * **修法**：renderer/host 拼 user message 时给 referenced / attached wrapper 挂
 * ``stale_after_turn="<clientMessageId>"``，history 装填阶段（也就是本函数所属
 * 模块）扫描所有 wrapper —— 凡是 ``stale_after_turn !== currentTurnId``（即不是
 * 本轮新挂的）一律替换 body 为指针提示，告诉 Agent "这是过期快照"。
 *
 * **替换策略**（按 type 分支）：
 *
 *  - ``type='referenced'`` → body 整段替换为
 *    ``[此轮曾引用资源（数据可能已变），如需最新请重新 @ 引用]``
 *
 *  - ``type='attached'`` → body 整段替换为指针。新 wrapper 若有 ``file_id``，
 *    保留原件复用入口并引导 ``save_attachment``；老 wrapper 没有 ``file_id``
 *    时仍提示重新上传。attrs 全量保留，让 Agent 能继续使用原 FileRecord。
 *
 *  - 其他 type（environment / memory-recall / lsp-diagnostic / tool-eviction）：
 *    跨轮场景下这些 wrapper 不应该出现在持久化历史里（hook 注入是 in-memory，
 *    每轮 filter 旧 marker 后 prepend 新 message——不持久化）。如果真出现了，
 *    保留原样（最保守策略；这些类型不挂 stale_after_turn）。
 *
 * **老消息向后兼容**：``findAllUserContextWrappers`` 只匹配新形态
 * ``<context type="...">``——老的 ``Referenced context data:`` / ``[文档: foo]``
 * 纯字符串前缀不在匹配范围，原样透传（保持治理前的行为，**只对治理后新消息
 * 修复跨轮污染**）。
 *
 * @param text 原始 user message 文本（可能包含 0+ 个 wrapper）
 * @param currentTurnId 当前轮 user message id；undefined 时跳过 stale 替换
 *   （没有锚点可比较）
 * @returns 替换后的文本；无 wrapper 或全是当前轮的 wrapper 时返回原文本引用
 */
function replaceStaleContextWrappers(
  text: string,
  currentTurnId: string | undefined,
): string {
  if (!currentTurnId) return text;
  const wrappers = findAllUserContextWrappers(text);
  if (wrappers.length === 0) return text;

  // 倒序替换避免 offset 漂移
  let out = text;
  for (let i = wrappers.length - 1; i >= 0; i -= 1) {
    const w = wrappers[i]!;
    const staleAnchor = w.attrs.stale_after_turn;
    if (!staleAnchor) continue;             // 没挂锚点的 wrapper 不动
    if (staleAnchor === currentTurnId) continue;  // 本轮新挂的 wrapper 不动

    let pointerBody: string;
    if (w.type === 'referenced') {
      pointerBody = '[此轮曾引用资源（数据可能已变），如需最新请重新 @ 引用]';
    } else if (w.type === 'attached') {
      const filename = w.attrs.filename ?? '未知文件';
      pointerBody = w.attrs.file_id
        ? `[此轮曾上传附件 ${filename}；如需原文件请调用 save_attachment，并传入此 context 的 file_id]`
        : `[此轮曾引用附件 ${filename}（数据可能已变），如需最新请重新上传]`;
    } else if (w.type === 'quoted-message') {
      // ：被引用消息正文已在历史里，跨轮折叠为指针避免重复占用上下文。
      // 与 referenced/attached 的「数据可能已变」不同——这里是去重，正文不变。
      pointerBody = '[此轮曾引用上文一条消息]';
    } else {
      continue; // 其他 type 保守不动
    }

    // 重写 wrapper：保留 type + attrs，body 替为指针。手工拼装 attr 序列时
    // 必须跟 buildUserContextWrapper 输出位序一致（字典序），让二次扫描仍能
    // parse。这里直接重新 stringify 后 splice 即可。
    const sortedAttrKeys = Object.keys(w.attrs).sort();
    const attrPairs: string[] = [`type="${w.type}"`];
    for (const k of sortedAttrKeys) {
      const v = w.attrs[k];
      if (v === undefined || v === '') continue;
      const escaped = v
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      attrPairs.push(`${k}="${escaped}"`);
    }
    const replacement = `<context ${attrPairs.join(' ')}>\n${pointerBody}\n</context>`;
    out = out.slice(0, w.startOffset) + replacement + out.slice(w.endOffset);
  }
  return out;
}

/**
 * 把一次工具调用的「输出」整形成跨轮历史里的 tool_result content 字符串。
 *
 * 旧单块 `tool_call`（output 在自身）与 Anthropic 独立 `tool_result`
 *（content 在自身、tool_name/input 来自配对的 tool_use）共用这套整形。
 *
 *  canonical result 契约：工具结果在产生时已限长一次（终端 stdout 由
 * shell.ts `STDOUT_INLINE_MAX_BYTES` 收口），跨轮历史**原样复用 raw**，只在
 * 超出 `TOOL_RESULT_MAX_CHARS` 时再截一次并附归档指针。旧行为把
 * run_terminal_command 等工具结果无条件替换成投影占位——这掐死了批量
 * 取证路径（模型被迫退回逐文件 read_file），且逐轮改写历史破坏前缀缓存
 * （根因分析见 ）。model projection / episode 摘要仅在 raw 缺失
 * （旧库未持久化 output）时作恢复线索兜底。
 */
function shapeToolOutputContent(args: {
  toolName: string;
  toolCallId: string;
  toolInput: unknown;
  outputValue: unknown;
  hasOutput: boolean;
  outputSummary?: string;
  isError: boolean;
  modelProjection: ModelProjectionIndex;
  episodeContext?: EpisodeContextIndex;
  sessionId?: string;
}): string {
  const {
    toolName, toolCallId, toolInput, outputValue, hasOutput,
    outputSummary, isError, modelProjection, episodeContext, sessionId,
  } = args;

  if (hasOutput) {
    const raw = stringifyToolOutput(outputValue);
    if (raw.length > TOOL_RESULT_MAX_CHARS) {
      const logRef = sessionId
        ? ` 完整输出可能在 tool-logs/${sessionId}/${toolCallId}.md。`
        : '';
      console.info(
        `[cross-turn] tool_result truncated: ${raw.length} → ${TOOL_RESULT_MAX_CHARS}` +
        ` (tool=${toolName}, id=${toolCallId})`,
      );
      return raw.slice(0, TOOL_RESULT_MAX_CHARS) + `\n[输出已截断 —— 原始 ${raw.length} 字符。${logRef}]`;
    }
    return raw;
  }

  // raw 缺失时的恢复线索（按信息量降序）：归档投影 → episode 摘要 → 归档指针。
  const toolProjection = modelProjection.toolTextByToolCallId.get(toolCallId);
  if (toolProjection) return toolProjection;

  const episodeSummary = isError
    ? undefined
    : episodeContext?.summariesByCommand.get(extractCommandFromToolInput(toolInput) ?? '');
  if (episodeSummary) return episodeSummary;

  const summaryHint = outputSummary ? ` 摘要：${outputSummary}` : '';
  const errorHint = isError ? '（执行时出错）' : '';
  if (sessionId) {
    return (
      `[工具输出已归档。${summaryHint}${errorHint} ` +
      `完整输出可能在：tool-logs/${sessionId}/${toolCallId}.md —— ` +
      `如果该文件不存在（例如换了设备），请依据上方摘要。]`
    );
  }
  return `[工具输出不可用 —— ${toolName} 已完成${errorHint}。${summaryHint}]`;
}

interface AssistantExpansionState {
  assistantBlocks: ContentBlock[];
  toolResultBlocks: ContentBlock[];
  toolInfoById: Map<string, { toolName: string; input: unknown }>;
  modelProjection: ModelProjectionIndex;
  episodeContext?: EpisodeContextIndex;
  sessionId?: string;
  preserveReasoningForToolTurns: boolean;
  preserveAllReasoningHistory: boolean;
}

function collectToolInfoById(blocks: HistoryMessageBlock[]): Map<string, { toolName: string; input: unknown }> {
  const toolInfoById = new Map<string, { toolName: string; input: unknown }>();
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (isToolCallBlock(block)) {
      toolInfoById.set(block.tool_call_id, { toolName: block.tool_name, input: block.input ?? {} });
    } else if (isToolUseBlock(block)) {
      toolInfoById.set(block.id, { toolName: block.name, input: block.input ?? {} });
    }
  }
  return toolInfoById;
}

function appendTaskEpisodeBlock(block: HistoryMessageBlock, state: AssistantExpansionState): void {
  const payload = extractEpisodePayload(block);
  const summary = payload
    ? summarizeLegacyTaskEpisode(payload, block.summary)
    : (typeof block.summary === 'string' && block.summary.length > 0 ? block.summary : null);
  if (summary) {
    state.assistantBlocks.push({ type: 'text', text: summary });
  }
}

function appendLegacyToolCallBlock(block: HistoryMessageBlock & {
  type: 'tool_call';
  tool_call_id: string;
  tool_name: string;
}, state: AssistantExpansionState): void {
  const toolInput: unknown = block.input ?? {};
  state.assistantBlocks.push({
    type: 'tool_use',
    id: block.tool_call_id,
    name: sanitizeHistoricalToolName(block.tool_name),
    input: toolInput,
  });
  state.toolResultBlocks.push({
    type: 'tool_result',
    tool_use_id: block.tool_call_id,
    content: shapeToolOutputContent({
      toolName: block.tool_name,
      toolCallId: block.tool_call_id,
      toolInput,
      outputValue: block.output,
      // 与独立 tool_result 路径同口径：空字符串视为无输出，走投影/归档兜底。
      hasOutput: block.output !== null && block.output !== undefined
        && !(typeof block.output === 'string' && block.output.length === 0),
      outputSummary: typeof block.output_summary === 'string' ? block.output_summary : undefined,
      isError: !!block.error,
      modelProjection: state.modelProjection,
      episodeContext: state.episodeContext,
      sessionId: state.sessionId,
    }),
    is_error: !!block.error,
  });
}

function appendToolUseBlock(block: HistoryMessageBlock & {
  type: 'tool_use';
  id: string;
  name: string;
}, state: AssistantExpansionState): void {
  state.assistantBlocks.push({
    type: 'tool_use',
    id: block.id,
    name: sanitizeHistoricalToolName(block.name),
    input: block.input ?? {},
  });
}

function appendToolResultBlock(block: HistoryMessageBlock & {
  type: 'tool_result';
  tool_use_id: string;
}, state: AssistantExpansionState): void {
  const info = state.toolInfoById.get(block.tool_use_id);
  const toolName = info?.toolName ?? 'unknown_tool';
  const content = block.content;
  const hasOutput = !(content === null || content === undefined
    || (typeof content === 'string' && content.length === 0));
  const isError = block.is_error === true || block.error === true;
  state.toolResultBlocks.push({
    type: 'tool_result',
    tool_use_id: block.tool_use_id,
    content: shapeToolOutputContent({
      toolName,
      toolCallId: block.tool_use_id,
      toolInput: info?.input,
      outputValue: content,
      hasOutput,
      outputSummary: typeof block.output_summary === 'string' ? block.output_summary : undefined,
      isError,
      modelProjection: state.modelProjection,
      episodeContext: state.episodeContext,
      sessionId: state.sessionId,
    }),
    is_error: isError,
  });
}

function appendAssistantHistoryBlock(block: HistoryMessageBlock, state: AssistantExpansionState): void {
  if (!block || typeof block !== 'object') return;
  if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
    state.assistantBlocks.push({ type: 'text', text: block.text });
    return;
  }
  // 跨轮 reasoning 回传：默认丢弃 thinking。
  // - preserveAllReasoningHistory：Kimi K3 等始终保留
  // - preserveReasoningForToolTurns：仅本消息含 tool_call 时保留（DeepSeek V4）
  // 是否真发上游由 proxy-provider convertAssistantMessage 按 policy 再决定。
  const keepThinking = state.preserveAllReasoningHistory
    || (state.preserveReasoningForToolTurns && state.toolInfoById.size > 0);
  if (block.type === 'thinking' && keepThinking) {
    const tb = block as { thinking?: string; signature?: string };
    const thinkingText = typeof tb.thinking === 'string' ? tb.thinking : '';
    if (thinkingText.length > 0) {
      state.assistantBlocks.push({ type: 'thinking', thinking: thinkingText, signature: tb.signature ?? '' } as ContentBlock);
    }
    return;
  }
  if (isTaskEpisodeRichBlock(block)) {
    appendTaskEpisodeBlock(block, state);
    return;
  }
  if (isToolCallBlock(block)) {
    appendLegacyToolCallBlock(block, state);
    return;
  }
  if (isToolUseBlock(block)) {
    appendToolUseBlock(block, state);
    return;
  }
  if (isToolResultBlock(block)) {
    appendToolResultBlock(block, state);
  }
}

function expandAssistantFromBlocks(
  message: HistorySourceMessage,
  sessionId?: string,
  episodeContext?: EpisodeContextIndex,
  preserveReasoningForToolTurns = false,
  preserveAllReasoningHistory = false,
): RuntimeHistoryMessage[] {
  const blocks = message.blocks_json;
  if (!Array.isArray(blocks) || blocks.length === 0) {
    const fallbackText = typeof message.content === 'string' ? message.content.trim() : '';
    if (fallbackText.length === 0) return [];
    return [{ role: 'assistant', content: fallbackText }];
  }

  // W4.3 P0 顺序保留：按 blocks_json 出现顺序逐块 push 到 assistantBlocks，
  // 保留 text / tool_use 的交错位置；toolResultBlocks 仍单独累积成跟随的
  // user message（Anthropic API 配对约定不变）。详见模块注释 dogfood
  // bug 复现路径表。
  const assistantBlocks: ContentBlock[] = [];
  const toolResultBlocks: ContentBlock[] = [];
  const modelProjection = collectModelProjectionIndex(blocks);

  // 先建 tool_use_id → {toolName,input} 索引：Anthropic 独立 tool_result 块自身
  // 不带 tool_name，需要回查配对的 tool_use 才能套用 terminal / raw-ref 等整形。
  const toolInfoById = collectToolInfoById(blocks);
  const state: AssistantExpansionState = {
    assistantBlocks,
    toolResultBlocks,
    toolInfoById,
    modelProjection,
    episodeContext,
    sessionId,
    preserveReasoningForToolTurns,
    preserveAllReasoningHistory,
  };

  for (const block of blocks) {
    appendAssistantHistoryBlock(block, state);
  }

  if (assistantBlocks.length === 0) {
    const fallbackText = typeof message.content === 'string' ? message.content.trim() : '';
    if (fallbackText.length === 0) return [];
    assistantBlocks.push({ type: 'text', text: fallbackText });
  }

  const out: RuntimeHistoryMessage[] = [{ role: 'assistant', content: assistantBlocks }];
  if (toolResultBlocks.length > 0) {
    out.push({ role: 'user', content: toolResultBlocks });
  }
  return out;
}

function validateCurrentTurnExclusion(opts: SelectRecentHistoryOptions): void {
  if (!opts.excludeCurrentTurn || opts.currentUserMessageId) return;
  if (opts.strictCurrentTurn === true) {
    throw new Error(
      '[cross-turn] selectRecentHistoryForRuntime: excludeCurrentTurn=true 但漏传 ' +
      'currentUserMessageId（strictCurrentTurn 已开启，fail-fast）。本轮 user 无法 ' +
      '精确剔除，继续装填会把用户刚发的话当作 history 重复送给 LLM。请确保调用方 ' +
      '传入本轮 user id（ / W4.3.2 契约）。',
    );
  }
  if (typeof console !== 'undefined' && console.warn) {
    console.warn(
      '[cross-turn] selectRecentHistoryForRuntime: excludeCurrentTurn=true 但漏传 ' +
      'currentUserMessageId——本轮 user 不会被剔除（可能造成本轮被当作 history 重复 ' +
      '送给 LLM）。请确保调用方传入本轮 user id（W4.3.2 契约）。' +
      '如需 fail-fast 请开启 strictCurrentTurn。',
    );
  }
}

function collectEligibleHistoryMessages(
  messages: HistorySourceMessage[],
  boundaryIndex: number,
  opts: SelectRecentHistoryOptions,
): HistorySourceMessage[] {
  const eligible: HistorySourceMessage[] = [];
  for (const [index, message] of messages.entries()) {
    if (!message || typeof message !== 'object') continue;
    if (message.message_kind === 'compaction_summary') continue;
    //  / ：hitl_interaction / system_prompt_context 等绝不进 LLM 历史。
    if (message.message_kind && EXCLUDED_FROM_LLM_HISTORY_MESSAGE_KINDS.has(message.message_kind)) continue;
    if (boundaryIndex >= 0 && index <= boundaryIndex) continue;
    if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'system') continue;
    if (message.role === 'system' && !isSystemAuthoredHistoryInjection(message)) continue;
    if (opts.excludeCurrentTurn && isCurrentTurnPlaceholder(message, opts.currentUserMessageId)) continue;
    eligible.push(message);
  }
  return eligible;
}

function isSystemAuthoredHistoryInjection(message: HistorySourceMessage): boolean {
  if (
    message.message_kind === 'environment_context'
    || message.message_kind === 'agent_profile_context'
    || message.message_kind === 'external_archive_context'
  ) return true;
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== 'object') return false;
  if (metadata.source === 'skill_invoke') return true;
  return metadata.triggered_by === 'push-notification'
    || metadata.triggered_by === 'parent_midflight';
}

/** ：落库 / 历史里的 agent-profile 块（kind 或 content 兜底）。 */
function isAgentProfileHistoryMessage(message: HistorySourceMessage): boolean {
  if (message.message_kind === 'agent_profile_context') return true;
  const text = extractUserText(message).trimStart();
  return text.startsWith('<context type="agent-profile"')
    || text.startsWith("<context type='agent-profile'");
}

/**
 * ：历史中多份 agent-profile 只保留时间上最新一份，更早的留 DB/审计。
 * 须在 slice 之前调用，避免旧 profile 占满窗口预算。
 */
export function keepLatestAgentProfileMessages(
  messages: HistorySourceMessage[],
): HistorySourceMessage[] {
  let latestIndex = -1;
  for (let i = 0; i < messages.length; i += 1) {
    if (isAgentProfileHistoryMessage(messages[i]!)) latestIndex = i;
  }
  if (latestIndex < 0) return messages;
  return messages.filter((msg, index) => !isAgentProfileHistoryMessage(msg) || index === latestIndex);
}

function appendUserHistoryMessage(
  expanded: RuntimeHistoryMessage[],
  msg: HistorySourceMessage,
  currentUserMessageId: string | undefined,
  includeSourceMessageIds: boolean,
): void {
  const rawText = extractUserText(msg);
  const text = replaceHistoricalSkillInstructions(
    replaceStaleContextWrappers(rawText, currentUserMessageId),
  ).trim();
  if (text.length === 0) return;
  expanded.push(includeSourceMessageIds
    ? { role: 'user', content: text, sourceMessageId: msg.id }
    : { role: 'user', content: text });
}

function appendExpandedHistoryMessage(
  expanded: RuntimeHistoryMessage[],
  msg: HistorySourceMessage,
  opts: SelectRecentHistoryOptions,
  includeSourceMessageIds: boolean,
  episodeContext: EpisodeContextIndex,
): void {
  if (msg.role === 'user' || msg.role === 'system') {
    // 阶段 6 议题 2：在拿到 user text 后扫描所有 user-context-wrapper，
    // 跨轮（stale_after_turn !== currentUserMessageId）的 referenced /
    // attached wrapper 把 body 替换为指针——告诉 Agent "你看到的是过期
    // 快照，需要新数据请重新 @ 引用"。
    appendUserHistoryMessage(expanded, msg, opts.currentUserMessageId, includeSourceMessageIds);
    return;
  }
  const pieces = expandAssistantFromBlocks(
    msg,
    opts.sessionId,
    episodeContext,
    opts.preserveReasoningForToolTurns ?? false,
    opts.preserveAllReasoningHistory ?? false,
  );
  for (const piece of pieces) {
    expanded.push(includeSourceMessageIds ? { ...piece, sourceMessageId: msg.id } : piece);
  }
}

// ── 主函数 ──────────────────────────────────────────────────────────

/**
 * 从历史消息源选出可注入 runtime initialMessages 的历史消息。
 *
 * 行为：
 * 1. 保留持久化 role ∈ {user, assistant, system} 的主消息；system 在 LLM 边界投影为 user
 * 2. **excludeCurrentTurn=true 时**：必须传 `currentUserMessageId`——根据它精确剔除
 *    本轮 user message。不再按 `id.startsWith('temp-')` 兜底（W4.3.2 修复，详见
 *    `isCurrentTurnPlaceholder` 注释）。如果调用方漏传 id，默认 dev-only
 *    `console.warn` 提示——本轮 user 不会被剔除，可能造成"本轮被当作 history
 *    重复送给 LLM"轻度回归；调用方可传 `strictCurrentTurn=true` 把此契约漂移
 *    升级为 fail-fast 抛错。
 * 3. 按原时间顺序保留最后 maxMessages 条原始消息
 * 4. 逐条展开：user → 纯文本；assistant → blocks_json 展开 tool_use/tool_result 对
 * 5. filterUnresolvedToolUses 兜底丢掉残缺 assistant
 *
 * 传入的 messages 假定已按时间升序排列。返回数组也保持时间升序。
 */
export function selectRecentHistoryForRuntime(
  messages: HistorySourceMessage[],
  opts: SelectRecentHistoryOptions,
): RuntimeHistoryMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  const { maxMessages } = opts;
  const includeSourceMessageIds = opts.includeSourceMessageIds === true;
  if (maxMessages <= 0) return [];

  // W4.3.2 dev-only 防御 +  严格模式：excludeCurrentTurn=true 漏传
  // currentUserMessageId 时新行为是"本轮不剔除"——跟旧 `startsWith('temp-')`
  // 兜底语义反向。调用方要么显式传 id，要么传 false 关闭剔除。
  //
  // ：默认仍走 warn 兜底（向后兼容，history.test.ts 锁定用例：漏传 id
  // 时 warn + 本轮 user 仍被装填）。高保障主路径可传 strictCurrentTurn=true
  // 升级为 fail-fast 抛错——把"漏传本轮 user id"从"可能把用户刚发的话再送
  // 一遍"变成"立即阻断本轮"，避免本轮 user 既进 history 又进 initialMessages
  // 重复送 LLM。
  validateCurrentTurnExclusion(opts);

  const checkpointIndex = findLatestCompactionCheckpoint(messages);
  const checkpointHistoryMessage = checkpointIndex >= 0
    ? buildCompactionSummaryHistoryMessage(messages[checkpointIndex], includeSourceMessageIds)
    : null;
  const boundaryIndex = checkpointIndex >= 0
    ? findCompactionBoundaryIndex(messages, checkpointIndex)
    : -1;

  const eligible = keepLatestAgentProfileMessages(
    collectEligibleHistoryMessages(messages, boundaryIndex, opts),
  );

  const tailLimit = checkpointHistoryMessage ? Math.max(0, maxMessages - 1) : maxMessages;
  const sliced = eligible.length <= tailLimit
    ? eligible
    : eligible.slice(eligible.length - tailLimit);
  const episodeContext = collectEpisodeContextIndex(sliced);

  const expanded: RuntimeHistoryMessage[] = [];
  if (checkpointHistoryMessage) {
    expanded.push(checkpointHistoryMessage);
  }
  for (const msg of sliced) {
    appendExpandedHistoryMessage(expanded, msg, opts, includeSourceMessageIds, episodeContext);
  }

  return filterUnresolvedToolUses(expanded);
}
