/**
 * RunEventRecorder — 统一的 Run 事件记录器
 *
 * 为 BrowserToolImpl / CrawlToolImpl 提供一致的事件归档能力。
 * 支持两种模式：
 *  - 回调模式（BrowserToolImpl）：通过 setRecorder 注入外部回调
 *  - API 模式（CrawlToolImpl）：通过 resolveRunSessionAPI 自动解析
 */

import { resolveRunSessionAPI } from '../../utils/runtime-bridge';

export type EventRecorderCallback = (event: any) => void;

export class RunEventRecorder {
  private callback: EventRecorderCallback | null = null;

  /**
   * 注入外部回调（由 BrowserToolImpl 在主进程中使用）。
   * 设置后优先通过回调发送事件。
   */
  setCallback(cb: EventRecorderCallback): void {
    this.callback = cb;
  }

  /**
   * 记录一个 Run 事件。
   *
   * 优先级：callback > runSessionAPI.addEvent
   */
  record(
    runId: string | undefined,
    viewId: string | undefined,
    type: string,
    data: any,
    context?: any,
  ): void {
    if (!runId && !viewId) return;

    const event = {
      runId,
      viewId,
      type,
      data,
      timestamp: Date.now(),
      context: context ?? buildContextFromData(data),
    };

    try {
      if (this.callback) {
        this.callback(event);
        return;
      }

      const runSession = resolveRunSessionAPI();
      runSession?.addEvent?.(event);
    } catch (error) {
      console.warn('[RunEventRecorder] ⚠️ 记录事件失败:', error);
    }
  }
}

/**
 * 从工具输出中推断上下文（URL/标题/耗时/错误码）。
 * 纯函数，可独立使用。
 */
export function buildContextFromData(data: any): any | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const ctx: any = {};
  const url = data.page_url || data.url;
  const title = data.page_title || data.title;
  if (url) ctx.url = url;
  if (title) ctx.title = title;
  if (typeof data.frontend_execution_time_ms === 'number') ctx.duration = data.frontend_execution_time_ms;
  else if (typeof data.duration === 'number') ctx.duration = data.duration;
  if (data.error_code || data.error) {
    ctx.error = { code: data.error_code, message: typeof data.error === 'string' ? data.error : undefined };
  }
  return Object.keys(ctx).length > 0 ? ctx : undefined;
}

let shared: RunEventRecorder | null = null;

export function getSharedRunEventRecorder(): RunEventRecorder {
  if (!shared) shared = new RunEventRecorder();
  return shared;
}
