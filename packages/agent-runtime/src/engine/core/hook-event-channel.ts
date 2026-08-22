/**
 * Hook 事件通道 —— 新一代钩子消费点的实时事件出口（ review 修复）。
 *
 * **为什么不是简单数组队列**：Wave 0 初版把 hook 事件攒进数组、hook 执行完
 * 一次性 flush。对同步策略无差异，但对含 await 的策略（413 恢复的
 * autoCompact 要调 LLM 做摘要，耗时数秒到数十秒）会把「过程开始」事件
 * （COMPACTION start）压到过程结束后才发出——前端在最需要进度反馈的时刻
 * 看不到任何指示。本通道让主循环在 `await hook` 期间也能把已入队的事件
 * 按 FIFO 实时 yield 出去：
 *   - 事件顺序仍严格 = hook 内 emit 顺序（FIFO）；
 *   - flush 出口仍在 QueryRun 消费点的 generator 里（主循环掌控协议出口，
 *     hook 拿不到直接 yield 的能力）——「钩子写信号、主循环掌控制流」的
 *     硬约束不变，只是把「执行完才倒队列」升级为「边执行边倒」。
 */

import type {
  StreamEvent,
} from '../contracts/wire-protocol.js';

export class HookEventChannel {
  private queue: StreamEvent[] = [];
  private notify: (() => void) | null = null;

  push(event: StreamEvent): void {
    this.queue.push(event);
    this.notify?.();
  }

  /**
   * 边等待 `work` 边按 FIFO yield 已入队事件；`work` settle 且队列排空后
   * 结束。`work` 的异常不在此处抛出——调用方应把 try/catch 包进 work 本身
   * （fail-soft 策略：错误转 hook_error notice 入队）。
   */
  async *drain(work: Promise<void>): AsyncGenerator<StreamEvent, void, undefined> {
    let settled = false;
    void work.finally(() => {
      settled = true;
      this.notify?.();
    });
    while (true) {
      while (this.queue.length > 0) yield this.queue.shift()!;
      if (settled) break;
      await new Promise<void>((resolve) => {
        this.notify = resolve;
      });
      this.notify = null;
    }
    while (this.queue.length > 0) yield this.queue.shift()!;
  }
}
