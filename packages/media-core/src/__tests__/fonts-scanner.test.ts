import { describe, it, expect } from 'vitest';
import { scanFonts, collectAllText, containsCjk } from '../fonts/scanner.js';

describe('字体扫描器 (Font Scanner)', () => {
  describe('containsCjk', () => {
    it('检测中文字符', () => {
      expect(containsCjk('你好世界')).toBe(true);
    });

    it('检测日文平假名', () => {
      expect(containsCjk('こんにちは')).toBe(true);
    });

    it('检测日文片假名', () => {
      expect(containsCjk('カタカナ')).toBe(true);
    });

    it('检测混合内容中的 CJK', () => {
      expect(containsCjk('Hello 你好 World')).toBe(true);
    });

    it('纯 ASCII 返回 false', () => {
      expect(containsCjk('Hello World')).toBe(false);
    });

    it('空字符串返回 false', () => {
      expect(containsCjk('')).toBe(false);
    });

    it('纯数字返回 false', () => {
      expect(containsCjk('12345')).toBe(false);
    });

    it('检测全角字符', () => {
      expect(containsCjk('ＡＢＣ')).toBe(true);
    });

    it('检测 CJK 标点', () => {
      expect(containsCjk('。、')).toBe(true);
    });
  });

  describe('scanFonts — 空输入', () => {
    it('空 objects 返回空结果', () => {
      const result = scanFonts({});
      expect(result.fonts.size).toBe(0);
      expect(result.allText).toBe('');
      expect(result.hasCjk).toBe(false);
    });

    it('只有非 text 类型的 shape 返回空结果', () => {
      const objects = {
        shape1: { type: 'rect', x: 0, y: 0 },
        shape2: { type: 'frame', children: [] },
      };
      const result = scanFonts(objects);
      expect(result.fonts.size).toBe(0);
    });
  });

  describe('scanFonts — shape 级别字体提取', () => {
    it('提取带 fontUrl 的 text shape', () => {
      const objects = {
        t1: {
          type: 'text',
          fontUrl: 'https://example.com/myfont.woff2',
          fontFamily: 'CustomFont',
          fontWeight: 400,
        },
      };
      const result = scanFonts(objects);
      expect(result.fonts.size).toBe(1);
      const spec = result.fonts.get('https://example.com/myfont.woff2');
      expect(spec).toBeDefined();
      expect(spec!.family).toBe('CustomFont');
      expect(spec!.weights.has(400)).toBe(true);
    });

    it('提取带 fontFamily（注册表中存在）的 text shape', () => {
      const objects = {
        t1: {
          type: 'text',
          fontFamily: 'Roboto',
          fontWeight: 700,
        },
      };
      const result = scanFonts(objects);
      expect(result.fonts.size).toBe(1);
      // 应该通过 registry 解析出 URL
      const entries = [...result.fonts.values()];
      expect(entries[0].family).toBe('Roboto');
      expect(entries[0].weights.has(700)).toBe(true);
    });

    it('不在注册表中且无 fontUrl 的字体不会被收集', () => {
      const objects = {
        t1: {
          type: 'text',
          fontFamily: 'UnknownFont',
        },
      };
      const result = scanFonts(objects);
      expect(result.fonts.size).toBe(0);
    });

    it('内建字体 Inter 不会被收集（属于 BUILTIN_FAMILIES）', () => {
      const objects = {
        t1: {
          type: 'text',
          fontFamily: 'Inter',
        },
      };
      const result = scanFonts(objects);
      expect(result.fonts.size).toBe(0);
    });

    it('fontWeight "bold" 解析为 700', () => {
      const objects = {
        t1: {
          type: 'text',
          fontUrl: 'https://example.com/bold.woff2',
          fontWeight: 'bold',
        },
      };
      const result = scanFonts(objects);
      const spec = [...result.fonts.values()][0];
      expect(spec.weights.has(700)).toBe(true);
    });

    it('fontStyle "italic" 被正确识别', () => {
      const objects = {
        t1: {
          type: 'text',
          fontUrl: 'https://example.com/italic.woff2',
          fontStyle: 'italic',
        },
      };
      const result = scanFonts(objects);
      const spec = [...result.fonts.values()][0];
      expect(spec.styles.has('italic')).toBe(true);
    });

    it('相同 URL 的多个 shape 会合并权重和样式', () => {
      const objects = {
        t1: {
          type: 'text',
          fontUrl: 'https://example.com/font.woff2',
          fontWeight: 400,
          fontStyle: 'normal',
        },
        t2: {
          type: 'text',
          fontUrl: 'https://example.com/font.woff2',
          fontWeight: 700,
          fontStyle: 'italic',
        },
      };
      const result = scanFonts(objects);
      expect(result.fonts.size).toBe(1);
      const spec = result.fonts.get('https://example.com/font.woff2')!;
      expect(spec.weights.has(400)).toBe(true);
      expect(spec.weights.has(700)).toBe(true);
      expect(spec.styles.has('normal')).toBe(true);
      expect(spec.styles.has('italic')).toBe(true);
    });
  });

  describe('scanFonts — 富文本内容树', () => {
    it('从富文本 leaf 节点中提取字体信息', () => {
      const objects = {
        t1: {
          type: 'text',
          fontFamily: 'Inter', // shape 级别是内建字体
          content: {
            children: [
              {
                children: [
                  {
                    text: 'Hello',
                    fontFamily: 'Roboto',
                    fontWeight: '500',
                  },
                ],
              },
            ],
          },
        },
      };
      const result = scanFonts(objects);
      expect(result.fonts.size).toBe(1);
      const entries = [...result.fonts.values()];
      expect(entries[0].family).toBe('Roboto');
    });

    it('从富文本中收集文本内容', () => {
      const objects = {
        t1: {
          type: 'text',
          name: 'Title',
          content: {
            children: [
              {
                children: [
                  { text: 'Hello ' },
                  { text: 'World' },
                ],
              },
            ],
          },
        },
      };
      const result = scanFonts(objects);
      expect(result.allText).toContain('Hello ');
      expect(result.allText).toContain('World');
      expect(result.allText).toContain('Title');
    });

    it('富文本中包含 CJK 时 hasCjk 为 true', () => {
      const objects = {
        t1: {
          type: 'text',
          content: {
            children: [
              {
                children: [
                  { text: '你好世界' },
                ],
              },
            ],
          },
        },
      };
      const result = scanFonts(objects);
      expect(result.hasCjk).toBe(true);
    });

    it('富文本 leaf 带 fontUrl 也能被提取', () => {
      const objects = {
        t1: {
          type: 'text',
          content: {
            children: [
              {
                children: [
                  {
                    text: 'styled',
                    fontUrl: 'https://example.com/leaf-font.woff2',
                    fontFamily: 'LeafFont',
                  },
                ],
              },
            ],
          },
        },
      };
      const result = scanFonts(objects);
      expect(result.fonts.has('https://example.com/leaf-font.woff2')).toBe(true);
    });
  });

  describe('collectAllText', () => {
    it('收集所有 text shape 的文本', () => {
      const objects = {
        t1: {
          type: 'text',
          name: 'Label',
          content: {
            children: [
              { children: [{ text: 'Hello' }] },
            ],
          },
        },
        t2: {
          type: 'text',
          name: 'Desc',
          content: 'Plain text content',
        },
      };
      const text = collectAllText(objects);
      expect(text).toContain('Label');
      expect(text).toContain('Hello');
      expect(text).toContain('Desc');
      expect(text).toContain('Plain text content');
    });

    it('跳过非 text 类型的 shape', () => {
      const objects = {
        rect1: { type: 'rect', name: 'Box' },
        t1: { type: 'text', name: 'Label' },
      };
      const text = collectAllText(objects);
      expect(text).toContain('Label');
      expect(text).not.toContain('Box');
    });

    it('空 objects 返回空字符串', () => {
      expect(collectAllText({})).toBe('');
    });
  });
});
