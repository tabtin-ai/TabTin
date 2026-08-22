/**
 * 通用并发控制工具 —— 限制同时执行的 Promise 数量。
 *
 * Worker 池模式：启动 N 个 worker 协程，共享 nextIndex 指针依次领取任务。
 * 结果数组保证与输入顺序一致。
 *
 * 注意：fn 内部抛出异常会被捕获并记录到 errors 数组，
 * 对应 results 位置为 undefined。调用方应自行处理 fn 内的错误
 *（推荐在 fn 内 try-catch 返回错误态结果，而非直接 throw）。
 */

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const len = items.length;
  if (len === 0) return [];

  const effectiveConcurrency = Math.max(1, Math.min(concurrency, len));
  const results = new Array<R>(len);
  const errors: Array<{ index: number; error: unknown }> = [];

  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < len) {
      const idx = nextIndex++;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (err) {
        errors.push({ index: idx, error: err });
        console.warn(`[mapWithConcurrency] fn threw at index ${idx}:`, err);
      }
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < effectiveConcurrency; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  if (errors.length > 0) {
    console.warn(`[mapWithConcurrency] ${errors.length}/${len} items threw errors`);
  }

  return results;
}
