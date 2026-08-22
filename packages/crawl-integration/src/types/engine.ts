/**
 * 引擎接口定义
 * 基于 ScrapePRD.md 中的引擎架构设计
 */

import type { AccessResult } from './access-result.js';
import type { ScrapeOptions, EngineType } from './options.js';
import type { CrawlError } from './errors.js';

// 引擎能力定义
export interface EngineCapabilities {
  supportsJavaScript: boolean;
  supportsScreenshots: boolean;
  supportsCookies: boolean;
  supportsProxy: boolean;
  supportsUserInteraction: boolean;
  supportsNetworkCapture: boolean;
  supportsExternalBrowser: boolean;  // 支持连接外部浏览器
  maxConcurrency: number;
  resourceUsage: 'LOW' | 'MEDIUM' | 'HIGH';

  // 支持的协议
  supportedProtocols: string[];

  // 支持的内容类型
  supportedContentTypes: string[];

  // 特殊能力
  canHandleSPA: boolean;
  canHandleInfiniteScroll: boolean;
  canBypassBasicAntiBot: boolean;
  canReuseConnections: boolean;
}

// 引擎状态
export enum EngineStatus {
  IDLE = 'IDLE',
  INITIALIZING = 'INITIALIZING',
  READY = 'READY',
  BUSY = 'BUSY',
  ERROR = 'ERROR',
  SHUTTING_DOWN = 'SHUTTING_DOWN',
  SHUTDOWN = 'SHUTDOWN'
}

// 引擎健康状态
export interface EngineHealth {
  status: EngineStatus;
  healthy: boolean;
  lastCheck: Date;

  // 性能指标
  metrics: {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    averageResponseTime: number;
    currentConcurrency: number;
    maxConcurrency: number;
  };

  // 资源使用情况
  resources: {
    memoryUsage: number;    // MB
    cpuUsage: number;       // 百分比
    activeConnections: number;
    openFiles?: number;
  };

  // 错误信息
  lastError?: CrawlError;
  errorCount: number;

  // 版本信息
  version?: string;
  dependencies?: Record<string, string>;
}

// 引擎初始化选项
export interface EngineInitOptions {
  // 基础配置
  maxConcurrency?: number;
  timeout?: number;
  retries?: number;

  // 资源限制
  memoryLimit?: number;
  cpuLimit?: number;

  // 日志配置
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  logNamespace?: string;

  // 特定引擎配置
  engineSpecific?: Record<string, any>;
}

// 抓取上下文
export interface ScrapeContext {
  requestId: string;
  traceId: string;
  startTime: Date;

  // 请求信息
  url: string;
  options: ScrapeOptions;

  // 重试信息
  attemptCount: number;
  maxAttempts: number;

  // 引擎信息
  engine: EngineType;
  engineVersion?: string;

  // 会话信息
  sessionId?: string;

  // 元数据
  metadata?: Record<string, any>;
}

// 抓取进度事件
export interface ScrapeProgressEvent {
  type: 'START' | 'PROGRESS' | 'COMPLETE' | 'ERROR' | 'RETRY';
  context: ScrapeContext;
  timestamp: Date;

  // 进度信息
  progress?: {
    phase: string;
    percentage: number;
    message?: string;
  };

  // 错误信息
  error?: CrawlError;

  // 结果信息
  result?: AccessResult;
}

// 引擎事件监听器
export type EngineEventListener = (event: ScrapeProgressEvent) => void;

// 抓取引擎基础接口
export interface ScrapeEngine {
  // 基础属性
  readonly name: string;
  readonly type: EngineType;
  readonly version: string;
  readonly capabilities: EngineCapabilities;

  // 状态管理
  getStatus(): EngineStatus;
  getHealth(): EngineHealth;
  isHealthy(): boolean;

  // 生命周期方法
  initialize(options?: EngineInitOptions): Promise<void>;
  shutdown(): Promise<void>;

  // 核心抓取方法
  scrape(url: string, options?: ScrapeOptions): Promise<AccessResult>;

  // 批量抓取（可选实现）
  scrapeMultiple?(urls: string[], options?: ScrapeOptions): Promise<AccessResult[]>;

  // 事件监听
  on(event: 'progress' | 'error' | 'complete', listener: EngineEventListener): void;
  off(event: 'progress' | 'error' | 'complete', listener: EngineEventListener): void;

  // 资源管理
  cleanup(): Promise<void>;

  // 配置管理
  updateConfig(config: Partial<EngineInitOptions>): Promise<void>;
  getConfig(): EngineInitOptions;

  // 诊断方法
  diagnose(): Promise<{
    issues: string[];
    suggestions: string[];
    systemInfo: Record<string, any>;
  }>;
}

// 引擎工厂接口
export interface IEngineFactory {
  // 引擎注册
  registerEngine(type: EngineType, engineClass: new() => ScrapeEngine): void;
  unregisterEngine(type: EngineType): void;

  // 引擎创建
  createEngine(type: EngineType, options?: EngineInitOptions): Promise<ScrapeEngine>;

  // 引擎查询
  getAvailableEngines(): EngineType[];
  getEngineCapabilities(type: EngineType): EngineCapabilities | null;
  isEngineAvailable(type: EngineType): boolean;

  // 引擎管理
  destroyEngine(engine: ScrapeEngine): Promise<void>;
  destroyAllEngines(): Promise<void>;

  // 健康检查
  checkEngineHealth(type: EngineType): Promise<EngineHealth>;
  checkAllEnginesHealth(): Promise<Record<EngineType, EngineHealth>>;
}

// 引擎性能基准测试结果
export interface EngineBenchmark {
  engine: EngineType;
  testUrl: string;

  // 性能指标
  responseTime: number;
  throughput: number;     // 请求/秒
  successRate: number;
  errorRate: number;

  // 资源使用
  peakMemoryUsage: number;
  averageCpuUsage: number;

  // 测试配置
  concurrency: number;
  duration: number;       // 测试持续时间（秒）
  totalRequests: number;

  // 时间戳
  timestamp: Date;
}

// 引擎比较结果
export interface EngineComparison {
  engines: EngineType[];
  testScenarios: string[];
  results: Record<EngineType, EngineBenchmark[]>;

  // 综合评分
  rankings: {
    engine: EngineType;
    overallScore: number;
    strengths: string[];
    weaknesses: string[];
  }[];

  // 推荐建议
  recommendations: {
    scenario: string;
    recommendedEngine: EngineType;
    reason: string;
  }[];
}
