/**
 * 大小限制和截断处理工具
 * 防止内存溢出和处理大文件
 */

import { DEFAULT_LIMITS } from '../types/access-result.js';
import { loggers } from '../logger/CrawlLogger.js';

// 截断结果
export interface TruncationResult {
  data: string | Buffer;
  truncated: boolean;
  originalSize: number;
  truncatedSize: number;
  truncationRatio: number;
}

// 大小信息
export interface SizeInfo {
  bytes: number;
  kb: number;
  mb: number;
  gb: number;
  humanReadable: string;
}

/**
 * 计算数据大小信息
 */
export function calculateSize(data: string | Buffer): SizeInfo {
  const bytes = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data, 'utf8');
  const kb = bytes / 1024;
  const mb = kb / 1024;
  const gb = mb / 1024;

  let humanReadable: string;
  if (gb >= 1) {
    humanReadable = `${gb.toFixed(2)} GB`;
  } else if (mb >= 1) {
    humanReadable = `${mb.toFixed(2)} MB`;
  } else if (kb >= 1) {
    humanReadable = `${kb.toFixed(2)} KB`;
  } else {
    humanReadable = `${bytes} bytes`;
  }

  return { bytes, kb, mb, gb, humanReadable };
}

/**
 * 检查数据是否超过大小限制
 */
export function exceedsLimit(data: string | Buffer, limit: number): boolean {
  const size = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data, 'utf8');
  return size > limit;
}

/**
 * 安全截断字符串（避免破坏 UTF-8 字符）
 */
export function truncateString(data: string, maxSize: number): TruncationResult {
  const originalSize = Buffer.byteLength(data, 'utf8');

  if (originalSize <= maxSize) {
    return {
      data,
      truncated: false,
      originalSize,
      truncatedSize: originalSize,
      truncationRatio: 0
    };
  }

  let truncated = data;
  let truncatedSize = originalSize;

  // 逐字符截断，确保不破坏 UTF-8 字符
  while (truncatedSize > maxSize && truncated.length > 0) {
    truncated = truncated.slice(0, -1);
    truncatedSize = Buffer.byteLength(truncated, 'utf8');
  }

  const truncationRatio = (originalSize - truncatedSize) / originalSize;

  loggers.core.warn('String truncated due to size limit', {
    originalSize,
    truncatedSize,
    maxSize,
    truncationRatio: `${(truncationRatio * 100).toFixed(2)}%`
  });

  return {
    data: truncated,
    truncated: true,
    originalSize,
    truncatedSize,
    truncationRatio
  };
}

/**
 * 截断 Buffer
 */
export function truncateBuffer(data: Buffer, maxSize: number): TruncationResult {
  const originalSize = data.length;

  if (originalSize <= maxSize) {
    return {
      data,
      truncated: false,
      originalSize,
      truncatedSize: originalSize,
      truncationRatio: 0
    };
  }

  const truncated = data.slice(0, maxSize);
  const truncatedSize = truncated.length;
  const truncationRatio = (originalSize - truncatedSize) / originalSize;

  loggers.core.warn('Buffer truncated due to size limit', {
    originalSize,
    truncatedSize,
    maxSize,
    truncationRatio: `${(truncationRatio * 100).toFixed(2)}%`
  });

  return {
    data: truncated,
    truncated: true,
    originalSize,
    truncatedSize,
    truncationRatio
  };
}

/**
 * 智能截断（根据数据类型选择合适的截断方式）
 */
export function smartTruncate(data: string | Buffer, maxSize: number): TruncationResult {
  if (Buffer.isBuffer(data)) {
    return truncateBuffer(data, maxSize);
  }
  return truncateString(data, maxSize);
}

/**
 * 截断 JSON 数据（保持 JSON 结构完整性）
 */
export function truncateJSON(data: any, maxSize: number): TruncationResult {
  const jsonString = JSON.stringify(data);
  const originalSize = Buffer.byteLength(jsonString, 'utf8');

  if (originalSize <= maxSize) {
    return {
      data: jsonString,
      truncated: false,
      originalSize,
      truncatedSize: originalSize,
      truncationRatio: 0
    };
  }

  // 尝试压缩 JSON（移除空格）
  const compactJson = JSON.stringify(data, null, 0);
  const compactSize = Buffer.byteLength(compactJson, 'utf8');

  if (compactSize <= maxSize) {
    const truncationRatio = (originalSize - compactSize) / originalSize;

    loggers.core.info('JSON compacted to fit size limit', {
      originalSize,
      compactSize,
      truncationRatio: `${(truncationRatio * 100).toFixed(2)}%`
    });

    return {
      data: compactJson,
      truncated: false, // 技术上没有截断，只是压缩
      originalSize,
      truncatedSize: compactSize,
      truncationRatio
    };
  }

  // 如果压缩后仍然太大，则截断字符串
  const result = truncateString(compactJson, maxSize);

  // 尝试修复截断后的 JSON
  try {
    const truncatedData = result.data as string;
    let fixedJson = truncatedData;

    // 简单的 JSON 修复：确保以 } 或 ] 结尾
    if (!fixedJson.endsWith('}') && !fixedJson.endsWith(']')) {
      const lastBrace = Math.max(fixedJson.lastIndexOf('}'), fixedJson.lastIndexOf(']'));
      if (lastBrace > 0) {
        fixedJson = fixedJson.substring(0, lastBrace + 1);
      }
    }

    // 验证修复后的 JSON
    JSON.parse(fixedJson);
    result.data = fixedJson;
    result.truncatedSize = Buffer.byteLength(fixedJson, 'utf8');

  } catch {
    // 如果无法修复，返回原始截断结果
    loggers.core.warn('Unable to fix truncated JSON, returning raw truncated string');
  }

  return result;
}

/**
 * 限制数组大小
 */
export function limitArraySize<T>(array: T[], maxItems: number): {
  items: T[];
  truncated: boolean;
  originalLength: number;
  truncatedLength: number;
} {
  if (array.length <= maxItems) {
    return {
      items: array,
      truncated: false,
      originalLength: array.length,
      truncatedLength: array.length
    };
  }

  const truncated = array.slice(0, maxItems);

  loggers.core.warn('Array truncated due to size limit', {
    originalLength: array.length,
    truncatedLength: truncated.length,
    maxItems
  });

  return {
    items: truncated,
    truncated: true,
    originalLength: array.length,
    truncatedLength: truncated.length
  };
}

/**
 * 内存使用监控器
 */
export class MemoryMonitor {
  private maxMemoryUsage: number;
  private currentUsage: number = 0;
  private warnings: number = 0;

  constructor(maxMemoryMB: number = 512) {
    this.maxMemoryUsage = maxMemoryMB * 1024 * 1024; // 转换为字节
  }

  /**
   * 检查内存使用情况
   */
  checkMemoryUsage(): {
    usage: number;
    limit: number;
    percentage: number;
    warning: boolean;
    critical: boolean;
  } {
    const memUsage = process.memoryUsage();
    this.currentUsage = memUsage.heapUsed;

    const percentage = (this.currentUsage / this.maxMemoryUsage) * 100;
    const warning = percentage > 70;
    const critical = percentage > 90;

    if (warning) {
      this.warnings++;

      if (this.warnings % 10 === 0) { // 每10次警告记录一次
        loggers.core.warn('High memory usage detected', {
          usage: calculateSize(Buffer.alloc(this.currentUsage)).humanReadable,
          limit: calculateSize(Buffer.alloc(this.maxMemoryUsage)).humanReadable,
          percentage: `${percentage.toFixed(2)}%`
        });
      }
    }

    return {
      usage: this.currentUsage,
      limit: this.maxMemoryUsage,
      percentage,
      warning,
      critical
    };
  }

  /**
   * 强制垃圾回收（如果可用）
   */
  forceGC(): boolean {
    if (global.gc) {
      global.gc();
      loggers.core.debug('Forced garbage collection');
      return true;
    }
    return false;
  }

  /**
   * 获取内存统计信息
   */
  getMemoryStats(): {
    heap: SizeInfo;
    external: SizeInfo;
    rss: SizeInfo;
    arrayBuffers: SizeInfo;
  } {
    const memUsage = process.memoryUsage();

    return {
      heap: calculateSize(Buffer.alloc(memUsage.heapUsed)),
      external: calculateSize(Buffer.alloc(memUsage.external)),
      rss: calculateSize(Buffer.alloc(memUsage.rss)),
      arrayBuffers: calculateSize(Buffer.alloc(memUsage.arrayBuffers))
    };
  }
}

/**
 * 大小限制管理器
 */
export class SizeLimitManager {
  private limits = { ...DEFAULT_LIMITS };
  private monitor = new MemoryMonitor();

  /**
   * 更新限制配置
   */
  updateLimits(newLimits: Partial<typeof DEFAULT_LIMITS>): void {
    this.limits = { ...this.limits, ...newLimits };

    loggers.core.info('Size limits updated', {
      mainPayload: calculateSize(Buffer.alloc(this.limits.MAIN_PAYLOAD_MAX)).humanReadable,
      samplePayload: calculateSize(Buffer.alloc(this.limits.SAMPLE_PAYLOAD_MAX)).humanReadable,
      networkSamples: this.limits.NETWORK_SAMPLES_MAX
    });
  }

  /**
   * 获取当前限制
   */
  getLimits(): typeof DEFAULT_LIMITS {
    return { ...this.limits };
  }

  /**
   * 检查并截断主载荷
   */
  processMainPayload(data: string | Buffer): TruncationResult {
    return smartTruncate(data, this.limits.MAIN_PAYLOAD_MAX);
  }

  /**
   * 检查并截断样本载荷
   */
  processSamplePayload(data: string | Buffer): TruncationResult {
    return smartTruncate(data, this.limits.SAMPLE_PAYLOAD_MAX);
  }

  /**
   * 限制网络请求数量
   */
  limitNetworkRequests<T>(requests: T[]): {
    items: T[];
    truncated: boolean;
    originalLength: number;
    truncatedLength: number;
  } {
    return limitArraySize(requests, this.limits.NETWORK_SAMPLES_MAX);
  }

  /**
   * 检查内存使用情况
   */
  checkMemory(): ReturnType<MemoryMonitor['checkMemoryUsage']> {
    return this.monitor.checkMemoryUsage();
  }

  /**
   * 获取内存统计
   */
  getMemoryStats(): ReturnType<MemoryMonitor['getMemoryStats']> {
    return this.monitor.getMemoryStats();
  }
}

// 全局大小限制管理器实例
export const sizeLimitManager = new SizeLimitManager();
