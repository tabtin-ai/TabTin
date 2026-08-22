/**
 * Client Hints 服务 - 核心服务类
 *
 * 🎯 职责：提供统一的 Client Hints 生成、验证和管理接口
 * 🔧 功能：
 *   - 从 User-Agent 生成 Client Hints
 *   - 验证 Hints 一致性
 *   - 缓存和复用
 *   - 错误处理和降级
 *
 * @example
 * ```typescript
 * const service = new ClientHintsService();
 * const hints = service.generate(userAgent);
 * const isValid = service.validate(userAgent, hints);
 * ```
 */

import type {
  ClientHints,
  ClientHintsConfig,
  ParsedUserAgent,
  ValidationResult,
} from './types.js';
import { parseUserAgent } from './parsers.js';
import { generateClientHints, clientHintsToHeaders, mergeClientHintsHeaders } from './generators.js';
import { validateClientHints, quickValidate, autoFixClientHints } from './validators.js';
import { DEFAULT_CLIENT_HINTS_CONFIG } from './constants.js';

/**
 * Client Hints 服务
 */
export class ClientHintsService {
  /** 默认配置 */
  private defaultConfig: Required<ClientHintsConfig>;

  /** 缓存：UA 字符串 → Client Hints */
  private cache = new Map<string, ClientHints>();

  /** 最大缓存数量 */
  private readonly maxCacheSize = 1000;

  /** 是否启用缓存 */
  private cacheEnabled = true;

  /** 统计信息 */
  private stats = {
    totalGenerated: 0,
    cacheHits: 0,
    validationPassed: 0,
    validationFailed: 0,
    autoFixed: 0,
  };

  constructor(config?: Partial<ClientHintsConfig>) {
    this.defaultConfig = {
      ...DEFAULT_CLIENT_HINTS_CONFIG,
      ...config,
    } as Required<ClientHintsConfig>;
  }

  /**
   * 从 User-Agent 生成 Client Hints
   *
   * @param userAgent UA 字符串
   * @param config 可选的自定义配置
   * @returns Client Hints 对象
   *
   * @example
   * ```typescript
   * const hints = service.generate(
   *   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0"
   * );
   * // hints['Sec-CH-UA'] = '"Not A(Brand";v="8", "Chromium";v="122", "Google Chrome";v="122"'
   * ```
   */
  generate(userAgent: string, config?: Partial<ClientHintsConfig>): ClientHints {
    // 1. 检查缓存
    if (this.cacheEnabled) {
      const cached = this.cache.get(userAgent);
      if (cached) {
        this.stats.cacheHits++;
        return cached;
      }
    }

    // 2. 解析 UA
    const parsed = parseUserAgent(userAgent);

    // 3. 合并配置
    const finalConfig = { ...this.defaultConfig, ...config };

    // 4. 生成 Hints
    const hints = generateClientHints(parsed, finalConfig);

    // 5. 验证（开发模式）
    if (process.env.NODE_ENV === 'development') {
      const validation = validateClientHints(parsed, hints);
      if (!validation.valid) {
        console.warn('[ClientHints] 生成的 Hints 存在一致性问题:', validation.errors);
      }
    }

    // 6. 缓存
    if (this.cacheEnabled) {
      this._addToCache(userAgent, hints);
    }

    this.stats.totalGenerated++;
    return hints;
  }

  /**
   * 生成并直接转换为 HTTP Headers
   *
   * @param userAgent UA 字符串
   * @param config 可选配置
   * @returns HTTP Headers 对象
   */
  generateHeaders(
    userAgent: string,
    config?: Partial<ClientHintsConfig>
  ): Record<string, string> {
    const hints = this.generate(userAgent, config);
    return clientHintsToHeaders(hints);
  }

  /**
   * 将 Client Hints 合并到现有 Headers
   *
   * @param userAgent UA 字符串
   * @param existingHeaders 现有 Headers
   * @param overwrite 是否覆盖已存在的值
   * @param config 可选配置
   * @returns 合并后的 Headers
   */
  mergeToHeaders(
    userAgent: string,
    existingHeaders: Record<string, string>,
    overwrite: boolean = false,
    config?: Partial<ClientHintsConfig>
  ): Record<string, string> {
    const hints = this.generate(userAgent, config);
    return mergeClientHintsHeaders(existingHeaders, hints, overwrite);
  }

  /**
   * 验证 Client Hints 与 User-Agent 的一致性
   *
   * @param userAgent UA 字符串
   * @param hints Client Hints 对象
   * @returns 验证结果
   */
  validate(userAgent: string, hints: ClientHints): ValidationResult {
    const parsed = parseUserAgent(userAgent);
    const result = validateClientHints(parsed, hints);

    if (result.valid) {
      this.stats.validationPassed++;
    } else {
      this.stats.validationFailed++;
    }

    return result;
  }

  /**
   * 快速验证（只检查关键项）
   *
   * @param userAgent UA 字符串
   * @param hints Client Hints 对象
   * @returns 是否通过验证
   */
  quickValidate(userAgent: string, hints: ClientHints): boolean {
    const parsed = parseUserAgent(userAgent);
    return quickValidate(parsed, hints);
  }

  /**
   * 自动修复不一致的 Client Hints
   *
   * @param userAgent UA 字符串
   * @param hints 有问题的 Client Hints
   * @returns 修复后的 Client Hints
   */
  autoFix(userAgent: string, hints: ClientHints): ClientHints {
    const parsed = parseUserAgent(userAgent);
    const fixed = autoFixClientHints(parsed, hints);
    this.stats.autoFixed++;
    return fixed;
  }

  /**
   * 解析 User-Agent（暴露内部方法）
   *
   * @param userAgent UA 字符串
   * @returns 解析后的结构化信息
   */
  parse(userAgent: string): ParsedUserAgent {
    return parseUserAgent(userAgent);
  }

  /**
   * 批量生成（用于预热缓存）
   *
   * @param userAgents UA 字符串数组
   * @param config 可选配置
   * @returns 生成的 Hints 数组
   */
  batchGenerate(
    userAgents: string[],
    config?: Partial<ClientHintsConfig>
  ): ClientHints[] {
    return userAgents.map(ua => this.generate(ua, config));
  }

  /**
   * 清空缓存
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * 设置缓存开关
   */
  setCacheEnabled(enabled: boolean): void {
    this.cacheEnabled = enabled;
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      ...this.stats,
      cacheSize: this.cache.size,
      cacheHitRate: this.stats.totalGenerated > 0
        ? (this.stats.cacheHits / this.stats.totalGenerated * 100).toFixed(2) + '%'
        : '0%',
    };
  }

  /**
   * 重置统计信息
   */
  resetStats(): void {
    this.stats = {
      totalGenerated: 0,
      cacheHits: 0,
      validationPassed: 0,
      validationFailed: 0,
      autoFixed: 0,
    };
  }

  /**
   * 添加到缓存（LRU 策略）
   */
  private _addToCache(userAgent: string, hints: ClientHints): void {
    // 如果缓存已满，删除最早的条目
    if (this.cache.size >= this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(userAgent, hints);
  }

  /**
   * 导出配置（用于持久化）
   */
  exportConfig(): Required<ClientHintsConfig> {
    return { ...this.defaultConfig };
  }

  /**
   * 更新默认配置
   */
  updateConfig(config: Partial<ClientHintsConfig>): void {
    Object.assign(this.defaultConfig, config);
  }
}

/**
 * 单例实例（全局共享）
 */
let sharedInstance: ClientHintsService | null = null;

/**
 * 获取共享的 ClientHintsService 实例
 *
 * @param config 可选的初始化配置（仅首次调用有效）
 * @returns ClientHintsService 实例
 */
export function getClientHintsService(config?: Partial<ClientHintsConfig>): ClientHintsService {
  if (!sharedInstance) {
    sharedInstance = new ClientHintsService(config);
  }
  return sharedInstance;
}

/**
 * 重置共享实例（主要用于测试）
 */
export function resetClientHintsService(): void {
  sharedInstance = null;
}

/**
 * 便捷函数：直接生成 Client Hints Headers
 *
 * @param userAgent UA 字符串
 * @param config 可选配置
 * @returns HTTP Headers 对象
 */
export function generateClientHintsHeaders(
  userAgent: string,
  config?: Partial<ClientHintsConfig>
): Record<string, string> {
  const service = getClientHintsService();
  return service.generateHeaders(userAgent, config);
}

