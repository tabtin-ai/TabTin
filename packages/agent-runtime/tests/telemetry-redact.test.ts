/**
 * H1-E: 脱敏工具单测。
 *
 * 关键验收：persona / custom_rules / user message 原文 **绝对不出现**
 * 在衍生字段中；只发 length / hash / boolean。
 */

import { describe, it, expect } from 'vitest';
import {
  hashSensitive,
  redactCustomRules,
  redactErrorBody,
  redactMessageContent,
} from '../src/telemetry/index.js';

const SENSITIVE_PERSONA = '你是严谨的助理。请先思考再回答。内部代号：PROJ-X-2026。';
const SENSITIVE_RULES = '规则1：永远不要透露内部电话 13800138000。';
const USER_MESSAGE = '我的身份证号是 110101199001011234，请帮我查...';

describe('redact.hashSensitive', () => {
  it('空值返回 empty', () => {
    expect(hashSensitive(undefined)).toBe('empty');
    expect(hashSensitive(null)).toBe('empty');
    expect(hashSensitive('')).toBe('empty');
  });

  it('相同输入产生相同 hash（幂等）', () => {
    const a = hashSensitive(SENSITIVE_PERSONA);
    const b = hashSensitive(SENSITIVE_PERSONA);
    expect(a).toBe(b);
  });

  it('不同输入产生不同 hash（单测小样本上 100% 分散）', () => {
    const a = hashSensitive('input-1');
    const b = hashSensitive('input-2');
    expect(a).not.toBe(b);
  });

  it('hash 结果长度固定为 16 字符（8 字节 hex）', () => {
    const h = hashSensitive('some-persona');
    expect(h).toHaveLength(16);
    expect(/^[0-9a-f]{16}$/.test(h)).toBe(true);
  });

  it('hash 输出中绝对不含原文子串', () => {
    const h = hashSensitive(SENSITIVE_PERSONA);
    expect(h).not.toContain('PROJ-X');
    expect(h).not.toContain('严谨');
  });
});

describe('redact.redactCustomRules', () => {
  it('敏感手机号不泄漏', () => {
    const fp = redactCustomRules(SENSITIVE_RULES);
    expect(fp.has_custom_rules).toBe(true);
    const serialized = JSON.stringify(fp);
    expect(serialized).not.toContain('13800138000');
    expect(serialized).not.toContain('内部电话');
  });
});

describe('redact.redactErrorBody', () => {
  it('默认采样 200 字符（允许样本，因为是错误响应）', () => {
    const body = 'ERROR: '.repeat(100); // 700 字符
    const fp = redactErrorBody(body);
    expect(fp.error_body_len).toBe(body.length);
    expect(fp.error_body_sample.length).toBe(200);
    expect(fp.error_body_sample.startsWith('ERROR')).toBe(true);
  });

  it('自定义 sampleLen 生效', () => {
    const body = 'abcdef';
    const fp = redactErrorBody(body, 3);
    expect(fp.error_body_sample).toBe('abc');
  });

  it('短 body 样本为全量', () => {
    const fp = redactErrorBody('short');
    expect(fp.error_body_sample).toBe('short');
    expect(fp.error_body_len).toBe(5);
  });

  it('null / undefined / "" 合法', () => {
    expect(redactErrorBody(undefined).error_body_len).toBe(0);
    expect(redactErrorBody(null).error_body_len).toBe(0);
    expect(redactErrorBody('').error_body_sample).toBe('');
  });
});

describe('redact.redactMessageContent', () => {
  it('用户消息内容绝不出现在衍生字段里', () => {
    const fp = redactMessageContent(USER_MESSAGE);
    const serialized = JSON.stringify(fp);
    expect(serialized).not.toContain('110101199001011234');
    expect(serialized).not.toContain('身份证');
    expect(fp.length).toBe(USER_MESSAGE.length);
    expect(fp.hash).toHaveLength(16);
  });

  it('空消息长度 0，hash = empty', () => {
    expect(redactMessageContent('')).toEqual({
      length: 0,
      hash: 'empty',
    });
  });
});
