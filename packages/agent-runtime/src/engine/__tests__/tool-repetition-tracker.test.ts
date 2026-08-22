/**
 * Wave 6 — Tool-repetition tracker 单元测试。
 *
 * 覆盖：
 *   - 阈值触发 notice / nudge（默认 2 / 3）
 *   - 30s 窗口过期 → 自然失效，不触发
 *   - 单调递增（同窗口内升级路径）
 *   - 末尾换 (tool, digest) → 计数归零（合理重试不误伤）
 *   - inputDigest 算法：相同 input 同 digest / 不同 input 不同 digest /
 *     UNDEFINED safe / 不可序列化 input safe
 *   - env 阈值覆盖（合法 / 边界 / 非法）
 *   - 配置非法回落默认
 *   - defensive 输入（空 tool / 不可序列化 input）
 *   - 文案构造不硬编码具体案例
 *
 * 集成测试（与 query.ts 主循环、stream events、system prompt 注入交互）见
 * `tests/tool-repetition-integration.test.ts`。
 */

import { describe, it, expect } from 'vitest';
import {
  ToolRepetitionTracker,
  isToolRepetitionStageUpgrade,
  buildToolRepetitionInputDigest,
  buildToolRepetitionNoticeContent,
  buildToolRepetitionNudgeContent,
  buildToolRepetitionNudgeSystemInjection,
  DEFAULT_TOOL_REPETITION_THRESHOLDS,
  DEFAULT_TOOL_REPETITION_WINDOW_MS,
  DEFAULT_TOOL_REPETITION_MAX_BUFFER,
  DEFAULT_TOOL_REPETITION_TRACKER_CONFIG,
} from '../guards/tool-repetition-tracker.js';

const ENV_NONE: NodeJS.ProcessEnv = {};

describe('ToolRepetitionTracker — defaults & basic threshold triggers', () => {
  it('exposes documented default config values (notice=2 / nudge=3 / window=30s)', () => {
    expect(DEFAULT_TOOL_REPETITION_THRESHOLDS).toEqual({ notice: 2, nudge: 3, terminate: 6 });
    expect(DEFAULT_TOOL_REPETITION_WINDOW_MS).toBe(30_000);
    expect(DEFAULT_TOOL_REPETITION_MAX_BUFFER).toBe(256);
    expect(DEFAULT_TOOL_REPETITION_TRACKER_CONFIG.enabled).toBe(true);
  });

  it('returns normal when buffer is empty', () => {
    const tracker = new ToolRepetitionTracker({ env: ENV_NONE, now: () => 1000 });
    expect(tracker.evaluate()).toEqual({ stage: 'normal', trigger: null });
  });

  it('triggers notice at exactly 2 same-input successes within window', () => {
    let now = 1_000_000;
    const tracker = new ToolRepetitionTracker({
      env: ENV_NONE,
      now: () => now,
    });

    tracker.recordSuccess({ tool: 'ask_user', input: { q: 'minimal?' } });
    expect(tracker.evaluate().stage).toBe('normal');

    now += 1000;
    tracker.recordSuccess({ tool: 'ask_user', input: { q: 'minimal?' } });

    const evaluation = tracker.evaluate();
    expect(evaluation.stage).toBe('notice');
    expect(evaluation.trigger?.tool).toBe('ask_user');
    expect(evaluation.trigger?.count).toBe(2);
    expect(evaluation.trigger?.windowMs).toBe(30_000);
  });

  it('triggers nudge at exactly 3 same-input successes within window', () => {
    let now = 1_000_000;
    const tracker = new ToolRepetitionTracker({
      env: ENV_NONE,
      now: () => now,
    });

    for (let i = 0; i < 2; i++) {
      tracker.recordSuccess({ tool: 'ask_user', input: { q: 'minimal?' } });
      now += 1000;
    }
    expect(tracker.evaluate().stage).toBe('notice');

    tracker.recordSuccess({ tool: 'ask_user', input: { q: 'minimal?' } });
    const evaluation = tracker.evaluate();
    expect(evaluation.stage).toBe('nudge');
    expect(evaluation.trigger?.count).toBe(3);
  });

  it('stays in nudge stage when count grows beyond nudge threshold (no regression)', () => {
    let now = 1_000_000;
    const tracker = new ToolRepetitionTracker({
      env: ENV_NONE,
      now: () => now,
    });

    for (let i = 0; i < 3; i++) {
      tracker.recordSuccess({ tool: 'ask_user', input: { q: 'x' } });
      now += 100;
    }
    expect(tracker.evaluate().stage).toBe('nudge');

    tracker.recordSuccess({ tool: 'ask_user', input: { q: 'x' } });
    const evaluation = tracker.evaluate();
    expect(evaluation.stage).toBe('nudge');
    expect(evaluation.trigger?.count).toBe(4);
  });
});

describe('ToolRepetitionTracker — window expiration semantics', () => {
  it('drops entries older than windowMs', () => {
    let now = 1_000_000;
    const tracker = new ToolRepetitionTracker({
      env: ENV_NONE,
      now: () => now,
    });

    // 第 1 次 @ ts=1_000_000
    tracker.recordSuccess({ tool: 'a', input: { x: 1 } });
    // 跨过 30s + 1
    now += 30_001;
    // 第 2 次 @ ts=1_030_001
    tracker.recordSuccess({ tool: 'a', input: { x: 1 } });

    // 窗口内只有第 2 次（第 1 次已过期）→ count=1 → normal
    expect(tracker.evaluate().stage).toBe('normal');
    expect(tracker.snapshot().length).toBe(1);
  });

  it('does NOT trigger when 3 calls span more than windowMs', () => {
    let now = 1_000_000;
    const tracker = new ToolRepetitionTracker({
      env: ENV_NONE,
      now: () => now,
    });

    // 三次调用跨越 90s（每次间隔 30s+），任何时刻窗口内最多 1 次
    for (let i = 0; i < 3; i++) {
      tracker.recordSuccess({ tool: 'a', input: { x: 1 } });
      now += 30_001;
    }
    expect(tracker.evaluate().stage).toBe('normal');
  });

  it('still triggers when calls cluster within window even if total span > window', () => {
    let now = 1_000_000;
    const tracker = new ToolRepetitionTracker({
      env: ENV_NONE,
      now: () => now,
    });

    // 第 1 次 @ ts=1_000_000，后 31s 已过期
    tracker.recordSuccess({ tool: 'a', input: { x: 1 } });
    now += 31_000;

    // 第 2、3、4 次集中在 5s 内 — 窗口内 3 次 → nudge
    for (let i = 0; i < 3; i++) {
      tracker.recordSuccess({ tool: 'a', input: { x: 1 } });
      now += 1000;
    }
    expect(tracker.evaluate().stage).toBe('nudge');
    expect(tracker.evaluate().trigger?.count).toBe(3);
  });

  it('evaluate() prunes expired entries even without new record', () => {
    let now = 1_000_000;
    const tracker = new ToolRepetitionTracker({
      env: ENV_NONE,
      now: () => now,
    });

    for (let i = 0; i < 3; i++) {
      tracker.recordSuccess({ tool: 'a', input: { x: 1 } });
      now += 100;
    }
    expect(tracker.evaluate().stage).toBe('nudge');

    // 时钟跨过 30s 但**不**新 record——下次 evaluate 应当 prune 干净 → normal
    now += 30_000;
    expect(tracker.evaluate().stage).toBe('normal');
    expect(tracker.snapshot().length).toBe(0);
  });

  // 技术 Review 3 §4.2 漏测补丁：cutoff 边界精确点
  // 验证 `pruneExpiredEntries` 用 `< cutoff` 而非 `<= cutoff` 语义
  // （ts === cutoff 时仍在窗口内）
  it('entry at exactly windowMs boundary is still in window (cutoff is strict <)', () => {
    let now = 1_000_000;
    const tracker = new ToolRepetitionTracker({
      env: ENV_NONE,
      now: () => now,
    });

    // entry @ ts=1_000_000
    tracker.recordSuccess({ tool: 'a', input: { x: 1 } });
    // 时钟前进恰好 windowMs（30_000）
    now += 30_000;
    // cutoff = now - windowMs = 1_000_000；entry.ts = 1_000_000；
    // 1_000_000 < 1_000_000 = false → entry **不**被 prune（仍在窗口内）
    tracker.recordSuccess({ tool: 'a', input: { x: 1 } });
    expect(tracker.snapshot().length).toBe(2);
    expect(tracker.evaluate().stage).toBe('notice');
  });

  it('entry at exactly windowMs+1 boundary is pruned (cutoff is strict <)', () => {
    let now = 1_000_000;
    const tracker = new ToolRepetitionTracker({
      env: ENV_NONE,
      now: () => now,
    });

    tracker.recordSuccess({ tool: 'a', input: { x: 1 } });
    // 时钟前进 windowMs + 1（30_001）
    now += 30_001;
    // cutoff = 1_000_001；entry.ts = 1_000_000 < 1_000_001 → 过期
    tracker.recordSuccess({ tool: 'a', input: { x: 1 } });
    expect(tracker.snapshot().length).toBe(1);
    expect(tracker.evaluate().stage).toBe('normal');
  });
});

describe('ToolRepetitionTracker — streak break semantics (sibling of tool-failure pop)', () => {
  it('different input on same tool starts fresh count (合理重试不误伤)', () => {
    let now = 1_000_000;
    const tracker = new ToolRepetitionTracker({
      env: ENV_NONE,
      now: () => now,
    });

    // 同 tool 不同 input：每次 evaluate 看末尾 (tool, digest)，count=1 → normal
    tracker.recordSuccess({ tool: 'grep_search', input: { pattern: 'foo' } });
    tracker.recordSuccess({ tool: 'grep_search', input: { pattern: 'bar' } });
    tracker.recordSuccess({ tool: 'grep_search', input: { pattern: 'baz' } });
    expect(tracker.evaluate().stage).toBe('normal');
  });

  it('different tool on same input starts fresh count', () => {
    let now = 1_000_000;
    const tracker = new ToolRepetitionTracker({
      env: ENV_NONE,
      now: () => now,
    });

    tracker.recordSuccess({ tool: 'tool_a', input: { x: 1 } });
    tracker.recordSuccess({ tool: 'tool_b', input: { x: 1 } });
    // 末尾是 (tool_b, x:1) count=1 → normal
    expect(tracker.evaluate().stage).toBe('normal');
  });

  it('counts non-consecutive same-input as long as both within window (任务要求：不要求连续)', () => {
    let now = 1_000_000;
    const tracker = new ToolRepetitionTracker({
      env: ENV_NONE,
      now: () => now,
    });

    // ask_user(X) → grep_search(Y) → ask_user(X)
    // 末尾是 ask_user(X)，窗口内 ask_user(X) 出现 2 次 → notice
    tracker.recordSuccess({ tool: 'ask_user', input: { q: 'x' } });
    tracker.recordSuccess({ tool: 'grep_search', input: { p: 'y' } });
    tracker.recordSuccess({ tool: 'ask_user', input: { q: 'x' } });

    const evaluation = tracker.evaluate();
    expect(evaluation.stage).toBe('notice');
    expect(evaluation.trigger?.count).toBe(2);
    expect(evaluation.trigger?.tool).toBe('ask_user');
  });
});

describe('ToolRepetitionTracker — inputDigest semantics', () => {
  it('exposes deterministic digest for same input', () => {
    const a = buildToolRepetitionInputDigest({ q: 'foo', n: 1 });
    const b = buildToolRepetitionInputDigest({ q: 'foo', n: 1 });
    expect(a).toBe(b);
    expect(a.length).toBe(32); // hex 32 字符 = 16 字节
  });

  it('different input → different digest', () => {
    const a = buildToolRepetitionInputDigest({ q: 'foo' });
    const b = buildToolRepetitionInputDigest({ q: 'bar' });
    expect(a).not.toBe(b);
  });

  it('UNDEFINED-safe: undefined / null → empty sentinel digest', () => {
    expect(buildToolRepetitionInputDigest(undefined)).toBe('');
    expect(buildToolRepetitionInputDigest(null)).toBe('');
  });

  it('non-serializable input safe (cycle / BigInt) → empty sentinel digest', () => {
    const cycle: Record<string, unknown> = { name: 'test' };
    cycle.self = cycle;
    expect(buildToolRepetitionInputDigest(cycle)).toBe('');

    // BigInt JSON.stringify 抛 TypeError，应回落到 sentinel
    expect(buildToolRepetitionInputDigest(BigInt(123))).toBe('');
  });

  it('two undefined-input calls trigger notice (无 input 工具的反复调用算复读)', () => {
    let now = 1_000_000;
    const tracker = new ToolRepetitionTracker({
      env: ENV_NONE,
      now: () => now,
    });

    tracker.recordSuccess({ tool: 'refresh_session' });
    tracker.recordSuccess({ tool: 'refresh_session' });
    expect(tracker.evaluate().stage).toBe('notice');
  });

  it('handles primitive input types (string / number / boolean)', () => {
    let now = 1_000_000;
    const tracker = new ToolRepetitionTracker({
      env: ENV_NONE,
      now: () => now,
    });

    tracker.recordSuccess({ tool: 'a', input: 'literal' });
    tracker.recordSuccess({ tool: 'a', input: 'literal' });
    expect(tracker.evaluate().stage).toBe('notice');
  });

  it('large input still digestible (no size cap on input)', () => {
    let now = 1_000_000;
    const tracker = new ToolRepetitionTracker({
      env: ENV_NONE,
      now: () => now,
    });

    const bigInput = { data: 'x'.repeat(10_000) };
    tracker.recordSuccess({ tool: 'parse_document', input: bigInput });
    tracker.recordSuccess({ tool: 'parse_document', input: bigInput });
    expect(tracker.evaluate().stage).toBe('notice');
  });

  // 技术 Review 3 §2.5 漏测补丁：empty obj/array/boolean 边界
  it('empty object/array still hashes deterministically (NOT conflated with undefined)', () => {
    const emptyObj = buildToolRepetitionInputDigest({});
    const emptyArr = buildToolRepetitionInputDigest([]);
    const undef = buildToolRepetitionInputDigest(undefined);
    expect(emptyObj).not.toBe('');
    expect(emptyArr).not.toBe('');
    expect(undef).toBe('');
    // 空对象与空数组 digest 必须不同（避免误判"调用空对象 + 调用空数组"为复读）
    expect(emptyObj).not.toBe(emptyArr);
  });

  it('boolean / number / string primitives all have distinct digests', () => {
    const dTrue = buildToolRepetitionInputDigest(true);
    const dFalse = buildToolRepetitionInputDigest(false);
    const dNum = buildToolRepetitionInputDigest(1);
    const dStr = buildToolRepetitionInputDigest('1');
    expect(dTrue).not.toBe(dFalse);
    expect(dTrue).not.toBe(dNum);
    // JSON.stringify(1) === '1', JSON.stringify('1') === '"1"' → 不同 digest
    expect(dNum).not.toBe(dStr);
  });

  // 技术 Review 3 §2.3 警告：cyclic input 的 trade-off 必须被显式文档化
  it('two different cyclic inputs are CONFLATED to empty sentinel (documented limitation)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cycle1: any = { kind: 'a' };
    cycle1.self = cycle1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cycle2: any = { kind: 'b' };
    cycle2.self = cycle2;
    // 已知 trade-off：两者 digest 都是空串 sentinel，会被视为同 input
    // 这是 non-throwing 优先的有意取舍（不可序列化 input 极罕见，且这种场景下
    // tracker 仍能保护用户免于"无 input 工具反复调用"的真实复读模式）
    expect(buildToolRepetitionInputDigest(cycle1)).toBe(
      buildToolRepetitionInputDigest(cycle2),
    );
    expect(buildToolRepetitionInputDigest(cycle1)).toBe('');
  });
});

describe('ToolRepetitionTracker — buffer overflow protection', () => {
  it('drops oldest entries when buffer overflows beyond maxBufferSize', () => {
    let now = 1_000_000;
    const tracker = new ToolRepetitionTracker({
      env: ENV_NONE,
      now: () => now,
      // 小 buffer 测试 overflow 行为；阈值同步降低让 overflow 后能稳定评估。
      // ：buffer floor 现以 terminate 为下限，显式给 terminate=5 让
      // maxBufferSize=5 不被撑大（floor=max(5,5)=5），保持 overflow 可控。
      config: {
        maxBufferSize: 5,
        thresholds: { notice: 2, nudge: 3, terminate: 5 },
        windowMs: 30_000,
      },
    });
    expect(tracker.getConfig().maxBufferSize).toBe(5);

    // 7 个 entry 进入 size=5 的 buffer：最早 2 个 tool_a 被挤出
    tracker.recordSuccess({ tool: 'tool_a', input: { x: 1 } });
    tracker.recordSuccess({ tool: 'tool_a', input: { x: 1 } });
    tracker.recordSuccess({ tool: 'tool_a', input: { x: 1 } });
    tracker.recordSuccess({ tool: 'tool_a', input: { x: 1 } });
    tracker.recordSuccess({ tool: 'tool_b', input: { y: 1 } });
    tracker.recordSuccess({ tool: 'tool_b', input: { y: 1 } });
    tracker.recordSuccess({ tool: 'tool_b', input: { y: 1 } });

    expect(tracker.snapshot().length).toBe(5);
    // 末尾 3 条是 (tool_b, y:1) → count=3 → nudge（仍 < terminate 5）
    expect(tracker.evaluate().trigger?.count).toBe(3);
    expect(tracker.evaluate().stage).toBe('nudge');
  });

  it('expands buffer when nudge threshold exceeds default buffer size', () => {
    const tracker = new ToolRepetitionTracker({
      env: ENV_NONE,
      config: {
        maxBufferSize: 5,
        thresholds: { notice: 8, nudge: 12 },
        windowMs: 30_000,
      },
    });
    // bufferSize=5 < nudge=12 → 自动撑大到 12
    expect(tracker.getConfig().maxBufferSize).toBeGreaterThanOrEqual(12);
  });
});

describe('ToolRepetitionTracker — env override', () => {
  it('overrides notice threshold from TABTIN_TOOL_REPETITION_NOTICE_COUNT (合法 1)', () => {
    // 单设 notice=1 配默认 nudge=3 → notice<nudge 合法 → 生效
    let now = 1_000_000;
    const tracker = new ToolRepetitionTracker({
      env: { TABTIN_TOOL_REPETITION_NOTICE_COUNT: '1' },
      now: () => now,
    });
    expect(tracker.getConfig().thresholds.notice).toBe(1);
    expect(tracker.getConfig().thresholds.nudge).toBe(3);

    tracker.recordSuccess({ tool: 'a', input: { x: 1 } });
    expect(tracker.evaluate().stage).toBe('notice');
  });

  it('falls back when env notice equals default nudge (notice<nudge invariant)', () => {
    // env 单设 notice=3 与默认 nudge=3 触发 invariant 失败 → 整 thresholds 回落
    // 这是有意设计（不局部修复以免反直觉），与 tool-failure-tracker 同惯例
    const tracker = new ToolRepetitionTracker({
      env: { TABTIN_TOOL_REPETITION_NOTICE_COUNT: '3' },
    });
    expect(tracker.getConfig().thresholds).toEqual(
      DEFAULT_TOOL_REPETITION_THRESHOLDS,
    );
  });

  it('overrides both thresholds simultaneously (合法组合)', () => {
    const tracker = new ToolRepetitionTracker({
      env: {
        TABTIN_TOOL_REPETITION_NOTICE_COUNT: '3',
        TABTIN_TOOL_REPETITION_NUDGE_COUNT: '5',
      },
    });
    // ：thresholds 现含 terminate 第三档（跟随合并，由专项测试覆盖），
    // 这里聚焦 notice/nudge 合并意图，用 toMatchObject 不约束 terminate。
    expect(tracker.getConfig().thresholds).toMatchObject({ notice: 3, nudge: 5 });
  });

  it('overrides windowMs from TABTIN_TOOL_REPETITION_WINDOW_MS', () => {
    const tracker = new ToolRepetitionTracker({
      env: { TABTIN_TOOL_REPETITION_WINDOW_MS: '60000' },
    });
    expect(tracker.getConfig().windowMs).toBe(60_000);
  });

  it('disables tracker when TABTIN_TOOL_REPETITION_TRACKER_ENABLED=false', () => {
    let now = 1_000_000;
    const tracker = new ToolRepetitionTracker({
      env: { TABTIN_TOOL_REPETITION_TRACKER_ENABLED: 'false' },
      now: () => now,
    });
    expect(tracker.getConfig().enabled).toBe(false);

    for (let i = 0; i < 10; i++) {
      tracker.recordSuccess({ tool: 'a', input: { x: 1 } });
    }
    expect(tracker.evaluate()).toEqual({ stage: 'normal', trigger: null });
  });

  it('falls back to defaults when env values are non-numeric', () => {
    const tracker = new ToolRepetitionTracker({
      env: {
        TABTIN_TOOL_REPETITION_NOTICE_COUNT: 'abc',
        TABTIN_TOOL_REPETITION_NUDGE_COUNT: 'NaN',
      },
    });
    expect(tracker.getConfig().thresholds).toEqual(
      DEFAULT_TOOL_REPETITION_THRESHOLDS,
    );
  });

  it('falls back when env value is negative / zero / out of range', () => {
    for (const bad of ['0', '-1', '999', '1.5e3']) {
      const t = new ToolRepetitionTracker({
        env: { TABTIN_TOOL_REPETITION_NOTICE_COUNT: bad },
      });
      expect(t.getConfig().thresholds.notice).toBe(
        DEFAULT_TOOL_REPETITION_THRESHOLDS.notice,
      );
    }
  });

  it('falls back when notice >= nudge invariant violated (env)', () => {
    const t = new ToolRepetitionTracker({
      env: {
        TABTIN_TOOL_REPETITION_NOTICE_COUNT: '5',
        TABTIN_TOOL_REPETITION_NUDGE_COUNT: '3',
      },
    });
    expect(t.getConfig().thresholds).toEqual(
      DEFAULT_TOOL_REPETITION_THRESHOLDS,
    );
  });

  it('falls back when windowMs out of range', () => {
    // < 1s
    const tLow = new ToolRepetitionTracker({
      env: { TABTIN_TOOL_REPETITION_WINDOW_MS: '500' },
    });
    expect(tLow.getConfig().windowMs).toBe(DEFAULT_TOOL_REPETITION_WINDOW_MS);
    // > 1h
    const tHigh = new ToolRepetitionTracker({
      env: { TABTIN_TOOL_REPETITION_WINDOW_MS: '7200000' },
    });
    expect(tHigh.getConfig().windowMs).toBe(DEFAULT_TOOL_REPETITION_WINDOW_MS);
  });

  it('explicit options.config overrides env', () => {
    const t = new ToolRepetitionTracker({
      env: { TABTIN_TOOL_REPETITION_NOTICE_COUNT: '3' },
      config: { thresholds: { notice: 4, nudge: 6 } },
    });
    expect(t.getConfig().thresholds).toMatchObject({ notice: 4, nudge: 6 });
  });

  it('accepts boolean alias values for enabled flag', () => {
    for (const onValue of ['on', '1', 'enabled', 'yes', 'true']) {
      const t = new ToolRepetitionTracker({
        env: { TABTIN_TOOL_REPETITION_TRACKER_ENABLED: onValue },
      });
      expect(t.getConfig().enabled).toBe(true);
    }
    for (const offValue of ['off', '0', 'disabled', 'no', 'false']) {
      const t = new ToolRepetitionTracker({
        env: { TABTIN_TOOL_REPETITION_TRACKER_ENABLED: offValue },
      });
      expect(t.getConfig().enabled).toBe(false);
    }
  });
});

describe('ToolRepetitionTracker — defensive input', () => {
  it('ignores recordSuccess with empty tool string', () => {
    const tracker = new ToolRepetitionTracker({ env: ENV_NONE, now: () => 1000 });
    tracker.recordSuccess({ tool: '', input: { x: 1 } });
    expect(tracker.snapshot().length).toBe(0);
  });

  it('ignores recordSuccess when disabled', () => {
    const tracker = new ToolRepetitionTracker({
      env: { TABTIN_TOOL_REPETITION_TRACKER_ENABLED: 'false' },
      now: () => 1000,
    });
    tracker.recordSuccess({ tool: 'a', input: { x: 1 } });
    expect(tracker.snapshot().length).toBe(0);
  });

  it('does not throw on cyclic input', () => {
    const tracker = new ToolRepetitionTracker({ env: ENV_NONE, now: () => 1000 });
    const cycle: Record<string, unknown> = { name: 'x' };
    cycle.self = cycle;
    expect(() => tracker.recordSuccess({ tool: 'a', input: cycle })).not.toThrow();
    expect(tracker.snapshot().length).toBe(1);
  });
});

describe('isToolRepetitionStageUpgrade', () => {
  it('undefined → notice is upgrade', () => {
    expect(isToolRepetitionStageUpgrade(undefined, 'notice')).toBe(true);
  });
  it('notice → nudge is upgrade', () => {
    expect(isToolRepetitionStageUpgrade('notice', 'nudge')).toBe(true);
  });
  it('notice → notice is not upgrade', () => {
    expect(isToolRepetitionStageUpgrade('notice', 'notice')).toBe(false);
  });
  it('nudge → notice is not upgrade (regression blocked)', () => {
    expect(isToolRepetitionStageUpgrade('nudge', 'notice')).toBe(false);
  });
  it('any → normal is not upgrade (consumer should reset state separately)', () => {
    expect(isToolRepetitionStageUpgrade(undefined, 'normal')).toBe(false);
    expect(isToolRepetitionStageUpgrade('notice', 'normal')).toBe(false);
    expect(isToolRepetitionStageUpgrade('nudge', 'normal')).toBe(false);
  });
});

describe('文案构造 — 不硬编码具体案例 + 含动作化引导', () => {
  // W4 (2026-05-11): ask 三件套合一为单 `ask_user`（AskUserQuestion 协议）。
  const trigger = {
    tool: 'ask_user',
    inputDigest: 'abcd1234abcd1234abcd1234abcd1234',
    count: 3,
    windowMs: 30_000,
  };

  it('notice content carries count + window + raw tool (jsonl 离线排查友好) + 中性主语 + escape 句', () => {
    const text = buildToolRepetitionNoticeContent(trigger);
    expect(text).toContain('3');
    expect(text).toContain('ask_user');
    expect(text).toContain('30');
    // 用「」全角括号包工具名（chat 流不渲染 markdown，反引号会显示字面字符）
    expect(text).toContain('「ask_user」');
    expect(text).not.toContain('`ask_user`');
    // 不硬编码具体案例
    expect(text).not.toContain('calculator');
    // 主语用"工具"避免问责姿态（与 tool-failure-tracker 同设计）
    expect(text).toMatch(/工具/);
    expect(text).not.toMatch(/Agent\s*在|Agent\s*已经/);
    // 含 TabTin 产品主语
    expect(text).toContain('TabTin');
    expect(text).toMatch(/关注|主动提示|相同输入/);
    // 真实用户视角 review L6-5 修复：用户主动重做的 escape 句
    expect(text).toMatch(/可以忽略|让 Agent 重做/);
  });

  it('nudge content carries count + window + product 姿态 + raw tool for jsonl + 用户接管把手', () => {
    const text = buildToolRepetitionNudgeContent(trigger);
    expect(text).toContain('3');
    expect(text).toContain('ask_user');
    expect(text).toContain('「ask_user」');
    expect(text).toContain('TabTin');
    expect(text).toMatch(/工具/);
    expect(text).not.toMatch(/反复失败|Agent\s*反复/);
    // 真实用户视角 review L6-3 修复：用户接管把手（让用户知道 nudge 后能主动给指令）
    expect(text).toMatch(/你可以|新指令|换个方式/);
  });

  it('中文 nudge injection has structural [系统 / 重复检测] header + 4 actions', () => {
    const text = buildToolRepetitionNudgeSystemInjection(trigger);
    expect(text).toContain('[系统 / 重复检测]');
    expect(text).toContain('ask_user');
    expect(text).toContain('3');
    expect(text).toContain('30 秒');
    // 必须明确的关键禁令
    expect(text).toMatch(/不要用相同输入重发/);
    // 必须 4 条可选动作（re-read / different input / continue / summarise）
    expect(text).toMatch(/回看.*tool_result/);
    expect(text).toMatch(/不同的输入/);
    expect(text).toMatch(/继续任务的下一步/);
    expect(text).toMatch(/总结目前的进展并结束本轮/);
    // 不硬编码具体案例
    expect(text).not.toContain('calculator');
    expect(text).not.toContain('minimal');
  });

  it('returns same [系统 / 重复检测] header for any (tool) combination', () => {
    const a = buildToolRepetitionNudgeSystemInjection({
      tool: 'web_search',
      inputDigest: 'xxxx',
      count: 5,
      windowMs: 30_000,
    });
    const b = buildToolRepetitionNudgeSystemInjection({
      tool: 'tabtin_browser_open',
      inputDigest: 'yyyy',
      count: 4,
      windowMs: 60_000,
    });
    expect(a).toContain('[系统 / 重复检测]');
    expect(b).toContain('[系统 / 重复检测]');
    expect(a).toContain('web_search');
    expect(b).toContain('tabtin_browser_open');
    // 不同 windowMs 应反映在文案中
    expect(a).toContain('30 秒');
    expect(b).toContain('60 秒');
  });

  // 与 tool-failure-tracker 同款：不引用已下线的 ask_question 工具
  it('NEVER references deprecated `ask_question` tool', () => {
    const text = buildToolRepetitionNudgeSystemInjection(trigger);
    expect(text).not.toContain('ask_question');
  });

  // 不引用 inputDigest（虽然只是 hash，也是间接指纹，符合 stream payload 隐私同模式）
  it('does NOT leak raw inputDigest into LLM-facing nudge text', () => {
    const text = buildToolRepetitionNudgeSystemInjection(trigger);
    expect(text).not.toContain(trigger.inputDigest);
  });
});

describe('ToolRepetitionTracker — composite scenarios', () => {
  it('window expires → tracker resets, next cluster triggers fresh notice/nudge', () => {
    let now = 1_000_000;
    const tracker = new ToolRepetitionTracker({
      env: ENV_NONE,
      now: () => now,
    });

    // 第一窗口：3 次同 input → nudge
    for (let i = 0; i < 3; i++) {
      tracker.recordSuccess({ tool: 'a', input: { x: 1 } });
      now += 100;
    }
    expect(tracker.evaluate().stage).toBe('nudge');

    // 跨过 30s+ → 全部过期
    now += 31_000;
    expect(tracker.evaluate().stage).toBe('normal');

    // 第二窗口：再 2 次 → notice 新触发
    for (let i = 0; i < 2; i++) {
      tracker.recordSuccess({ tool: 'a', input: { x: 1 } });
      now += 100;
    }
    expect(tracker.evaluate().stage).toBe('notice');
  });

  it('mixed tools and inputs — only the active tail (tool, digest) counts', () => {
    let now = 1_000_000;
    const tracker = new ToolRepetitionTracker({
      env: ENV_NONE,
      now: () => now,
    });

    // [(A, x), (A, x), (B, y), (B, y), (B, y)]
    tracker.recordSuccess({ tool: 'a', input: { v: 1 } });
    tracker.recordSuccess({ tool: 'a', input: { v: 1 } });
    tracker.recordSuccess({ tool: 'b', input: { w: 1 } });
    tracker.recordSuccess({ tool: 'b', input: { w: 1 } });
    tracker.recordSuccess({ tool: 'b', input: { w: 1 } });

    // 末尾 (B, y) count=3 → nudge
    const evaluation = tracker.evaluate();
    expect(evaluation.stage).toBe('nudge');
    expect(evaluation.trigger?.tool).toBe('b');
    expect(evaluation.trigger?.count).toBe(3);
  });

  // 关键：calculator dogfood 模拟 —— 4 次同 ask_user 同 input 调用
  // W4 (2026-05-11): ask 三件套合一为单 `ask_user`（AskUserQuestion 协议）。
  // dogfood 原始 case 是 ask_choice 4 次重复，现在 LLM 直接调 ask_user。
  it('reproduces calculator dogfood: 4 ask_user with identical input → nudge by 3rd call', () => {
    let now = 1_000_000;
    const tracker = new ToolRepetitionTracker({
      env: ENV_NONE,
      now: () => now,
    });

    const calculatorInput = {
      questions: [
        {
          question: 'Choose a calculator visual style',
          options: ['minimal', 'colorful', 'retro'],
        },
      ],
    };

    // 第 1 次：合法
    tracker.recordSuccess({ tool: 'ask_user', input: calculatorInput });
    expect(tracker.evaluate().stage).toBe('normal');
    now += 5000;

    // 第 2 次：notice
    tracker.recordSuccess({ tool: 'ask_user', input: calculatorInput });
    expect(tracker.evaluate().stage).toBe('notice');
    now += 5000;

    // 第 3 次：nudge —— runtime 必须介入
    tracker.recordSuccess({ tool: 'ask_user', input: calculatorInput });
    expect(tracker.evaluate().stage).toBe('nudge');
    now += 5000;

    // 第 4 次：仍 nudge（不 regression）
    tracker.recordSuccess({ tool: 'ask_user', input: calculatorInput });
    expect(tracker.evaluate().stage).toBe('nudge');
  });
});

// ─── ：terminate 硬熔断档 ──────────────────────────────────────
describe('ToolRepetitionTracker — terminate hard-stop ()', () => {
  const repeatedInput = { question: 'pick one', mode: 'minimal' };

  it('exposes default terminate threshold = 6', () => {
    expect(DEFAULT_TOOL_REPETITION_THRESHOLDS.terminate).toBe(6);
  });

  it('triggers terminate at exactly 6 same-input repetitions', () => {
    let now = 1_000_000;
    const tracker = new ToolRepetitionTracker({ env: ENV_NONE, now: () => now });
    for (let i = 0; i < 5; i++) {
      tracker.recordSuccess({ tool: 'ask_form', input: repeatedInput });
      now += 1000;
    }
    // 5 次仍 nudge（< terminate 6）
    expect(tracker.evaluate().stage).toBe('nudge');

    tracker.recordSuccess({ tool: 'ask_form', input: repeatedInput });
    const evaluation = tracker.evaluate();
    expect(evaluation.stage).toBe('terminate');
    expect(evaluation.trigger?.count).toBe(6);
    expect(evaluation.trigger?.tool).toBe('ask_form');
  });

  it('different input each time does not count toward terminate', () => {
    let now = 1_000_000;
    const tracker = new ToolRepetitionTracker({ env: ENV_NONE, now: () => now });
    for (let i = 0; i < 6; i++) {
      tracker.recordSuccess({ tool: 'ask_form', input: { n: i } });
      now += 1000;
    }
    // 末尾 (tool, digest) count=1 → normal（合理的不同输入重试不误伤）
    expect(tracker.evaluate().stage).toBe('normal');
  });

  it('isToolRepetitionStageUpgrade treats terminate as the highest stage', () => {
    expect(isToolRepetitionStageUpgrade('nudge', 'terminate')).toBe(true);
    expect(isToolRepetitionStageUpgrade('notice', 'terminate')).toBe(true);
    expect(isToolRepetitionStageUpgrade(undefined, 'terminate')).toBe(true);
    expect(isToolRepetitionStageUpgrade('terminate', 'terminate')).toBe(false);
  });

  it('env TABTIN_TOOL_REPETITION_TERMINATE_COUNT overrides threshold', () => {
    let now = 1_000_000;
    const tracker = new ToolRepetitionTracker({
      env: { TABTIN_TOOL_REPETITION_TERMINATE_COUNT: '4' },
      now: () => now,
    });
    expect(tracker.getConfig().thresholds.terminate).toBe(4);
    for (let i = 0; i < 4; i++) {
      tracker.recordSuccess({ tool: 'ask_form', input: repeatedInput });
      now += 1000;
    }
    expect(tracker.evaluate().stage).toBe('terminate');
  });
});
