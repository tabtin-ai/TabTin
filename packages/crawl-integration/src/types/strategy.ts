/**
 * 策略相关类型定义
 * 基于 ScrapePRD.md 中的策略管理设计
 */

import type { EngineType, ScrapeOptions } from './options.js';

export type StrategyMode = 'auto' | 'disabled' | 'external';

// 网站类型
export enum WebsiteType {
  SPA = 'SPA',           // 单页应用
  MPA = 'MPA',           // 多页应用
  STATIC = 'STATIC',     // 静态网站
  DYNAMIC = 'DYNAMIC',   // 动态网站
  API_DRIVEN = 'API_DRIVEN' // API 驱动
}

// CDN 提供商
export enum CDNProvider {
  CLOUDFLARE = 'cloudflare',
  AKAMAI = 'akamai',
  FASTLY = 'fastly',
  UNKNOWN = 'unknown'
}

// 反爬虫级别
export enum AntiBotLevel {
  NONE = 'NONE',
  BASIC = 'BASIC',
  ADVANCED = 'ADVANCED'
}

// 网站特征
export interface WebsiteFeatures {
  ajax?: boolean;
  infiniteScroll?: boolean;
  lazyLoad?: boolean;
  cdn?: CDNProvider | null;
  antiBot?: AntiBotLevel;
  requiresJavaScript?: boolean;
  hasFrames?: boolean;
  usesCookies?: boolean;
  requiresAuth?: boolean;
}

// 引擎成功率统计
export interface EngineSuccessRate {
  http: number;        // HTTP 引擎成功率
  webcontents: number; // WebContents 引擎成功率
}

// 网站画像
export interface WebsiteProfile {
  domain: string;
  type: WebsiteType;
  features: WebsiteFeatures;
  preferred: EngineType;
  fallbacks: EngineType[];

  // 历史数据
  successRate: EngineSuccessRate;
  lastUpdated: Date;
  sampleCount: number; // 样本数量

  // 性能数据
  averageLoadTime: number;
  averageSize: number;

  // 可靠性数据
  uptime: number; // 可用性百分比
  errorRate: number; // 错误率
}

// 策略条件
export interface StrategyConditions {
  urlPatterns: string[];
  domainPatterns: string[];
  contentTypes: string[];
  headers?: Record<string, string>;
  statusCodes?: number[];
}

// 抓取策略
export interface ScrapeStrategy {
  id: string;
  name: string;
  description?: string;
  engine: EngineType;
  options: ScrapeOptions;
  conditions: StrategyConditions;
  priority: number;

  // 策略元数据
  version: string;
  author?: string;
  tags?: string[];

  // 使用统计
  usageCount: number;
  successRate: number;
  lastUsed?: Date;

  // 策略状态
  enabled: boolean;
  deprecated?: boolean;
}

// 策略匹配结果
export interface StrategyMatch {
  strategy: ScrapeStrategy;
  confidence: number; // 匹配置信度 0-1
  reasons: string[];  // 匹配原因
}

// 策略选择选项
export interface StrategySelectionOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  userAgent?: string;

  // 强制选项
  forceEngine?: EngineType;
  forceStrategy?: string;

  // 过滤选项
  excludeEngines?: EngineType[];
  excludeStrategies?: string[];

  // 性能要求
  maxLoadTime?: number;
  preferFast?: boolean;
}

// 策略评估结果
export interface StrategyEvaluation {
  strategy: ScrapeStrategy;
  score: number;      // 综合评分 0-100
  factors: {
    compatibility: number;  // 兼容性评分
    performance: number;    // 性能评分
    reliability: number;    // 可靠性评分
    cost: number;          // 成本评分（资源消耗）
  };
  recommendation: 'RECOMMENDED' | 'ACCEPTABLE' | 'NOT_RECOMMENDED';
}

// 策略管理器配置
export interface StrategyManagerConfig {
  /**
   * 策略执行模式：
   * - auto：按需启用策略执行（默认）
   * - disabled：仅执行智能抓取流程
   * - external：使用外部策略执行器（如 Midscene）
   */
  mode?: StrategyMode;
  // 默认策略
  defaultStrategy?: string;
  defaultEngine?: EngineType;

  // 降级配置
  enableFallback: boolean;
  maxFallbackAttempts: number;
  fallbackDelay: number;

  // 学习配置
  enableLearning: boolean;
  minSamplesForLearning: number;
  learningRate: number;

  // 缓存配置
  profileCacheTTL: number;
  strategyCacheTTL: number;

  // 性能配置
  evaluationTimeout: number;
  maxConcurrentEvaluations: number;
}

// 策略更新事件
export interface StrategyUpdateEvent {
  type: 'STRATEGY_ADDED' | 'STRATEGY_UPDATED' | 'STRATEGY_REMOVED' | 'PROFILE_UPDATED';
  strategyId?: string;
  domain?: string;
  timestamp: Date;
  details?: Record<string, any>;
}

// 预定义策略模板
export interface StrategyTemplate {
  id: string;
  name: string;
  description: string;
  engine: EngineType;
  defaultOptions: Partial<ScrapeOptions>;
  conditions: Partial<StrategyConditions>;
  tags: string[];

  // 模板参数
  parameters?: {
    name: string;
    type: 'string' | 'number' | 'boolean' | 'array';
    description: string;
    default?: any;
    required?: boolean;
  }[];
}

// 策略性能指标
export interface StrategyMetrics {
  strategyId: string;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageResponseTime: number;
  averagePayloadSize: number;
  errorDistribution: Record<string, number>;

  // 时间范围
  periodStart: Date;
  periodEnd: Date;

  // 趋势数据
  trend: {
    successRate: number;    // 成功率趋势（正负百分比）
    responseTime: number;   // 响应时间趋势
    errorRate: number;      // 错误率趋势
  };
}
