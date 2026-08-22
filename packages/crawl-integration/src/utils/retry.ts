/**
 * 重试机制工具
 * 提供指数退避、抖动和智能重试策略
 */

import type { CrawlError, ErrorCategory } from '../types/errors.js';
import { loggers } from '../logger/CrawlLogger.js';

// 重试配置
export interface RetryConfig {
  maxAttempts: number;
  baseDelay: number;        // 基础延迟（毫秒）
  maxDelay: number;         // 最大延迟（毫秒）
  backoffFactor: number;    // 退避因子
  jitter: boolean;          // 是否添加抖动
  jitterFactor: number;     // 抖动因子 (0-1)

  // 重试条件
  retryableErrors: string[];
  retryableCategories: ErrorCategory[];

  // 回调函数
  onRetry?: (attempt: number, error: Error, delay: number) => void;
  onMaxAttemptsReached?: (error: Error) => void;
}

// 默认重试配置
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelay: 1000,
  maxDelay: 30000,
  backoffFactor: 2,
  jitter: true,
  jitterFactor: 0.1,
  retryableErrors: ['TIMEOUT', 'NETWORK', 'RATE_LIMIT'],
  retryableCategories: ['RETRYABLE' as any],
  onRetry: (attempt, error, delay) => {
    loggers.core.warn(`Retry attempt ${attempt}`, { error: error.message, delay });
  },
  onMaxAttemptsReached: (error) => {
    loggers.core.error('Max retry attempts reached', { error: error.message });
  }
};

/**
 * 重试执行器
 */
export class RetryExecutor {
  private config: RetryConfig;

  constructor(config: Partial<RetryConfig> = {}) {
    this.config = { ...DEFAULT_RETRY_CONFIG, ...config };
  }

  /**
   * 执行带重试的操作
   */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error;

    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;

        // 检查是否应该重试
        if (!this.shouldRetry(error as Error, attempt)) {
          throw error;
        }

        // 如果不是最后一次尝试，则等待后重试
        if (attempt < this.config.maxAttempts) {
          const delay = this.calculateDelay(attempt);

          if (this.config.onRetry) {
            this.config.onRetry(attempt, error as Error, delay);
          }

          await this.sleep(delay);
        }
      }
    }

    // 达到最大重试次数
    if (this.config.onMaxAttemptsReached) {
      this.config.onMaxAttemptsReached(lastError!);
    }

    throw lastError!;
  }

  /**
   * 判断是否应该重试
   */
  private shouldRetry(error: Error, attempt: number): boolean {
    // 超过最大尝试次数
    if (attempt >= this.config.maxAttempts) {
      return false;
    }

    // 检查是否为可重试的错误
    const crawlError = error as unknown as CrawlError;

    // 检查错误分类
    if (crawlError.category && this.config.retryableCategories.includes(crawlError.category)) {
      return true;
    }

    // 检查错误代码
    if (crawlError.code && this.config.retryableErrors.includes(crawlError.code)) {
      return true;
    }

    // 检查错误名称（兼容性）
    if (this.config.retryableErrors.includes(error.name)) {
      return true;
    }

    // 检查错误消息中的关键词
    const message = error.message.toLowerCase();
    const retryableKeywords = ['timeout', 'network', 'connection', 'econnreset', 'enotfound'];

    return retryableKeywords.some(keyword => message.includes(keyword));
  }

  /**
   * 计算延迟时间（指数退避 + 抖动）
   */
  private calculateDelay(attempt: number): number {
    // 指数退避
    let delay = this.config.baseDelay * Math.pow(this.config.backoffFactor, attempt - 1);

    // 限制最大延迟
    delay = Math.min(delay, this.config.maxDelay);

    // 添加抖动
    if (this.config.jitter) {
      const jitterRange = delay * this.config.jitterFactor;
      const jitter = (Math.random() - 0.5) * 2 * jitterRange;
      delay += jitter;
    }

    return Math.max(0, Math.round(delay));
  }

  /**
   * 睡眠函数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<RetryConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取当前配置
   */
  getConfig(): RetryConfig {
    return { ...this.config };
  }
}

/**
 * 重试装饰器
 */
export function retry(config?: Partial<RetryConfig>) {
  return function (_target: any, _propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    const executor = new RetryExecutor(config);

    descriptor.value = async function (...args: any[]) {
      return executor.execute(() => originalMethod.apply(this, args));
    };

    return descriptor;
  };
}

/**
 * 简单重试函数
 */
export async function retryOperation<T>(
  operation: () => Promise<T>,
  config?: Partial<RetryConfig>
): Promise<T> {
  const executor = new RetryExecutor(config);
  return executor.execute(operation);
}

/**
 * 条件重试（基于错误类型）
 */
export async function retryOnError<T>(
  operation: () => Promise<T>,
  errorTypes: (string | ErrorCategory)[],
  maxAttempts: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  const config: Partial<RetryConfig> = {
    maxAttempts,
    baseDelay,
    retryableErrors: errorTypes.filter(t => typeof t === 'string') as string[],
    retryableCategories: errorTypes.filter(t => typeof t !== 'string') as ErrorCategory[]
  };

  return retryOperation(operation, config);
}

/**
 * 线性退避重试
 */
export async function retryWithLinearBackoff<T>(
  operation: () => Promise<T>,
  maxAttempts: number = 3,
  delay: number = 1000
): Promise<T> {
  const config: Partial<RetryConfig> = {
    maxAttempts,
    baseDelay: delay,
    backoffFactor: 1, // 线性退避
    jitter: false
  };

  return retryOperation(operation, config);
}

/**
 * 固定间隔重试
 */
export async function retryWithFixedInterval<T>(
  operation: () => Promise<T>,
  maxAttempts: number = 3,
  interval: number = 1000
): Promise<T> {
  let lastError: Error;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, interval));
      }
    }
  }

  throw lastError!;
}

/**
 * 重试统计信息
 */
export interface RetryStats {
  totalAttempts: number;
  successfulAttempts: number;
  failedAttempts: number;
  averageAttempts: number;
  totalDelay: number;
  averageDelay: number;
  errorDistribution: Record<string, number>;
}

/**
 * 重试统计收集器
 */
export class RetryStatsCollector {
  private stats: RetryStats = {
    totalAttempts: 0,
    successfulAttempts: 0,
    failedAttempts: 0,
    averageAttempts: 0,
    totalDelay: 0,
    averageDelay: 0,
    errorDistribution: {}
  };

  private operationAttempts: number[] = [];
  private operationDelays: number[] = [];

  /**
   * 记录操作开始
   */
  recordOperationStart(): void {
    // 可以记录开始时间等信息
  }

  /**
   * 记录重试
   */
  recordRetry(_attempt: number, error: Error, delay: number): void {
    this.stats.totalAttempts++;
    this.stats.totalDelay += delay;

    // 记录错误分布
    const errorKey = error.name || 'Unknown';
    this.stats.errorDistribution[errorKey] = (this.stats.errorDistribution[errorKey] || 0) + 1;
  }

  /**
   * 记录操作成功
   */
  recordSuccess(totalAttempts: number, totalDelay: number): void {
    this.stats.successfulAttempts++;
    this.operationAttempts.push(totalAttempts);
    this.operationDelays.push(totalDelay);
    this.updateAverages();
  }

  /**
   * 记录操作失败
   */
  recordFailure(totalAttempts: number, totalDelay: number): void {
    this.stats.failedAttempts++;
    this.operationAttempts.push(totalAttempts);
    this.operationDelays.push(totalDelay);
    this.updateAverages();
  }

  /**
   * 更新平均值
   */
  private updateAverages(): void {
    const totalOperations = this.operationAttempts.length;

    if (totalOperations > 0) {
      this.stats.averageAttempts = this.operationAttempts.reduce((a, b) => a + b, 0) / totalOperations;
      this.stats.averageDelay = this.operationDelays.reduce((a, b) => a + b, 0) / totalOperations;
    }
  }

  /**
   * 获取统计信息
   */
  getStats(): RetryStats {
    return { ...this.stats };
  }

  /**
   * 重置统计信息
   */
  reset(): void {
    this.stats = {
      totalAttempts: 0,
      successfulAttempts: 0,
      failedAttempts: 0,
      averageAttempts: 0,
      totalDelay: 0,
      averageDelay: 0,
      errorDistribution: {}
    };
    this.operationAttempts = [];
    this.operationDelays = [];
  }
}
