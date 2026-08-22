/**
 * RateLimiter — 同一 tab 连续操作的随机间隔速率控制
 *
 * 防止 Agent 高频请求触发反爬。
 */

export interface RateLimiterOptions {
  minIntervalMs?: number;
  maxIntervalMs?: number;
}

const DEFAULTS: Required<RateLimiterOptions> = {
  minIntervalMs: 800,
  maxIntervalMs: 1500,
};

export class RateLimiter {
  private timestamps = new Map<string, number>();
  private readonly minMs: number;
  private readonly maxMs: number;

  constructor(options?: RateLimiterOptions) {
    this.minMs = options?.minIntervalMs ?? DEFAULTS.minIntervalMs;
    this.maxMs = options?.maxIntervalMs ?? DEFAULTS.maxIntervalMs;
  }

  /**
   * 如果距上次操作间隔不足，则等待到最小随机间隔。
   */
  async enforce(key: string): Promise<void> {
    const last = this.timestamps.get(key);
    if (!last) return;
    const elapsed = Date.now() - last;
    const required = this.minMs + Math.random() * (this.maxMs - this.minMs);
    if (elapsed < required) {
      await new Promise((r) => setTimeout(r, required - elapsed));
    }
  }

  /**
   * 记录本次操作时间戳。
   */
  mark(key: string): void {
    this.timestamps.set(key, Date.now());
  }

  /**
   * 清除指定 key 的时间戳记录，用于 tab 销毁时释放内存。
   */
  clear(key: string): void {
    this.timestamps.delete(key);
  }
}
