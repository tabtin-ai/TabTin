/**
 * unicodeSecurity 模块测试
 *
 * 覆盖：
 * - stripDangerousUnicode：正常文本不变、危险字符被移除、混合文本正确处理
 * - detectDangerousUnicode：检测结果包含正确的类别和位置
 * - containsDangerousUnicode：快速检测
 * - normalizeForMatching：NFC + 不可见字符清除
 * - 前后端码位一致性验证
 */
import { describe, it, expect } from 'vitest';
import {
  DANGEROUS_INVISIBLE_CODEPOINTS,
  stripDangerousUnicode,
  detectDangerousUnicode,
  containsDangerousUnicode,
  normalizeForMatching,
  stripInvisibleUnicode,
  containsInvisibleUnicode,
} from '../src/unicodeSecurity';

// ── stripDangerousUnicode ───────────────────────────────────────

describe('stripDangerousUnicode', () => {
  it('正常 ASCII 文本不变', () => {
    expect(stripDangerousUnicode('hello world 123 !@#')).toBe('hello world 123 !@#');
  });

  it('CJK 文字不变', () => {
    expect(stripDangerousUnicode('你好世界 こんにちは 안녕하세요')).toBe('你好世界 こんにちは 안녕하세요');
  });

  it('Emoji 不变', () => {
    expect(stripDangerousUnicode('hello 🎉🚀💡')).toBe('hello 🎉🚀💡');
  });

  it('空字符串不变', () => {
    expect(stripDangerousUnicode('')).toBe('');
  });

  it('移除零宽字符', () => {
    expect(stripDangerousUnicode('he\u200Bllo')).toBe('hello');
    expect(stripDangerousUnicode('\uFEFFtest')).toBe('test');
  });

  it('移除方向控制符', () => {
    expect(stripDangerousUnicode('a\u202Eb\u202Cc')).toBe('abc');
  });

  it('移除 Hangul Filler', () => {
    expect(stripDangerousUnicode('rm\u3164-rf')).toBe('rm-rf');
    expect(stripDangerousUnicode('cmd\uFFA0test')).toBe('cmdtest');
  });

  it('移除 Tag Characters', () => {
    const tag = String.fromCodePoint(0xE0041);
    expect(stripDangerousUnicode(`he${tag}llo`)).toBe('hello');
  });

  it('移除 Variation Selectors', () => {
    const vs = String.fromCodePoint(0xFE01);
    expect(stripDangerousUnicode(`login${vs}`)).toBe('login');
  });

  it('移除 Variation Selectors Supplement', () => {
    const vs = String.fromCodePoint(0xE0100);
    expect(stripDangerousUnicode(`te${vs}st`)).toBe('test');
  });

  it('移除 Interlinear Annotation', () => {
    expect(stripDangerousUnicode('x\uFFF9y\uFFFBz')).toBe('xyz');
  });

  it('混合危险字符全部移除', () => {
    expect(stripDangerousUnicode('h\u200Be\u3164l\u202El\uFFA0o')).toBe('hello');
  });

  it('全部是危险字符时返回空', () => {
    expect(stripDangerousUnicode('\u200B\u200C\u200D\uFEFF')).toBe('');
  });
});

// ── detectDangerousUnicode ──────────────────────────────────────

describe('detectDangerousUnicode', () => {
  it('干净文本返回 hasDangerous=false', () => {
    const result = detectDangerousUnicode('safe text');
    expect(result.hasDangerous).toBe(false);
    expect(result.found).toHaveLength(0);
    expect(result.categories).toHaveLength(0);
  });

  it('空文本返回 hasDangerous=false', () => {
    expect(detectDangerousUnicode('').hasDangerous).toBe(false);
  });

  it('检测零宽字符并返回正确类别', () => {
    const result = detectDangerousUnicode('hi\u200Bthere');
    expect(result.hasDangerous).toBe(true);
    expect(result.categories).toContain('zero_width');
    expect(result.found[0]!.codepoint).toBe('U+200B');
    expect(result.found[0]!.position).toBe(2);
  });

  it('检测多类别', () => {
    const result = detectDangerousUnicode('hi\u200Bthere\u3164end');
    expect(result.hasDangerous).toBe(true);
    expect(result.categories).toContain('zero_width');
    expect(result.categories).toContain('hangul_filler');
    expect(result.found).toHaveLength(2);
  });

  it('检测 Tag Characters', () => {
    const tag = String.fromCodePoint(0xE0041);
    const result = detectDangerousUnicode(`x${tag}y`);
    expect(result.hasDangerous).toBe(true);
    expect(result.categories).toContain('tag_characters');
  });

  it('检测方向控制符', () => {
    const result = detectDangerousUnicode('x\u202Ey');
    expect(result.hasDangerous).toBe(true);
    expect(result.categories).toContain('bidi_control');
  });
});

// ── containsDangerousUnicode ────────────────────────────────────

describe('containsDangerousUnicode', () => {
  it('不误报正常 ASCII', () => {
    expect(containsDangerousUnicode('echo hello world')).toBe(false);
  });

  it('不误报 CJK', () => {
    expect(containsDangerousUnicode('你好世界')).toBe(false);
  });

  it('不误报 Emoji', () => {
    expect(containsDangerousUnicode('hello 🎉🚀')).toBe(false);
  });

  it('检测零宽空格', () => {
    expect(containsDangerousUnicode('hello\u200Bworld')).toBe(true);
  });

  it('连续调用不受 lastIndex 影响', () => {
    const tag = String.fromCodePoint(0xE0041);
    const text = `hello${tag}world`;
    expect(containsDangerousUnicode(text)).toBe(true);
    expect(containsDangerousUnicode(text)).toBe(true);
    expect(containsDangerousUnicode(text)).toBe(true);
  });
});

// ── normalizeForMatching ────────────────────────────────────────

describe('normalizeForMatching', () => {
  it('NFC 规范化', () => {
    const nfd = 'e\u0301'; // é 的 NFD 形式
    expect(normalizeForMatching(nfd)).toBe('\u00E9');
  });

  it('清除不可见字符 + NFC', () => {
    const tag = String.fromCodePoint(0xE0041);
    const vs = String.fromCodePoint(0xFE01);
    expect(normalizeForMatching(`rm${tag}${vs} -rf /`)).toBe('rm -rf /');
  });

  it('保留 CJK', () => {
    expect(normalizeForMatching('数据库查询')).toBe('数据库查询');
  });

  it('空字符串', () => {
    expect(normalizeForMatching('')).toBe('');
  });
});

// ── 兼容别名 ────────────────────────────────────────────────────

describe('兼容别名', () => {
  it('stripInvisibleUnicode 与 stripDangerousUnicode 相同', () => {
    expect(stripInvisibleUnicode).toBe(stripDangerousUnicode);
  });

  it('containsInvisibleUnicode 与 containsDangerousUnicode 相同', () => {
    expect(containsInvisibleUnicode).toBe(containsDangerousUnicode);
  });
});

// ── 攻击场景模拟 ────────────────────────────────────────────────

describe('攻击场景模拟', () => {
  it('Hangul Filler 绕过 rm 命令检测', () => {
    const malicious = 'r\u3164m -rf /';
    expect(containsDangerousUnicode(malicious)).toBe(true);
    expect(normalizeForMatching(malicious)).toBe('rm -rf /');
  });

  it('RLO 字符 URL 视觉混淆', () => {
    const url = 'https://safe.com/\u202Eevil.com';
    const cleaned = stripDangerousUnicode(url);
    expect(cleaned).toBe('https://safe.com/evil.com');
  });

  it('零宽空格绕过 SQL 检测', () => {
    const malicious = 'DR\u200BOP TABLE users';
    expect(normalizeForMatching(malicious)).toBe('DROP TABLE users');
  });

  it('Tag Characters 编码 ASCII（Pliny 攻击向量）', () => {
    const tagEncoded = Array.from('rm -rf /').map(c => String.fromCodePoint(0xE0000 + c.charCodeAt(0))).join('');
    expect(containsDangerousUnicode(tagEncoded)).toBe(true);
    expect(stripDangerousUnicode(tagEncoded)).toBe('');
  });

  it('Soft Hyphen 绕过命令黑名单', () => {
    const malicious = 'curl\u00AD http://evil.com';
    expect(containsDangerousUnicode(malicious)).toBe(true);
    expect(normalizeForMatching(malicious)).toBe('curl http://evil.com');
  });
});

// ── 前后端码位一致性验证 ─────────────────────────────────────────

describe('前后端码位一致性', () => {
  it('码点总数超过 100', () => {
    expect(DANGEROUS_INVISIBLE_CODEPOINTS.size).toBeGreaterThan(100);
  });

  it('Tag Characters 全范围覆盖 (U+E0001–U+E007F)', () => {
    for (let cp = 0xE0001; cp <= 0xE007F; cp++) {
      expect(DANGEROUS_INVISIBLE_CODEPOINTS.has(cp)).toBe(true);
    }
  });

  it('Variation Selectors BMP 全范围覆盖 (U+FE00–U+FE0F)', () => {
    for (let cp = 0xFE00; cp <= 0xFE0F; cp++) {
      expect(DANGEROUS_INVISIBLE_CODEPOINTS.has(cp)).toBe(true);
    }
  });

  it('Variation Selectors Supplement 全范围覆盖 (U+E0100–U+E01EF)', () => {
    for (let cp = 0xE0100; cp <= 0xE01EF; cp++) {
      expect(DANGEROUS_INVISIBLE_CODEPOINTS.has(cp)).toBe(true);
    }
  });

  it('Interlinear Annotation 全覆盖 (U+FFF9–U+FFFB)', () => {
    for (const cp of [0xFFF9, 0xFFFA, 0xFFFB]) {
      expect(DANGEROUS_INVISIBLE_CODEPOINTS.has(cp)).toBe(true);
    }
  });

  // 与后端 unicode_security.py DANGEROUS_INVISIBLE_CODEPOINTS 完全一致的必备码位
  const BACKEND_REQUIRED_CODEPOINTS = [
    // _ZERO_WIDTH
    0x200B, 0x200C, 0x200D, 0xFEFF,
    // _BIDI_CONTROL
    0x200E, 0x200F, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E,
    0x2066, 0x2067, 0x2068, 0x2069,
    // _HANGUL_FILLER
    0x3164, 0xFFA0,
    // _OTHER_INVISIBLE
    0x00AD, 0x034F, 0x061C, 0x2800,
    // _INTERLINEAR_ANNOTATION
    0xFFF9, 0xFFFA, 0xFFFB,
  ];

  it('后端所有单独码位在前端均存在', () => {
    for (const cp of BACKEND_REQUIRED_CODEPOINTS) {
      expect(DANGEROUS_INVISIBLE_CODEPOINTS.has(cp)).toBe(true);
    }
  });

  it('每个危险码位都能被 stripDangerousUnicode 清除', () => {
    for (const cp of DANGEROUS_INVISIBLE_CODEPOINTS) {
      const char = String.fromCodePoint(cp);
      const text = `before${char}after`;
      const cleaned = stripDangerousUnicode(text);
      expect(cleaned).toBe('beforeafter');
    }
  });

  it('每个危险码位都能被 containsDangerousUnicode 检测', () => {
    for (const cp of DANGEROUS_INVISIBLE_CODEPOINTS) {
      const char = String.fromCodePoint(cp);
      expect(containsDangerousUnicode(`x${char}y`)).toBe(true);
    }
  });
});
