/**
 * **W5 (2026-05-12)** unified diff snippet 单测。
 *
 * 覆盖 `getSnippetForPatch` 的字节级行为：单行改动 / 多行改动 / 文件开头 / 文件
 * 结尾 / context 行数控制 / 退化 case（无改动）。
 */
import { describe, it, expect } from 'vitest';

import { getSnippetForPatch } from '../edit-snippet.js';

describe('getSnippetForPatch · 退化', () => {
  it('原文件 === 新文件 → 空字符串', () => {
    expect(getSnippetForPatch('hello', 'hello')).toBe('');
  });

  it('两个空字符串 → 空字符串', () => {
    expect(getSnippetForPatch('', '')).toBe('');
  });
});

describe('getSnippetForPatch · 单行改动', () => {
  it('单行改动文件中部 → snippet 含 ±4 行 context + 改动行带 +/- 标注', () => {
    const original = [
      'line1',
      'line2',
      'line3',
      'line4',
      'line5',
      'line6',
      'line7',
      'line8',
    ].join('\n');
    const updated = [
      'line1',
      'line2',
      'line3',
      'line4',
      'LINE5_CHANGED',
      'line6',
      'line7',
      'line8',
    ].join('\n');

    const snippet = getSnippetForPatch(original, updated);
    expect(snippet).toContain('5\t- line5');
    expect(snippet).toContain('5\t+ LINE5_CHANGED');
    // ±4 context（文件 8 行，改第 5 行 → 上 1-4 + 下 6-8 都应在 context）
    expect(snippet).toContain('1\t  line1');
    expect(snippet).toContain('4\t  line4');
    expect(snippet).toContain('6\t  line6');
    expect(snippet).toContain('8\t  line8');
  });

  it('改文件第一行 → 上 context 截到文件开头', () => {
    const original = ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n');
    const updated = ['LINE1', 'line2', 'line3', 'line4', 'line5'].join('\n');

    const snippet = getSnippetForPatch(original, updated);
    expect(snippet).toContain('1\t- line1');
    expect(snippet).toContain('1\t+ LINE1');
    expect(snippet).toContain('2\t  line2');
    // 不应该含 line0 / 负行号
    expect(snippet).not.toMatch(/^0\t/m);
  });

  it('改文件最后一行 → 下 context 截到文件结尾', () => {
    const original = ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n');
    const updated = ['line1', 'line2', 'line3', 'line4', 'LINE5'].join('\n');

    const snippet = getSnippetForPatch(original, updated);
    expect(snippet).toContain('5\t- line5');
    expect(snippet).toContain('5\t+ LINE5');
  });
});

describe('getSnippetForPatch · 多行改动', () => {
  it('连续多行改动 → 一个 hunk 内全部展示', () => {
    const original = ['a', 'b', 'c', 'd', 'e', 'f'].join('\n');
    const updated = ['a', 'B', 'C', 'd', 'e', 'f'].join('\n');

    const snippet = getSnippetForPatch(original, updated);
    expect(snippet).toContain('2\t- b');
    expect(snippet).toContain('3\t- c');
    expect(snippet).toContain('2\t+ B');
    expect(snippet).toContain('3\t+ C');
  });
});

describe('getSnippetForPatch · context 行数控制', () => {
  it('contextLines=2：仅展示 ±2 行 context', () => {
    const original = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9'].join('\n');
    const updated = ['l1', 'l2', 'l3', 'l4', 'L5', 'l6', 'l7', 'l8', 'l9'].join('\n');

    const snippet = getSnippetForPatch(original, updated, 2);
    // ±2 行：l3 / l4（before）+ l6 / l7（after）应该有
    expect(snippet).toContain('3\t  l3');
    expect(snippet).toContain('7\t  l7');
    // l1 / l2 / l8 / l9 应该不在 ±2 context
    expect(snippet).not.toContain('1\t  l1');
    expect(snippet).not.toContain('9\t  l9');
  });
});

describe('getSnippetForPatch · 行号正确性', () => {
  it('删除一行：旧行号继续递增，新行号跳过删除行', () => {
    const original = ['a', 'b', 'c', 'd', 'e'].join('\n');
    const updated = ['a', 'c', 'd', 'e'].join('\n');

    const snippet = getSnippetForPatch(original, updated);
    expect(snippet).toContain('2\t- b');
    // 删除 b 后 c 在新文件位置 2，但旧文件位置 3 —— format 决定用哪个？
    // 我们 context 行用 newLineNum
    expect(snippet).toContain('2\t  c');
  });

  it('添加一行：旧行号停在添加位置，新行号继续递增', () => {
    const original = ['a', 'b', 'c'].join('\n');
    const updated = ['a', 'NEW', 'b', 'c'].join('\n');

    const snippet = getSnippetForPatch(original, updated);
    expect(snippet).toContain('2\t+ NEW');
    expect(snippet).toContain('3\t  b');
  });
});

describe('getSnippetForPatch · "No newline at end of file" meta 跳过', () => {
  it('文件无 trailing newline → "\\ No newline" meta 行不出现在 snippet', () => {
    const original = 'a\nb\nc';
    const updated = 'a\nB\nc';

    const snippet = getSnippetForPatch(original, updated);
    expect(snippet).not.toContain('\\ No newline');
    expect(snippet).toContain('- b');
    expect(snippet).toContain('+ B');
  });
});
