/**
 * Orphan tool_use 修复工具（，Wave 5 自 query.ts 原样搬出）。
 *
 * assistant 消息里的 tool_use 若没有配对的 user tool_result，直接发给
 * provider 会被 API 拒绝。本模块生成 error tool_result 消息补齐配对——
 * 由 query.ts 的 abort / error catch 路径与 hooks/model-fallback.ts 的
 * fallback 换模型路径共用（逻辑零改动，只解 hook → query 循环 import）。
 */

import { buildToolErrorResultBlock } from '../tooling/tool-error.js';
import type { ToolErrorKind } from '../tooling/tool-error.js';
import type {
  ContentBlock,
  Message,
  ToolResultBlock,
  ToolUseBlock,
} from '../contracts/conversation.js';

/**
 * Scan messages for orphan tool_use blocks (assistant produced tool_use but
 * no corresponding user tool_result exists). Returns error tool_result messages
 * that should be pushed to state.messages to satisfy API pairing requirements.
 */
export function buildOrphanToolResults(
  messages: Message[],
  reason: string,
  kind: ToolErrorKind = 'execute_error',
): Message[] {
  const orphans = extractOrphanToolUses(messages);
  if (orphans.length === 0) return [];
  const blocks: ToolResultBlock[] = orphans.map((tu) =>
    buildToolErrorResultBlock(tu.id, kind, tu.name, reason),
  );
  return [{ role: 'user', content: blocks }];
}

/**
 * Extract unpaired tool_use blocks from the last assistant message.
 * Shared by both `buildOrphanToolResults` and the abort/error catch
 * path that needs to yield TOOL error events (H1).
 */
export function extractOrphanToolUses(messages: Message[]): ToolUseBlock[] {
  const lastMsg = messages[messages.length - 1];
  if (!lastMsg || lastMsg.role !== 'assistant' || typeof lastMsg.content === 'string') {
    return [];
  }
  const existingResultIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== 'user' || typeof msg.content === 'string') continue;
    for (const b of msg.content) {
      if (b.type === 'tool_result') existingResultIds.add(b.tool_use_id);
    }
  }
  return (lastMsg.content as ContentBlock[]).filter(
    (b): b is ToolUseBlock => b.type === 'tool_use' && !existingResultIds.has(b.id),
  );
}

/**
 * Build the orphan set used by abort/error terminal persistence.
 *
 * Inflight blocks may be ahead of state when a pre-started tool is interrupted,
 * so they must supplement the state-derived orphan set. Once state contains a
 * matching tool_result, however, re-adding that tool would overwrite its
 * successful result with a synthetic terminal error.
 */
export function extractTerminalOrphanToolUses(
  messages: Message[],
  inflightBlocks: ContentBlock[],
): ToolUseBlock[] {
  const orphans = extractOrphanToolUses(messages);
  const orphanIds = new Set(orphans.map((toolUse) => toolUse.id));
  const completedToolUseIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'user' || typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (block.type === 'tool_result') completedToolUseIds.add(block.tool_use_id);
    }
  }
  for (const block of inflightBlocks) {
    if (
      block.type === 'tool_use'
      && !completedToolUseIds.has(block.id)
      && !orphanIds.has(block.id)
    ) {
      orphans.push(block);
      orphanIds.add(block.id);
    }
  }
  return orphans;
}
