/**
 * Cookie 管理服务
 *
 * 统一管理所有 Cookie 相关操作，支持 Puppeteer Page 和 Electron WebContents
 *
 * @example
 * ```typescript
 * const cookieManager = CookieManager.getInstance();
 *
 * // 获取 cookies
 * const cookies = await cookieManager.getCookies(page);
 *
 * // 设置 cookies
 * await cookieManager.setCookies(page, cookies);
 *
 * // 导出 cookies
 * const json = await cookieManager.exportCookies(page);
 * ```
 *
 * @author TabTin Team
 * @date 2025-11-21
 */

import type { Page } from 'puppeteer-core';
import type { WebContents, Cookie as ElectronCookie } from 'electron';
import type { Cookie, CookieFilter, CookieExportFormat } from '../types/cookies';
import { createLogger } from '../logger';

const log = createLogger('CookieManager');

/**
 * Cookie 来源类型
 *
 * : Electron 侧从 WebContentsView 收窄为 WebContents（内部只用 session）。
 */
type CookieSource = Page | WebContents;

/**
 * Cookie 管理器配置
 */
export interface CookieManagerConfig {
  /** 是否启用 Cookie 缓存 */
  enableCache?: boolean;
  /** 缓存过期时间（毫秒） */
  cacheExpiry?: number;
  /** 是否启用详细日志 */
  verbose?: boolean;
}

/**
 * Cookie 管理器（单例）
 */
export class CookieManager {
  private static instance: CookieManager;
  private config: Required<CookieManagerConfig>;
  private cookieCache = new Map<string, { cookies: Cookie[]; timestamp: number }>();

  private constructor(config?: CookieManagerConfig) {
    this.config = {
      enableCache: config?.enableCache ?? false,
      cacheExpiry: config?.cacheExpiry ?? 60000, // 60 秒
      verbose: config?.verbose ?? false
    };

    this.log('[CookieManager] 初始化完成', this.config);
  }

  /**
   * 获取单例实例
   */
  static getInstance(config?: CookieManagerConfig): CookieManager {
    if (!CookieManager.instance) {
      CookieManager.instance = new CookieManager(config);
    }
    return CookieManager.instance;
  }

  /**
   * 获取 Cookies
   *
   * @param source Cookie 来源（Puppeteer Page 或 Electron WebContents）
   * @param url 可选的 URL 过滤（默认获取所有）
   * @returns Cookie 数组
   *
   * @example
   * ```typescript
   * // 获取所有 cookies
   * const allCookies = await cookieManager.getCookies(page);
   *
   * // 获取特定 URL 的 cookies
   * const siteCookies = await cookieManager.getCookies(page, 'https://example.com');
   * ```
   */
  async getCookies(source: CookieSource, url?: string): Promise<Cookie[]> {
    try {
      const cacheKey = this.getCacheKey(source, url);

      // 检查缓存
      if (this.config.enableCache) {
        const cached = this.cookieCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < this.config.cacheExpiry) {
          this.log('[CookieManager] 从缓存返回 cookies', cached.cookies.length);
          return cached.cookies;
        }
      }

      let cookies: Cookie[];

      if (this.isPuppeteerPage(source)) {
        // Puppeteer 路径
        cookies = url ? await source.cookies(url) : await source.cookies();
        this.log('[CookieManager] 从 Puppeteer Page 获取 cookies', cookies.length);
      } else {
        // Electron WebContents 路径
        const session = source.session;
        const filter = url ? { url } : {};
        const electronCookies = await session.cookies.get(filter);
        cookies = this.convertElectronCookiesToPuppeteer(electronCookies);
        this.log('[CookieManager] 从 Electron Session 获取 cookies', cookies.length);
      }

      // 更新缓存
      if (this.config.enableCache) {
        this.cookieCache.set(cacheKey, { cookies, timestamp: Date.now() });
      }

      return cookies;
    } catch (error) {
      log.error('❌ 获取 Cookies 失败:', error);
      return [];
    }
  }

  /**
   * 设置 Cookies
   *
   * @param source Cookie 来源
   * @param cookies 要设置的 cookies
   *
   * @example
   * ```typescript
   * await cookieManager.setCookies(page, [
   *   {
   *     name: 'session_id',
   *     value: 'abc123',
   *     domain: '.example.com',
   *     path: '/',
   *     secure: true,
   *     httpOnly: true
   *   }
   * ]);
   * ```
   */
  async setCookies(source: CookieSource, cookies: Cookie[]): Promise<void> {
    try {
      if (this.isPuppeteerPage(source)) {
        // Puppeteer 路径
        await source.setCookie(...cookies);
        this.log('[CookieManager] ✅ 通过 Puppeteer 设置 cookies', cookies.length);
      } else {
        // Electron WebContents 路径
        const session = source.session;
        for (const cookie of cookies) {
          const cookieUrl = this.buildCookieUrl(cookie);
          if (!cookieUrl) {
            log.warn('⚠️ 跳过无效 cookie（缺少 domain）:', cookie.name);
            continue;
          }
          let sameSite: 'no_restriction' | 'lax' | 'strict' | undefined;
          if (cookie.sameSite) {
            const raw = String(cookie.sameSite).toLowerCase();
            if (raw === 'none' || raw === 'no_restriction') sameSite = 'no_restriction';
            else if (raw === 'strict') sameSite = 'strict';
            else sameSite = 'lax';
          }
          const secure = sameSite === 'no_restriction' ? true : cookie.secure;

          await session.cookies.set({
            url: cookieUrl,
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            secure,
            httpOnly: cookie.httpOnly,
            expirationDate: cookie.expires,
            ...(sameSite ? { sameSite } : {}),
          });
        }
        this.log('[CookieManager] ✅ 通过 Electron Session 设置 cookies', cookies.length);
      }

      // 清除缓存
      this.clearCache();
    } catch (error) {
      log.error('❌ 设置 Cookies 失败:', error);
      throw error;
    }
  }

  /**
   * 清除 Cookies
   *
   * @param source Cookie 来源
   * @param filter 可选的过滤条件
   *
   * @example
   * ```typescript
   * // 清除所有 cookies
   * await cookieManager.clearCookies(page);
   *
   * // 清除特定域名的 cookies
   * await cookieManager.clearCookies(page, { domain: '.example.com' });
   * ```
   */
  async clearCookies(source: CookieSource, filter?: CookieFilter): Promise<void> {
    try {
      if (this.isPuppeteerPage(source)) {
        // Puppeteer 路径
        const cookies = filter?.url ? await source.cookies(filter.url) : await source.cookies();
        for (const cookie of cookies) {
          if (this.matchesCookieFilter(cookie, filter)) {
            await source.deleteCookie(cookie);
          }
        }
        this.log('[CookieManager] ✅ 通过 Puppeteer 清除 cookies');
      } else {
        // Electron WebContents 路径
        const session = source.session;
        const electronFilter = filter ? { url: filter.url, domain: filter.domain, name: filter.name } : {};
        const cookies = await session.cookies.get(electronFilter);
        for (const cookie of cookies) {
          const cookieUrl = this.buildCookieUrl(cookie);
          if (cookieUrl) {
            await session.cookies.remove(cookieUrl, cookie.name);
          }
        }
        this.log('[CookieManager] ✅ 通过 Electron Session 清除 cookies');
      }

      // 清除缓存
      this.clearCache();
    } catch (error) {
      log.error('❌ 清除 Cookies 失败:', error);
      throw error;
    }
  }

  /**
   * 导出 Cookies（JSON 格式）
   *
   * @param source Cookie 来源
   * @returns JSON 字符串
   *
   * @example
   * ```typescript
   * const json = await cookieManager.exportCookies(page);
   * fs.writeFileSync('cookies.json', json);
   * ```
   */
  async exportCookies(source: CookieSource): Promise<string> {
    try {
      const cookies = await this.getCookies(source);
      const format: CookieExportFormat = {
        version: '1.0',
        cookies,
        exportedAt: new Date().toISOString(),
        source: this.isPuppeteerPage(source) ? 'puppeteer' : 'electron'
      };
      return JSON.stringify(format, null, 2);
    } catch (error) {
      log.error('❌ 导出 Cookies 失败:', error);
      throw error;
    }
  }

  /**
   * 导入 Cookies（JSON 格式）
   *
   * @param source Cookie 来源
   * @param json JSON 字符串
   *
   * @example
   * ```typescript
   * const json = fs.readFileSync('cookies.json', 'utf-8');
   * await cookieManager.importCookies(page, json);
   * ```
   */
  async importCookies(source: CookieSource, json: string): Promise<void> {
    try {
      const format: CookieExportFormat = JSON.parse(json);

      if (format.version !== '1.0') {
        throw new Error(`不支持的 Cookie 导出格式版本: ${format.version}`);
      }

      await this.setCookies(source, format.cookies);
      this.log('[CookieManager] ✅ 导入 cookies', format.cookies.length);
    } catch (error) {
      log.error('❌ 导入 Cookies 失败:', error);
      throw error;
    }
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.cookieCache.clear();
    this.log('[CookieManager] 🧹 缓存已清除');
  }

  // ==================== 私有辅助方法 ====================

  /**
   * 判断是否为 Puppeteer Page
   */
  private isPuppeteerPage(source: CookieSource): source is Page {
    return 'cookies' in source && typeof source.cookies === 'function';
  }

  /**
   * 转换 Electron Cookies 为 Puppeteer 格式
   */
  private convertElectronCookiesToPuppeteer(electronCookies: ElectronCookie[]): Cookie[] {
    return electronCookies.map(cookie => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain || '',
      path: cookie.path || '/',
      expires: cookie.expirationDate || -1,
      size: (cookie.name + cookie.value).length,
      httpOnly: cookie.httpOnly || false,
      secure: cookie.secure || false,
      session: !cookie.expirationDate,
      sameSite: this.convertSameSite(cookie.sameSite)
    }));
  }

  /**
   * 转换 SameSite 属性
   */
  private convertSameSite(sameSite?: string): 'Strict' | 'Lax' | 'None' {
    switch (sameSite?.toLowerCase()) {
      case 'strict':
        return 'Strict';
      case 'lax':
        return 'Lax';
      case 'none':
        return 'None';
      default:
        return 'Lax';
    }
  }

  /**
   * 构建 Cookie URL
   */
  private buildCookieUrl(cookie: Partial<Cookie> | Partial<ElectronCookie>): string | null {
    if (!cookie.domain) {
      return null;
    }
    const protocol = cookie.secure ? 'https' : 'http';
    const domain = cookie.domain.startsWith('.')
      ? cookie.domain.substring(1)
      : cookie.domain;
    return `${protocol}://${domain}${cookie.path || '/'}`;
  }

  /**
   * 检查 Cookie 是否匹配过滤条件
   */
  private matchesCookieFilter(cookie: Cookie, filter?: CookieFilter): boolean {
    if (!filter) return true;

    if (filter.name && cookie.name !== filter.name) return false;
    if (filter.domain && !cookie.domain?.includes(filter.domain)) return false;
    if (filter.path && cookie.path !== filter.path) return false;

    return true;
  }

  /**
   * SS-19: 使用稳定的 WeakMap 分配 Page 唯一 ID，避免依赖 Puppeteer 私有 API
   * `_client().connection()._url` 是未公开的内部 API，升级后可能静默失效。
   */
  private pageIdMap = new WeakMap<object, string>();
  private pageIdCounter = 0;

  private getPageStableId(page: object): string {
    const existing = this.pageIdMap.get(page);
    if (existing) return existing;
    const id = `p${++this.pageIdCounter}`;
    this.pageIdMap.set(page, id);
    return id;
  }

  /**
   * 生成缓存 Key
   */
  private getCacheKey(source: CookieSource, url?: string): string {
    const sourceId = this.isPuppeteerPage(source)
      ? `page-${this.getPageStableId(source as object)}`
      : `view-${(source as any).id || 'unknown'}`;
    return `${sourceId}:${url || 'all'}`;
  }

  /**
   * 日志输出（根据配置）
   */
  private log(message: string, ...args: any[]): void {
    if (this.config.verbose) {
      log.debug(message.replace(/^\[CookieManager\]\s*/, ''), ...args);
    }
  }
}

// 导出单例
export const cookieManager = CookieManager.getInstance();
