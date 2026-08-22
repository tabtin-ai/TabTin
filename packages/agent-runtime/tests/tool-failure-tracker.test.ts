/**
 * W3 — Tool-failure stall detector 单元测试。
 *
 * 覆盖：
 *   - 阈值触发 notice / nudge
 *   - streak 打破：成功 reset / 用户新消息 / 不同 tool / 不同 kind / 排除 kinds
 *   - 单调递增（同 streak 内升级路径）
 *   - 环形缓冲老化
 *   - env 阈值覆盖（合法 / 边界 / 非法）
 *   - 配置非法回落默认
 *   - defensive 输入（空 tool / 空 kind）
 *   - 文案构造不硬编码具体案例
 *
 * 集成测试（与 query.ts 主循环、stream events、system prompt 注入交互）见
 * `stall-detection-integration.test.ts`。
 */

import { describe, it, expect } from 'vitest';
import {
  ToolFailureTracker,
  isToolFailureStageUpgrade,
  buildToolFailureNoticeContent,
  buildToolFailureNudgeContent,
  buildToolFailureNudgeSystemInjection,
  DEFAULT_TOOL_FAILURE_BUDGET_THRESHOLDS,
  DEFAULT_TOOL_FAILURE_BUFFER_SIZE,
  DEFAULT_TOOL_FAILURE_EXCLUDE_KINDS,
  DEFAULT_TOOL_FAILURE_TRACKER_CONFIG,
} from '../src/engine/guards/tool-failure-tracker.js';
import {
  HOST_UNSUPPORTED,
  INVALID_PARAM_FORMAT,
  INTERNAL_ERROR,
  NETWORK_FAILED,
  RUNTIME_MISCONFIG,
} from '../src/engine/errors/error-kinds.js';

const ENV_NONE: NodeJS.ProcessEnv = {};

describe('ToolFailureTracker — defaults & basic threshold triggers', () => {
  it('exposes documented default config values', () => {
    expect(DEFAULT_TOOL_FAILURE_BUDGET_THRESHOLDS).toEqual({
      notice: 3,
      nudge: 5,
      terminate: 8,
    });
    expect(DEFAULT_TOOL_FAILURE_BUFFER_SIZE).toBe(10);
    expect(DEFAULT_TOOL_FAILURE_EXCLUDE_KINDS.length).toBeGreaterThanOrEqual(8);
    expect(DEFAULT_TOOL_FAILURE_TRACKER_CONFIG.enabled).toBe(true);
  });

  it('returns normal when buffer is empty', () => {
    const tracker = new ToolFailureTracker({ env: ENV_NONE });
    expect(tracker.evaluate()).toEqual({ stage: 'normal', trigger: null });
  });

  it('triggers notice at exactly 3 consecutive same (tool, kind) failures', () => {
    const tracker = new ToolFailureTracker({ env: ENV_NONE });
    tracker.recordFailure({ tool: 'read_file', error_kind: NETWORK_FAILED });
    expect(tracker.evaluate().stage).toBe('normal');
    tracker.recordFailure({ tool: 'read_file', error_kind: NETWORK_FAILED });
    expect(tracker.evaluate().stage).toBe('normal');
    tracker.recordFailure({ tool: 'read_file', error_kind: NETWORK_FAILED });

    const evaluation = tracker.evaluate();
    expect(evaluation.stage).toBe('notice');
    expect(evaluation.trigger).toEqual({
      tool: 'read_file',
      error_kind: NETWORK_FAILED,
      streak: 3,
    });
  });

  it('triggers nudge at exactly 5 consecutive same failures', () => {
    const tracker = new ToolFailureTracker({ env: ENV_NONE });
    for (let i = 0; i < 4; i++) {
      tracker.recordFailure({
        tool: 'parse_document',
        error_kind: 'upstream_error',
      });
    }
    expect(tracker.evaluate().stage).toBe('notice');

    tracker.recordFailure({
      tool: 'parse_document',
      error_kind: 'upstream_error',
    });
    const evaluation = tracker.evaluate();
    expect(evaluation.stage).toBe('nudge');
    expect(evaluation.trigger).toEqual({
      tool: 'parse_document',
      error_kind: 'upstream_error',
      streak: 5,
    });
  });

  it('stays in nudge stage when streak grows beyond nudge threshold (no regression to notice)', () => {
    const tracker = new ToolFailureTracker({ env: ENV_NONE });
    for (let i = 0; i < 5; i++) {
      tracker.recordFailure({ tool: 'fetch_url', error_kind: 'network_failed' });
    }
    expect(tracker.evaluate().stage).toBe('nudge');

    // streak 增长到 6/7/8 仍是 nudge —— 不会回 notice
    tracker.recordFailure({ tool: 'fetch_url', error_kind: 'network_failed' });
    expect(tracker.evaluate().stage).toBe('nudge');
    expect(tracker.evaluate().trigger?.streak).toBe(6);
  });

  it('ask_form invalid_param_format triggers terminate at 3 failures to stop empty-field loops', () => {
    const tracker = new ToolFailureTracker({ env: ENV_NONE });
    tracker.recordFailure({ tool: 'ask_form', error_kind: INVALID_PARAM_FORMAT });
    expect(tracker.evaluate().stage).toBe('normal');
    tracker.recordFailure({ tool: 'ask_form', error_kind: INVALID_PARAM_FORMAT });
    expect(tracker.evaluate().stage).toBe('normal');
    tracker.recordFailure({ tool: 'ask_form', error_kind: INVALID_PARAM_FORMAT });

    const evaluation = tracker.evaluate();
    expect(evaluation.stage).toBe('terminate');
    expect(evaluation.trigger).toEqual({
      tool: 'ask_form',
      error_kind: INVALID_PARAM_FORMAT,
      streak: 3,
    });
  });

  it('non ask_form invalid_param_format still uses the generic terminate threshold', () => {
    const tracker = new ToolFailureTracker({ env: ENV_NONE });
    for (let i = 0; i < 3; i++) {
      tracker.recordFailure({ tool: 'other_form_tool', error_kind: INVALID_PARAM_FORMAT });
    }

    expect(tracker.evaluate().stage).toBe('notice');
    expect(tracker.evaluate().trigger?.streak).toBe(3);
  });

  it('ask_form fast terminate counts only invalid_param_format failures', () => {
    const tracker = new ToolFailureTracker({ env: ENV_NONE });
    tracker.recordFailure({ tool: 'ask_form', error_kind: 'request_timeout' });
    tracker.recordFailure({ tool: 'ask_form', error_kind: 'request_timeout' });
    tracker.recordFailure({ tool: 'ask_form', error_kind: INVALID_PARAM_FORMAT });

    // 只有 1 次 invalid_param_format，不应把前面的 timeout 混入 3 次专项阈值。
    expect(tracker.evaluate().stage).toBe('normal');
    tracker.recordFailure({ tool: 'ask_form', error_kind: INVALID_PARAM_FORMAT });
    expect(tracker.evaluate().stage).toBe('normal');
    tracker.recordFailure({ tool: 'ask_form', error_kind: INVALID_PARAM_FORMAT });
    expect(tracker.evaluate().stage).toBe('terminate');
    expect(tracker.evaluate().trigger?.streak).toBe(3);
  });
});

describe('ToolFailureTracker — streak break semantics', () => {
  it('recordSuccess(tool, kind) resets streak when tail matches', () => {
    const tracker = new ToolFailureTracker({ env: ENV_NONE });
    for (let i = 0; i < 3; i++) {
      tracker.recordFailure({ tool: 'read_file', error_kind: NETWORK_FAILED });
    }
    expect(tracker.evaluate().stage).toBe('notice');

    tracker.recordSuccess({ tool: 'read_file', error_kind: NETWORK_FAILED });
    expect(tracker.evaluate().stage).toBe('normal');
    expect(tracker.snapshot().length).toBe(0);
  });

  it('recordSuccess without error_kind drops any kind for matching tool', () => {
    const tracker = new ToolFailureTracker({ env: ENV_NONE });
    tracker.recordFailure({ tool: 'read_file', error_kind: 'a' });
    tracker.recordFailure({ tool: 'read_file', error_kind: 'b' });
    tracker.recordFailure({ tool: 'read_file', error_kind: 'b' });
    expect(tracker.snapshot().length).toBe(3);

    tracker.recordSuccess({ tool: 'read_file' });
    // 末尾连续 tool=read_file 全 pop（即使 kind 不同）
    expect(tracker.snapshot().length).toBe(0);
  });

  it('recordSuccess(tool, kind) with mismatched kind does not pop', () => {
    const tracker = new ToolFailureTracker({ env: ENV_NONE });
    tracker.recordFailure({ tool: 'read_file', error_kind: NETWORK_FAILED });
    tracker.recordFailure({ tool: 'read_file', error_kind: NETWORK_FAILED });
    tracker.recordFailure({ tool: 'read_file', error_kind: NETWORK_FAILED });

    tracker.recordSuccess({
      tool: 'read_file',
      error_kind: 'permission_denied', // 不同 kind
    });
    // 末尾是 NETWORK_FAILED 不匹配 → 不 pop
    expect(tracker.snapshot().length).toBe(3);
    expect(tracker.evaluate().stage).toBe('notice');
  });

  it('recordSuccess on different tool does not affect existing streak', () => {
    const tracker = new ToolFailureTracker({ env: ENV_NONE });
    for (let i = 0; i < 3; i++) {
      tracker.recordFailure({ tool: 'tool_a', error_kind: 'x' });
    }
    tracker.recordSuccess({ tool: 'tool_b' });
    // 不同 tool 不影响 (tool_a, x) streak
    expect(tracker.evaluate().stage).toBe('notice');
  });

  it('only pops the contiguous tail matching tool — does not drop earlier streaks of same kind', () => {
    const tracker = new ToolFailureTracker({ env: ENV_NONE });
    // [(A, X)*3, (B, X)*2]
    for (let i = 0; i < 3; i++) {
      tracker.recordFailure({ tool: 'tool_a', error_kind: 'x' });
    }
    for (let i = 0; i < 2; i++) {
      tracker.recordFailure({ tool: 'tool_b', error_kind: 'x' });
    }
    expect(tracker.snapshot().length).toBe(5);

    tracker.recordSuccess({ tool: 'tool_b', error_kind: 'x' });
    // 末尾连续 (B, X) 被移除，剩 [(A, X)*3]
    expect(tracker.snapshot().length).toBe(3);
    expect(tracker.evaluate().trigger?.tool).toBe('tool_a');
    expect(tracker.evaluate().stage).toBe('notice');
  });

  it('different error_kind in same tool does not accumulate', () => {
    const tracker = new ToolFailureTracker({ env: ENV_NONE });
    tracker.recordFailure({ tool: 'fetch_url', error_kind: 'network_failed' });
    tracker.recordFailure({ tool: 'fetch_url', error_kind: 'request_timeout' });
    tracker.recordFailure({ tool: 'fetch_url', error_kind: 'network_failed' });
    tracker.recordFailure({ tool: 'fetch_url', error_kind: 'network_failed' });
    tracker.recordFailure({ tool: 'fetch_url', error_kind: 'network_failed' });

    // 末尾连续 (fetch_url, network_failed) = 3 → notice，**不**是 5 → nudge
    // 因为中间被 request_timeout 打断
    const evaluation = tracker.evaluate();
    expect(evaluation.stage).toBe('notice');
    expect(evaluation.trigger?.streak).toBe(3);
  });

  it('different tool in same kind does not accumulate', () => {
    const tracker = new ToolFailureTracker({ env: ENV_NONE });
    for (let i = 0; i < 3; i++) {
      tracker.recordFailure({ tool: 'tool_a', error_kind: 'x' });
    }
    tracker.recordFailure({ tool: 'tool_b', error_kind: 'x' });

    // 末尾是 (tool_b, x) streak=1 → normal
    expect(tracker.evaluate().stage).toBe('normal');
  });

});

describe('ToolFailureTracker — circular buffer aging', () => {
  it('drops oldest entries when buffer overflows beyond bufferSize', () => {
    const tracker = new ToolFailureTracker({
      env: ENV_NONE,
      // notice/nudge/terminate 同步降低，确保 bufferSize=4 不被 invariant 撑大
      // （：buffer floor 现以 terminate 为下限）。
      config: {
        bufferSize: 4,
        thresholds: { notice: 2, nudge: 3, terminate: 4 },
      },
    });
    expect(tracker.getConfig().bufferSize).toBe(4);

    // 5 个 entry 进入 size=4 的 buffer：最早的 tool_a 被挤出
    tracker.recordFailure({ tool: 'tool_a', error_kind: 'x' });
    tracker.recordFailure({ tool: 'tool_a', error_kind: 'x' });
    tracker.recordFailure({ tool: 'tool_b', error_kind: 'y' });
    tracker.recordFailure({ tool: 'tool_b', error_kind: 'y' });
    tracker.recordFailure({ tool: 'tool_b', error_kind: 'y' });

    expect(tracker.snapshot().length).toBe(4);
    // 末尾连续 (tool_b, y) = 3 → nudge（同 tool 失败计数 3 仍 < terminate 4）
    expect(tracker.evaluate().trigger?.streak).toBe(3);
    expect(tracker.evaluate().stage).toBe('nudge');
  });

  it('expands buffer when nudge threshold exceeds default buffer size', () => {
    const tracker = new ToolFailureTracker({
      env: ENV_NONE,
      config: {
        thresholds: { notice: 8, nudge: 12, terminate: 13 },
      },
    });
    // 默认 bufferSize=10 < nudge=12 → 自动撑大到 12
    expect(tracker.getConfig().bufferSize).toBeGreaterThanOrEqual(12);
  });

  it('streak still correct after older non-matching entries get evicted', () => {
    // ：默认 bufferSize=10 ≥ terminate(8)，floor=max(10,8)=10。塞 8 条
    // noise + 4 条 streak record 共 12 条，最早 2 条 noise 被挤出，验证 eviction
    // 后 streak 仍正确。
    const tracker = new ToolFailureTracker({ env: ENV_NONE });
    for (let i = 0; i < 8; i++) {
      tracker.recordFailure({ tool: 'noise_tool', error_kind: 'a' });
    }
    for (let i = 0; i < 4; i++) {
      tracker.recordFailure({ tool: 'real_tool', error_kind: 'b' });
    }
    // buffer 上限 10，末尾 10 条：[noise/a ×6, real/b ×4] → tail streak=4
    expect(tracker.snapshot().length).toBe(10);
    expect(tracker.evaluate().trigger?.streak).toBe(4);
    expect(tracker.evaluate().stage).toBe('notice');
  });
});

describe('ToolFailureTracker — exclude kinds', () => {
  const excludeCases = [
    'aborted',
    'aborted_by_user',
    'budget_skipped',
    'unknown_tool',
    'schema_invalid',
    'validate_input',
    'plan_guard_deny',
    RUNTIME_MISCONFIG,
    INTERNAL_ERROR,
    HOST_UNSUPPORTED,
    // W3-R1 H3 修复：sentinel kind 不应触发 nudge
    'unknown_error_kind',
  ];

  for (const kind of excludeCases) {
    it(`excludes "${kind}" from streak counting (5 in a row → still normal)`, () => {
      const tracker = new ToolFailureTracker({ env: ENV_NONE });
      for (let i = 0; i < 5; i++) {
        tracker.recordFailure({ tool: 'tool_x', error_kind: kind });
      }
      expect(tracker.evaluate().stage).toBe('normal');
      expect(tracker.evaluate().trigger).toBeNull();
    });
  }

  it('still counts non-excluded kinds normally', () => {
    const tracker = new ToolFailureTracker({ env: ENV_NONE });
    for (let i = 0; i < 3; i++) {
      tracker.recordFailure({
        tool: 'tool_x',
        error_kind: NETWORK_FAILED,
      });
    }
    expect(tracker.evaluate().stage).toBe('notice');
  });
});

describe('ToolFailureTracker — env override', () => {
  it('overrides notice threshold from TABTIN_TOOL_FAILURE_NOTICE_STREAK', () => {
    const tracker = new ToolFailureTracker({
      env: { TABTIN_TOOL_FAILURE_NOTICE_STREAK: '2' },
    });
    expect(tracker.getConfig().thresholds.notice).toBe(2);
    tracker.recordFailure({ tool: 'a', error_kind: 'x' });
    tracker.recordFailure({ tool: 'a', error_kind: 'x' });
    expect(tracker.evaluate().stage).toBe('notice');
  });

  it('overrides both thresholds simultaneously', () => {
    const tracker = new ToolFailureTracker({
      env: {
        TABTIN_TOOL_FAILURE_NOTICE_STREAK: '2',
        TABTIN_TOOL_FAILURE_NUDGE_STREAK: '4',
      },
    });
    // ：thresholds 现含 terminate 第三档（跟随合并，由专项测试覆盖），
    // 这里聚焦 notice/nudge 合并意图，用 toMatchObject 不约束 terminate。
    expect(tracker.getConfig().thresholds).toMatchObject({ notice: 2, nudge: 4 });
  });

  it('disables tracker when TABTIN_TOOL_FAILURE_TRACKER_ENABLED=false', () => {
    const tracker = new ToolFailureTracker({
      env: { TABTIN_TOOL_FAILURE_TRACKER_ENABLED: 'false' },
    });
    expect(tracker.getConfig().enabled).toBe(false);
    for (let i = 0; i < 10; i++) {
      tracker.recordFailure({ tool: 'a', error_kind: 'x' });
    }
    expect(tracker.evaluate()).toEqual({ stage: 'normal', trigger: null });
  });

  it('falls back to defaults when env values are non-numeric', () => {
    const tracker = new ToolFailureTracker({
      env: {
        TABTIN_TOOL_FAILURE_NOTICE_STREAK: 'abc',
        TABTIN_TOOL_FAILURE_NUDGE_STREAK: 'NaN',
      },
    });
    expect(tracker.getConfig().thresholds).toEqual(
      DEFAULT_TOOL_FAILURE_BUDGET_THRESHOLDS,
    );
  });

  it('falls back when env value is negative / zero / out of range', () => {
    for (const bad of ['0', '-1', '999', '1.5e3']) {
      const t = new ToolFailureTracker({
        env: { TABTIN_TOOL_FAILURE_NOTICE_STREAK: bad },
      });
      expect(t.getConfig().thresholds.notice).toBe(
        DEFAULT_TOOL_FAILURE_BUDGET_THRESHOLDS.notice,
      );
    }
  });

  it('falls back when notice >= nudge invariant violated', () => {
    const t = new ToolFailureTracker({
      env: {
        TABTIN_TOOL_FAILURE_NOTICE_STREAK: '5',
        TABTIN_TOOL_FAILURE_NUDGE_STREAK: '3',
      },
    });
    // 整 thresholds 回落默认（不局部修复）
    expect(t.getConfig().thresholds).toEqual(
      DEFAULT_TOOL_FAILURE_BUDGET_THRESHOLDS,
    );
  });

  // W3-R3-P2-3 修复：parseStreakThreshold 边界场景显式覆盖（防止 `>` / `>=` 微小回归）
  it('parseStreakThreshold edge cases: floats / boundary / scientific notation', () => {
    // 浮点 → floor，合法（注：阈值仍受 notice<nudge 约束）
    const tFloat = new ToolFailureTracker({
      env: {
        TABTIN_TOOL_FAILURE_NOTICE_STREAK: '2.9',
        TABTIN_TOOL_FAILURE_NUDGE_STREAK: '5.1',
      },
    });
    expect(tFloat.getConfig().thresholds).toMatchObject({ notice: 2, nudge: 5 });

    // 边界 100 inclusive 允许
    const tHundred = new ToolFailureTracker({
      env: {
        TABTIN_TOOL_FAILURE_NOTICE_STREAK: '99',
        TABTIN_TOOL_FAILURE_NUDGE_STREAK: '100',
      },
    });
    expect(tHundred.getConfig().thresholds).toMatchObject({ notice: 99, nudge: 100 });

    // 边界 100.1 拒绝（> 100 即非法）
    const tOver = new ToolFailureTracker({
      env: { TABTIN_TOOL_FAILURE_NUDGE_STREAK: '100.1' },
    });
    expect(tOver.getConfig().thresholds.nudge).toBe(
      DEFAULT_TOOL_FAILURE_BUDGET_THRESHOLDS.nudge,
    );

    // 科学计数法 5e1 = 50 通过 + Math.floor，合法（与 nudge 默认 5 不冲突时单独覆盖）
    const tSci = new ToolFailureTracker({
      env: {
        TABTIN_TOOL_FAILURE_NOTICE_STREAK: '5e0', // = 5
        TABTIN_TOOL_FAILURE_NUDGE_STREAK: '5e1',  // = 50
      },
    });
    expect(tSci.getConfig().thresholds).toMatchObject({ notice: 5, nudge: 50 });
  });

  it('explicit options.config overrides env', () => {
    const t = new ToolFailureTracker({
      env: { TABTIN_TOOL_FAILURE_NOTICE_STREAK: '2' },
      config: { thresholds: { notice: 4, nudge: 6, terminate: 8 } },
    });
    expect(t.getConfig().thresholds).toMatchObject({ notice: 4, nudge: 6 });
  });

  it('accepts boolean alias values for enabled flag', () => {
    for (const onValue of ['on', '1', 'enabled', 'yes', 'true']) {
      const t = new ToolFailureTracker({
        env: { TABTIN_TOOL_FAILURE_TRACKER_ENABLED: onValue },
      });
      expect(t.getConfig().enabled).toBe(true);
    }
    for (const offValue of ['off', '0', 'disabled', 'no', 'false']) {
      const t = new ToolFailureTracker({
        env: { TABTIN_TOOL_FAILURE_TRACKER_ENABLED: offValue },
      });
      expect(t.getConfig().enabled).toBe(false);
    }
  });
});

describe('ToolFailureTracker — defensive input', () => {
  it('ignores recordFailure with empty tool string', () => {
    const tracker = new ToolFailureTracker({ env: ENV_NONE });
    tracker.recordFailure({ tool: '', error_kind: 'x' });
    expect(tracker.snapshot().length).toBe(0);
  });

  it('ignores recordFailure with missing or empty error_kind', () => {
    const tracker = new ToolFailureTracker({ env: ENV_NONE });
    tracker.recordFailure({ tool: 'a', error_kind: '' });
    tracker.recordFailure({ tool: 'a', error_kind: undefined });
    tracker.recordFailure({ tool: 'a' });
    expect(tracker.snapshot().length).toBe(0);
  });

  it('ignores recordSuccess with empty tool string', () => {
    const tracker = new ToolFailureTracker({ env: ENV_NONE });
    tracker.recordFailure({ tool: 'a', error_kind: 'x' });
    tracker.recordSuccess({ tool: '' });
    expect(tracker.snapshot().length).toBe(1);
  });
});

describe('isToolFailureStageUpgrade', () => {
  it('undefined → notice is upgrade', () => {
    expect(isToolFailureStageUpgrade(undefined, 'notice')).toBe(true);
  });
  it('notice → nudge is upgrade', () => {
    expect(isToolFailureStageUpgrade('notice', 'nudge')).toBe(true);
  });
  it('notice → notice is not upgrade (same stage)', () => {
    expect(isToolFailureStageUpgrade('notice', 'notice')).toBe(false);
  });
  it('nudge → notice is not upgrade (regression blocked)', () => {
    expect(isToolFailureStageUpgrade('nudge', 'notice')).toBe(false);
  });
  it('any → normal is not upgrade (consumer should reset state separately)', () => {
    expect(isToolFailureStageUpgrade(undefined, 'normal')).toBe(false);
    expect(isToolFailureStageUpgrade('notice', 'normal')).toBe(false);
    expect(isToolFailureStageUpgrade('nudge', 'normal')).toBe(false);
  });
});

describe('文案构造 — 不硬编码具体案例 + 含动作化引导', () => {
  const trigger = {
    tool: 'parse_document',
    error_kind: 'upstream_error',
    streak: 5,
  };

  it('notice content carries streak count + raw tool/kind (jsonl 离线排查友好) + 中性主语 (W3 真实用户视角 P1-3 修复)', () => {
    const text = buildToolFailureNoticeContent(trigger);
    expect(text).toContain('5');
    // W3 真实用户视角 Review P1-3 修复：fallback **专门**给 jsonl 离线 logging 用
    // （前端永远走 `chat:systemNotice.toolFailureNotice` i18n 模板，用户不会看到这条）。
    // 暴露 raw tool/kind 让 jsonl 排查时能精确定位"哪个工具撞哪个错"。
    expect(text).toContain('parse_document');
    expect(text).toContain('upstream_error');
    // 不硬编码具体案例（不能写 PDF / `read_file 5 次`）
    expect(text).not.toContain('PDF');
    // 主语是工具名，避免"Agent 反复失败"的问责姿态
    expect(text).toMatch(/已连续失败/);
    expect(text).not.toMatch(/Agent\s*在|Agent\s*已经|反复失败次数过多/);
    expect(text).toMatch(/系统会提醒 Agent 换种方式尝试/);
  });

  it('nudge content carries streak count + product姿态 + raw tool/kind for jsonl', () => {
    const text = buildToolFailureNudgeContent(trigger);
    expect(text).toContain('5');
    // 与 notice 同设计：jsonl 友好（含 raw）、用户面前永远走 i18n 模板
    expect(text).toContain('parse_document');
    expect(text).toContain('upstream_error');
    expect(text).toMatch(/已连续失败/);
    expect(text).toContain('系统已提醒 Agent 换种方式尝试');
    expect(text).not.toMatch(/反复失败次数过多|Agent\s*反复/);
  });

  it('中文 nudge injection has structural [系统 / 停滞检测] header + 3 actions', () => {
    const text = buildToolFailureNudgeSystemInjection(trigger);
    expect(text).toContain('[系统 / 停滞检测]');
    expect(text).toContain('parse_document');
    expect(text).toContain('upstream_error');
    expect(text).toContain('5');
    // nudge 至少引用真实存在的 ask 工具之一（按场景智能选择；#3709 后为两件）。
    expect(text).toMatch(/ask_user|ask_form/);
    // 不应再出现已退役的 ask_question
    expect(text).not.toContain('ask_question');
    expect(text).toMatch(/换一个工具|换一种思路|换个工具/);
    expect(text).toMatch(/总结目前的进展并结束本轮/);
    // 不硬编码具体案例
    expect(text).not.toContain('PDF');
    expect(text).not.toContain('parse_document file_id');
  });

  it('returns same [系统 / 停滞检测] header for any (tool, kind) combination', () => {
    const a = buildToolFailureNudgeSystemInjection({
      tool: 'web_search',
      error_kind: 'network_failed',
      streak: 7,
    });
    const b = buildToolFailureNudgeSystemInjection({
      tool: 'tabtin_browser_open',
      error_kind: 'mode_restricted',
      streak: 6,
    });
    expect(a).toContain('[系统 / 停滞检测]');
    expect(b).toContain('[系统 / 停滞检测]');
    expect(a).toContain('web_search');
    expect(b).toContain('tabtin_browser_open');
  });

  // W1 D6 决议对齐：mode_restricted / hardline / 默认三类 nudge 路径不同
  it('mode_restricted nudge guides LLM to switch_mode, NOT "different tool"', () => {
    const text = buildToolFailureNudgeSystemInjection({
      tool: 'tabcode_write',
      error_kind: 'mode_restricted',
      streak: 5,
    });
    // : mode_restricted 优先 switch_mode（请求切 mode），可同时含 ask_user 备选
    expect(text).toContain('switch_mode');
    expect(text).not.toContain('request_approval');
    // 关键负例：mode_restricted 下"换工具"是误导（其他写工具同样被拦）
    expect(text).not.toMatch(/换工具|换一个工具/);
    expect(text).toMatch(/切换到 Agent 模式|切换模式/);
  });

  it('command_blocked_by_policy nudge does NOT suggest "different tool" (hardline cannot pivot)', () => {
    const text = buildToolFailureNudgeSystemInjection({
      tool: 'run_terminal_command',
      error_kind: 'command_blocked_by_policy',
      streak: 5,
    });
    // hardline 红线不能换姿势——只能让用户给替代目标（ask_user）或 summarise 退出
    expect(text).toContain('ask_user');
    expect(text).not.toContain('request_approval');
    expect(text).not.toContain('ask_question');
    expect(text).not.toMatch(/different tool/);
    expect(text).toMatch(/hardline|blocked|policy/i);
  });

  it('default branch (network / upstream / etc.) lists ask 三件套 — never deprecated ask_question', () => {
    const text = buildToolFailureNudgeSystemInjection({
      tool: 'web_search',
      error_kind: 'network_failed',
      streak: 5,
    });
    expect(text).toContain('ask_user');
    expect(text).not.toContain('ask_question');
    expect(text).toContain('换一个工具');
    expect(text).toMatch(/总结目前的进展并结束本轮/);
  });

  // R1 阻塞 B1 / R1 H2 修复：auth/permission 类应引导用户重新登录 / 授权
  it('auth_failed nudge guides LLM to ask_user (re-authentication)', () => {
    const text = buildToolFailureNudgeSystemInjection({
      tool: 'data_query',
      error_kind: 'auth_failed',
      streak: 5,
    });
    expect(text).toContain('ask_user');
    expect(text).not.toContain('request_approval');
    expect(text).not.toContain('ask_question');
    expect(text).toMatch(/重新认证|授予访问权限|授予缺失的权限/);
  });

  it('permission_denied nudge guides LLM to ask_user (grant access)', () => {
    const text = buildToolFailureNudgeSystemInjection({
      tool: 'oss_upload',
      error_kind: 'permission_denied',
      streak: 5,
    });
    expect(text).toContain('ask_user');
    expect(text).not.toContain('request_approval');
    expect(text).not.toContain('ask_question');
  });

  // resource_not_found 类应优先 ask_choice 让用户选目标
  it('resource_not_found nudge guides LLM to ask_user (let user pick target)', () => {
    const text = buildToolFailureNudgeSystemInjection({
      tool: 'parse_document',
      error_kind: 'resource_not_found',
      streak: 5,
    });
    expect(text).toContain('ask_user');
    expect(text).not.toContain('ask_question');
    expect(text).toMatch(/换一种查找策略|按名称.*搜索/);
  });

  // W3-R1-P0-1 修复：os_access_error 是路径级 OS 拒绝（macOS TCC / Linux EPERM /
  // Windows ACL），换工具同样被拦——必须走路径级授权而非 "different tool"
  it('os_access_error nudge guides LLM to OS-level grant + retry, NOT retired tools or "different tool"', () => {
    const text = buildToolFailureNudgeSystemInjection({
      tool: 'read_file',
      error_kind: 'os_access_error',
      streak: 5,
    });
    expect(text).toContain('ask_user');
    expect(text).not.toContain('request_approval');
    expect(text).not.toContain('ask_question');
    // 必须明确不是"换工具"——路径级拒绝换工具同样被拦
    expect(text).toMatch(/按路径生效|路径级别|换一个用户已授权的路径|其他路径/);
    expect(text).toMatch(/重试原操作|授权.*完成后重试/);
    expect(text).not.toContain('clear_os_error_blacklist');
    expect(text).not.toContain('relaunch_app');
    // 必须提到 OS 授权（macOS TCC / Linux EPERM / Windows ACL）
    expect(text).toMatch(/TCC|EPERM|ACL|OS-level permission/i);
  });

  // W3-R1-P2-2 修复：command_denied_by_validator 是 denylist 软边界，每条 deny rule
  // 都有 metadata.hint 给具体"换姿势"建议，nudge 应让 LLM 回看 hint 而非泛泛换工具
  it('command_denied_by_validator nudge guides LLM to follow metadata.hint, not "different tool"', () => {
    const text = buildToolFailureNudgeSystemInjection({
      tool: 'run_terminal_command',
      error_kind: 'command_denied_by_validator',
      streak: 5,
    });
    expect(text).toContain('hint');
    expect(text).not.toContain('ask_question');
    expect(text).toMatch(/切换调用姿势|替代姿势|换姿势/);
    expect(text).toMatch(/write_file|两步/);
  });

  // W3-R1-P1-1 修复：header 必须强制 LLM 回看 metadata.hint —— W2 投入的 hint 资产
  // 不应在 stall 介入时被 LLM 忽略，否则 LLM 凭空"换工具"会浪费步数
  it('every nudge branch header includes "re-read metadata.hint" reminder (W2 hint reuse)', () => {
    const kinds = [
      'mode_restricted',
      'command_blocked_by_policy',
      'auth_failed',
      'os_access_error',
      'resource_not_found',
      'command_denied_by_validator',
      'network_failed',
    ];
    for (const kind of kinds) {
      const text = buildToolFailureNudgeSystemInjection({
        tool: 'any_tool',
        error_kind: kind,
        streak: 5,
      });
      expect(
        text,
        `branch for ${kind} must remind LLM to re-read metadata.hint`,
      ).toMatch(/metadata\.hint|re-read.*hint/i);
    }
  });

  // 跨 error_kind 全集校验：所有分支都不含已下线工具
  it('NO branch ever references deprecated triade names or ask_question', () => {
    const kinds = [
      'mode_restricted',
      'command_blocked_by_policy',
      'auth_failed',
      'permission_denied',
      'resource_not_found',
      'skill_not_found',
      'tool_result_not_found',
      'network_failed',
      'upstream_error',
      'request_timeout',
      'rate_limited',
      'command_denied_by_validator',
      'os_access_error',
      'cwd_not_found',
    ];
    for (const kind of kinds) {
      const text = buildToolFailureNudgeSystemInjection({
        tool: 'any_tool',
        error_kind: kind,
        streak: 5,
      });
      // 整段 nudge 任何 branch 都至少引用真实存在的用户交互工具，
      // 且不应再出现已退役的 ask_question / request_approval。
      expect(text, `branch for ${kind} must not reference deprecated ask_question`).not.toContain('ask_question');
      expect(text, `branch for ${kind} must not reference retired request_approval`).not.toContain('request_approval');
      // 至少引用 ask 工具 / switch_mode 之一
      expect(text, `branch for ${kind} must reference an existing interaction tool`).toMatch(
        /ask_user|ask_form|switch_mode/,
      );
    }
  });
});

describe('ToolFailureTracker — composite scenarios', () => {
  it('streak resumes after success → failure cycle', () => {
    const tracker = new ToolFailureTracker({ env: ENV_NONE });
    // 第一轮 streak 撞 nudge
    for (let i = 0; i < 5; i++) {
      tracker.recordFailure({ tool: 'a', error_kind: 'x' });
    }
    expect(tracker.evaluate().stage).toBe('nudge');

    // success 重置
    tracker.recordSuccess({ tool: 'a', error_kind: 'x' });
    expect(tracker.evaluate().stage).toBe('normal');

    // 第二轮新的 streak 撞 notice
    for (let i = 0; i < 3; i++) {
      tracker.recordFailure({ tool: 'a', error_kind: 'x' });
    }
    expect(tracker.evaluate().stage).toBe('notice');
  });

  it('mixed tools — only the active tail tool counts towards streak', () => {
    const tracker = new ToolFailureTracker({ env: ENV_NONE });
    // [(A, X), (A, X), (B, Y), (B, Y), (B, Y)]
    tracker.recordFailure({ tool: 'a', error_kind: 'x' });
    tracker.recordFailure({ tool: 'a', error_kind: 'x' });
    tracker.recordFailure({ tool: 'b', error_kind: 'y' });
    tracker.recordFailure({ tool: 'b', error_kind: 'y' });
    tracker.recordFailure({ tool: 'b', error_kind: 'y' });

    // 末尾连续 (B, y) streak=3 → notice
    const evaluation = tracker.evaluate();
    expect(evaluation.stage).toBe('notice');
    expect(evaluation.trigger?.tool).toBe('b');
    expect(evaluation.trigger?.streak).toBe(3);
  });

});

// ─── W2 L16: file pipeline 13 类全员端到端识别 ───────────────────────
//
// **L16 任务**：toolFailureNudge 检测器是否识别 W1 新增 8 个 file pipeline
// `error_kind`？理论上按 string 字面值匹配应该兼容，但要端到端钉死防止
// 未来"加新 kind 但忘加进 nudger 测试覆盖"。
//
// 本套测试自动从 SSoT `FILE_PIPELINE_ERROR_KINDS` 遍历——加新 kind 立即被
// 覆盖，不需要手动同步两份字面值列表（避免反思 §八 #3 SSoT 双源）。
//
// 期望：除 `aborted`（在 DEFAULT_TOOL_FAILURE_EXCLUDE_KINDS 里 — 用户主动
// 取消不该 streak）外，所有 12 类 file pipeline kind 应该正常累积 streak +
// 触发 notice (3) → nudge (5)。

import { FILE_PIPELINE_ERROR_KINDS } from '@tabtin/file-pipeline-errors';

const FILE_PIPELINE_NUDGE_ELIGIBLE_KINDS = FILE_PIPELINE_ERROR_KINDS.filter(
  (kind) => !DEFAULT_TOOL_FAILURE_EXCLUDE_KINDS.includes(kind),
) as readonly string[];

describe('W2 L16 / W5 L17/L38 — toolFailureNudge identifies all file pipeline kinds', () => {
  it('SSoT sanity: file pipeline catalog has 14 kinds, 13 of them are nudge-eligible (aborted excluded)', () => {
    // **W5 L17/L38（2026-05-14）**：13 → 14 类（新增 IMAGE_RESIZE_FAILED 数字码 19）
    expect(FILE_PIPELINE_ERROR_KINDS.length).toBe(14);
    expect(FILE_PIPELINE_NUDGE_ELIGIBLE_KINDS.length).toBe(13);
    expect(FILE_PIPELINE_NUDGE_ELIGIBLE_KINDS).not.toContain('aborted');
  });

  it.each(FILE_PIPELINE_NUDGE_ELIGIBLE_KINDS)(
    'kind=%s — 3 same failures triggers notice, 5 triggers nudge',
    (kind) => {
      const tracker = new ToolFailureTracker({ env: ENV_NONE });
      for (let i = 0; i < 3; i++) {
        tracker.recordFailure({ tool: 'read_file', error_kind: kind });
      }
      const noticeEval = tracker.evaluate();
      expect(noticeEval.stage).toBe('notice');
      expect(noticeEval.trigger).toEqual({
        tool: 'read_file',
        error_kind: kind,
        streak: 3,
      });
      // 再撞 2 次到 nudge 阈值
      tracker.recordFailure({ tool: 'read_file', error_kind: kind });
      tracker.recordFailure({ tool: 'read_file', error_kind: kind });
      const nudgeEval = tracker.evaluate();
      expect(nudgeEval.stage).toBe('nudge');
      expect(nudgeEval.trigger?.streak).toBe(5);
    },
  );

  it('aborted kind is excluded from streak (user-initiated, not a real "failure")', () => {
    const tracker = new ToolFailureTracker({ env: ENV_NONE });
    for (let i = 0; i < 5; i++) {
      tracker.recordFailure({ tool: 'read_file', error_kind: 'aborted' });
    }
    expect(tracker.evaluate().stage).toBe('normal');
  });

  it('runtime fallback message includes raw error_kind for any file pipeline kind', () => {
    for (const kind of FILE_PIPELINE_NUDGE_ELIGIBLE_KINDS) {
      const noticeText = buildToolFailureNoticeContent({
        tool: 'read_file',
        error_kind: kind,
        streak: 3,
      });
      expect(noticeText).toContain(kind);
      expect(noticeText).toContain('read_file');
    }
  });
});

// ─── ：terminate 硬熔断档 ──────────────────────────────────────
describe('ToolFailureTracker — terminate hard-stop ()', () => {
  it('exposes default terminate threshold = 8', () => {
    expect(DEFAULT_TOOL_FAILURE_BUDGET_THRESHOLDS.terminate).toBe(8);
  });

  it('triggers terminate at exactly 8 consecutive same (tool, kind) failures', () => {
    const tracker = new ToolFailureTracker({ env: ENV_NONE });
    for (let i = 0; i < 7; i++) {
      tracker.recordFailure({ tool: 'read_file', error_kind: NETWORK_FAILED });
    }
    // 7 次仍是 nudge（< terminate 8）
    expect(tracker.evaluate().stage).toBe('nudge');

    tracker.recordFailure({ tool: 'read_file', error_kind: NETWORK_FAILED });
    const evaluation = tracker.evaluate();
    expect(evaluation.stage).toBe('terminate');
    expect(evaluation.trigger).toEqual({
      tool: 'read_file',
      error_kind: NETWORK_FAILED,
      streak: 8,
    });
  });

  it('terminate counts same-tool failures even when error_kind alternates (盲区修复)', () => {
    // 这是  的核心：同一工具反复失败，但 error_kind 在两类间抖动
    // （schema warn ↔ execute 内层校验），连续 streak 永远算不满 nudge，
    // 但 terminate 按"同 tool 失败总数"判定，仍能熔断。
    const tracker = new ToolFailureTracker({ env: ENV_NONE });
    const kinds = ['invalid_param_format', 'missing_required_param'];
    for (let i = 0; i < 8; i++) {
      tracker.recordFailure({ tool: 'ask_form', error_kind: kinds[i % 2]! });
    }
    const evaluation = tracker.evaluate();
    // 末尾连续 streak 只有 1（kind 每次都变），但同 tool 失败总数 = 8 → terminate
    expect(evaluation.stage).toBe('terminate');
    expect(evaluation.trigger?.tool).toBe('ask_form');
    expect(evaluation.trigger?.streak).toBe(8);
  });

  it('does NOT terminate when same-tool failure count below threshold', () => {
    const tracker = new ToolFailureTracker({ env: ENV_NONE });
    const kinds = ['invalid_param_format', 'missing_required_param'];
    for (let i = 0; i < 6; i++) {
      tracker.recordFailure({ tool: 'ask_form', error_kind: kinds[i % 2]! });
    }
    // 同 tool 失败总数 6 < terminate 8；末尾连续 streak=1 < notice → normal
    expect(tracker.evaluate().stage).toBe('normal');
  });

  it('excluded kinds never count toward terminate', () => {
    const tracker = new ToolFailureTracker({ env: ENV_NONE });
    // schema_invalid 在 excludeKinds 内：连续 10 次也不应 terminate
    for (let i = 0; i < 10; i++) {
      tracker.recordFailure({ tool: 'ask_form', error_kind: 'schema_invalid' });
    }
    expect(tracker.evaluate().stage).toBe('normal');
  });

  it('recordSuccess resets the terminate count for that tool', () => {
    const tracker = new ToolFailureTracker({ env: ENV_NONE });
    for (let i = 0; i < 7; i++) {
      tracker.recordFailure({ tool: 'read_file', error_kind: NETWORK_FAILED });
    }
    tracker.recordSuccess({ tool: 'read_file' });
    // 末尾连续失败被 pop → buffer 空 → normal
    expect(tracker.evaluate().stage).toBe('normal');
    tracker.recordFailure({ tool: 'read_file', error_kind: NETWORK_FAILED });
    expect(tracker.evaluate().stage).toBe('normal');
  });

  it('isToolFailureStageUpgrade treats terminate as the highest stage', () => {
    expect(isToolFailureStageUpgrade('nudge', 'terminate')).toBe(true);
    expect(isToolFailureStageUpgrade('notice', 'terminate')).toBe(true);
    expect(isToolFailureStageUpgrade(undefined, 'terminate')).toBe(true);
    expect(isToolFailureStageUpgrade('terminate', 'terminate')).toBe(false);
    expect(isToolFailureStageUpgrade('terminate', 'nudge')).toBe(false);
  });

  it('terminate fallback keeps terminate strictly above nudge when nudge raised past base', () => {
    // 用户把 nudge 调到 9（> terminate 8）→ terminate 自动
    // 抬到 nudge+1=10，保证 terminate > nudge 不变量。
    const tracker = new ToolFailureTracker({
      env: ENV_NONE,
      config: { thresholds: { notice: 4, nudge: 9, terminate: 8 } },
    });
    expect(tracker.getConfig().thresholds.terminate).toBeGreaterThan(9);
  });

  it('env TABTIN_TOOL_FAILURE_TERMINATE_STREAK overrides threshold', () => {
    const tracker = new ToolFailureTracker({
      env: { TABTIN_TOOL_FAILURE_TERMINATE_STREAK: '6' },
    });
    expect(tracker.getConfig().thresholds.terminate).toBe(6);
    for (let i = 0; i < 6; i++) {
      tracker.recordFailure({ tool: 'read_file', error_kind: NETWORK_FAILED });
    }
    expect(tracker.evaluate().stage).toBe('terminate');
  });
});
