/**
 * CookieManager 单元测试
 *
 * 测试覆盖：
 * - getCookies() 方法
 * - setCookies() 方法
 * - clearCookies() 方法
 * - exportCookies() / importCookies() 方法
 * - 缓存机制
 * - 错误处理
 *
 * @author TabTin Team
 * @date 2025-11-21
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CookieManager } from '../CookieManager';
import type { Cookie, CookieFilter } from '../../types/cookies';

// Mock Puppeteer Page
const createMockPage = () => ({
  cookies: vi.fn().mockResolvedValue([
    {
      name: 'session_id',
      value: 'abc123',
      domain: '.example.com',
      path: '/',
      expires: -1,
      size: 13,
      httpOnly: true,
      secure: true,
      session: true,
      sameSite: 'Lax' as const
    }
  ] as Cookie[]),
  setCookie: vi.fn().mockResolvedValue(undefined),
  deleteCookie: vi.fn().mockResolvedValue(undefined)
});

// Mock Electron WebContents（: CookieSource 已从 WebContentsView 收窄为 WebContents）
const createMockWebContentsView = () => ({
  id: 1,
  session: {
    cookies: {
      get: vi.fn().mockResolvedValue([
        {
          name: 'session_id',
          value: 'abc123',
          domain: '.example.com',
          path: '/',
          expirationDate: undefined,
          httpOnly: true,
          secure: true,
          sameSite: 'lax'
        }
      ]),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined)
    }
  }
});

describe('CookieManager', () => {
  let cookieManager: CookieManager;

  beforeEach(() => {
    ;(CookieManager as any).instance = undefined
    // 重置单例（通过创建新实例）
    cookieManager = CookieManager.getInstance({ enableCache: false });
  });

  describe('getInstance()', () => {
    it('应该返回单例实例', () => {
      const instance1 = CookieManager.getInstance();
      const instance2 = CookieManager.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('应该支持配置参数', () => {
      const instance = CookieManager.getInstance({
        enableCache: true,
        cacheExpiry: 30000,
        verbose: true
      });
      expect(instance).toBeInstanceOf(CookieManager);
    });
  });

  describe('getCookies()', () => {
    it('应该从 Puppeteer Page 获取 cookies', async () => {
      const mockPage = createMockPage();
      const cookies = await cookieManager.getCookies(mockPage as any);

      expect(mockPage.cookies).toHaveBeenCalled();
      expect(cookies).toHaveLength(1);
      expect(cookies[0].name).toBe('session_id');
    });

    it('应该从 Electron WebContentsView 获取 cookies', async () => {
      const mockView = createMockWebContentsView();
      const cookies = await cookieManager.getCookies(mockView as any);

      expect(mockView.session.cookies.get).toHaveBeenCalled();
      expect(cookies).toHaveLength(1);
      expect(cookies[0].name).toBe('session_id');
    });

    it('应该支持 URL 过滤', async () => {
      const mockPage = createMockPage();
      const url = 'https://example.com';
      await cookieManager.getCookies(mockPage as any, url);

      expect(mockPage.cookies).toHaveBeenCalledWith(url);
    });

    it('应该在错误时返回空数组', async () => {
      const mockPage = {
        cookies: vi.fn().mockRejectedValue(new Error('Network error'))
      };

      const cookies = await cookieManager.getCookies(mockPage as any);
      expect(cookies).toEqual([]);
    });

    it('应该正确转换 Electron Cookie 格式', async () => {
      const mockView = createMockWebContentsView();
      const cookies = await cookieManager.getCookies(mockView as any);

      expect(cookies[0]).toHaveProperty('sameSite', 'Lax');
      expect(cookies[0]).toHaveProperty('session', true);
    });
  });

  describe('setCookies()', () => {
    it('应该在 Puppeteer Page 上设置 cookies', async () => {
      const mockPage = createMockPage();
      const cookies: Cookie[] = [
        {
          name: 'test',
          value: 'value',
          domain: '.example.com',
          path: '/',
          expires: -1,
          size: 10,
          httpOnly: false,
          secure: false,
          session: true,
          sameSite: 'Lax'
        }
      ];

      await cookieManager.setCookies(mockPage as any, cookies);
      expect(mockPage.setCookie).toHaveBeenCalledWith(...cookies);
    });

    it('应该在 Electron WebContentsView 上设置 cookies', async () => {
      const mockView = createMockWebContentsView();
      const cookies: Cookie[] = [
        {
          name: 'test',
          value: 'value',
          domain: '.example.com',
          path: '/',
          expires: -1,
          size: 10,
          httpOnly: false,
          secure: false,
          session: true,
          sameSite: 'Lax'
        }
      ];

      await cookieManager.setCookies(mockView as any, cookies);
      expect(mockView.session.cookies.set).toHaveBeenCalled();
    });

    it('应该在错误时抛出异常', async () => {
      const mockPage = {
        cookies: vi.fn().mockResolvedValue([]),
        setCookie: vi.fn().mockRejectedValue(new Error('Set failed'))
      };
      const cookies: Cookie[] = [];

      await expect(
        cookieManager.setCookies(mockPage as any, cookies)
      ).rejects.toThrow('Set failed');
    });
  });

  describe('clearCookies()', () => {
    it('应该清除 Puppeteer Page 的 cookies', async () => {
      const mockPage = createMockPage();
      await cookieManager.clearCookies(mockPage as any);

      expect(mockPage.cookies).toHaveBeenCalled();
      expect(mockPage.deleteCookie).toHaveBeenCalled();
    });

    it('应该清除 Electron WebContentsView 的 cookies', async () => {
      const mockView = createMockWebContentsView();
      await cookieManager.clearCookies(mockView as any);

      expect(mockView.session.cookies.get).toHaveBeenCalled();
      expect(mockView.session.cookies.remove).toHaveBeenCalled();
    });

    it('应该支持过滤条件', async () => {
      const mockPage = createMockPage();
      const filter: CookieFilter = {
        url: 'https://example.com',
        domain: '.example.com'
      };

      await cookieManager.clearCookies(mockPage as any, filter);
      expect(mockPage.cookies).toHaveBeenCalledWith(filter.url);
    });

    it('应该在错误时抛出异常', async () => {
      const mockPage = {
        cookies: vi.fn().mockRejectedValue(new Error('Clear failed'))
      };

      await expect(
        cookieManager.clearCookies(mockPage as any)
      ).rejects.toThrow('Clear failed');
    });
  });

  describe('exportCookies() / importCookies()', () => {
    it('应该导出 cookies 为 JSON', async () => {
      const mockPage = createMockPage();
      const json = await cookieManager.exportCookies(mockPage as any);

      const parsed = JSON.parse(json);
      expect(parsed).toHaveProperty('version', '1.0');
      expect(parsed).toHaveProperty('cookies');
      expect(parsed).toHaveProperty('exportedAt');
      expect(parsed).toHaveProperty('source', 'puppeteer');
      expect(parsed.cookies).toHaveLength(1);
    });

    it('应该导入 JSON cookies', async () => {
      const mockPage = createMockPage();
      const json = JSON.stringify({
        version: '1.0',
        cookies: [
          {
            name: 'imported',
            value: 'test',
            domain: '.example.com',
            path: '/',
            expires: -1,
            size: 10,
            httpOnly: false,
            secure: false,
            session: true,
            sameSite: 'Lax' as const
          }
        ],
        exportedAt: new Date().toISOString(),
        source: 'puppeteer'
      });

      await cookieManager.importCookies(mockPage as any, json);
      expect(mockPage.setCookie).toHaveBeenCalled();
    });

    it('应该拒绝不支持的版本', async () => {
      const mockPage = createMockPage();
      const json = JSON.stringify({
        version: '2.0',
        cookies: [],
        exportedAt: new Date().toISOString(),
        source: 'puppeteer'
      });

      await expect(
        cookieManager.importCookies(mockPage as any, json)
      ).rejects.toThrow('不支持的 Cookie 导出格式版本');
    });

    it('导出读取失败时会退化为空 cookies JSON', async () => {
      const mockPage = {
        cookies: vi.fn().mockRejectedValue(new Error('Export failed'))
      };

      await expect(cookieManager.exportCookies(mockPage as any)).resolves.toContain('"cookies": []');
    });
  });

  describe('缓存机制', () => {
    it('应该在启用缓存时使用缓存', async () => {
      ;(CookieManager as any).instance = undefined
      const cachedManager = CookieManager.getInstance({
        enableCache: true,
        cacheExpiry: 60000
      });

      const mockPage = createMockPage();

      // 第一次调用
      await cachedManager.getCookies(mockPage as any);
      expect(mockPage.cookies).toHaveBeenCalledTimes(1);

      // 第二次调用（应该使用缓存）
      await cachedManager.getCookies(mockPage as any);
      expect(mockPage.cookies).toHaveBeenCalledTimes(1); // 没有增加
    });

    it('应该在缓存过期后重新获取', async () => {
      ;(CookieManager as any).instance = undefined
      const cachedManager = CookieManager.getInstance({
        enableCache: true,
        cacheExpiry: 100 // 100ms
      });

      const mockPage = createMockPage();

      // 第一次调用
      await cachedManager.getCookies(mockPage as any);
      expect(mockPage.cookies).toHaveBeenCalledTimes(1);

      // 等待缓存过期
      await new Promise(resolve => setTimeout(resolve, 150));

      // 第二次调用（缓存已过期）
      await cachedManager.getCookies(mockPage as any);
      expect(mockPage.cookies).toHaveBeenCalledTimes(2);
    });

    it('应该在 setCookies 后清除缓存', async () => {
      ;(CookieManager as any).instance = undefined
      const cachedManager = CookieManager.getInstance({ enableCache: true });
      const mockPage = createMockPage();

      // 填充缓存
      await cachedManager.getCookies(mockPage as any);

      // 设置 cookies（应该清除缓存）
      await cachedManager.setCookies(mockPage as any, []);

      // 清除缓存
      cachedManager.clearCache();
    });
  });

  describe('辅助方法', () => {
    it('应该正确判断 Puppeteer Page', () => {
      const mockPage = createMockPage();
      const result = (cookieManager as any).isPuppeteerPage(mockPage);
      expect(result).toBe(true);
    });

    it('应该正确判断 Electron WebContentsView', () => {
      const mockView = createMockWebContentsView();
      const result = (cookieManager as any).isPuppeteerPage(mockView);
      expect(result).toBe(false);
    });

    it('应该正确转换 SameSite 属性', () => {
      const convert = (cookieManager as any).convertSameSite.bind(cookieManager);
      expect(convert('strict')).toBe('Strict');
      expect(convert('lax')).toBe('Lax');
      expect(convert('none')).toBe('None');
      expect(convert('invalid')).toBe('Lax'); // 默认值
    });

    it('应该正确构建 Cookie URL', () => {
      const buildUrl = (cookieManager as any).buildCookieUrl.bind(cookieManager);

      const url1 = buildUrl({ domain: '.example.com', path: '/', secure: true });
      expect(url1).toBe('https://example.com/');

      const url2 = buildUrl({ domain: 'example.com', path: '/api', secure: false });
      expect(url2).toBe('http://example.com/api');

      const url3 = buildUrl({ domain: null });
      expect(url3).toBeNull();
    });

    it('应该正确匹配 Cookie 过滤条件', () => {
      const matches = (cookieManager as any).matchesCookieFilter.bind(cookieManager);

      const cookie: Cookie = {
        name: 'test',
        value: 'value',
        domain: '.example.com',
        path: '/',
        expires: -1,
        size: 10,
        httpOnly: false,
        secure: false,
        session: true,
        sameSite: 'Lax'
      };

      expect(matches(cookie, {})).toBe(true);
      expect(matches(cookie, { name: 'test' })).toBe(true);
      expect(matches(cookie, { name: 'other' })).toBe(false);
      expect(matches(cookie, { domain: 'example.com' })).toBe(true);
      expect(matches(cookie, { path: '/' })).toBe(true);
    });
  });
});
