/**
 * 从消息序列里提取「最近一条真实 user 消息」作为相关性排序 query 的共享工具。
 *
 * 被 `SkillsCap` 与 `McpCap` 复用：两者都需要拿当轮用户意图对可用能力
 * （skills / MCP tools）做 BM25 相关性排序，逻辑完全一致，抽到此处避免各写一份
 * 漂移。
 */

import type {
  ContentBlock,
  InternalMessageMarker,
  Message,
  TextBlock,
} from '../../engine/contracts/conversation.js';
import {
  INTERNAL_MESSAGE_MARKERS,
  hasInternalMarker,
} from '../../engine/contracts/conversation.js';
import { extractInProgressTodo } from '../../todo/todo-replay.js';

/** 从 content 抽取纯文本（string 直接用；block 数组拼接 TextBlock）。 */
export function extractMessageText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is TextBlock => (b as { type?: string }).type === 'text')
    .map((b) => b.text)
    .join(' ');
}

/**
 * 取最近一条**真实** user 消息文本作为相关性排序 query。
 *
 * 跳过所有带内部 marker 的合成 user 消息（context / memory / rules / lsp /
 * continuation 等注入块）——它们不是用户意图，混入会污染打分。找不到返回空串
 * （调用方回退到无动态注入）。
 */
export function extractLatestUserQuery(messages: Message[] | undefined): string {
  if (!messages || messages.length === 0) return '';
  const markers = Object.values(
    INTERNAL_MESSAGE_MARKERS,
  ) as InternalMessageMarker[];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (markers.some((mk) => hasInternalMarker(m, mk))) continue;
    const text = extractMessageText(m.content).trim();
    if (text) return text;
  }
  return '';
}

/**
 * 召回检索词—— 用户原话 + 当前 `in_progress` todo。
 *
 * 复合长任务里 Agent 逐条推进 todo，用户不再发新消息。仅靠最近用户 query
 * 会让 skill/cli/mcp 召回冻结在最初意图上，跟不上当前正在做的这一步。
 * 拼上 in_progress todo content 后，召回随 todo 推进刷新，命中当前子任务的能力。
 *
 * 无活跃 todo / 批已收尾 → 退化为纯 `extractLatestUserQuery`（向后兼容，零行为变化）。
 * 检索词变化的判定由调用方（cap）用返回字符串是否变化门控。
 */
export function buildRecallQuery(messages: Message[] | undefined): string {
  const userQuery = extractLatestUserQuery(messages);
  const inProgress = messages ? extractInProgressTodo(messages) : '';
  if (!inProgress) return userQuery;
  if (!userQuery) return inProgress;
  return `${userQuery}\n${inProgress}`;
}
