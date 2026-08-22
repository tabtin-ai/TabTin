/**
 * ST-002 回归测试：terminal-core denylist 补充 pkill 规则
 *
 * 问题：kill 规则原正则 \b(kill|killall)\b 完全未覆盖 pkill，
 * 导致 pkill -f <pattern> 可绕过 denylist，在 agent 场景下可误杀自身进程。
 * CLAUDE.md 明确禁止 pkill -f。
 *
 * 修复：将 pattern 改为 \b(kill|killall|pkill)\b，统一拦截三种进程杀死命令。
 */
import { describe, it, expect } from 'vitest';
import { CommandValidator } from '../src/commandValidator';

describe('ST-002: pkill 规则 — denylist 覆盖回归', () => {
  const validator = new CommandValidator();

  // ── pkill 各形式必须被拦截 ──

  it('pkill chrome 被拦截', () => {
    const result = validator.validate('pkill chrome');
    expect(result.allowed).toBe(false);
    expect(result.decision).toBe('deny');
  });

  it('pkill -f tabtin-agent 被拦截（CLAUDE.md 明确禁止）', () => {
    const result = validator.validate('pkill -f tabtin-agent');
    expect(result.allowed).toBe(false);
    expect(result.decision).toBe('deny');
  });

  it('pkill -9 node 被拦截', () => {
    const result = validator.validate('pkill -9 node');
    expect(result.allowed).toBe(false);
    expect(result.decision).toBe('deny');
  });

  it('pkill -KILL python 被拦截', () => {
    const result = validator.validate('pkill -KILL python');
    expect(result.allowed).toBe(false);
    expect(result.decision).toBe('deny');
  });

  it('管道中的 pkill 被拦截', () => {
    const result = validator.validate('echo ok && pkill myapp');
    expect(result.allowed).toBe(false);
    expect(result.decision).toBe('deny');
  });

  // ── 原有 kill / killall 规则不受影响 ──

  it('kill 1234 仍被拦截', () => {
    const result = validator.validate('kill 1234');
    expect(result.allowed).toBe(false);
  });

  it('killall node 仍被拦截', () => {
    const result = validator.validate('killall node');
    expect(result.allowed).toBe(false);
  });

  // ── 不误报（关键词出现在参数字符串中）──

  it('echo "pkill is forbidden" 被 allowlist 放行（echo 先于 denylist 通过）', () => {
    // echo 在 allowlist 中，validator 在 allowlist 命中后不再检查 denylist，
    // 因此参数字符串中包含 pkill 不会触发拦截。这是当前设计的预期行为。
    const result = validator.validate('echo "pkill is forbidden"');
    expect(result.allowed).toBe(true);
    expect(result.decision).toBe('allow');
  });
});
