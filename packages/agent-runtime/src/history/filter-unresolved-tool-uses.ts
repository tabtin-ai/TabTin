/**
 * 跨轮记忆 · 装填阶段"半拉子 assistant"过滤（宿主无关）。
 *
 * 从 Electron renderer 下沉而来。原位置：
 * apps/tabtin-electron/src/renderer/src/stores/chat/utils/filterUnresolvedToolUses.ts
 *
 * 纯函数，不依赖任何 store / 环境变量 / Node API。
 * 详细设计理由见原文件的 docstring（保留完整语义）。
 */

import type { RuntimeHistoryMessage } from './types.js';

interface BlockWithTypeAndId {
  type?: string;
  id?: string;
  tool_use_id?: string;
}

function collectToolUseResolutionIds(messages: RuntimeHistoryMessage[]): {
  toolUseIds: Set<string>;
  toolResultIds: Set<string>;
} {
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content as BlockWithTypeAndId[]) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        toolUseIds.add(block.id);
      }
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        toolResultIds.add(block.tool_use_id);
      }
    }
  }

  return { toolUseIds, toolResultIds };
}

function collectUnresolvedIds(toolUseIds: Set<string>, toolResultIds: Set<string>): Set<string> {
  const unresolvedIds = new Set<string>();
  for (const id of toolUseIds) {
    if (!toolResultIds.has(id)) unresolvedIds.add(id);
  }
  return unresolvedIds;
}

function assistantHasOnlyUnresolvedToolUses(
  msg: RuntimeHistoryMessage,
  unresolvedIds: Set<string>,
): boolean {
  if (msg.role !== 'assistant') return false;
  if (!Array.isArray(msg.content)) return false;

  const toolUseBlockIds: string[] = [];
  for (const block of msg.content as BlockWithTypeAndId[]) {
    if (block && block.type === 'tool_use' && typeof block.id === 'string') {
      toolUseBlockIds.push(block.id);
    }
  }
  if (toolUseBlockIds.length === 0) return false;
  return toolUseBlockIds.every((id) => unresolvedIds.has(id));
}

/**
 * 过滤"所有 tool_use 都未闭环"的 assistant 消息。
 *
 * 扫所有消息 content 里的 tool_use.id 与 tool_result.tool_use_id，
 * unresolvedIds = toolUseIds ∖ toolResultIds。对每条 assistant，若它的
 * 全部 tool_use block 都在 unresolvedIds 里，则整条丢弃。
 *
 * 部分 tool_use 已配对部分没配对 → 保留整条 assistant，缺 result 的
 * 交给 engine 侧 ensureToolResultPairing 补合成占位。
 *
 * 当前数据流下预期 no-op（reference equal 输入），真触发时是回归信号。
 */
export function filterUnresolvedToolUses(
  messages: RuntimeHistoryMessage[],
): RuntimeHistoryMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  const { toolUseIds, toolResultIds } = collectToolUseResolutionIds(messages);
  const unresolvedIds = collectUnresolvedIds(toolUseIds, toolResultIds);

  if (unresolvedIds.size === 0) return messages;

  if (typeof console !== 'undefined' && console.warn) {
    console.warn(
      `[cross-turn-memory] filterUnresolvedToolUses triggered: ${unresolvedIds.size} unresolved tool_use id(s). ` +
      `This is unexpected in the current data flow — investigate if blocks_json contains orphan tool_calls.`,
    );
  }

  return messages.filter((msg) => !assistantHasOnlyUnresolvedToolUses(msg, unresolvedIds));
}
