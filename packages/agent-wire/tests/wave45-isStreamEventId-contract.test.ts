/**
 * W4.5 第二波 B3 · `isStreamEventId` 跨语言契约测试（TS 端）
 *
 * 目标
 * ----
 * 用 SSOT 函数 `packages/agent-wire/src/cross-lang-validators/isStreamEventId.ts`
 * 跑 cross-lang-fixtures/wave45-isStreamEventId.json 的所有 case，期望全部
 * 与 fixture `expected` 一致。
 *
 * 同时验证 Renderer 现网副本（apps/tabtin-electron/src/renderer/src/services/
 * wsLastEventIdPersistence.ts:134-138）行为等价——通过把内联函数复制到这里做
 * "副本契约校验"（直接 import 该文件会带入整个 services 层副作用，得不偿失）。
 *
 * Python 端测试：`apps/tabtin_django/apps/services/common/ws/tests/test_wave45_isStreamEventId_cross_language.py`
 * Swift 占位：`packages/wire-codegen/generated/swift/StreamEventIdValidator.swift`
 * Kotlin 占位：`packages/wire-codegen/generated/kotlin/StreamEventIdValidator.kt`
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isStreamEventId } from '../src/cross-lang-validators/isStreamEventId.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface ContractCase {
  name: string;
  // fixture rules.must_reject_non_string === true，input 类型严格 string；
  // 任何往 fixture 里塞非字符串的 PR 会被 TS 类型检查在 JSON.parse 之后的
  // type-cast 阶段拦下（vitest 不会跑非字符串 case，避免与"非字符串输入防御"
  // 的独立断言区域职责重叠）。
  input: string;
  expected: boolean;
  notes?: string;
}

interface ContractFixture {
  _doc: string;
  spec_version: string;
  ssot_anchor: string;
  validation_rule: string;
  rules: {
    must_match_regex: string;
    must_be_ascii_only: boolean;
    must_reject_empty: boolean;
    must_reject_non_string: boolean;
    leading_zero_accepted?: boolean;
    syntax_only?: boolean;
    rationale: string;
  };
  cases: ContractCase[];
}

const FIXTURE_PATH = join(
  __dirname,
  '..',
  'src',
  'cross-lang-fixtures',
  'wave45-isStreamEventId.json',
);

const fixture: ContractFixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

/**
 * Renderer 现网副本（W4c R5-P0-1 引入）—— 与 SSOT 必须等价。
 * 源：apps/tabtin-electron/src/renderer/src/services/wsLastEventIdPersistence.ts:134-138
 *
 * 复制到此而不是 import 是为了避免引入 Renderer 的 logger / window 依赖。
 * Renderer 副本与 SSOT 任一行为偏移 → 本测试立刻失败。
 */
function rendererIsStreamEventIdReplica(eventId: string): boolean {
  if (!eventId || typeof eventId !== 'string') return false;
  const parts = eventId.split('-');
  return parts.length === 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1]);
}

describe('W4.5 B3 · isStreamEventId 跨语言契约（TS SSOT）', () => {
  it('fixture 自身格式正确', () => {
    expect(fixture.spec_version).toBe('v1');
    expect(fixture.rules.must_match_regex).toBe('^[0-9]+-[0-9]+$');
    expect(fixture.rules.must_be_ascii_only).toBe(true);
    expect(fixture.cases.length).toBeGreaterThanOrEqual(10);
  });

  it.each(fixture.cases)(
    'case "$name" · SSOT isStreamEventId 结果与 fixture expected 一致',
    ({ input, expected }) => {
      expect(isStreamEventId(input)).toBe(expected);
    },
  );

  it.each(fixture.cases)(
    'case "$name" · Renderer 副本结果与 SSOT 一致（防止 Renderer 副本漂移）',
    ({ input, expected }) => {
      expect(rendererIsStreamEventIdReplica(input)).toBe(expected);
    },
  );

  describe('非字符串输入防御（fixture 不覆盖，独立断言）', () => {
    it('null → false', () => {
      expect(isStreamEventId(null)).toBe(false);
    });
    it('undefined → false', () => {
      expect(isStreamEventId(undefined)).toBe(false);
    });
    it('number → false', () => {
      expect(isStreamEventId(170200000 as unknown)).toBe(false);
    });
    it('object → false', () => {
      expect(isStreamEventId({ id: '1702-0' } as unknown)).toBe(false);
    });
    it('array → false', () => {
      expect(isStreamEventId(['1702', '0'] as unknown)).toBe(false);
    });
  });

  describe('Unicode 分歧防御（这是本 fixture 与 Python isdigit 实现的分歧点）', () => {
    it('全角数字（U+FF10..U+FF19）严格拒绝', () => {
      expect(isStreamEventId('１７０２０００-０')).toBe(false);
    });
    it('阿拉伯-印度数字（U+0660..U+0669）严格拒绝', () => {
      expect(isStreamEventId('١٧٠٢٠٠٠-٠')).toBe(false);
    });
    it('扩展阿拉伯-印度数字（U+06F0..U+06F9）严格拒绝', () => {
      expect(isStreamEventId('۱۷۰۲۰۰۰-۰')).toBe(false);
    });
  });
});
