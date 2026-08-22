/**
 * 缓存键生成器
 * 实现 SHA256 规范化缓存键，提高缓存命中率
 */

import crypto from 'crypto';

export interface CacheKeyOptions {
  url: string;
  method: string;
  body?: string | Buffer;
  engine: string;
  userAgent: string;
  proxy?: {
    host: string;
    port: number;
    protocol?: string;
  };
  headers?: Record<string, string>;
  viewport?: { width: number; height: number };
  timezone?: string;

  // 渲染策略影响缓存键
  renderHints?: {
    waitFor?: 'networkidle' | 'domcontentloaded' | 'selector';
    selector?: string;
    timeout?: number;
  };

  // 策略配置
  strategy?: {
    id: string;
    version?: string;
    options?: Record<string, any>;
  };
}

export interface CacheOptions {
  allowSensitive?: boolean;      // 是否允许缓存敏感信息
  ttl?: number;                  // 缓存生存时间（秒）
  respectCacheHeaders?: boolean; // 是否遵守 HTTP 缓存头
}

export class CacheKeyGenerator {
  // 敏感头部白名单（这些头部会影响缓存键）
  private static readonly CACHE_RELEVANT_HEADERS = new Set([
    'accept',
    'accept-language',
    'accept-encoding',
    'content-type',
    'referer',
    'origin'
  ]);

  // 敏感头部（包含这些头部的请求默认不缓存）
  private static readonly SENSITIVE_HEADERS = new Set([
    'authorization',
    'cookie',
    'x-api-key',
    'x-auth-token',
    'bearer',
    'session-id',
    'csrf-token'
  ]);


  /**
   * 生成规范化的缓存键
   */
  static generateKey(options: CacheKeyOptions): string {
    const keyData = {
      // 核心请求信息
      url: this.normalizeUrl(options.url),
      method: options.method.toUpperCase(),
      bodyHash: options.body ? this.hashContent(options.body) : null,

      // 引擎和策略
      engine: options.engine,
      strategyHash: options.strategy ? this.hashObject(options.strategy) : null,

      // 用户代理（只保留主要标识，忽略版本号）
      userAgentTag: this.normalizeUserAgent(options.userAgent),

      // 代理（只保留主机，忽略端口等细节）
      proxyTag: options.proxy ? this.hashString(options.proxy.host) : null,

      // 相关头部（白名单过滤）
      relevantHeaders: this.extractRelevantHeaders(options.headers || {}),

      // 浏览器环境
      viewport: options.viewport,
      timezone: options.timezone,

      // 渲染策略
      renderHints: options.renderHints ? {
        waitFor: options.renderHints.waitFor,
        selector: options.renderHints.selector,
        timeout: options.renderHints.timeout
      } : null
    };

    // 移除 null/undefined 值
    const cleanedKeyData = this.removeNullValues(keyData);

    // 生成 SHA256 哈希
    return crypto.createHash('sha256')
      .update(JSON.stringify(cleanedKeyData))
      .digest('hex');
  }

  /**
   * 检查请求是否可缓存
   */
  static isCacheable(options: CacheKeyOptions, cacheOptions: CacheOptions = {}): boolean {
    // 检查 HTTP 方法
    if (!['GET', 'HEAD'].includes(options.method.toUpperCase())) {
      return false;
    }

    // 检查敏感头部
    if (!cacheOptions.allowSensitive) {
      const hasSensitiveHeaders = this.hasSensitiveHeaders(options.headers || {});
      if (hasSensitiveHeaders) {
        return false;
      }
    }

    // 检查 URL 模式（避免缓存明显的动态内容）
    if (this.isDynamicUrl(options.url)) {
      return false;
    }

    return true;
  }

  /**
   * 规范化 URL（移除查询参数中的时间戳等噪声）
   */
  private static normalizeUrl(url: string): string {
    try {
      const parsed = new URL(url);

      // 移除常见的时间戳和随机参数
      const noisyParams = ['_', 't', 'timestamp', 'rand', 'random', 'cache_bust', 'cb'];
      noisyParams.forEach(param => {
        parsed.searchParams.delete(param);
      });

      // 对查询参数排序
      parsed.searchParams.sort();

      return parsed.toString();
    } catch {
      return url;
    }
  }

  /**
   * 规范化 User-Agent（提取主要标识，忽略版本号）
   */
  private static normalizeUserAgent(userAgent: string): string {
    // 提取主要浏览器标识
    const patterns = [
      /Chrome\/[\d.]+/,
      /Firefox\/[\d.]+/,
      /Safari\/[\d.]+/,
      /Edge\/[\d.]+/,
      /Opera\/[\d.]+/
    ];

    for (const pattern of patterns) {
      const match = userAgent.match(pattern);
      if (match) {
        // 只保留浏览器名称，忽略版本号
        return match[0].split('/')[0];
      }
    }

    // 如果没有匹配到标准浏览器，返回哈希
    return this.hashString(userAgent).substring(0, 8);
  }

  /**
   * 提取缓存相关的头部
   */
  private static extractRelevantHeaders(headers: Record<string, string>): Record<string, string> {
    const relevant: Record<string, string> = {};

    for (const [key, value] of Object.entries(headers)) {
      const lowerKey = key.toLowerCase();
      if (this.CACHE_RELEVANT_HEADERS.has(lowerKey)) {
        relevant[lowerKey] = value;
      }
    }

    return relevant;
  }

  /**
   * 检查是否包含敏感头部
   */
  private static hasSensitiveHeaders(headers: Record<string, string>): boolean {
    for (const key of Object.keys(headers)) {
      if (this.SENSITIVE_HEADERS.has(key.toLowerCase())) {
        return true;
      }
    }
    return false;
  }

  /**
   * 检查是否为动态 URL
   */
  private static isDynamicUrl(url: string): boolean {
    const dynamicPatterns = [
      /\/api\/.*\/\d+$/,        // API 端点带 ID
      /\?.*time/i,              // 包含时间参数
      /\?.*session/i,           // 包含会话参数
      /\/search\?/i,            // 搜索页面
      /\/login/i,               // 登录页面
      /\/logout/i,              // 登出页面
      /\/admin/i,               // 管理页面
      /\/dashboard/i            // 仪表板
    ];

    return dynamicPatterns.some(pattern => pattern.test(url));
  }

  /**
   * 计算内容哈希
   */
  private static hashContent(content: string | Buffer): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * 计算字符串哈希
   */
  private static hashString(str: string): string {
    return crypto.createHash('sha256').update(str).digest('hex');
  }

  /**
   * 计算对象哈希
   */
  private static hashObject(obj: any): string {
    return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
  }

  /**
   * 移除对象中的 null/undefined 值
   */
  private static removeNullValues(obj: any): any {
    if (Array.isArray(obj)) {
      return obj.map(item => this.removeNullValues(item)).filter(item => item !== null && item !== undefined);
    }

    if (typeof obj === 'object' && obj !== null) {
      const cleaned: any = {};
      for (const [key, value] of Object.entries(obj)) {
        if (value !== null && value !== undefined) {
          cleaned[key] = this.removeNullValues(value);
        }
      }
      return cleaned;
    }

    return obj;
  }

  /**
   * 生成缓存键的调试信息
   */
  static generateDebugInfo(options: CacheKeyOptions): {
    cacheKey: string;
    keyComponents: Record<string, any>;
    isCacheable: boolean;
    reasons?: string[];
  } {
    const keyComponents = {
      url: this.normalizeUrl(options.url),
      method: options.method.toUpperCase(),
      bodyHash: options.body ? this.hashContent(options.body) : null,
      engine: options.engine,
      userAgentTag: this.normalizeUserAgent(options.userAgent),
      proxyTag: options.proxy ? this.hashString(options.proxy.host) : null,
      relevantHeaders: this.extractRelevantHeaders(options.headers || {}),
      viewport: options.viewport,
      timezone: options.timezone,
      renderHints: options.renderHints
    };

    const cacheKey = this.generateKey(options);
    const isCacheable = this.isCacheable(options);

    const reasons: string[] = [];
    if (!isCacheable) {
      if (!['GET', 'HEAD'].includes(options.method.toUpperCase())) {
        reasons.push(`HTTP method ${options.method} is not cacheable`);
      }
      if (this.hasSensitiveHeaders(options.headers || {})) {
        reasons.push('Contains sensitive headers');
      }
      if (this.isDynamicUrl(options.url)) {
        reasons.push('URL appears to be dynamic');
      }
    }

    return {
      cacheKey,
      keyComponents: this.removeNullValues(keyComponents),
      isCacheable,
      reasons: reasons.length > 0 ? reasons : undefined
    };
  }
}
