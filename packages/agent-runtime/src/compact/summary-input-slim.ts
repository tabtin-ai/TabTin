/**
 * 摘要输入瘦身（ 第二波）——只作用于送给摘要模型的消息**拷贝**。
 *
 * ## 为什么需要
 *
 * 单次长任务里，基于时间的微压缩永不触发（活跃执行 gap 不够三十分钟），
 * 旧工具结果一直躺在历史里直到 0.85 压缩线。压缩发生时，摘要模型必须把
 * 这些几十万字符的原始工具输出全读一遍——摘要调用又贵又容易自身超长。
 * 时间微压缩可在压缩前清掉旧结果；本路径没有
 * 这道前置，就在摘要环节补：**只瘦身摘要请求的输入，真实历史一个字节不动**。
 *
 * ## 缓存约束（为什么不在首次尝试就瘦身）
 *
 * `callCacheFriendlyFullSummary` 的设计前提是"发送与常规调用完全一致的前缀
 * 以命中提示词缓存"（缓存读约一折价）。瘦身会让前缀分叉、全量缓存失效，
 * 反而更贵。所以瘦身只用于**前缀本来就不与缓存对齐**的路径：
 *   - fork provider 摘要（独立调用，无共享前缀）
 *   - 分块摘要（切片后前缀必然分叉）
 *   - 增量摘要（system prompt 不同，前缀已分叉）
 *   - 首次缓存友好调用报"提示过长"后的重试（缓存已然没救）
 *
 * ## 不变量（与 time-based microcompact 四条对齐）
 *
 *   1. 不动 tool_use_id、不删 block、不动 tool_use 块；
 *   2. 只动白名单工具（复用 `COMPACTABLE_TOOLS_DEFAULT` SSoT）；
 *   3. 保留最近 `keepRecent` 条白名单 tool_result 原文（摘要模型对"最近
 *      发生了什么"需要真数据）；
 *   4. **输入是拷贝**——返回新数组新对象，调用方的原 messages 引用不变。
 *
 * 图片块无条件替换为占位文本块（摘要模型不需要看图，图片是超长重灾区）。
 */

import type {
  ContentBlock,
  Message,
  ToolResultBlock,
} from '../engine/contracts/conversation.js';
import {
  COMPACTABLE_TOOLS_DEFAULT,
  COMPACTABLE_TOOL_PREFIXES_DEFAULT,
  isCompactableTool,
} from './time-based-microcompact.js';
import {
  SUMMARY_INPUT_IMAGE_OMITTED,
  SUMMARY_INPUT_TOOL_RESULT_OMITTED,
} from '../prompts/compact/summary-input-slim.js';

/** 与 time-based microcompact 的 keepRecent 默认值（4）对齐。 */
const SUMMARY_INPUT_SLIM_KEEP_RECENT = 4;

export interface SlimSummaryInputResult {
  /** 瘦身后的消息拷贝（未命中任何替换时仍返回新数组、原消息对象引用）。 */
  messages: Message[];
  /** 被替换为占位的白名单工具 tool_result 条数。 */
  slimmedToolResults: number;
  /** 被替换为占位文本的图片块条数。 */
  slimmedImages: number;
}

/**
 * 生成摘要请求输入的瘦身拷贝。
 *
 * 替换规则：
 *   - 白名单工具的 tool_result（除最近 `keepRecent` 条）content →
 *     `SUMMARY_INPUT_TOOL_RESULT_OMITTED`；
 *   - 图片块 → `{ type: 'text', text: SUMMARY_INPUT_IMAGE_OMITTED }`。
 */
export function slimMessagesForSummaryInput(
  messages: Message[],
  options?: {
    keepRecent?: number;
  },
): SlimSummaryInputResult {
  const keepRecent = Math.max(0, options?.keepRecent ?? SUMMARY_INPUT_SLIM_KEEP_RECENT);

  const toolUseNameById = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        toolUseNameById.set(block.id, block.name);
      }
    }
  }

  // 收集白名单 tool_result 位置（出现顺序），尾部 keepRecent 条不动。
  const compactableLocations: Array<{ msgIdx: number; blockIdx: number }> = [];
  messages.forEach((msg, msgIdx) => {
    if (typeof msg.content === 'string') return;
    msg.content.forEach((block, blockIdx) => {
      if (block.type !== 'tool_result') return;
      const toolName = toolUseNameById.get(block.tool_use_id) ?? '';
      if (isCompactableTool(toolName, COMPACTABLE_TOOLS_DEFAULT, COMPACTABLE_TOOL_PREFIXES_DEFAULT)) {
        compactableLocations.push({ msgIdx, blockIdx });
      }
    });
  });
  const slimCount = Math.max(0, compactableLocations.length - keepRecent);
  const toSlim = new Set(
    compactableLocations.slice(0, slimCount).map((loc) => `${loc.msgIdx}#${loc.blockIdx}`),
  );

  let slimmedToolResults = 0;
  let slimmedImages = 0;

  const slimmed = messages.map((msg, msgIdx) => {
    if (typeof msg.content === 'string') return msg;

    let mutated = false;
    const newContent: ContentBlock[] = msg.content.map((block, blockIdx) => {
      if (block.type === 'image') {
        mutated = true;
        slimmedImages++;
        return { type: 'text' as const, text: SUMMARY_INPUT_IMAGE_OMITTED };
      }
      if (block.type !== 'tool_result') return block;

      if (toSlim.has(`${msgIdx}#${blockIdx}`)) {
        const existing = typeof block.content === 'string' ? block.content : '';
        if (existing === SUMMARY_INPUT_TOOL_RESULT_OMITTED) return block;

        mutated = true;
        slimmedToolResults++;
        const replaced: ToolResultBlock = {
          ...block,
          content: SUMMARY_INPUT_TOOL_RESULT_OMITTED,
        };
        return replaced;
      }

      // 非白名单 / 保留窗内的 tool_result：正文保留，但嵌套图片块
      // （截图类工具的常见形态）仍替换为占位——「图片块无条件替换」。
      if (typeof block.content === 'string') return block;
      const hasNestedImage = block.content.some((inner) => inner.type === 'image');
      if (!hasNestedImage) return block;

      mutated = true;
      const innerContent: ContentBlock[] = block.content.map((inner) => {
        if (inner.type !== 'image') return inner;
        slimmedImages++;
        return { type: 'text' as const, text: SUMMARY_INPUT_IMAGE_OMITTED };
      });
      const replaced: ToolResultBlock = { ...block, content: innerContent };
      return replaced;
    });

    return mutated ? { ...msg, content: newContent } : msg;
  });

  return { messages: slimmed, slimmedToolResults, slimmedImages };
}
