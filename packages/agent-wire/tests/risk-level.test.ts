/**
 * risk-level.test.ts —  风险分级双词表归一契约。
 */

import { describe, it, expect } from 'vitest';
import {
  ApprovalWireRiskLevelSchema,
  normalizeToRegistrationRiskLevel,
  normalizeToWireRiskLevel,
  inferWireRiskLevelFromTool,
  inferWireRiskLevelForToolCall,
} from '../src/risk-level.js';

describe('normalizeToWireRiskLevel — 注册表 → wire', () => {
  it.each([
    ['safe', 'low'],
    ['review', 'medium'],
    ['strict', 'high'],
    ['high', 'high'],
  ] as const)('%s → %s', (input, expected) => {
    expect(normalizeToWireRiskLevel(input)).toBe(expected);
  });
});

describe('normalizeToWireRiskLevel — wire 直通 + 旧值兼容', () => {
  it.each(['low', 'medium', 'high'] as const)('保留 %s', (level) => {
    expect(normalizeToWireRiskLevel(level)).toBe(level);
  });

  it('大小写不敏感', () => {
    expect(normalizeToWireRiskLevel('STRICT')).toBe('high');
    expect(normalizeToWireRiskLevel(' Review ')).toBe('medium');
  });

  it('未知字符串 fallback medium', () => {
    expect(normalizeToWireRiskLevel('bogus')).toBe('medium');
    expect(normalizeToWireRiskLevel(undefined)).toBe('medium');
    expect(normalizeToWireRiskLevel(null, 'low')).toBe('low');
  });

  it('contracts critical → high', () => {
    expect(normalizeToWireRiskLevel('critical')).toBe('high');
  });
});

describe('normalizeToRegistrationRiskLevel — wire → 注册表', () => {
  it.each([
    ['low', 'safe'],
    ['medium', 'review'],
    ['high', 'strict'],
    ['safe', 'safe'],
    ['review', 'review'],
    ['strict', 'strict'],
  ] as const)('%s → %s', (input, expected) => {
    expect(normalizeToRegistrationRiskLevel(input)).toBe(expected);
  });

  it('未知值返回 null', () => {
    expect(normalizeToRegistrationRiskLevel('critical')).toBeNull();
    expect(normalizeToRegistrationRiskLevel(42)).toBeNull();
  });
});

describe('inferWireRiskLevelFromTool — 优先级', () => {
  it('优先 Tool.riskLevel=strict，忽略 isReadOnly=true', () => {
    expect(inferWireRiskLevelFromTool({ riskLevel: 'strict', isReadOnly: true })).toBe('high');
  });

  it('riskLevel=safe → low', () => {
    expect(inferWireRiskLevelFromTool({ riskLevel: 'safe', isReadOnly: false })).toBe('low');
  });

  it('riskLevel=review → medium', () => {
    expect(inferWireRiskLevelFromTool({ riskLevel: 'review' })).toBe('medium');
  });

  it('无 riskLevel 时 fallback isReadOnly', () => {
    expect(inferWireRiskLevelFromTool({ isReadOnly: true })).toBe('low');
    expect(inferWireRiskLevelFromTool({ isReadOnly: false })).toBe('medium');
    expect(inferWireRiskLevelFromTool({})).toBe('medium');
  });

  it('非法 riskLevel 字符串 fallback isReadOnly', () => {
    expect(inferWireRiskLevelFromTool({ riskLevel: 'unknown', isReadOnly: true })).toBe('low');
    expect(inferWireRiskLevelFromTool({ riskLevel: 'unknown', isReadOnly: false })).toBe('medium');
  });
});

describe('inferWireRiskLevelForToolCall — isWriteOp(input)', () => {
  it('无 riskLevel 时按 isWriteOp 区分 low/medium', () => {
    const tool = {
      isReadOnly: false,
      isWriteOp: (input: unknown) => {
        const cmd = (input as { command?: string })?.command ?? '';
        return cmd.startsWith('rm');
      },
    };
    expect(inferWireRiskLevelForToolCall(tool, { command: 'grep x f' })).toBe('low');
    expect(inferWireRiskLevelForToolCall(tool, { command: 'rm -f f' })).toBe('medium');
  });

  it('显式 riskLevel 仍优先', () => {
    expect(inferWireRiskLevelForToolCall(
      { riskLevel: 'strict', isWriteOp: () => false },
      {},
    )).toBe('high');
  });
});

describe('ApprovalWireRiskLevelSchema — schema 层双向收 + wire 输出', () => {
  it.each([
    ['safe', 'low'],
    ['review', 'medium'],
    ['strict', 'high'],
    ['medium', 'medium'],
  ] as const)('输入 %s 输出 %s', (input, expected) => {
    expect(ApprovalWireRiskLevelSchema.parse(input)).toBe(expected);
  });

  it('contracts critical 归一为 high', () => {
    expect(ApprovalWireRiskLevelSchema.parse('critical')).toBe('high');
  });

  it('缺失值 preprocess 默认 medium（旧 payload 兼容）', () => {
    expect(ApprovalWireRiskLevelSchema.parse(undefined)).toBe('medium');
  });
});
