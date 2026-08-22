import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  queryLocalFonts,
  isFontAvailable,
  clearLocalFontCache,
  SYSTEM_FONT_CANDIDATES,
} from '../fonts/local-fonts.js';

describe('本地字体检测 (Local Fonts)', () => {
  beforeEach(() => {
    clearLocalFontCache();
  });

  // ─── SYSTEM_FONT_CANDIDATES ──────────────────────────────────────

  describe('SYSTEM_FONT_CANDIDATES', () => {
    it('是非空数组', () => {
      expect(Array.isArray(SYSTEM_FONT_CANDIDATES)).toBe(true);
      expect(SYSTEM_FONT_CANDIDATES.length).toBeGreaterThan(0);
    });

    it('包含常见字体', () => {
      expect(SYSTEM_FONT_CANDIDATES).toContain('Arial');
      expect(SYSTEM_FONT_CANDIDATES).toContain('Times New Roman');
      expect(SYSTEM_FONT_CANDIDATES).toContain('PingFang SC');
      expect(SYSTEM_FONT_CANDIDATES).toContain('Microsoft YaHei');
      expect(SYSTEM_FONT_CANDIDATES).toContain('Courier New');
    });

    it('所有元素都是非空字符串', () => {
      for (const font of SYSTEM_FONT_CANDIDATES) {
        expect(typeof font).toBe('string');
        expect(font.trim().length).toBeGreaterThan(0);
      }
    });
  });

  // ─── isFontAvailable ─────────────────────────────────────────────

  describe('isFontAvailable', () => {
    it('在无 document 环境返回 false', () => {
      // vitest 默认 Node.js 环境，没有 document
      const result = isFontAvailable('Arial');
      expect(result).toBe(false);
    });
  });

  // ─── queryLocalFonts ──────────────────────────────────────────────

  describe('queryLocalFonts', () => {
    it('在非浏览器环境返回空数组', async () => {
      const fonts = await queryLocalFonts();
      expect(fonts).toEqual([]);
    });

    it('缓存结果 — 第二次调用返回同一引用', async () => {
      const first = await queryLocalFonts();
      const second = await queryLocalFonts();
      expect(first).toBe(second);
    });

    it('clearLocalFontCache 后重新检测', async () => {
      const first = await queryLocalFonts();
      clearLocalFontCache();
      const second = await queryLocalFonts();
      // 虽然值相同（都是空数组），但应该是不同的引用（重新创建）
      expect(first).not.toBe(second);
    });
  });

  // ─── 模拟浏览器环境测试 Local Font Access API ────────────────────

  describe('queryLocalFonts — 模拟 window.queryLocalFonts', () => {
    let originalWindow: typeof globalThis.window;

    beforeEach(() => {
      originalWindow = globalThis.window;
      clearLocalFontCache();
    });

    afterEach(() => {
      // 恢复原始环境
      if (originalWindow === undefined) {
        // @ts-expect-error -- 恢复 Node.js 环境
        delete globalThis.window;
      } else {
        globalThis.window = originalWindow;
      }
      clearLocalFontCache();
    });

    it('当 Local Font Access API 可用时，返回去重后的字体列表', async () => {
      const mockFonts = [
        { family: 'Arial', fullName: 'Arial', postscriptName: 'ArialMT', style: 'Regular' },
        { family: 'Arial', fullName: 'Arial Bold', postscriptName: 'Arial-BoldMT', style: 'Bold' },
        { family: 'Helvetica', fullName: 'Helvetica', postscriptName: 'Helvetica', style: 'Regular' },
      ];

      // @ts-expect-error -- 模拟浏览器环境
      globalThis.window = {
        queryLocalFonts: vi.fn().mockResolvedValue(mockFonts),
      };

      const fonts = await queryLocalFonts();
      // Arial 应被去重，只出现一次
      expect(fonts.length).toBe(2);
      expect(fonts[0].family).toBe('Arial');
      expect(fonts[0].source).toBe('local-font-access');
      expect(fonts[0].fullName).toBe('Arial');
      expect(fonts[0].postscriptName).toBe('ArialMT');
      expect(fonts[1].family).toBe('Helvetica');
      expect(fonts[1].source).toBe('local-font-access');
    });

    it('当 Local Font Access API 授权失败时，降级为 canvas 检测', async () => {
      // @ts-expect-error -- 模拟浏览器环境
      globalThis.window = {
        queryLocalFonts: vi.fn().mockRejectedValue(new Error('Permission denied')),
      };

      // 由于 Node.js 中没有 document，canvas fallback 也检测不到字体
      const fonts = await queryLocalFonts();
      expect(fonts).toEqual([]);
    });

    it('过滤空字体名称', async () => {
      const mockFonts = [
        { family: '', fullName: '', postscriptName: '', style: '' },
        { family: '  ', fullName: '', postscriptName: '', style: '' },
        { family: 'Valid Font', fullName: 'Valid Font', postscriptName: 'ValidFont', style: 'Regular' },
      ];

      // @ts-expect-error -- 模拟浏览器环境
      globalThis.window = {
        queryLocalFonts: vi.fn().mockResolvedValue(mockFonts),
      };

      const fonts = await queryLocalFonts();
      expect(fonts.length).toBe(1);
      expect(fonts[0].family).toBe('Valid Font');
    });

    it('大小写相同的字体名称被正确去重', async () => {
      const mockFonts = [
        { family: 'Arial', fullName: 'Arial', postscriptName: 'ArialMT', style: 'Regular' },
        { family: 'arial', fullName: 'arial', postscriptName: 'arial', style: 'Regular' },
        { family: 'ARIAL', fullName: 'ARIAL', postscriptName: 'ARIAL', style: 'Bold' },
      ];

      // @ts-expect-error -- 模拟浏览器环境
      globalThis.window = {
        queryLocalFonts: vi.fn().mockResolvedValue(mockFonts),
      };

      const fonts = await queryLocalFonts();
      expect(fonts.length).toBe(1);
      expect(fonts[0].family).toBe('Arial'); // 保留第一个出现的大小写
    });
  });

  // ─── clearLocalFontCache ──────────────────────────────────────────

  describe('clearLocalFontCache', () => {
    it('调用不抛异常', () => {
      expect(() => clearLocalFontCache()).not.toThrow();
    });

    it('重复调用不抛异常', () => {
      clearLocalFontCache();
      clearLocalFontCache();
      clearLocalFontCache();
    });
  });
});
