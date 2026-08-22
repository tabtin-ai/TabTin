/**
 * Parent Mid-flight Injector Hook ——  Wave2：主 Agent 向运行中子 Agent
 * 注入 user 指引，子下一轮 beforeModel 消费。
 *
 * 对齐 `thread-notifications-injector.ts`：
 *   1. beforeModel 调 `drainMessages()`（取走即清空）
 *   2. 每条非空文本 wrap 为 `<parent-midflight-guidance>` 块后 push 进 messages
 *   3. 排 USER 事件（`triggered_by: 'parent_midflight'`）供观测
 *   4. 再排 content-block 六件套（role=user），经 SUBAGENT_STREAM_EVENT 进详情时间线
 *   5. 可选 `onInjected` 供 fork-query 即时落盘子 session storage
 */

import { v4 as uuidv4 } from 'uuid';
import { UserEvent } from '../event/events/user-events.js';
import { StoredContentEvent } from '../event/events/content-events.js';
import { buildUserEventBlocks } from '../engine/context/user-message.js';
import { ContentBlockEvents } from '../engine/contracts/stream-events.js';
import type { EngineHooks } from '../engine/contracts/kernel.js';
import type { Message } from '../engine/contracts/conversation.js';
import type { StreamEvent } from '../engine/contracts/wire-protocol.js';

/** 固定标签——供 isChildProducedMessage / UI 识别。 */
export const PARENT_MIDFLIGHT_GUIDANCE_TAG = 'parent-midflight-guidance';

/** UserEvent / message_start.triggered_by 同源字面量。 */
export const PARENT_MIDFLIGHT_TRIGGERED_BY = 'parent_midflight';

export function wrapParentMidflightGuidance(text: string): string {
  return `<${PARENT_MIDFLIGHT_GUIDANCE_TAG}>\n${text}\n</${PARENT_MIDFLIGHT_GUIDANCE_TAG}>`;
}

export function containsParentMidflightGuidance(content: string): boolean {
  return content.includes(`<${PARENT_MIDFLIGHT_GUIDANCE_TAG}>`);
}

/**
 * 构造 role=user 的最小六件套，供子详情 live reduce（applyEnvelopeEvent）。
 * 与 SessionStorage._appendMessageEnvelope 同构，但不依赖 storage 实例。
 */
export function buildParentMidflightUserEnvelopeEvents(
  messageId: string,
  wrappedText: string,
  blockId: string = `midflight-blk-${messageId.slice(0, 8)}`,
): StreamEvent[] {
  return [
    new StoredContentEvent(ContentBlockEvents.MESSAGE_START, {
      event_type: ContentBlockEvents.MESSAGE_START,
      message_id: messageId,
      role: 'user',
      message_kind: 'llm',
      triggered_by: PARENT_MIDFLIGHT_TRIGGERED_BY,
      started_at: new Date().toISOString(),
    }).toStreamEvent(),
    new StoredContentEvent(ContentBlockEvents.CONTENT_BLOCK_START, {
      event_type: ContentBlockEvents.CONTENT_BLOCK_START,
      message_id: messageId,
      index: 0,
      block_id: blockId,
      block: { type: 'text', text: '' },
    }).toStreamEvent(),
    new StoredContentEvent(ContentBlockEvents.CONTENT_BLOCK_DELTA, {
      event_type: ContentBlockEvents.CONTENT_BLOCK_DELTA,
      message_id: messageId,
      index: 0,
      delta: { type: 'text_delta', text: wrappedText },
    }).toStreamEvent(),
    new StoredContentEvent(ContentBlockEvents.CONTENT_BLOCK_STOP, {
      event_type: ContentBlockEvents.CONTENT_BLOCK_STOP,
      message_id: messageId,
      index: 0,
    }).toStreamEvent(),
    new StoredContentEvent(ContentBlockEvents.MESSAGE_STOP, {
      event_type: ContentBlockEvents.MESSAGE_STOP,
      message_id: messageId,
    }).toStreamEvent(),
  ];
}

export interface ParentMidflightInjectorOptions {
  /** 取走待注入指引（缺省时 hook 空转）。 */
  drainMessages?: () => string[];
  /** 注入后立即落盘（fork-query 传入 childStorage 写入同一 messageId 的历史记录）。 */
  onInjected?: (wrappedText: string, message: Message, messageId: string) => void | Promise<void>;
  /** 兼容旧调用方的去重集合；当前 fork-query 不再需要。 */
  examinedMessages?: WeakSet<object>;
  generateUUID?: () => string;
}

export function buildParentMidflightInjectorHook(
  options: ParentMidflightInjectorOptions,
): EngineHooks {
  const {
    drainMessages,
    onInjected,
    examinedMessages,
    generateUUID = uuidv4,
  } = options;
  return {
    async beforeModel(ctx): Promise<void> {
      if (!drainMessages) return;
      const pending = drainMessages();
      if (pending.length === 0) return;
      for (const raw of pending) {
        const text = raw.trim();
        if (!text) continue;
        const wrapped = wrapParentMidflightGuidance(text);
        const message: Message = {
          role: 'user',
          content: [{ type: 'text', text: wrapped }],
        };
        const messageId = generateUUID();
        ctx.state.messages.push(message);
        examinedMessages?.add(message);
        if (onInjected) {
          await onInjected(wrapped, message, messageId);
        }
        ctx.emitEvent(new UserEvent({
          client_event_id: messageId,
          message_id: messageId,
          content: wrapped,
          blocks_json: buildUserEventBlocks(wrapped),
          triggered_by: PARENT_MIDFLIGHT_TRIGGERED_BY,
        }).toStreamEvent());
        // 六件套 → hook channel → yield → SUBAGENT_STREAM_EVENT → 详情时间线
        for (const ev of buildParentMidflightUserEnvelopeEvents(messageId, wrapped)) {
          ctx.emitEvent(ev);
        }
      }
    },
  };
}
