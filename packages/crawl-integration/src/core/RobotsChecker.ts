/**
 * Robots.txt 检查器
 * 提供详细的 robots.txt 解析和合规检查
 */
import { getDefaultUserAgent } from '../config/default.js';
import { t } from '../i18n.js';
import { checkURLSecurity } from '../utils/url.js';

export interface RobotsRule {
  userAgent: string;
  directive: 'Allow' | 'Disallow';
  path: string;
  lineNumber: number;
}

export interface RobotsResult {
  allowed: boolean;
  source: string | null;             // robots.txt URL，null 表示没有 robots.txt
  userAgent: string;                 // 匹配的 User-Agent
  rule: string;                      // 匹配的规则
  crawlDelay?: number;               // 建议的抓取延迟（秒）
  sitemaps?: string[];               // 站点地图 URL

  // 详细信息
  details: {
    robotsContent?: string;          // robots.txt 原始内容
    matchedRules: RobotsRule[];      // 所有匹配的规则
    parseErrors?: string[];          // 解析错误
    fetchError?: string;             // 获取 robots.txt 时的错误
    lastModified?: Date;             // robots.txt 最后修改时间
    cacheExpiry?: Date;              // 缓存过期时间
  };
}

export interface RobotsCheckOptions {
  userAgent: string;
  respectRobots?: 'obey' | 'ignore' | 'dryrun';  // 默认 'obey'
  timeout?: number;                               // 获取 robots.txt 的超时时间
  cache?: boolean;                               // 是否缓存 robots.txt
  cacheTtl?: number;                             // 缓存生存时间（秒）
}

export class RobotsChecker {
  private static robotsCache = new Map<string, { content: string; expiry: Date; lastModified?: Date }>();

  /**
   * 检查 URL 是否被 robots.txt 允许
   */
  static async checkUrl(url: string, options: RobotsCheckOptions): Promise<RobotsResult> {
    const { userAgent, respectRobots = 'obey', timeout = 5000 } = options;

    // 如果设置为忽略 robots.txt
    if (respectRobots === 'ignore') {
      return {
        allowed: true,
        source: 'N/A (ignored)',
        userAgent,
        rule: 'robots.txt ignored by configuration',
        details: {
          matchedRules: []
        }
      };
    }

    try {
      const robotsUrl = this.getRobotsUrl(url);
      const robotsContent = await this.fetchRobots(robotsUrl, timeout, options.cache, options.cacheTtl);

      if (!robotsContent) {
        // 没有 robots.txt 文件，默认允许
        return {
          allowed: true,
          source: null,
          userAgent,
          rule: 'no robots.txt (default allow)',
          details: {
            matchedRules: [],
            fetchError: 'robots.txt not found'
          }
        };
      }

      const parseResult = this.parseRobots(robotsContent.content);
      const checkResult = this.checkUrlAgainstRules(url, userAgent, parseResult.rules);

      return {
        allowed: respectRobots === 'dryrun' ? true : checkResult.allowed,
        source: robotsUrl,
        userAgent: checkResult.matchedUserAgent || userAgent,
        rule: checkResult.rule,
        crawlDelay: checkResult.crawlDelay,
        sitemaps: parseResult.sitemaps,
        details: {
          robotsContent: robotsContent.content,
          matchedRules: checkResult.matchedRules,
          parseErrors: parseResult.errors,
          lastModified: robotsContent.lastModified,
          cacheExpiry: robotsContent.expiry
        }
      };

    } catch (error) {
      return {
        allowed: true, // 获取失败时默认允许
        source: this.getRobotsUrl(url),
        userAgent,
        rule: 'robots.txt fetch failed (default allow)',
        details: {
          matchedRules: [],
          fetchError: error instanceof Error ? error.message : 'Unknown error'
        }
      };
    }
  }

  /**
   * 获取 robots.txt URL
   */
  private static getRobotsUrl(url: string): string {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}/robots.txt`;
    } catch {
      throw new Error(t('errors.robots.invalidUrl'));
    }
  }

  /**
   * 获取 robots.txt 内容
   */
  private static async fetchRobots(
    robotsUrl: string,
    timeout: number,
    useCache = true,
    cacheTtl = 3600
  ): Promise<{ content: string; expiry: Date; lastModified?: Date } | null> {
    // 检查缓存
    if (useCache && this.robotsCache.has(robotsUrl)) {
      const cached = this.robotsCache.get(robotsUrl)!;
      if (cached.expiry > new Date()) {
        return cached;
      }
      this.robotsCache.delete(robotsUrl);
    }

    try {
      // SSRF 防护：在发出请求前检查 URL 安全性（拒绝内网/回环地址）
      const securityCheck = checkURLSecurity(robotsUrl);
      if (securityCheck.blocked) {
        throw new Error(`robots.txt fetch blocked by SSRF protection: ${securityCheck.reason || securityCheck.risks.join(', ')}`);
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(robotsUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': getDefaultUserAgent()
        }
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        if (response.status === 404) {
          return null; // robots.txt 不存在
        }
        throw new Error(t('errors.http.generic', { status: response.status, statusText: response.statusText }));
      }

      const content = await response.text();
      const lastModified = response.headers.get('last-modified')
        ? new Date(response.headers.get('last-modified')!)
        : undefined;

      const result = {
        content,
        expiry: new Date(Date.now() + cacheTtl * 1000),
        lastModified
      };

      // 缓存结果
      if (useCache) {
        this.robotsCache.set(robotsUrl, result);
      }

      return result;

    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(t('errors.robots.fetchTimeout'));
      }
      throw error;
    }
  }

  /**
   * 解析 robots.txt 内容
   */
  private static parseRobots(content: string): {
    rules: RobotsRule[];
    sitemaps: string[];
    crawlDelays: Map<string, number>;
    errors: string[];
  } {
    const rules: RobotsRule[] = [];
    const sitemaps: string[] = [];
    const crawlDelays = new Map<string, number>();
    const errors: string[] = [];

    const lines = content.split('\n');
    let currentUserAgent = '*';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const lineNumber = i + 1;

      // 跳过空行和注释
      if (!line || line.startsWith('#')) {
        continue;
      }

      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) {
        errors.push(`Line ${lineNumber}: Invalid format (missing colon)`);
        continue;
      }

      const directive = line.substring(0, colonIndex).trim().toLowerCase();
      const value = line.substring(colonIndex + 1).trim();

      switch (directive) {
        case 'user-agent':
          currentUserAgent = value;
          break;

        case 'allow':
          rules.push({
            userAgent: currentUserAgent,
            directive: 'Allow',
            path: value,
            lineNumber
          });
          break;

        case 'disallow':
          rules.push({
            userAgent: currentUserAgent,
            directive: 'Disallow',
            path: value,
            lineNumber
          });
          break;

        case 'crawl-delay':
          const delay = parseInt(value, 10);
          if (!isNaN(delay)) {
            crawlDelays.set(currentUserAgent, delay);
          } else {
            errors.push(`Line ${lineNumber}: Invalid crawl-delay value`);
          }
          break;

        case 'sitemap':
          if (this.isValidUrl(value)) {
            sitemaps.push(value);
          } else {
            errors.push(`Line ${lineNumber}: Invalid sitemap URL`);
          }
          break;

        default:
          // 忽略未知指令
          break;
      }
    }

    return { rules, sitemaps, crawlDelays, errors };
  }

  /**
   * 检查 URL 是否符合 robots.txt 规则
   */
  private static checkUrlAgainstRules(
    url: string,
    userAgent: string,
    rules: RobotsRule[]
  ): {
    allowed: boolean;
    rule: string;
    matchedUserAgent?: string;
    matchedRules: RobotsRule[];
    crawlDelay?: number;
  } {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname + parsed.search;

      // 按优先级排序：具体的 User-Agent > 通配符
      const sortedRules = rules.sort((a, b) => {
        if (a.userAgent === userAgent && b.userAgent !== userAgent) return -1;
        if (a.userAgent !== userAgent && b.userAgent === userAgent) return 1;
        if (a.userAgent === '*' && b.userAgent !== '*') return 1;
        if (a.userAgent !== '*' && b.userAgent === '*') return -1;
        return 0;
      });

      const matchedRules: RobotsRule[] = [];
      let finalDecision: 'allow' | 'disallow' | null = null;
      let matchedUserAgent: string | undefined;

      for (const rule of sortedRules) {
        // 检查 User-Agent 匹配
        if (!this.matchUserAgent(userAgent, rule.userAgent)) {
          continue;
        }

        // 检查路径匹配
        if (this.matchPath(path, rule.path)) {
          matchedRules.push(rule);

          // 第一个匹配的规则决定结果
          if (finalDecision === null) {
            finalDecision = rule.directive === 'Allow' ? 'allow' : 'disallow';
            matchedUserAgent = rule.userAgent;
          }
        }
      }

      // 如果没有匹配的规则，默认允许
      const allowed = finalDecision !== 'disallow';
      const rule = finalDecision === null
        ? 'no matching rules (default allow)'
        : `${finalDecision} ${matchedRules[0]?.path || ''}`;

      return {
        allowed,
        rule,
        matchedUserAgent,
        matchedRules
      };

    } catch {
      return {
        allowed: true,
        rule: 'URL parsing failed (default allow)',
        matchedRules: []
      };
    }
  }

  /**
   * 检查 User-Agent 是否匹配
   */
  private static matchUserAgent(actual: string, pattern: string): boolean {
    if (pattern === '*') return true;

    // 简单的子字符串匹配（不区分大小写）
    return actual.toLowerCase().includes(pattern.toLowerCase());
  }

  /**
   * 检查路径是否匹配 robots.txt 规则
   */
  private static matchPath(path: string, pattern: string): boolean {
    if (pattern === '') return true;
    if (pattern === '/') return true;

    // 处理通配符
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      return path.startsWith(prefix);
    }

    // 精确匹配或前缀匹配
    return path === pattern || path.startsWith(pattern);
  }

  /**
   * 验证 URL 是否有效
   */
  private static isValidUrl(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 清除缓存
   */
  static clearCache(): void {
    this.robotsCache.clear();
  }

  /**
   * 获取缓存统计
   */
  static getCacheStats(): {
    size: number;
    entries: Array<{ url: string; expiry: Date; lastModified?: Date }>;
  } {
    const entries = Array.from(this.robotsCache.entries()).map(([url, data]) => ({
      url,
      expiry: data.expiry,
      lastModified: data.lastModified
    }));

    return {
      size: this.robotsCache.size,
      entries
    };
  }

  /**
   * 预加载常见网站的 robots.txt
   */
  static async preloadRobots(urls: string[], options: RobotsCheckOptions): Promise<void> {
    const robotsUrls = [...new Set(urls.map(url => this.getRobotsUrl(url)))];

    const promises = robotsUrls.map(async (robotsUrl) => {
      try {
        await this.fetchRobots(robotsUrl, options.timeout || 5000, true, options.cacheTtl);
      } catch {
        // 忽略预加载失败
      }
    });

    await Promise.allSettled(promises);
  }
}
