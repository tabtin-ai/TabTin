import { describe, it, expect, afterEach } from 'vitest';
import {
  getAvailableFonts,
  findFont,
  getFontUrl,
  getClosestWeight,
  resolveFontFamily,
  getCjkFonts,
  getFontsByCategory,
  registerFont,
  registerFonts,
  unregisterFont,
  resetRegistry,
  NOTO_SANS_SC_URL,
  INTER_URL,
} from '../fonts/registry.js';
import type { FontRegistryEntry } from '../fonts/registry.js';

// Restore built-in state after every test that mutates the registry
afterEach(() => {
  resetRegistry();
});

describe('字体注册表 (Font Registry)', () => {
  describe('getAvailableFonts', () => {
    it('返回非空数组', () => {
      const fonts = getAvailableFonts();
      expect(fonts.length).toBeGreaterThan(0);
    });

    it('内置字体数量 >= 60（后端 67 种字体对齐 + CJK 扩充）', () => {
      const fonts = getAvailableFonts();
      expect(fonts.length).toBeGreaterThanOrEqual(60);
    });

    it('返回的是副本，修改不影响原始数据', () => {
      const fonts1 = getAvailableFonts();
      const fonts2 = getAvailableFonts();
      expect(fonts1).not.toBe(fonts2);
      fonts1.pop();
      expect(getAvailableFonts().length).toBe(fonts2.length);
    });

    it('每个 entry 包含必要字段', () => {
      for (const font of getAvailableFonts()) {
        expect(font.family).toBeTruthy();
        expect(font.category).toBeTruthy();
        expect(font.weights.length).toBeGreaterThan(0);
        expect(font.urlPattern).toMatch(/^https:\/\//);
      }
    });
  });

  describe('findFont', () => {
    it('精确匹配找到 Inter', () => {
      const font = findFont('Inter');
      expect(font).toBeDefined();
      expect(font!.family).toBe('Inter');
    });

    it('大小写不敏感 — "inter" 也能找到', () => {
      const font = findFont('inter');
      expect(font).toBeDefined();
      expect(font!.family).toBe('Inter');
    });

    it('大小写不敏感 — "INTER" 也能找到', () => {
      const font = findFont('INTER');
      expect(font).toBeDefined();
      expect(font!.family).toBe('Inter');
    });

    it('大小写不敏感 — "noto sans sc" 也能找到', () => {
      const font = findFont('noto sans sc');
      expect(font).toBeDefined();
      expect(font!.family).toBe('Noto Sans SC');
    });

    it('不存在的字体返回 undefined', () => {
      expect(findFont('NonExistent')).toBeUndefined();
    });

    it('空字符串返回 undefined', () => {
      expect(findFont('')).toBeUndefined();
    });
  });

  describe('getFontUrl', () => {
    it('返回 Inter 的 CDN URL', () => {
      const url = getFontUrl('Inter');
      expect(url).toBeDefined();
      expect(url).toMatch(/^https:\/\/fonts\.gstatic\.com/);
    });

    it('返回的 URL 与导出常量一致', () => {
      expect(getFontUrl('Inter')).toBe(INTER_URL);
    });

    it('不存在的字体返回 undefined', () => {
      expect(getFontUrl('NonExistent')).toBeUndefined();
    });

    it('Noto Sans SC URL 与导出常量一致', () => {
      expect(getFontUrl('Noto Sans SC')).toBe(NOTO_SANS_SC_URL);
    });
  });

  describe('getClosestWeight', () => {
    it('精确匹配权重 400', () => {
      expect(getClosestWeight('Inter', 400)).toBe(400);
    });

    it('精确匹配权重 700', () => {
      expect(getClosestWeight('Inter', 700)).toBe(700);
    });

    it('请求 350 → 返回最近的权重（300 或 400）', () => {
      const weight = getClosestWeight('Inter', 350);
      expect(weight).toBeDefined();
      // Inter 有 100-900 的所有百位权重，350 距离 300 和 400 相等，
      // reduce 会保留第一个碰到的更近值
      expect([300, 400]).toContain(weight);
    });

    it('请求 999 → 返回 900', () => {
      expect(getClosestWeight('Inter', 999)).toBe(900);
    });

    it('请求 1 → 返回 100', () => {
      expect(getClosestWeight('Inter', 1)).toBe(100);
    });

    it('不存在的字体返回 undefined', () => {
      expect(getClosestWeight('NonExistent', 400)).toBeUndefined();
    });
  });

  describe('resolveFontFamily', () => {
    it('解析 Inter 返回完整 ResolvedFont', () => {
      const resolved = resolveFontFamily('Inter');
      expect(resolved).toBeDefined();
      expect(resolved!.url).toMatch(/^https:\/\//);
      expect(resolved!.resolvedFamily).toBe('Inter');
      expect(resolved!.weights).toEqual(expect.arrayContaining([400, 700]));
      expect(resolved!.cjk).toBe(false);
    });

    it('解析 CJK 字体标记 cjk 为 true', () => {
      const resolved = resolveFontFamily('Noto Sans SC');
      expect(resolved).toBeDefined();
      expect(resolved!.cjk).toBe(true);
    });

    it('大小写不敏感', () => {
      const resolved = resolveFontFamily('inter');
      expect(resolved).toBeDefined();
      expect(resolved!.resolvedFamily).toBe('Inter');
    });

    it('不存在的字体返回 undefined', () => {
      expect(resolveFontFamily('NonExistent')).toBeUndefined();
    });
  });

  describe('getCjkFonts', () => {
    it('返回 CJK 字体列表', () => {
      const cjkFonts = getCjkFonts();
      expect(cjkFonts.length).toBeGreaterThan(0);
    });

    it('所有返回项的 cjk 标记为 true', () => {
      for (const font of getCjkFonts()) {
        expect(font.cjk).toBe(true);
      }
    });

    it('包含 Noto Sans SC', () => {
      const families = getCjkFonts().map((f) => f.family);
      expect(families).toContain('Noto Sans SC');
    });

    it('包含 Noto Serif SC', () => {
      const families = getCjkFonts().map((f) => f.family);
      expect(families).toContain('Noto Serif SC');
    });

    it('包含 Noto Sans TC（繁体中文）', () => {
      const families = getCjkFonts().map((f) => f.family);
      expect(families).toContain('Noto Sans TC');
    });

    it('包含 Noto Sans JP（日文）', () => {
      const families = getCjkFonts().map((f) => f.family);
      expect(families).toContain('Noto Sans JP');
    });

    it('包含 Noto Sans KR（韩文）', () => {
      const families = getCjkFonts().map((f) => f.family);
      expect(families).toContain('Noto Sans KR');
    });

    it('包含 Noto Serif TC / JP / KR', () => {
      const families = getCjkFonts().map((f) => f.family);
      expect(families).toContain('Noto Serif TC');
      expect(families).toContain('Noto Serif JP');
      expect(families).toContain('Noto Serif KR');
    });
  });

  describe('getFontsByCategory', () => {
    it('monospace 类别只返回等宽字体', () => {
      const monoFonts = getFontsByCategory('monospace');
      expect(monoFonts.length).toBeGreaterThan(0);
      for (const font of monoFonts) {
        expect(font.category).toBe('monospace');
      }
    });

    it('monospace 类别包含 JetBrains Mono', () => {
      const families = getFontsByCategory('monospace').map((f) => f.family);
      expect(families).toContain('JetBrains Mono');
    });

    it('serif 类别不包含 Inter', () => {
      const families = getFontsByCategory('serif').map((f) => f.family);
      expect(families).not.toContain('Inter');
    });

    it('sans-serif 类别包含 Inter', () => {
      const families = getFontsByCategory('sans-serif').map((f) => f.family);
      expect(families).toContain('Inter');
    });

    it('display 类别包含 Lobster', () => {
      const families = getFontsByCategory('display').map((f) => f.family);
      expect(families).toContain('Lobster');
    });

    it('handwriting 类别包含 Dancing Script', () => {
      const families = getFontsByCategory('handwriting').map((f) => f.family);
      expect(families).toContain('Dancing Script');
    });
  });

  // =========================================================================
  // 动态注册 API 测试
  // =========================================================================

  describe('registerFont', () => {
    const customFont: FontRegistryEntry = {
      family: 'MyCustomFont',
      category: 'sans-serif',
      weights: [400, 700],
      urlPattern: 'https://example.com/mycustomfont.ttf',
    };

    it('注册新字体后 findFont() 能找到', () => {
      registerFont(customFont);
      const found = findFont('MyCustomFont');
      expect(found).toBeDefined();
      expect(found!.family).toBe('MyCustomFont');
      expect(found!.urlPattern).toBe('https://example.com/mycustomfont.ttf');
    });

    it('注册新字体后 getAvailableFonts() 数量增加', () => {
      const before = getAvailableFonts().length;
      registerFont(customFont);
      expect(getAvailableFonts().length).toBe(before + 1);
    });

    it('注册已存在字体默认跳过（不覆盖）', () => {
      const originalUrl = findFont('Inter')!.urlPattern;
      registerFont({
        family: 'Inter',
        category: 'sans-serif',
        weights: [400],
        urlPattern: 'https://example.com/fake-inter.ttf',
      });
      expect(findFont('Inter')!.urlPattern).toBe(originalUrl);
    });

    it('overwrite=true 可覆盖已存在字体', () => {
      const newUrl = 'https://example.com/new-inter.ttf';
      registerFont(
        {
          family: 'Inter',
          category: 'sans-serif',
          weights: [400, 700],
          urlPattern: newUrl,
        },
        true,
      );
      expect(findFont('Inter')!.urlPattern).toBe(newUrl);
    });

    it('大小写不敏感查找自定义字体', () => {
      registerFont(customFont);
      expect(findFont('mycustomfont')).toBeDefined();
      expect(findFont('MYCUSTOMFONT')).toBeDefined();
    });
  });

  describe('registerFonts', () => {
    it('批量注册多个字体', () => {
      const fonts: FontRegistryEntry[] = [
        {
          family: 'BatchFont1',
          category: 'serif',
          weights: [400],
          urlPattern: 'https://example.com/batch1.ttf',
        },
        {
          family: 'BatchFont2',
          category: 'display',
          weights: [400, 700],
          urlPattern: 'https://example.com/batch2.ttf',
        },
      ];
      registerFonts(fonts);
      expect(findFont('BatchFont1')).toBeDefined();
      expect(findFont('BatchFont2')).toBeDefined();
    });
  });

  describe('unregisterFont', () => {
    it('移除后 findFont() 返回 undefined', () => {
      registerFont({
        family: 'TempFont',
        category: 'sans-serif',
        weights: [400],
        urlPattern: 'https://example.com/temp.ttf',
      });
      expect(findFont('TempFont')).toBeDefined();
      const removed = unregisterFont('TempFont');
      expect(removed).toBe(true);
      expect(findFont('TempFont')).toBeUndefined();
    });

    it('移除不存在的字体返回 false', () => {
      expect(unregisterFont('NoSuchFont')).toBe(false);
    });

    it('可以移除内置字体', () => {
      expect(findFont('Inter')).toBeDefined();
      unregisterFont('Inter');
      expect(findFont('Inter')).toBeUndefined();
    });

    it('大小写不敏感移除', () => {
      registerFont({
        family: 'CaseTest',
        category: 'serif',
        weights: [400],
        urlPattern: 'https://example.com/case.ttf',
      });
      expect(unregisterFont('casetest')).toBe(true);
      expect(findFont('CaseTest')).toBeUndefined();
    });
  });

  describe('resetRegistry', () => {
    it('恢复到初始状态（仅内置字体）', () => {
      const initialCount = getAvailableFonts().length;

      // 注册自定义字体
      registerFont({
        family: 'CustomForReset',
        category: 'display',
        weights: [400],
        urlPattern: 'https://example.com/reset.ttf',
      });
      expect(getAvailableFonts().length).toBe(initialCount + 1);

      // 重置
      resetRegistry();
      expect(getAvailableFonts().length).toBe(initialCount);
      expect(findFont('CustomForReset')).toBeUndefined();
    });

    it('重置后被移除的内置字体恢复', () => {
      unregisterFont('Inter');
      expect(findFont('Inter')).toBeUndefined();

      resetRegistry();
      expect(findFont('Inter')).toBeDefined();
    });

    it('重置后被覆盖的内置字体恢复为原始值', () => {
      const originalUrl = findFont('Inter')!.urlPattern;
      registerFont(
        {
          family: 'Inter',
          category: 'sans-serif',
          weights: [400],
          urlPattern: 'https://example.com/overwrite.ttf',
        },
        true,
      );
      expect(findFont('Inter')!.urlPattern).not.toBe(originalUrl);

      resetRegistry();
      expect(findFont('Inter')!.urlPattern).toBe(originalUrl);
    });
  });

  describe('自定义 CJK 字体', () => {
    it('注册自定义 CJK 字体后 getCjkFonts() 包含它', () => {
      const cjkFont: FontRegistryEntry = {
        family: 'MyCustomCJK',
        category: 'sans-serif',
        weights: [400, 700],
        urlPattern: 'https://example.com/custom-cjk.ttf',
        cjk: true,
      };
      registerFont(cjkFont);

      const cjkFamilies = getCjkFonts().map((f) => f.family);
      expect(cjkFamilies).toContain('MyCustomCJK');
    });

    it('注册非 CJK 字体不出现在 getCjkFonts()', () => {
      registerFont({
        family: 'NotCJK',
        category: 'serif',
        weights: [400],
        urlPattern: 'https://example.com/not-cjk.ttf',
      });
      const cjkFamilies = getCjkFonts().map((f) => f.family);
      expect(cjkFamilies).not.toContain('NotCJK');
    });
  });

  describe('后端字体对齐验证', () => {
    // 后端 font_service.py 中的关键字体必须存在于前端注册表
    const backendFonts = [
      'Inter', 'Roboto', 'Open Sans', 'Montserrat', 'Lato', 'Poppins',
      'Nunito', 'Raleway', 'Work Sans', 'DM Sans', 'Manrope',
      'Plus Jakarta Sans', 'Source Sans 3', 'Figtree', 'Rubik', 'Mulish',
      'Cabin', 'Quicksand', 'Karla', 'Ubuntu', 'Noto Sans',
      // CJK
      'Noto Sans SC', 'Noto Serif SC', 'Noto Sans JP', 'Noto Sans KR',
      // Serif
      'Playfair Display', 'Merriweather', 'Lora', 'PT Serif',
      'Libre Baskerville', 'EB Garamond', 'Cormorant Garamond',
      'Crimson Text', 'DM Serif Display', 'Bitter', 'Noto Serif',
      // Monospace
      'JetBrains Mono', 'Fira Code', 'Source Code Pro', 'IBM Plex Mono',
      'Roboto Mono', 'Space Mono', 'Inconsolata',
      // Display
      'Bebas Neue', 'Oswald', 'Anton', 'Abril Fatface', 'Righteous',
      'Fredoka', 'Comfortaa', 'Alfa Slab One',
      'ZCOOL QingKe HuangYou', 'ZCOOL KuaiLe',
      // Handwriting
      'Caveat', 'Dancing Script', 'Pacifico', 'Satisfy',
      'Shadows Into Light', 'Indie Flower', 'Great Vibes', 'Sacramento',
      'Ma Shan Zheng', 'Long Cang', 'Zhi Mang Xing',
    ];

    for (const family of backendFonts) {
      it(`包含后端字体: ${family}`, () => {
        expect(findFont(family)).toBeDefined();
      });
    }
  });
});
