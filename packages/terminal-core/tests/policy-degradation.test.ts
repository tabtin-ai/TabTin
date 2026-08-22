/**
 * evaluateTerminalPolicyDegradation 测试
 * 验证降级评估函数在不同策略组合下的正确行为。
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateTerminalPolicyDegradation,
  getInteractiveTerminalPolicySupportError,
} from '../src/policy';

describe('evaluateTerminalPolicyDegradation', () => {
  it('route=sandbox → canDegrade=true, reason=sandbox_not_supported_in_pty', () => {
    const decision = evaluateTerminalPolicyDegradation({ route: 'sandbox', sandboxLevel: 'filesystem' });
    expect(decision).not.toBeNull();
    expect(decision!.canDegrade).toBe(true);
    expect(decision!.reason).toBe('sandbox_not_supported_in_pty');
    expect(decision!.sandboxConfig.route).toBe('sandbox');
    expect(decision!.sandboxConfig.sandboxLevel).toBe('filesystem');
  });

  it('route=sandbox with full config preserves all sandbox fields', () => {
    const decision = evaluateTerminalPolicyDegradation({
      route: 'sandbox',
      sandboxLevel: 'complete',
      networkMode: 'blocked',
      relaxedRules: ['curl-mutating'],
    });
    expect(decision).not.toBeNull();
    expect(decision!.canDegrade).toBe(true);
    expect(decision!.sandboxConfig).toEqual({
      route: 'sandbox',
      sandboxLevel: 'complete',
      networkMode: 'blocked',
      relaxedRules: ['curl-mutating'],
    });
  });

  it('route=blocked → null (不可降级)', () => {
    const decision = evaluateTerminalPolicyDegradation({
      route: 'blocked',
      denyReason: 'dangerous command',
    });
    expect(decision).toBeNull();
  });

  it('route=sandbox 不传 sandboxLevel → fallback 到 filesystem', () => {
    const decision = evaluateTerminalPolicyDegradation({ route: 'sandbox' });
    expect(decision).not.toBeNull();
    expect(decision!.canDegrade).toBe(true);
    expect(decision!.sandboxConfig.sandboxLevel).toBe('filesystem');
  });

  it('route=regular + networkMode=blocked → canDegrade=true, reason=network_restriction_not_supported', () => {
    const decision = evaluateTerminalPolicyDegradation({
      route: 'regular',
      networkMode: 'blocked',
    });
    expect(decision).not.toBeNull();
    expect(decision!.canDegrade).toBe(true);
    expect(decision!.reason).toBe('network_restriction_not_supported');
    expect(decision!.sandboxConfig.route).toBe('regular');
    expect(decision!.sandboxConfig.networkMode).toBe('blocked');
    expect(decision!.sandboxConfig.sandboxLevel).toBe('filesystem');
  });

  it('route=regular + networkMode=custom → canDegrade=true', () => {
    const decision = evaluateTerminalPolicyDegradation({
      route: 'regular',
      networkMode: 'custom',
    });
    expect(decision).not.toBeNull();
    expect(decision!.canDegrade).toBe(true);
    expect(decision!.reason).toBe('network_restriction_not_supported');
  });

  it('route=regular + networkMode=allowed → null（无需降级）', () => {
    const decision = evaluateTerminalPolicyDegradation({
      route: 'regular',
      networkMode: 'allowed',
    });
    expect(decision).toBeNull();
  });

  it('无策略 → null', () => {
    expect(evaluateTerminalPolicyDegradation(null)).toBeNull();
    expect(evaluateTerminalPolicyDegradation(undefined)).toBeNull();
    expect(evaluateTerminalPolicyDegradation({})).toBeNull();
  });

  it('snake_case payload (TerminalExecutionPolicyPayload) 同样可被评估', () => {
    const decision = evaluateTerminalPolicyDegradation({
      route: 'sandbox',
      sandbox_level: 'complete',
      network_mode: 'blocked',
      relaxed_rules: ['curl-mutating'],
    });
    expect(decision).not.toBeNull();
    expect(decision!.canDegrade).toBe(true);
    expect(decision!.sandboxConfig.sandboxLevel).toBe('complete');
    expect(decision!.sandboxConfig.networkMode).toBe('blocked');
  });

  it('与 getInteractiveTerminalPolicySupportError 配合：仅在有错误时降级有意义', () => {
    const policy = { route: 'sandbox' as const, sandboxLevel: 'filesystem' as const };
    const error = getInteractiveTerminalPolicySupportError(policy);
    expect(error).not.toBeNull();

    const decision = evaluateTerminalPolicyDegradation(policy);
    expect(decision).not.toBeNull();
    expect(decision!.canDegrade).toBe(true);
  });

  it('route=regular 无特殊限制 → 无错误也无降级', () => {
    const policy = { route: 'regular' as const };
    const error = getInteractiveTerminalPolicySupportError(policy);
    expect(error).toBeNull();

    const decision = evaluateTerminalPolicyDegradation(policy);
    expect(decision).toBeNull();
  });
});
