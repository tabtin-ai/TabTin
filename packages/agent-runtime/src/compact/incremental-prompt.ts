/**
 * FR-16 H3-B — Helpers for incremental conversation summarization.
 *
 * **历史结构**：本文件原本聚合三块——
 *   1. `INCREMENTAL_COMPACT_SYSTEM_PROMPT_TEMPLATE` 增量 system 模板
 *   2. `INCREMENTAL_COMPACT_USER_INSTRUCTION` 末尾 user 指令
 *   3. `renderMessagesPreviewForJudge` judge prompt 用的轻量消息渲染
 *
 * **E1 资源化（宪法 v0.1 §3）**：1 + 2 + `buildIncrementalCompactSystemPrompt`
 * 已迁到 `packages/agent-runtime/src/prompts/compact/incremental-{system,user}.ts`，
 * 本文件只保留 3 —— `renderMessagesPreviewForJudge`（纯 helper，非 prompt 资产）。
 *
 * 旧的命名导出（`INCREMENTAL_COMPACT_USER_INSTRUCTION` /
 * `buildIncrementalCompactSystemPrompt`）以 re-export 形式继续暴露，
 * 避免下游消费者批量改 import。新代码请直接从 `prompts/compact/` 取。
 */

import type {
  ContentBlock,
  Message,
} from '../engine/contracts/conversation.js';

export {
  INCREMENTAL_COMPACT_SYSTEM_PROMPT_TEMPLATE,
  buildIncrementalCompactSystemPrompt,
} from '../prompts/compact/incremental-system.js';
export { INCREMENTAL_COMPACT_USER_INSTRUCTION } from '../prompts/compact/incremental-user.js';

/**
 * judge prompt 用的轻量消息渲染：把 NEW_MESSAGES 拍扁成可读字符串。
 *
 * 设计点：
 * - 不发送给 react loop，发送给独立 judge LLM——所以无需保留 tool_use / tool_result
 *   block 的精确结构，只需要语义可读。
 * - `tool_use`/`tool_result` 简化为 `[tool_use name=...]` / `[tool_result ...]` 占位，
 *   裁掉 input/output 的具体内容（避免 judge prompt 爆掉）。
 * - 字符上限 `maxChars` 默认 4_000；超出时尾部追加 `...[truncated]` 标记。
 * - 文本类 block 截到 1_200 chars/块——单条 tool_result 巨大时不拖累 judge。
 */
export function renderMessagesPreviewForJudge(
  messages: Message[],
  maxChars: number,
): string {
  const lines: string[] = [];
  let totalChars = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const blockText = renderMessageForPreview(msg);
    if (blockText.length === 0) continue;

    const line = `[${i}] ${msg.role}: ${blockText}`;
    if (totalChars + line.length + 1 > maxChars) {
      lines.push('...[为 judge prompt 截断]');
      break;
    }
    lines.push(line);
    totalChars += line.length + 1;
  }

  return lines.length === 0 ? '(无新消息)' : lines.join('\n');
}

const MAX_CHARS_PER_BLOCK = 1_200;

function renderMessageForPreview(msg: Message): string {
  if (typeof msg.content === 'string') {
    return clip(msg.content, MAX_CHARS_PER_BLOCK);
  }
  const parts: string[] = [];
  for (const block of msg.content) {
    parts.push(renderBlockForPreview(block));
  }
  return parts.filter((p) => p.length > 0).join(' | ');
}

function renderBlockForPreview(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return clip(block.text, MAX_CHARS_PER_BLOCK);
    case 'thinking':
      return `[thinking ${block.thinking.length} chars]`;
    case 'tool_use':
      return `[tool_use name=${block.name} id=${block.id.slice(0, 6)}]`;
    case 'tool_result': {
      const inner =
        typeof block.content === 'string'
          ? clip(block.content, MAX_CHARS_PER_BLOCK)
          : `[${block.content.length} blocks]`;
      const errFlag = block.is_error ? ' is_error=true' : '';
      return `[tool_result tool_use_id=${block.tool_use_id.slice(0, 6)}${errFlag}: ${inner}]`;
    }
    case 'image':
      return '[image]';
    default:
      return '';
  }
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...[clipped ${text.length - max} chars]`;
}
