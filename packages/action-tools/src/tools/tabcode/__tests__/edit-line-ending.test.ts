/**
 * **W5 (2026-05-12)** CRLF detect/preserve 单测。
 *
 * 覆盖 detectLineEnding / normalizeLineEndings / convertToLineEnding 的字节级
 * 行为。e2e 行为（fileEditTool.execute 端到端 CRLF preserve）见
 * `edit-file-match.test.ts` 末尾的 W5 块。
 */
import { describe, it, expect } from 'vitest';

import {
  convertToLineEnding,
  detectLineEnding,
  hasBOM,
  normalizeLineEndings,
  restoreBOM,
  stripBOM,
} from '../edit-line-ending.js';

describe('detectLineEnding', () => {
  it('LF 文件返 \\n', () => {
    expect(detectLineEnding('foo\nbar\n')).toBe('\n');
  });

  it('CRLF 文件返 \\r\\n', () => {
    expect(detectLineEnding('foo\r\nbar\r\n')).toBe('\r\n');
  });

  it('空文件返 \\n（默认行业惯例）', () => {
    expect(detectLineEnding('')).toBe('\n');
  });

  it('单行无 newline 返 \\n', () => {
    expect(detectLineEnding('hello')).toBe('\n');
  });

  it('mixed CRLF + LF：任意 CRLF 出现就走 CRLF（git autocrlf 哲学）', () => {
    expect(detectLineEnding('a\r\nb\nc\r\n')).toBe('\r\n');
  });
});

describe('normalizeLineEndings', () => {
  it('CRLF → LF', () => {
    expect(normalizeLineEndings('foo\r\nbar\r\n')).toBe('foo\nbar\n');
  });

  it('已经 LF 不动', () => {
    expect(normalizeLineEndings('foo\nbar\n')).toBe('foo\nbar\n');
  });

  it('mixed 都归一', () => {
    expect(normalizeLineEndings('a\r\nb\nc\r\n')).toBe('a\nb\nc\n');
  });

  it('空字符串', () => {
    expect(normalizeLineEndings('')).toBe('');
  });
});

describe('convertToLineEnding', () => {
  it('LF + ending=\\n → 不动', () => {
    expect(convertToLineEnding('foo\nbar', '\n')).toBe('foo\nbar');
  });

  it('LF + ending=\\r\\n → 全转 CRLF', () => {
    expect(convertToLineEnding('foo\nbar\n', '\r\n')).toBe('foo\r\nbar\r\n');
  });

  it('幂等：已经 CRLF 再 convert 不变成 \\r\\r\\n', () => {
    expect(convertToLineEnding('foo\r\nbar\r\n', '\r\n')).toBe('foo\r\nbar\r\n');
  });

  it('mixed 转 CRLF：先归一再 convert', () => {
    expect(convertToLineEnding('a\r\nb\nc', '\r\n')).toBe('a\r\nb\r\nc');
  });

  it('空字符串', () => {
    expect(convertToLineEnding('', '\r\n')).toBe('');
    expect(convertToLineEnding('', '\n')).toBe('');
  });
});

describe('hasBOM / stripBOM / restoreBOM (W5 收尾轮)', () => {
  it('hasBOM：含 BOM 文件返 true', () => {
    expect(hasBOM('\uFEFFhello')).toBe(true);
  });

  it('hasBOM：无 BOM 文件返 false', () => {
    expect(hasBOM('hello')).toBe(false);
  });

  it('hasBOM：空字符串返 false', () => {
    expect(hasBOM('')).toBe(false);
  });

  it('stripBOM：剥离首字符 BOM', () => {
    expect(stripBOM('\uFEFFhello')).toBe('hello');
  });

  it('stripBOM：无 BOM 不动', () => {
    expect(stripBOM('hello')).toBe('hello');
  });

  it('stripBOM：仅文件中间出现 \\uFEFF 不剥离（只看首字符）', () => {
    expect(stripBOM('hello\uFEFFworld')).toBe('hello\uFEFFworld');
  });

  it('restoreBOM：原文件有 BOM → 写回时补 BOM', () => {
    expect(restoreBOM('hello', true)).toBe('\uFEFFhello');
  });

  it('restoreBOM：原文件无 BOM → 写回保持无 BOM', () => {
    expect(restoreBOM('hello', false)).toBe('hello');
  });

  it('restoreBOM：text 已经有 BOM 时不重复添加（防御性）', () => {
    expect(restoreBOM('\uFEFFhello', true)).toBe('\uFEFFhello');
  });

  it('round-trip：read 含 BOM 文件 → strip → 改 → restore', () => {
    const disk = '\uFEFFconst x = 1;\nconst y = 2;\n';
    const hadBOM = hasBOM(disk);
    expect(hadBOM).toBe(true);
    const content = stripBOM(disk);
    expect(content).toBe('const x = 1;\nconst y = 2;\n');
    const modified = content.replace('x', 'X');
    const restored = restoreBOM(modified, hadBOM);
    expect(restored).toBe('\uFEFFconst X = 1;\nconst y = 2;\n');
  });
});

describe('round-trip：detect → normalize → modify → convert 还原', () => {
  it('CRLF 文件改一行后 ending 仍是 CRLF', () => {
    const original = 'line1\r\nline2\r\nline3\r\n';
    const ending = detectLineEnding(original);
    expect(ending).toBe('\r\n');

    const normalized = normalizeLineEndings(original);
    expect(normalized).toBe('line1\nline2\nline3\n');

    // 模拟 edit：替换 line2 为 newline
    const modified = normalized.replace('line2', 'newline');
    expect(modified).toBe('line1\nnewline\nline3\n');

    const restored = convertToLineEnding(modified, ending);
    expect(restored).toBe('line1\r\nnewline\r\nline3\r\n');
  });

  it('LF 文件保持 LF', () => {
    const original = 'line1\nline2\nline3\n';
    const ending = detectLineEnding(original);
    expect(ending).toBe('\n');
    const restored = convertToLineEnding(original, ending);
    expect(restored).toBe(original);
  });
});
