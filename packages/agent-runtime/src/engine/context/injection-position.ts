/**
 * 注入位置共享 helper —— 定位「最后一条真用户消息」，供需要把内容紧贴当前
 * user turn 注入的 hook 复用（context-injector / memory-injector /
 * mode-reminder-injector）。
 *
 * **为什么要紧贴当前 user 而非 messages 头部**：每轮变化的注入
 * （environment context / memory recall / mode reminder）若 prepend 到
 * messages 头部，会让整条对话历史前缀字节跨轮变化，打掉 prompt cache 的
 * 历史复用（典型 30 万 token 历史每轮重新 prefill）。把易变注入移到「紧贴
 * 当前 user 消息」处，历史前缀保持 byte-stable，只有当前 user + 注入尾部是
 * 新内容（当前 user 本就每轮新增，故无额外损失）。
 */

import type {
  Message,
} from '../contracts/conversation.js';
import {
  INTERNAL_MESSAGE_MARKERS,
  hasInternalMarker,
} from '../contracts/conversation.js';
import { classifyUserMessageForMerge } from './message-normalizer.js';

// 所有「内部注入」的 user-role marker —— 带任一 marker 的 user message 都不是
// 真用户输入，定位插入锚点时要跳过。
const INTERNAL_USER_MARKERS = [
  INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION,
  INTERNAL_MESSAGE_MARKERS.HISTORICAL_CONTEXT,
  INTERNAL_MESSAGE_MARKERS.MEMORY_INJECTION,
  INTERNAL_MESSAGE_MARKERS.AGENT_PROFILE_INJECTION,
  INTERNAL_MESSAGE_MARKERS.HISTORICAL_AGENT_PROFILE,
  INTERNAL_MESSAGE_MARKERS.LSP_DIAGNOSTICS_INJECTION,
  INTERNAL_MESSAGE_MARKERS.TOOL_EVICTION_NOTICE,
  INTERNAL_MESSAGE_MARKERS.MODE_REMINDER_INJECTION,
  INTERNAL_MESSAGE_MARKERS.MODE_TRANSITION_REMINDER,
  INTERNAL_MESSAGE_MARKERS.PROJECT_RULES_INJECTION,
  INTERNAL_MESSAGE_MARKERS.CONTINUATION,
] as const;

/**
 * 是否「真用户消息」：role=user、不带任何内部注入 marker、且结构上不是
 * tool_result-only（classifyUserMessageForMerge === 'other'）。
 */
export function isRealUserMessage(msg: Message): boolean {
  if (msg.role !== 'user') return false;
  for (const marker of INTERNAL_USER_MARKERS) {
    if (hasInternalMarker(msg, marker)) return false;
  }
  return classifyUserMessageForMerge(msg) === 'other';
}

/** 从尾部倒序找最后一条真用户消息的 index；没有 → -1。 */
export function findLastRealUserIndex(messages: readonly Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isRealUserMessage(messages[i]!)) return i;
  }
  return -1;
}

/**
 * 取消息的文本内容：string content 直接返回；array content 取首个 text block 的
 * text；都没有 → null。供识别 context wrapper 等文本判定复用。
 */
export function firstMessageText(msg: Message): string | null {
  if (typeof msg.content === 'string') return msg.content;
  if (!Array.isArray(msg.content)) return null;
  for (const block of msg.content) {
    const b = block as { type?: string; text?: string };
    if (b.type === 'text' && typeof b.text === 'string') return b.text;
  }
  return null;
}
