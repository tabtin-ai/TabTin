/**
 * 默认配置定义
 * 提供 crawl 模块的默认配置值
 */

import type {
  CommonScrapeOptions,
  EngineType,
  TaskPriority,
  NetworkCaptureLevel
} from '../types/options.js';
import type { StrategyManagerConfig, StrategyMode } from '../types/strategy.js';
import { DEFAULT_LIMITS } from '../types/access-result.js';
import { LogLevel } from '../logger/CrawlLogger.js';
import { getSystemUserAgent } from '../utils/system-ua.js';

// 默认抓取选项
export const DEFAULT_SCRAPE_OPTIONS: Required<CommonScrapeOptions> = {
  // 基础配置
  timeout: 30000,           // 30秒超时
  retries: 3,               // 最多重试3次
  userAgent: getDefaultUserAgent(),
  headers: {},

  // 网络监控（full 模式包含完整的请求和响应体）
  networkCapture: 'full' as NetworkCaptureLevel,

  // 隐私脱敏
  privacyMask: [
    'authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'x-auth-token',
    'bearer'
  ],

  // 原始数据保留
  keepRawBody: false,

  // 缓存配置
  cache: {
    enabled: true,
    allowSensitive: false,    // 默认不缓存敏感信息
    ttl: 3600000             // 1小时缓存时间
  },

  // 安全配置
  security: {
    ssrf: 'block',           // 默认阻止 SSRF
    robots: 'obey'           // 默认遵守 robots.txt
  },

  // 大小限制
  limits: {
    mainPayload: DEFAULT_LIMITS.MAIN_PAYLOAD_MAX,
    samplePayload: DEFAULT_LIMITS.SAMPLE_PAYLOAD_MAX,
    networkSamples: DEFAULT_LIMITS.NETWORK_SAMPLES_MAX
  }
};

/**
 * 获取默认 User-Agent
 * 优先使用系统 UA，如果无法获取则使用固定的默认值
 */
export function getDefaultUserAgent(): string {
  try {
    return getSystemUserAgent();
  } catch (error) {
    // 如果系统检测失败，使用固定默认值
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  }
}

// 默认引擎配置
export const DEFAULT_ENGINE_CONFIG = {
  // HTTP 引擎配置
  http: {
    maxConcurrency: 50,
    timeout: 30000,
    retries: 3,
    followRedirects: true,
    maxRedirects: 10,
    keepAlive: true,
    keepAliveMsecs: 1000
  }
};

// 默认策略管理器配置
export const DEFAULT_STRATEGY_CONFIG: StrategyManagerConfig = {
  mode: 'auto' as StrategyMode,
  // 默认策略
  defaultEngine: 'http' as EngineType,

  // 降级配置
  enableFallback: true,
  maxFallbackAttempts: 2,
  fallbackDelay: 1000,

  // 学习配置
  enableLearning: true,
  minSamplesForLearning: 10,
  learningRate: 0.1,

  // 缓存配置
  profileCacheTTL: 86400000,    // 24小时
  strategyCacheTTL: 3600000,    // 1小时

  // 性能配置
  evaluationTimeout: 5000,
  maxConcurrentEvaluations: 5
};

// 默认任务队列配置
export const DEFAULT_QUEUE_CONFIG = {
  // 内存队列配置
  memory: {
    maxSize: 1000,
    defaultPriority: 'NORMAL' as TaskPriority,
    maxConcurrency: 5,
    processingTimeout: 300000,  // 5分钟
    cleanupInterval: 60000      // 1分钟清理间隔
  },

  // 持久化队列配置
  persistent: {
    dbPath: './crawl-tasks.db',
    maxSize: 10000,
    batchSize: 100,
    syncInterval: 5000,         // 5秒同步间隔
    retentionDays: 7            // 保留7天的历史记录
  }
};

// 默认缓存配置
export const DEFAULT_CACHE_CONFIG = {
  // 文件系统缓存
  filesystem: {
    cacheDir: './cache',
    maxSize: 1024 * 1024 * 1024,  // 1GB
    cleanupInterval: 3600000,      // 1小时清理间隔
    compressionEnabled: true,
    compressionLevel: 6
  },

  // SQLite 元信息缓存
  sqlite: {
    dbPath: './cache-meta.db',
    maxEntries: 100000,
    cleanupInterval: 3600000,
    vacuumInterval: 86400000    // 24小时执行一次 VACUUM
  }
};

// 默认安全配置
export const DEFAULT_SECURITY_CONFIG = {
  // SSRF 防护
  ssrf: {
    enabled: true,
    allowedHosts: [] as string[],
    blockedNetworks: [
      '127.0.0.0/8',    // 环回地址
      '10.0.0.0/8',     // 私网 A 类
      '172.16.0.0/12',  // 私网 B 类
      '192.168.0.0/16', // 私网 C 类
      '169.254.0.0/16', // 链路本地
      'fc00::/7',       // IPv6 私网
      '::1/128'         // IPv6 环回
    ]
  },

  // Robots.txt 检查
  robots: {
    enabled: true,
    cacheTimeout: 3600000,      // 1小时缓存
    userAgent: '*',
    respectCrawlDelay: true,
    maxCrawlDelay: 10000        // 最大延迟10秒
  },

  // 隐私脱敏
  privacy: {
    enabled: true,
    sensitiveFields: [
      'authorization',
      'cookie',
      'set-cookie',
      'x-api-key',
      'x-auth-token',
      'bearer',
      'session',
      'csrf-token'
    ],
    maskingPattern: '****'
  }
};

// 默认日志配置
export const DEFAULT_LOG_CONFIG = {
  level: LogLevel.INFO,
  enableTracing: true,
  enableContext: true,
  maxContextSize: 1000,

  // 输出配置
  outputs: {
    console: {
      enabled: true,
      formatter: 'colored',
      level: LogLevel.INFO
    },
    file: {
      enabled: false,
      filePath: './logs/crawl.log',
      formatter: 'json',
      level: LogLevel.DEBUG,
      maxSize: 10 * 1024 * 1024,  // 10MB
      maxFiles: 5
    }
  }
};

// 默认性能配置
export const DEFAULT_PERFORMANCE_CONFIG = {
  // 内存管理
  memory: {
    maxHeapSize: 512 * 1024 * 1024,  // 512MB
    gcInterval: 60000,                // 1分钟检查一次
    warningThreshold: 0.8,            // 80% 内存使用率警告
    criticalThreshold: 0.95           // 95% 内存使用率严重警告
  },

  // 并发控制
  concurrency: {
    maxGlobalConcurrency: 20,
    maxPerDomainConcurrency: 3,
    requestInterval: 100,             // 请求间隔100ms
    burstLimit: 10                    // 突发请求限制
  },

  // 监控配置
  monitoring: {
    enabled: true,
    metricsInterval: 30000,           // 30秒收集一次指标
    historyRetention: 3600000,        // 保留1小时的历史数据
    alertThresholds: {
      errorRate: 0.1,                 // 10% 错误率
      avgResponseTime: 10000,         // 10秒平均响应时间
      memoryUsage: 0.9                // 90% 内存使用率
    }
  }
};

// 主配置对象
export const DEFAULT_CONFIG = {
  // 基础配置
  version: '1.0.0',
  environment: 'development',

  // 模块配置
  scrape: DEFAULT_SCRAPE_OPTIONS,
  engines: DEFAULT_ENGINE_CONFIG,
  strategy: DEFAULT_STRATEGY_CONFIG,
  queue: DEFAULT_QUEUE_CONFIG,
  cache: DEFAULT_CACHE_CONFIG,
  security: DEFAULT_SECURITY_CONFIG,
  logging: DEFAULT_LOG_CONFIG,
  performance: DEFAULT_PERFORMANCE_CONFIG
};

// 配置类型定义
export type CrawlConfig = typeof DEFAULT_CONFIG;

// 环境特定配置
export const ENVIRONMENT_CONFIGS = {
  development: {
    logging: {
      level: LogLevel.DEBUG,
      outputs: {
        console: { enabled: true, level: LogLevel.DEBUG },
        file: { enabled: true, level: LogLevel.DEBUG }
      }
    },
    performance: {
      monitoring: { enabled: true }
    }
  },

  production: {
    logging: {
      level: LogLevel.INFO,
      outputs: {
        console: { enabled: false },
        file: { enabled: true, level: LogLevel.WARN }
      }
    },
    performance: {
      monitoring: { enabled: true },
      memory: { warningThreshold: 0.7, criticalThreshold: 0.9 }
    }
  },

  test: {
    logging: {
      level: LogLevel.WARN,
      outputs: {
        console: { enabled: false },
        file: { enabled: false }
      }
    },
    cache: {
      filesystem: { cacheDir: './test-cache' },
      sqlite: { dbPath: './test-cache-meta.db' }
    },
    queue: {
      persistent: { dbPath: './test-tasks.db' }
    }
  }
};
