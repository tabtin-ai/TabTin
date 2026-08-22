/**
 * user-context-wrapper SSoT 测试（阶段 6 议题 2）。
 *
 * 覆盖：
 *   1. builder 渲染：6 种 type、空 attrs、有 attrs 字典序、空字符串 attr 跳过、
 *      XML 字符转义（& / " / < / >）
 *   2. parser 反向：单 wrapper、多 wrapper、嵌套不命中、老形态不命中
 *   3. round-trip：buildXxx(parseXxx(...)) 等价
 *   4. Python contract：与 TS 端 byte-identical 的 fixture（由 Python 端单测验证）
 */

import { describe, it, expect } from 'vitest';
import contractTypes from '../../../../user-context-wrapper-types.contract.json';
import {
  buildUserContextWrapper,
  findFirstUserContextWrapper,
  findAllUserContextWrappers,
  VALID_USER_CONTEXT_WRAPPER_TYPES,
} from '../user-context-wrapper.js';

describe('buildUserContextWrapper', () => {
  it('渲染 environment 类无 attrs', () => {
    const out = buildUserContextWrapper('environment', 'current_datetime: 2026-05-21');
    expect(out).toBe(
      '<context type="environment">\ncurrent_datetime: 2026-05-21\n</context>',
    );
  });

  it('渲染 referenced 类带 stale_after_turn', () => {
    const out = buildUserContextWrapper('referenced', '## 表: 营销表\n字段：name, age', {
      stale_after_turn: 'msg-123',
    });
    expect(out).toBe(
      '<context type="referenced" stale_after_turn="msg-123">\n## 表: 营销表\n字段：name, age\n</context>',
    );
  });

  it('渲染 attached 类带 filename + stale_after_turn（字典序 attr）', () => {
    const out = buildUserContextWrapper('attached', '[文档: foo.pdf]\n文档内容', {
      filename: 'foo.pdf',
      stale_after_turn: 'msg-xyz',
    });
    // 字典序：filename < stale_after_turn → filename 在前
    expect(out).toBe(
      '<context type="attached" filename="foo.pdf" stale_after_turn="msg-xyz">\n[文档: foo.pdf]\n文档内容\n</context>',
    );
  });

  it('attr value 为空字符串 → 跳过该 attr', () => {
    const out = buildUserContextWrapper('referenced', 'body', {
      stale_after_turn: '',
      filename: 'x',
    });
    expect(out).toBe('<context type="referenced" filename="x">\nbody\n</context>');
  });

  it('attr value 为 undefined → 跳过该 attr', () => {
    const out = buildUserContextWrapper('attached', 'body', {
      stale_after_turn: undefined,
      filename: 'real.pdf',
    });
    expect(out).toBe('<context type="attached" filename="real.pdf">\nbody\n</context>');
  });

  it('XML attr 转义：& / " / < / > 全覆盖', () => {
    const out = buildUserContextWrapper('referenced', 'body', {
      filename: 'a&b<c>"d',
    });
    expect(out).toBe(
      '<context type="referenced" filename="a&amp;b&lt;c&gt;&quot;d">\nbody\n</context>',
    );
  });

  it('body 不做转义（XML attr 转义只在 attr value）', () => {
    const out = buildUserContextWrapper('environment', 'before <nested>\ninner\n</nested>');
    expect(out).toContain('<nested>\ninner\n</nested>');
  });
});

describe('findFirstUserContextWrapper', () => {
  it('parse 单 wrapper（无 attrs）', () => {
    const text = '<context type="environment">\ncurrent_datetime: x\n</context>';
    const w = findFirstUserContextWrapper(text);
    expect(w).not.toBeNull();
    expect(w!.type).toBe('environment');
    expect(w!.attrs).toEqual({});
    expect(w!.body).toBe('current_datetime: x');
    expect(w!.startOffset).toBe(0);
    expect(w!.endOffset).toBe(text.length);
  });

  it('parse 单 wrapper（带多 attrs）', () => {
    const text = '<context type="attached" filename="foo.pdf" stale_after_turn="msg-1">\n[文档: foo.pdf]\nbody\n</context>';
    const w = findFirstUserContextWrapper(text);
    expect(w).not.toBeNull();
    expect(w!.type).toBe('attached');
    expect(w!.attrs).toEqual({
      filename: 'foo.pdf',
      stale_after_turn: 'msg-1',
    });
    expect(w!.body).toBe('[文档: foo.pdf]\nbody');
  });

  it('parse 多 wrapper（findAll）', () => {
    const text =
      '前缀\n<context type="referenced" stale_after_turn="m1">\nref body 1\n</context>\n\n' +
      '<context type="attached" filename="a.pdf" stale_after_turn="m1">\nattached body\n</context>\n后缀';
    const all = findAllUserContextWrappers(text);
    expect(all).toHaveLength(2);
    expect(all[0]!.type).toBe('referenced');
    expect(all[1]!.type).toBe('attached');
    expect(all[1]!.attrs.filename).toBe('a.pdf');
  });

  it('老形态 `<context>` 无 type 属性 → 不命中（向后兼容）', () => {
    const text = '<context>\nold body\n</context>';
    expect(findFirstUserContextWrapper(text)).toBeNull();
  });

  it('老形态字符串前缀 `Referenced context data:` → 不命中', () => {
    const text = '用户问题\n\n---\nReferenced context data:\n## 表 schema...';
    expect(findFirstUserContextWrapper(text)).toBeNull();
  });

  it('老形态 `[文档: foo]` → 不命中', () => {
    const text = '[文档: foo.pdf]\n文档正文';
    expect(findFirstUserContextWrapper(text)).toBeNull();
  });

  it('parse 反向 XML attr 转义', () => {
    const text = '<context type="referenced" filename="a&amp;b&lt;c&gt;&quot;d">\nbody\n</context>';
    const w = findFirstUserContextWrapper(text);
    expect(w).not.toBeNull();
    expect(w!.attrs.filename).toBe('a&b<c>"d');
  });
});

describe('round-trip：build → parse → build', () => {
  it('environment 无 attrs', () => {
    const orig = buildUserContextWrapper('environment', 'body content');
    const parsed = findFirstUserContextWrapper(orig)!;
    const rebuilt = buildUserContextWrapper(
      parsed.type as 'environment',
      parsed.body,
      parsed.attrs,
    );
    expect(rebuilt).toBe(orig);
  });

  it('attached 带 filename + stale_after_turn', () => {
    const orig = buildUserContextWrapper('attached', '[文档: x.pdf]\ncontent', {
      filename: 'x.pdf',
      stale_after_turn: 'msg-abc',
    });
    const parsed = findFirstUserContextWrapper(orig)!;
    const rebuilt = buildUserContextWrapper(
      parsed.type as 'attached',
      parsed.body,
      parsed.attrs,
    );
    expect(rebuilt).toBe(orig);
  });

  it('特殊字符 attr round-trip', () => {
    const orig = buildUserContextWrapper('referenced', 'body', {
      filename: 'a&b<c>"',
    });
    const parsed = findFirstUserContextWrapper(orig)!;
    expect(parsed.attrs.filename).toBe('a&b<c>"');
    const rebuilt = buildUserContextWrapper(
      parsed.type as 'referenced',
      parsed.body,
      parsed.attrs,
    );
    expect(rebuilt).toBe(orig);
  });
});

describe('Python contract（byte-identical fixture）', () => {
  // Python 端 tests/test_user_context_wrapper.py 用同一组 fixture 验证字字节
  // 等价。这里登记 fixture，TS / Python 任一边改了渲染算法都会失败。

  it('fixture 1：environment 无 attrs', () => {
    expect(buildUserContextWrapper('environment', 'current_datetime: 2026-05-21'))
      .toBe('<context type="environment">\ncurrent_datetime: 2026-05-21\n</context>');
  });

  it('fixture 2：referenced + stale_after_turn', () => {
    expect(
      buildUserContextWrapper('referenced', '## 表: 营销表\n字段：name, age', {
        stale_after_turn: 'msg-123',
      }),
    ).toBe(
      '<context type="referenced" stale_after_turn="msg-123">\n## 表: 营销表\n字段：name, age\n</context>',
    );
  });

  it('fixture 3：attached + filename + stale_after_turn（字典序）', () => {
    expect(
      buildUserContextWrapper('attached', '[文档: foo.pdf]\ncontent', {
        filename: 'foo.pdf',
        stale_after_turn: 'msg-xyz',
      }),
    ).toBe(
      '<context type="attached" filename="foo.pdf" stale_after_turn="msg-xyz">\n[文档: foo.pdf]\ncontent\n</context>',
    );
  });

  it('fixture 4：转义字符', () => {
    expect(
      buildUserContextWrapper('attached', 'body', {
        filename: 'a&b"c<d>',
      }),
    ).toBe('<context type="attached" filename="a&amp;b&quot;c&lt;d&gt;">\nbody\n</context>');
  });
});

describe('VALID_USER_CONTEXT_WRAPPER_TYPES contract', () => {
  it('matches contract JSON (Python VALID_TYPES 对齐)', () => {
    expect([...VALID_USER_CONTEXT_WRAPPER_TYPES].sort()).toEqual(
      [...contractTypes].sort(),
    );
    expect(VALID_USER_CONTEXT_WRAPPER_TYPES).toContain('mode-reminder');
    expect(VALID_USER_CONTEXT_WRAPPER_TYPES).toContain('mode-transition-reminder');
  });
});
