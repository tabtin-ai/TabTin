/**
 * 跨轮记忆 · initialMessages 构建工具函数。
 *
 * 统一 ElectronAgentHost 和 DaemonAgentHost 中重复的
 * history.map → initialMessages 拼装逻辑。
 */

import type {
  Message,
} from '../engine/contracts/conversation.js';
import type { RuntimeHistoryMessage } from './types.js';

export interface UserMessageAttachment {
  type: 'image' | 'file' | 'video';
  url?: string;
}

/**
 * 构造本轮 user Message，必要时把 image/video attachments 挂成 content blocks。
 *
 *  批次 7：本体收进内核 `engine/context/user-message.ts`（依赖方向
 * 翻正——history 是宿主侧装填 helper，正确方向是 history → engine）；
 * 此处 re-export 保住宿主既有 import 路径，行为不变。
 */
export { buildUserMessageWithAttachments } from '../engine/context/user-message.js';

/**
 * 从装填好的 history + 本轮 userMessage 构建 runtime.query 的 initialMessages。
 *
 * history 为空 / undefined → 返回 undefined → 引擎回落旧行为。
 */
export function buildInitialMessages(
  history: RuntimeHistoryMessage[] | undefined,
  userMessage: Message,
): Message[] | undefined {
  if (!history || history.length === 0) return undefined;

  return [
    ...history.map((h): Message => {
      const message: Message = { role: h.role, content: h.content };
      if (h.sourceMessageId) {
        (message as Message & { __sourceMessageId?: string }).__sourceMessageId = h.sourceMessageId;
      }
      return message;
    }),
    userMessage,
  ];
}
