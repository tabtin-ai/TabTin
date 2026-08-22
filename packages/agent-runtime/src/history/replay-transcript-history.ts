/**
 * 跨轮记忆 · 本地 transcript 全量重放（宿主无关）。
 *
 * W6（跨轮上下文权威源）：跨轮上下文的**权威源**从「UI 显示投影」
 * （renderer ChatMessage / MySQL content_blocks_json，经 selectRecentHistoryForRuntime
 * 重建）切换为 runtime 自己的完整 transcript —— `SessionStorage.restoreMessages()`
 * 从 `messages.jsonl` 重建出的 `Message[]`。
 *
 * **为什么换源**（根因，非降级）：
 * 显示投影是为 UI 渲染而生的有损形态——多条连续 assistant 会被合并、tool_use 被
 * 压成 `[工具调用]` 占位文字、tool_use↔tool_result 配对在跨轮重建时丢失。每轮新
 * query 都从它重建 initialMessages，导致 LLM 看到的历史逐轮失真（第 2 条起即退化），
 * 重启后更乱（DB relay 空洞 + append-only 补丁产生孤儿 tool_result）。
 *
 * transcript（`messages.jsonl`）则是结构完整的权威记录：
 *   - tool_use（含解析好的 input）与 tool_result 严格配对、按真实时间序排列；
 *   - 天然遵守 compaction 边界（restoreMessages 从最后一个 `compaction:done` 起重建）；
 *   - 跨进程重启仍在（落盘）。
 *
 * 本函数把 transcript `Message[]` 整形成可注入 `initialMessages` 的
 * `RuntimeHistoryMessage[]`，尽量贴近 live 发给 LLM 的字节序（保 prompt cache）：
 *   1. **tool_result 保留 raw**（ ②）：直接重放 transcript 里存的工具结果，
 *      不再改写成「Tool Projection」摘要 / 占位。这与本模块约定一致——历史里的
 *      tool_result 跨轮 byte-identical，prompt cache 才能命中；Agent 也看到真实输出
 *      而非有损摘要。#10610 起 storage 层对 tool_result 仅保留 400K 灾难上限
 *      （工具边界已限长一次，正常无损落盘），窗口整体水位由引擎 compaction 兜底，
 *      不在重放层做额外改写。
 *   2. **user 消息折回 string**：与 live 的 string content 一致（见 toStructuralHistory）。
 *   3. **env context 调到当前 user 之前**：与 live 注入顺序 `[ctx, user]` 一致。
 *   4. 丢弃 thinking 块 —— 与现行 `selectRecentHistoryForRuntime` 契约一致（保留带
 *      签名的历史 thinking 是后续工作，配套 W7 cache_edits 做窗口管理）。
 *   5. `filterUnresolvedToolUses` 丢弃半拉子 assistant（transcript 结构正确时为 no-op）。
 *
 * 宿主在本地 transcript 不可用（跨设备 / 云端 agent）时回退到 renderer history，
 * 保证零回归。
 */

import type {
  ContentBlock,
  Message,
} from '../engine/contracts/conversation.js';
import type { RuntimeHistoryMessage } from './types.js';
import { filterUnresolvedToolUses } from './filter-unresolved-tool-uses.js';

function sanitizeToolResultContent(content: unknown): string | ContentBlock[] | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;

  const blocks = content
    .map(toModelVisibleBlock)
    .filter((block): block is ContentBlock => block !== null);
  return blocks;
}

/**
 * Transcript 里会混入 UI-only 产物块（如 tabtin_rich_content/tool_artifact）。
 * replay history 是模型输入边界，只允许 engine ContentBlock 联合类型通过。
 */
function toModelVisibleBlock(block: unknown): ContentBlock | null {
  if (!block || typeof block !== 'object') return null;
  const record = block as Record<string, unknown>;

  switch (record.type) {
    case 'text':
      return toVisibleTextBlock(record);
    case 'thinking':
      return toVisibleThinkingBlock(record);
    case 'tool_use':
      return toVisibleToolUseBlock(record);
    case 'tool_result':
      return toVisibleToolResultBlock(record);
    case 'image':
      return toVisibleImageBlock(record);
    case 'video':
      return toVisibleVideoBlock(record);
    default:
      return null;
  }
}

function toVisibleTextBlock(record: Record<string, unknown>): ContentBlock | null {
  return typeof record.text === 'string'
    ? { type: 'text', text: record.text }
    : null;
}

function toVisibleThinkingBlock(record: Record<string, unknown>): ContentBlock | null {
  return typeof record.thinking === 'string'
    ? { type: 'thinking', thinking: record.thinking }
    : null;
}

function toVisibleToolUseBlock(record: Record<string, unknown>): ContentBlock | null {
  return typeof record.id === 'string' && typeof record.name === 'string'
    ? { type: 'tool_use', id: record.id, name: record.name, input: record.input }
    : null;
}

function toVisibleToolResultBlock(record: Record<string, unknown>): ContentBlock | null {
  if (typeof record.tool_use_id !== 'string') return null;
  const content = sanitizeToolResultContent(record.content);
  if (content === undefined) return null;
  return {
    type: 'tool_result',
    tool_use_id: record.tool_use_id,
    content,
    ...(record.is_error === true ? { is_error: true } : {}),
  };
}

function toVisibleImageBlock(record: Record<string, unknown>): ContentBlock | null {
  if (!record.source || typeof record.source !== 'object') return null;
  return record as unknown as ContentBlock;
}

function toVisibleVideoBlock(record: Record<string, unknown>): ContentBlock | null {
  if (!record.source || typeof record.source !== 'object') return null;
  return record as unknown as ContentBlock;
}

/**
 * 把 transcript `Message[]` 转成保留结构的 `RuntimeHistoryMessage[]`。
 *
 * - 仅保留 role ∈ {user, assistant}；
 * - 丢弃 thinking 块（见模块注释）；
 * - 丢弃丢空后无内容的消息（如纯 thinking 的 assistant）；
 * - tool_result / tool_use 原样保留（raw，不改写）。
 */
function toStructuralHistory(transcript: Message[]): RuntimeHistoryMessage[] {
  const out: RuntimeHistoryMessage[] = [];
  for (const message of transcript) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;

    if (typeof message.content === 'string') {
      const text = message.content.trim();
      if (text.length === 0) continue;
      out.push({ role: message.role, content: text });
      continue;
    }

    if (!Array.isArray(message.content)) continue;

    const blocks: ContentBlock[] = [];
    for (const block of message.content) {
      const modelBlock = toModelVisibleBlock(block);
      if (!modelBlock || modelBlock.type === 'thinking') continue;
      blocks.push(modelBlock);
    }
    if (blocks.length === 0) continue;

    // ：user 消息结构与 live 对齐。live 的真 user / env context 都是
    // **string content**（host `{role:'user', content: prompt}`、context-injector
    // 注入 string）；但 restoreMessages 从 6 件套重建会得到 `[{type:'text'}]` 数组。
    // 一轮 string 一轮 array 会让 prompt cache 前缀字节不一致。这里把「纯文本的
    // user 消息」折回 string；含 tool_result / image 的 user（工具结果载体）保持数组。
    if (
      message.role === 'user'
      && blocks.every((b) => b.type === 'text')
    ) {
      const text = blocks
        .map((b) => (b as { type: 'text'; text: string }).text)
        .join('\n\n');
      // 续跑会落盘 `[{type:'text', text:''}]`。折成 string 后若仍为空，
      // 不能推给上游——Kimi/K3 会 400。
      if (text.trim().length === 0) continue;
      out.push({ role: 'user', content: text });
      continue;
    }

    out.push({ role: message.role, content: blocks });
  }
  return out;
}

const ENV_CONTEXT_PREFIX = '<context type="environment"';

/**
 * 取一条消息的首个文本（string content 直接返回；blocks 取第一个 text 块）。
 */
function firstText(message: RuntimeHistoryMessage): string | undefined {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return undefined;
  for (const block of message.content) {
    if (block && block.type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
      return (block as { text: string }).text;
    }
  }
  return undefined;
}

/** environment context 块：user 角色且文本以 `<context type="environment"` 起头。 */
function isEnvContextMessage(message: RuntimeHistoryMessage): boolean {
  if (message.role !== 'user') return false;
  const text = firstText(message);
  return typeof text === 'string' && text.trimStart().startsWith(ENV_CONTEXT_PREFIX);
}

/**
 * 把 `[真 user, env-context]` 相邻对交换回 `[env-context, 真 user]`。
 *
 * 为什么需要：live 路径里 context-injector 把每轮 env context 注入到**当前 user
 * 之前**（顺序 `[ctxN, userN]`），这是 LLM 实际看到、prompt cache 据以建立的字节序。
 * 但 transcript 落盘顺序是 `[userN, ctxN]`——因为 host 在 query 前先
 * `recordUserMessage(userN)`，env context 在 query iteration 0 才记录。直接重放
 * 会得到 `[userN, ctxN]`，与 live 的 `[ctxN, userN]` 字节序不一致 → 跨轮 prompt
 * cache 前缀从这里就断。这里把相邻对换回与 live 一致的顺序。
 *
 * 只交换「真 user 紧跟一条 env-context」的相邻对；env context 在 transcript 里总是
 * 紧随其所属轮的 user（中间无其它落盘消息），故单趟前向扫描即可精确配对。
 */
function reorderEnvContextBeforeUser(
  messages: RuntimeHistoryMessage[],
): RuntimeHistoryMessage[] {
  const out = messages.slice();
  for (let i = 0; i + 1 < out.length; i++) {
    const cur = out[i]!;
    const next = out[i + 1]!;
    if (cur.role === 'user' && !isEnvContextMessage(cur) && isEnvContextMessage(next)) {
      out[i] = next;
      out[i + 1] = cur;
      i++; // 跳过已配对的 env-context，避免连环误换
    }
  }
  return out;
}

/**
 * 从本地 transcript 构建跨轮 history。
 *
 * @param transcript `SessionStorage.restoreMessages()` 的返回（已去掉本轮 user）。
 */
export function buildReplayHistoryFromTranscript(
  transcript: Message[],
): RuntimeHistoryMessage[] {
  if (!Array.isArray(transcript) || transcript.length === 0) return [];

  const structural = toStructuralHistory(transcript);
  if (structural.length === 0) return [];

  // ：把 env context 调回当前 user 之前，与 live 注入顺序 `[ctx, user]` 一致，
  // 保住跨轮 prompt cache 前缀。tool_result 已在 toStructuralHistory 原样保留（raw）。
  const reordered = reorderEnvContextBeforeUser(structural);

  return filterUnresolvedToolUses(reordered);
}
