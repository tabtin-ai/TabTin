/**
 * **W5 (2026-05-12)** 4 级 fuzzy 匹配测试。
 *
 * 覆盖：
 *   - Level 1（exact）
 *   - Level 2（curly quotes）
 *   - Level 3（tab/space）+ 反向映射边界
 *   - Level 4（curly + tab/space 组合）
 *   - 全部 miss
 *   - calculator regression（hallucinated middle 必须 fail）
 *   - 不命中假阳性（仅相似但语义不同的内容必须 miss）
 */
import { describe, expect, it } from 'vitest';

import { findActualString, __internal } from '../edit-fuzzy.js';

const {
  normalizeQuotes,
  normalizeWhitespace,
  mapNormalizedMatchBackToFile,
  LEFT_SINGLE_CURLY_QUOTE,
  RIGHT_SINGLE_CURLY_QUOTE,
  LEFT_DOUBLE_CURLY_QUOTE,
  RIGHT_DOUBLE_CURLY_QUOTE,
} = __internal;

describe('normalizeQuotes（W5 Level 2 helper）', () => {
  it('双向 curly → straight：单引号', () => {
    expect(normalizeQuotes(`${LEFT_SINGLE_CURLY_QUOTE}hello${RIGHT_SINGLE_CURLY_QUOTE}`)).toBe(
      "'hello'",
    );
  });

  it('双向 curly → straight：双引号', () => {
    expect(normalizeQuotes(`${LEFT_DOUBLE_CURLY_QUOTE}world${RIGHT_DOUBLE_CURLY_QUOTE}`)).toBe(
      '"world"',
    );
  });

  it('混合 curly + straight：仅 normalize curly 的，直引号原样保留', () => {
    const input = `say ${LEFT_DOUBLE_CURLY_QUOTE}hi${RIGHT_DOUBLE_CURLY_QUOTE} but 'preserve' me`;
    expect(normalizeQuotes(input)).toBe(`say "hi" but 'preserve' me`);
  });

  it('无 curly 字符时长度不变（短路保护）', () => {
    const input = 'plain "ASCII" text';
    expect(normalizeQuotes(input)).toBe(input);
    expect(normalizeQuotes(input).length).toBe(input.length);
  });
});

describe('normalizeWhitespace（W5 Level 3 helper）', () => {
  it('单 tab 展开成 4 spaces', () => {
    expect(normalizeWhitespace('\tfoo')).toBe('    foo');
  });

  it('多个 tab 全部展开', () => {
    expect(normalizeWhitespace('\t\tfoo\tbar')).toBe('        foo    bar');
  });

  it('已经是空格的不动', () => {
    expect(normalizeWhitespace('    foo')).toBe('    foo');
  });

  it('跨行 tab 都展开（多行文本）', () => {
    expect(normalizeWhitespace('\tfoo\n\tbar')).toBe('    foo\n    bar');
  });
});

describe('mapNormalizedMatchBackToFile（W5 反向映射）', () => {
  it('普通字符（无 tab）：normalized 位置等于 origin 位置', () => {
    const orig = 'hello world';
    const norm = orig;
    // 命中 'world' 长度 5，从位置 6 开始
    expect(mapNormalizedMatchBackToFile(orig, norm, 6, 5)).toBe('world');
  });

  it('开头 tab：normalized 位置 0 → orig 位置 0', () => {
    const orig = '\tfoo';
    const norm = '    foo';
    // 命中 'foo' 长度 3，normalized 位置 4
    expect(mapNormalizedMatchBackToFile(orig, norm, 4, 3)).toBe('foo');
  });

  it('单 tab 开头：命中含 tab 的整段 → 返原文件含 tab 子串', () => {
    const orig = '\tfoo\nbar';
    const norm = '    foo\nbar';
    // 命中整个第一行 '    foo' normalized 长度 7，从位置 0 开始
    expect(mapNormalizedMatchBackToFile(orig, norm, 0, 7)).toBe('\tfoo');
  });

  it('多 tab 文件：命中跨多 tab 的内容', () => {
    const orig = '\tfoo\n\tbar\n\tbaz';
    const norm = '    foo\n    bar\n    baz';
    // 命中 '    bar' normalized 位置 8 长度 7
    expect(mapNormalizedMatchBackToFile(orig, norm, 8, 7)).toBe('\tbar');
  });

  it('命中末尾恰好整个文件', () => {
    const orig = 'hello';
    const norm = 'hello';
    expect(mapNormalizedMatchBackToFile(orig, norm, 0, 5)).toBe('hello');
  });

  it('Mixed tab + 空格内容（典型代码场景）', () => {
    // 函数定义有 tab 缩进，注释有空格缩进
    const orig = 'def foo():\n\t# comment\n\treturn 1';
    const norm = normalizeWhitespace(orig);
    // norm = "def foo():\n    # comment\n    return 1"
    //         0         10  11           24  25
    // "def foo():" 占 0-9 (len 10), "\n" 占 10, "    # comment" 占 11-23 (len 13),
    // "\n" 占 24, "    return 1" 从 25 开始 (len 12)。
    const idx = norm.indexOf('    return 1');
    expect(idx).toBe(25);
    expect(mapNormalizedMatchBackToFile(orig, norm, idx, '    return 1'.length)).toBe(
      '\treturn 1',
    );
  });
});

describe('findActualString · Level 1 exact 命中', () => {
  it('精确匹配立即返回原 search', () => {
    const file = 'hello world\nfoo bar';
    expect(findActualString(file, 'foo bar')).toBe('foo bar');
  });

  it('多行精确匹配', () => {
    const file = 'line1\nline2\nline3';
    expect(findActualString(file, 'line1\nline2')).toBe('line1\nline2');
  });

  it('不存在内容直接返 null（不绕道走 fuzzy）', () => {
    const file = 'hello world';
    expect(findActualString(file, 'nonexistent')).toBeNull();
  });
});

describe('findActualString · Level 2 curly quote 命中', () => {
  it('文件含 curly 双引号 + LLM 给 ASCII 双引号 → 命中并返**文件原始 curly 形态**', () => {
    const file = `say ${LEFT_DOUBLE_CURLY_QUOTE}hello${RIGHT_DOUBLE_CURLY_QUOTE}`;
    const search = 'say "hello"';
    const result = findActualString(file, search);
    expect(result).toBe(`say ${LEFT_DOUBLE_CURLY_QUOTE}hello${RIGHT_DOUBLE_CURLY_QUOTE}`);
  });

  it('文件含 ASCII 引号 + LLM 给 curly → 命中并返**文件原始 ASCII 形态**', () => {
    const file = `say "hello"`;
    const search = `say ${LEFT_DOUBLE_CURLY_QUOTE}hello${RIGHT_DOUBLE_CURLY_QUOTE}`;
    const result = findActualString(file, search);
    expect(result).toBe(`say "hello"`);
  });

  it('单引号 curly 同款行为', () => {
    const file = `it${RIGHT_SINGLE_CURLY_QUOTE}s working`;
    const search = `it's working`;
    expect(findActualString(file, search)).toBe(`it${RIGHT_SINGLE_CURLY_QUOTE}s working`);
  });

  it('混合 curly + 直引号 + LLM 给全 ASCII 版本', () => {
    const file = `${LEFT_DOUBLE_CURLY_QUOTE}outer${RIGHT_DOUBLE_CURLY_QUOTE} 'inner'`;
    const search = `"outer" 'inner'`;
    const result = findActualString(file, search);
    expect(result).toBe(`${LEFT_DOUBLE_CURLY_QUOTE}outer${RIGHT_DOUBLE_CURLY_QUOTE} 'inner'`);
  });
});

describe('findActualString · Level 3 tab/space 命中', () => {
  it('文件 tab + LLM 给 4 spaces → 命中并返文件原始 tab 形态', () => {
    const file = '\tfoo';
    const search = '    foo';
    expect(findActualString(file, search)).toBe('\tfoo');
  });

  it('文件 4 spaces + LLM 给 tab → 命中并返文件原始 4 spaces', () => {
    const file = '    foo';
    const search = '\tfoo';
    expect(findActualString(file, search)).toBe('    foo');
  });

  it('多行 tab 缩进的代码块', () => {
    const file = 'def f():\n\treturn 1\n\treturn 2';
    const search = '    return 1\n    return 2';
    expect(findActualString(file, search)).toBe('\treturn 1\n\treturn 2');
  });

  it('开头有多个 tab', () => {
    const file = '\t\t\tdeep_nested';
    const search = '            deep_nested';
    expect(findActualString(file, search)).toBe('\t\t\tdeep_nested');
  });
});

describe('findActualString · Level 4 组合命中', () => {
  it('curly 引号 + tab 缩进同时存在 → 4 级组合命中', () => {
    const file = `\t${LEFT_DOUBLE_CURLY_QUOTE}hello${RIGHT_DOUBLE_CURLY_QUOTE}`;
    const search = `    "hello"`;
    expect(findActualString(file, search)).toBe(
      `\t${LEFT_DOUBLE_CURLY_QUOTE}hello${RIGHT_DOUBLE_CURLY_QUOTE}`,
    );
  });
});

describe('findActualString · 全 miss 必须返 null（不允许"相似度阈值"）', () => {
  it('完全不存在的内容', () => {
    const file = 'hello world';
    expect(findActualString(file, 'goodbye')).toBeNull();
  });

  it('部分相似但中间字符不同（calculator regression：首末锚定中间幻觉）', () => {
    // 模拟 LLM 凭幻觉写 old_string：首末两行命中真实代码，中间塞虚构内容
    const file = `.button {\n  background: linear-gradient(135deg, #f093fb 0%, #fa709a 100%);\n}`;
    // LLM 凭印象虚构的"假"old_string——首末跟原文一致，但中间塞了原文不存在的内容
    const hallucinated = `.button {\n  background: NEVER_IN_FILE_FAKE_GRADIENT;\n}`;
    // 即使首末锚定 fuzzy 也不能命中——本模块仅做"语义无损 normalize"
    expect(findActualString(file, hallucinated)).toBeNull();
  });

  it('仅缩进风格不同（已被 Level 3 兜住）vs 内容不同（不应命中）', () => {
    const file = '\tfoo bar';
    expect(findActualString(file, '    foo bar')).toBe('\tfoo bar'); // Level 3 命中
    expect(findActualString(file, '    foo BAZ')).toBeNull(); // 内容不同必 miss
  });

  it('curly quote 内文字内容不同（不命中）', () => {
    const file = `${LEFT_DOUBLE_CURLY_QUOTE}hello${RIGHT_DOUBLE_CURLY_QUOTE}`;
    expect(findActualString(file, '"world"')).toBeNull();
  });
});

describe('findActualString · 顺序敏感性（前面命中后立即返回）', () => {
  it('exact 命中时不走 fuzzy', () => {
    // 文件刚好有 ASCII 直引号也有 curly 引号 —— exact 命中 ASCII 段时不应该
    // 返 curly 段（exact 优先）
    const file = `"asciiQuoted" and ${LEFT_DOUBLE_CURLY_QUOTE}curlyQuoted${RIGHT_DOUBLE_CURLY_QUOTE}`;
    expect(findActualString(file, '"asciiQuoted"')).toBe('"asciiQuoted"');
  });

  it('Level 2 命中时不走 Level 3（curly 优先于 tab-space）', () => {
    // 这种 case 极少：但要保证 ordering 不出乎意料
    const file = `${LEFT_DOUBLE_CURLY_QUOTE}foo${RIGHT_DOUBLE_CURLY_QUOTE}`;
    const search = `"foo"`;
    expect(findActualString(file, search)).toBe(
      `${LEFT_DOUBLE_CURLY_QUOTE}foo${RIGHT_DOUBLE_CURLY_QUOTE}`,
    );
  });
});

describe('findActualString · 空字符串 / 边界', () => {
  it('search 为空字符串 → exact indexOf 命中（位置 0）返空字符串', () => {
    expect(findActualString('hello', '')).toBe('');
  });

  it('file 为空 + search 非空 → null', () => {
    expect(findActualString('', 'foo')).toBeNull();
  });

  it('file 为空 + search 为空 → 命中', () => {
    expect(findActualString('', '')).toBe('');
  });
});

// ─── W5 收尾轮 CJK / 子串不变量补测试钉 (2026-05-12) ──────
//
// 参考用例含 3 条 CJK + tab 多行
// fuzzy 测试 + 多条「返回子串必是 file 子串」断言。我们 W5 实现的 fuzzy /
// 反向映射对 CJK 已经语义安全（双指针 walk 按字符 codepoint 计算），但缺少
// 单测钉——若将来有人重写 fuzzy 实现（如改用 grapheme cluster 迭代）
// 容易回归。
describe('findActualString · CJK 字符', () => {
  it('CJK 字符在 content 里 + exact 命中', () => {
    const file = '函数 foo() 返回 hello';
    const result = findActualString(file, '函数 foo()');
    expect(result).toBe('函数 foo()');
    expect(file.includes(result!)).toBe(true);
  });

  it('CJK 字符 + tab/space 差异 → Level 3 命中且返原 tab 形态', () => {
    const file = '\t注释 = "test"';
    const result = findActualString(file, '    注释 = "test"');
    expect(result).toBe('\t注释 = "test"');
    expect(file.includes(result!)).toBe(true);
  });

  it('多行 tab 缩进 + CJK：Level 3 反向映射在中文混排下正确', () => {
    const file = 'def 处理():\n\treturn "成功"\n\tpass';
    const result = findActualString(file, '    return "成功"\n    pass');
    expect(result).toBe('\treturn "成功"\n\tpass');
    expect(file.includes(result!)).toBe(true);
  });

  it('CJK + curly quote：Level 2 命中', () => {
    const file = `说 \u201C你好\u201D`;
    const result = findActualString(file, 'say "你好"'.replace('say', '说'));
    expect(result).toBe(`说 \u201C你好\u201D`);
    expect(file.includes(result!)).toBe(true);
  });
});

describe('findActualString · 「返回子串必是 file 子串」不变量', () => {
  // 显式断言每个 fuzzy 命中返的 string 必须能在
  // 原 fileContent 里 includes 找到——这是反向映射正确性的最强 invariant。
  // 任何 fuzzy 命中都必须满足，否则 fileEditTool 用 actualString 做 indexOf
  // 时会 miss，引发"明明 findActualString 说命中了但 indexOf 失败"的状态机
  // 错乱。
  const cases: Array<{ name: string; file: string; search: string }> = [
    { name: 'tab 命中', file: '\tfoo bar', search: '    foo bar' },
    { name: '多 tab', file: '\t\t\tfoo', search: '            foo' },
    { name: 'curly quote 单引号', file: `it\u2019s`, search: "it's" },
    { name: 'curly quote 双引号', file: `\u201Chello\u201D`, search: '"hello"' },
    { name: '组合 tab + curly', file: `\t\u201Cfoo\u201D`, search: '    "foo"' },
    { name: 'tab 在中间', file: 'before\tafter', search: 'before    after' },
    { name: 'tab 在结尾', file: 'foo\t', search: 'foo    ' },
    { name: '部分 tab 部分 spaces', file: '\tfoo bar', search: '    foo bar' },
    { name: '混合缩进等级', file: '\tdef foo():\n\t\treturn 1', search: '    def foo():\n        return 1' },
  ];

  for (const tc of cases) {
    it(`${tc.name}：actualString 必是 file 字面子串`, () => {
      const result = findActualString(tc.file, tc.search);
      expect(result).not.toBeNull();
      expect(tc.file.includes(result!)).toBe(true);
    });
  }
});
