/**
 * ViewFactory 性能指标与内存压力检测
 */

import v8 from 'node:v8'

// ── Memory Pressure Detection ────────────────────────────────────

export type MemoryPressureLevel = 'normal' | 'warning' | 'critical'

export interface MemoryPressureSnapshot {
  level: MemoryPressureLevel
  heapUsedMB: number
  heapTotalMB: number
  usageRatio: number
}

/**
 * 检测当前进程内存压力等级。
 * 使用 v8 heap_size_limit 作为分母，避免 heapTotal 动态扩容导致 ratio 永远达不到阈值。
 * - critical (>85%): 应强制清理所有非 inUse View
 * - warning (>70%): 应降低 idle 阈值加速清理
 * - normal: 正常运行
 */
export function getMemoryPressure(): MemoryPressureSnapshot {
  const { heapUsed } = process.memoryUsage()
  const { heap_size_limit } = v8.getHeapStatistics()
  const heapUsedMB = heapUsed / 1024 / 1024
  const heapTotalMB = heap_size_limit / 1024 / 1024
  const usageRatio = heapUsed / heap_size_limit

  let level: MemoryPressureLevel = 'normal'
  if (usageRatio > 0.85) level = 'critical'
  else if (usageRatio > 0.70) level = 'warning'

  return { level, heapUsedMB, heapTotalMB, usageRatio }
}

// ── Performance Metrics ──────────────────────────────────────────

export interface PerformanceMetrics {
  // 启动性能
  startupTime: number;              // 总启动时间 (ms)
  viewFactoryInitTime: number;      // ViewFactory 初始化时间 (ms)

  // 运行时性能
  viewCreationTime: number;         // View 创建平均耗时 (ms)
  viewCreationCount: number;        // View 创建次数
  viewDestroyTime: number;          // View 销毁平均耗时 (ms)
  viewDestroyCount: number;         // View 销毁次数

  // 资源使用
  activeViewCount: number;          // 活跃 View 数量
  totalViewCount: number;           // 总 View 数量
  memoryUsageMB: number;            // 内存使用 (MB)

  // 清理性能
  cleanupExecutionTime: number;     // 清理平均耗时 (ms)
  cleanupViewCount: number;         // 清理 View 总数
  cleanupRunCount: number;          // 清理执行次数

  // 复用统计
  viewReuseCount: number;           // View 复用次数
  viewReuseRate: number;            // View 复用率 (%)
}

export interface PerformanceEvent {
  timestamp: number;
  event: string;
  duration?: number;
  metadata?: Record<string, any>;
}

/**
 * 性能指标收集器
 */
export class PerformanceCollector {
  private metrics: PerformanceMetrics = {
    startupTime: 0,
    viewFactoryInitTime: 0,
    viewCreationTime: 0,
    viewCreationCount: 0,
    viewDestroyTime: 0,
    viewDestroyCount: 0,
    activeViewCount: 0,
    totalViewCount: 0,
    memoryUsageMB: 0,
    cleanupExecutionTime: 0,
    cleanupViewCount: 0,
    cleanupRunCount: 0,
    viewReuseCount: 0,
    viewReuseRate: 0
  };

  private events: PerformanceEvent[] = [];
  private maxEvents = 100;  // 最多保留 100 个事件

  /**
   * 记录 View 创建
   */
  public recordViewCreation(duration: number, reused: boolean): void {
    this.metrics.viewCreationCount++;

    if (reused) {
      this.metrics.viewReuseCount++;
    }

    // 计算移动平均
    const prevTotal = this.metrics.viewCreationTime * (this.metrics.viewCreationCount - 1);
    this.metrics.viewCreationTime = (prevTotal + duration) / this.metrics.viewCreationCount;

    // 更新复用率
    this.metrics.viewReuseRate =
      (this.metrics.viewReuseCount / this.metrics.viewCreationCount) * 100;

    this.addEvent('view_created', duration, { reused });
  }

  /**
   * 记录 View 销毁
   */
  public recordViewDestroy(duration: number): void {
    this.metrics.viewDestroyCount++;

    // 计算移动平均
    const prevTotal = this.metrics.viewDestroyTime * (this.metrics.viewDestroyCount - 1);
    this.metrics.viewDestroyTime = (prevTotal + duration) / this.metrics.viewDestroyCount;

    this.addEvent('view_destroyed', duration);
  }

  /**
   * 记录清理操作
   */
  public recordCleanup(duration: number, viewCount: number): void {
    this.metrics.cleanupRunCount++;
    this.metrics.cleanupViewCount += viewCount;

    // 计算移动平均
    const prevTotal = this.metrics.cleanupExecutionTime * (this.metrics.cleanupRunCount - 1);
    this.metrics.cleanupExecutionTime = (prevTotal + duration) / this.metrics.cleanupRunCount;

    this.addEvent('cleanup', duration, { viewCount });
  }

  /**
   * 更新资源使用情况
   */
  public updateResourceUsage(activeCount: number, totalCount: number): void {
    this.metrics.activeViewCount = activeCount;
    this.metrics.totalViewCount = totalCount;
    this.metrics.memoryUsageMB = process.memoryUsage().heapUsed / 1024 / 1024;
  }

  /**
   * 设置启动时间
   */
  public setStartupTime(time: number): void {
    this.metrics.startupTime = time;
  }

  /**
   * 设置 ViewFactory 初始化时间
   */
  public setViewFactoryInitTime(time: number): void {
    this.metrics.viewFactoryInitTime = time;
  }

  /**
   * 获取性能指标
   */
  public getMetrics(): PerformanceMetrics {
    // 更新内存使用
    this.metrics.memoryUsageMB = process.memoryUsage().heapUsed / 1024 / 1024;

    return { ...this.metrics };
  }

  /**
   * 获取事件历史
   */
  public getEvents(): PerformanceEvent[] {
    return [...this.events];
  }

  /**
   * 重置指标
   */
  public reset(): void {
    this.metrics = {
      startupTime: 0,
      viewFactoryInitTime: 0,
      viewCreationTime: 0,
      viewCreationCount: 0,
      viewDestroyTime: 0,
      viewDestroyCount: 0,
      activeViewCount: 0,
      totalViewCount: 0,
      memoryUsageMB: 0,
      cleanupExecutionTime: 0,
      cleanupViewCount: 0,
      cleanupRunCount: 0,
      viewReuseCount: 0,
      viewReuseRate: 0
    };
    this.events = [];
  }

  /**
   * 添加事件
   */
  private addEvent(event: string, duration?: number, metadata?: Record<string, any>): void {
    this.events.push({
      timestamp: Date.now(),
      event,
      duration,
      metadata
    });

    // 保持事件数量在限制内
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }
  }
}

