/**
 * Thread Notifications Injector Hook —— 每轮 LLM 前把宿主暂存的后台推送
 * （push notification / 群聊 @ 等）注入 messages（，Wave 1）。
 *
 * **历史背景**：本行为原内联在 `query.ts` 的 `injectThreadNotifications`
 * （prepareIteration → injectHostMessages 固定位置）。#3939 策略迁移把它
 * 挂到新一代 `beforeModel` 扩展点上。
 *
 * **行为不变**：
 *   1. 每轮 beforeModel 调 `drainThreadNotifications()`（宿主闭包，来自
 *      `EngineConfig.drainThreadNotifications`；drain 语义——取走即清空）
 *   2. 空文本 → 跳过
 *   3. 注入文本 push 进 `state.messages`（role=user）
 *   4. 排一条 USER 事件（`triggered_by: 'push-notification'`，带 blocks_json 持久化全文）
 *   5. drain 抛错 → 排 `background_notification_inject_error` notice，
 *      不阻断 iteration
 */

import { UserEvent } from '../../event/events/user-events.js';
import { v4 as uuidv4 } from 'uuid';
import { buildUserEventBlocks } from '../context/user-message.js';
import type {
  EngineHooks,
} from '../contracts/kernel.js';

export interface ThreadNotificationsInjectorOptions {
  /** 宿主回调 —— 缺省时本 hook 空转（与原 config 字段缺省行为一致）。 */
  drainThreadNotifications?: () => Promise<string | null>;
  /** USER 事件 client_event_id 生成器（测试可注入；默认 uuid v4）。 */
  generateUUID?: () => string;
}

export function buildThreadNotificationsInjectorHook(
  options: ThreadNotificationsInjectorOptions,
): EngineHooks {
  const { drainThreadNotifications, generateUUID = uuidv4 } = options;
  return {
    async beforeModel(ctx): Promise<void> {
      if (!drainThreadNotifications) return;
      try {
        const injectionText = await drainThreadNotifications();
        if (!injectionText || injectionText.length === 0) return;
        ctx.state.messages.push({
          role: 'user',
          content: [{ type: 'text', text: injectionText }],
        });
        const pushMessageId = generateUUID();
        // arrival_seq 不在此预打——事件经 channel 在钩子点按 FIFO flush，出口
        // EventEmitter 按 yield 顺序补 arrival_seq；hook 执行期预打会让本事件序号
        // 早于排在它前面、flush 时才补号的 notice，时间线倒挂（review D2）。
        ctx.emitEvent(new UserEvent({
          client_event_id: pushMessageId,
          message_id: pushMessageId,
          content: injectionText,
          blocks_json: buildUserEventBlocks(injectionText),
          triggered_by: 'push-notification',
        }).toStreamEvent());
      } catch (err) {
        ctx.emitNotice({
          content: `drainThreadNotifications failed: ${String(err)}`,
          notice_type: 'background_notification_inject_error',
          iteration: ctx.iteration,
        });
      }
    },
  };
}
