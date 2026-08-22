/**
 * Per-document 异步互斥锁
 *
 * 基于 Promise 链实现，与 BaseCollabDatabase._storeQueues 同一模式。
 * 确保同一 key（documentName）的操作严格串行执行。
 *
 * CI-016: 用于 agent-push 路由的 detectConcurrentEditors + transact
 * 临界区保护，消除 TOCTOU 竞态。
 */

export class DocumentMutex {
  private readonly _queues = new Map<string, Promise<void>>();

  /**
   * 在 key 对应的串行队列中执行 fn。
   * 同一 key 的多个 runExclusive 调用按顺序依次执行。
   */
  runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this._queues.get(key) ?? Promise.resolve();

    let resolveSentinel: () => void;
    const sentinel = new Promise<void>((resolve) => {
      resolveSentinel = resolve;
    });
    this._queues.set(key, sentinel);

    const execute = async (): Promise<T> => {
      try {
        await prev;
      } catch {
        // 前序操作的错误不影响后续操作
      }
      try {
        return await fn();
      } finally {
        resolveSentinel!();
        if (this._queues.get(key) === sentinel) {
          this._queues.delete(key);
        }
      }
    };

    return execute();
  }

  /** 当前持有锁的 key 数量（用于监控/测试） */
  get size(): number {
    return this._queues.size;
  }
}
