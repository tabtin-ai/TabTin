/**
 * FR-01 / FR-03 / FR-04 / FR-07 / FR-09 回归：Daemon 宿主对 runtime
 * knob 环境变量的解析。
 *
 * 与 Electron `host-knobs.test.ts` 对称——两边使用同一组 env key 和
 * fallback 规则，测试断言的不变量也应一致。这样如果后续有人只改一边
 * （比如只给 Electron 加新 env 但忘了 Daemon），差异测试很快暴露。
 *
 * 直接测纯函数，不构造 `DaemonAgentHost` 实例，避免 gateway / mkdir /
 * logger 副作用拉进 vitest。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  DAEMON_DEFAULT_MAX_LOCAL_FILE_SIZE_MB,
  DEFAULT_MAX_CONCURRENT_CHILDREN,
  daemonHostRuntimeOptions,
  decodeAttachmentStrategyFromPayload,
  type HostRuntimeOptionsLogger,
} from '../src/configuration/host-runtime-options.js';
const {
  resolveAttachmentStrategy,
  resolveDoomLoopPolicy,
  resolveIterationBudget,
  resolveMaxConcurrentChildren,
  resolveMaxLocalFileSizeMb,
  resolveMaxMessageChars,
  resolveNormalizationLevel,
  resolvePressureThresholds,
  resolveSubagentResultCompact,
  resolveSyncPersistence,
  resolveSummaryReuse,
  resolveSummaryReuseJudgeSampleRate,
  resolveSummaryReuseJudgeWindowSize,
  resolveSummaryReuseJudgeThreshold,
  resolveSummaryReuseMaxAgeMs,
  resolveSummaryReuseMinAddedMessages,
  resolveToolSchemaValidation,
  resolveToolOutputScan,
} = daemonHostRuntimeOptions
import {
  DEFAULT_ITERATION_BUDGET,
  DEFAULT_MAX_MESSAGE_CHARS,
  DEFAULT_NORMALIZATION_LEVEL,
  DEFAULT_TOOL_SCHEMA_VALIDATION,
} from '@tabtin/agent-runtime/engine';

function makeLogger(): HostRuntimeOptionsLogger & { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn() };
}

describe('Daemon host runtime options — resolveDoomLoopPolicy', () => {
  it("defaults to 'soft' when TABTIN_DOOM_LOOP_POLICY is unset", () => {
    const logger = makeLogger();
    expect(resolveDoomLoopPolicy({}, logger)).toBe('soft');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("accepts 'soft' / 'strict' (case-insensitive, trimmed)", () => {
    const logger = makeLogger();
    expect(
      resolveDoomLoopPolicy({ TABTIN_DOOM_LOOP_POLICY: 'strict' }, logger),
    ).toBe('strict');
    expect(
      resolveDoomLoopPolicy({ TABTIN_DOOM_LOOP_POLICY: 'STRICT' }, logger),
    ).toBe('strict');
    expect(
      resolveDoomLoopPolicy({ TABTIN_DOOM_LOOP_POLICY: '  soft  ' }, logger),
    ).toBe('soft');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("falls back to 'soft' + warns on typo with Daemon tag", () => {
    const logger = makeLogger();
    const out = resolveDoomLoopPolicy(
      { TABTIN_DOOM_LOOP_POLICY: 'aggressive' },
      logger,
    );
    expect(out).toBe('soft');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const msg = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(msg).toMatch(/DaemonAgentHost/);
    expect(msg).toMatch(/TABTIN_DOOM_LOOP_POLICY/);
    expect(msg).toMatch(/aggressive/);
  });

  it("treats empty / whitespace env as unset (no warn)", () => {
    const logger = makeLogger();
    expect(
      resolveDoomLoopPolicy({ TABTIN_DOOM_LOOP_POLICY: '' }, logger),
    ).toBe('soft');
    expect(
      resolveDoomLoopPolicy({ TABTIN_DOOM_LOOP_POLICY: '  \t ' }, logger),
    ).toBe('soft');
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('Daemon host runtime options — resolveMaxMessageChars', () => {
  it('defaults to DEFAULT_MAX_MESSAGE_CHARS when unset', () => {
    const logger = makeLogger();
    expect(resolveMaxMessageChars({}, logger)).toBe(DEFAULT_MAX_MESSAGE_CHARS);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('accepts a positive finite integer string', () => {
    const logger = makeLogger();
    expect(
      resolveMaxMessageChars({ TABTIN_MAX_MESSAGE_CHARS: '750000' }, logger),
    ).toBe(750_000);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('floors a positive float', () => {
    const logger = makeLogger();
    expect(
      resolveMaxMessageChars({ TABTIN_MAX_MESSAGE_CHARS: '250000.5' }, logger),
    ).toBe(250_000);
  });

  it('falls back + warns on 0 / negative / NaN / Infinity with Daemon tag', () => {
    const logger = makeLogger();
    for (const bad of ['0', '-1', 'big', 'Infinity', 'NaN']) {
      expect(
        resolveMaxMessageChars({ TABTIN_MAX_MESSAGE_CHARS: bad }, logger),
      ).toBe(DEFAULT_MAX_MESSAGE_CHARS);
    }
    expect(logger.warn).toHaveBeenCalledTimes(5);
    for (const call of (logger.warn as ReturnType<typeof vi.fn>).mock.calls) {
      expect(String(call[0])).toMatch(/DaemonAgentHost/);
      expect(String(call[0])).toMatch(/TABTIN_MAX_MESSAGE_CHARS/);
    }
  });

  it('trims whitespace and accepts large values without overflow', () => {
    const logger = makeLogger();
    expect(
      resolveMaxMessageChars(
        { TABTIN_MAX_MESSAGE_CHARS: '   10000000   ' },
        logger,
      ),
    ).toBe(10_000_000);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns default (no warn) on empty string', () => {
    const logger = makeLogger();
    expect(
      resolveMaxMessageChars({ TABTIN_MAX_MESSAGE_CHARS: '' }, logger),
    ).toBe(DEFAULT_MAX_MESSAGE_CHARS);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('Daemon host runtime options — resolveNormalizationLevel', () => {
  it('defaults to DEFAULT_NORMALIZATION_LEVEL when unset', () => {
    const logger = makeLogger();
    expect(resolveNormalizationLevel({}, logger)).toBe(
      DEFAULT_NORMALIZATION_LEVEL,
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("accepts 'off' / 'conservative' / 'full' (case-insensitive)", () => {
    const logger = makeLogger();
    for (const raw of ['off', 'CONSERVATIVE', ' Full ']) {
      const out = resolveNormalizationLevel(
        { TABTIN_NORMALIZATION_LEVEL: raw },
        logger,
      );
      expect(['off', 'conservative', 'full']).toContain(out);
    }
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('falls back + warns with Daemon tag on typo', () => {
    const logger = makeLogger();
    expect(
      resolveNormalizationLevel(
        { TABTIN_NORMALIZATION_LEVEL: 'conservativ' },
        logger,
      ),
    ).toBe(DEFAULT_NORMALIZATION_LEVEL);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const msg = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(String(msg)).toMatch(/DaemonAgentHost/);
    expect(String(msg)).toMatch(/TABTIN_NORMALIZATION_LEVEL/);
    expect(String(msg)).toMatch(/conservativ/);
  });

  it('treats empty / whitespace env as unset (no warn)', () => {
    const logger = makeLogger();
    expect(
      resolveNormalizationLevel({ TABTIN_NORMALIZATION_LEVEL: '' }, logger),
    ).toBe(DEFAULT_NORMALIZATION_LEVEL);
    expect(
      resolveNormalizationLevel(
        { TABTIN_NORMALIZATION_LEVEL: '   ' },
        logger,
      ),
    ).toBe(DEFAULT_NORMALIZATION_LEVEL);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

// ：压缩分档阈值 env 旋钮——排序口径与云端 decode / runtime 一致
// （micro <= summary < emergency），与 Electron 对称。
describe('Daemon host runtime options — resolvePressureThresholds', () => {
  it('parses three comma-separated thresholds', () => {
    const logger = makeLogger();
    expect(
      resolvePressureThresholds({ TABTIN_PRESSURE_THRESHOLDS: '0.7,0.8,0.9' }, logger),
    ).toEqual({ microCompactStart: 0.7, llmSummaryStart: 0.8, emergencyStart: 0.9 });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('accepts micro == summary (parallel tiers, same rule as cloud decode)', () => {
    const logger = makeLogger();
    expect(
      resolvePressureThresholds({ TABTIN_PRESSURE_THRESHOLDS: '0.85,0.85,0.95' }, logger),
    ).toEqual({ microCompactStart: 0.85, llmSummaryStart: 0.85, emergencyStart: 0.95 });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns and returns undefined on invalid ordering', () => {
    const logger = makeLogger();
    expect(
      resolvePressureThresholds({ TABTIN_PRESSURE_THRESHOLDS: '0.9,0.8,0.95' }, logger),
    ).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});

// FR-14（H2-D）SyncQueue 持久化开关。
// 默认 false 与 PRD §10 用户约束 "不要默认强制启用持久化" 对齐；
// 开启路径在 DaemonAgentHost.start() 改用 FilePersistentQueue。
describe('Daemon host runtime options — resolveSyncPersistence', () => {
  // 默认 true（与 Electron 对称，dogfood 修复 5/2 起）——实际默认早已是 true
  // （host-runtime-options.ts:639）。旧测试断言 false 是"全绿信号不可信"的表现。
  it('defaults to true when env unset (持久化默认开启)', () => {
    const logger = makeLogger();
    expect(resolveSyncPersistence({}, logger)).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('treats empty / whitespace env as unset (no warn, defaults true)', () => {
    const logger = makeLogger();
    expect(resolveSyncPersistence({ TABTIN_SYNC_PERSISTENCE: '' }, logger)).toBe(true);
    expect(
      resolveSyncPersistence({ TABTIN_SYNC_PERSISTENCE: '   ' }, logger),
    ).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("accepts truthy values: '1' / 'true' / 'on' (case-insensitive, trimmed)", () => {
    const logger = makeLogger();
    for (const raw of ['1', 'true', 'TRUE', 'on', ' On ']) {
      expect(
        resolveSyncPersistence({ TABTIN_SYNC_PERSISTENCE: raw }, logger),
      ).toBe(true);
    }
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("accepts falsy values: '0' / 'false' / 'off'", () => {
    const logger = makeLogger();
    for (const raw of ['0', 'false', 'FALSE', 'off']) {
      expect(
        resolveSyncPersistence({ TABTIN_SYNC_PERSISTENCE: raw }, logger),
      ).toBe(false);
    }
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('falls back + warns with Daemon tag on typo', () => {
    const logger = makeLogger();
    expect(
      resolveSyncPersistence({ TABTIN_SYNC_PERSISTENCE: 'enabled' }, logger),
    ).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const msg = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(String(msg)).toMatch(/DaemonAgentHost/);
    expect(String(msg)).toMatch(/TABTIN_SYNC_PERSISTENCE/);
    expect(String(msg)).toMatch(/enabled/);
  });
});

// FR-07 工具参数运行时校验级别
describe('Daemon host runtime options — resolveToolSchemaValidation', () => {
  it('defaults to warn when env unset', () => {
    const logger = makeLogger();
    expect(resolveToolSchemaValidation({}, logger)).toBe(DEFAULT_TOOL_SCHEMA_VALIDATION);
    expect(DEFAULT_TOOL_SCHEMA_VALIDATION).toBe('warn');
  });

  it('accepts off / warn / strict (case-insensitive, trimmed)', () => {
    const logger = makeLogger();
    expect(
      resolveToolSchemaValidation({ TABTIN_TOOL_SCHEMA_VALIDATION: 'off' }, logger),
    ).toBe('off');
    expect(
      resolveToolSchemaValidation({ TABTIN_TOOL_SCHEMA_VALIDATION: 'STRICT' }, logger),
    ).toBe('strict');
    expect(
      resolveToolSchemaValidation({ TABTIN_TOOL_SCHEMA_VALIDATION: '  Warn  ' }, logger),
    ).toBe('warn');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('falls back + warns with DaemonAgentHost tag on typo', () => {
    const logger = makeLogger();
    expect(
      resolveToolSchemaValidation({ TABTIN_TOOL_SCHEMA_VALIDATION: 'strikt' }, logger),
    ).toBe('warn');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const msg = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(String(msg)).toMatch(/DaemonAgentHost/);
    expect(String(msg)).toMatch(/TABTIN_TOOL_SCHEMA_VALIDATION/);
  });
});

// FR-09 工具输出注入扫描总开关
describe('Daemon host runtime options — resolveToolOutputScan', () => {
  it('defaults to true when env unset', () => {
    const logger = makeLogger();
    expect(resolveToolOutputScan({}, logger)).toBe(true);
  });

  it('parses truthy / falsy aliases', () => {
    const logger = makeLogger();
    expect(resolveToolOutputScan({ TABTIN_TOOL_OUTPUT_SCAN: 'on' }, logger)).toBe(true);
    expect(resolveToolOutputScan({ TABTIN_TOOL_OUTPUT_SCAN: '0' }, logger)).toBe(false);
    expect(resolveToolOutputScan({ TABTIN_TOOL_OUTPUT_SCAN: 'false' }, logger)).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('falls back + warns with DaemonAgentHost tag on typo', () => {
    const logger = makeLogger();
    expect(resolveToolOutputScan({ TABTIN_TOOL_OUTPUT_SCAN: 'maybe' }, logger)).toBe(true);
    const msg = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(String(msg)).toMatch(/DaemonAgentHost/);
    expect(String(msg)).toMatch(/TABTIN_TOOL_OUTPUT_SCAN/);
  });
});

// FR-18 Phase 2 (H2-E)：附件解析策略 knob。
// 与 Electron `host-runtime-options.ts` 对称同字符串集（local_first / cloud_first / cloud_only）。
// ─── resolveSummaryReuse (FR-16 H3-B) ───────────────────────────────

describe('Daemon host runtime options — resolveSummaryReuse', () => {
  it('defaults to true when env unset', () => {
    const logger = makeLogger();
    expect(resolveSummaryReuse({}, logger)).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('treats empty / whitespace env as unset (no warn)', () => {
    const logger = makeLogger();
    expect(resolveSummaryReuse({ TABTIN_SUMMARY_REUSE: '' }, logger)).toBe(true);
    expect(resolveSummaryReuse({ TABTIN_SUMMARY_REUSE: '   ' }, logger)).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('accepts on / true / 1 / enabled (case-insensitive, trimmed)', () => {
    const logger = makeLogger();
    expect(resolveSummaryReuse({ TABTIN_SUMMARY_REUSE: 'on' }, logger)).toBe(true);
    expect(resolveSummaryReuse({ TABTIN_SUMMARY_REUSE: 'TRUE' }, logger)).toBe(true);
    expect(resolveSummaryReuse({ TABTIN_SUMMARY_REUSE: '1' }, logger)).toBe(true);
    expect(resolveSummaryReuse({ TABTIN_SUMMARY_REUSE: '  Enabled  ' }, logger)).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('accepts off / false / 0 / disabled', () => {
    const logger = makeLogger();
    expect(resolveSummaryReuse({ TABTIN_SUMMARY_REUSE: 'off' }, logger)).toBe(false);
    expect(resolveSummaryReuse({ TABTIN_SUMMARY_REUSE: 'False' }, logger)).toBe(false);
    expect(resolveSummaryReuse({ TABTIN_SUMMARY_REUSE: '0' }, logger)).toBe(false);
    expect(resolveSummaryReuse({ TABTIN_SUMMARY_REUSE: 'disabled' }, logger)).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('falls back to true on typos and warns once with Daemon tag', () => {
    const logger = makeLogger();
    expect(resolveSummaryReuse({ TABTIN_SUMMARY_REUSE: 'maybe' }, logger)).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const msg = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(String(msg)).toMatch(/DaemonAgentHost/);
    expect(String(msg)).toMatch(/TABTIN_SUMMARY_REUSE/);
    expect(String(msg)).toMatch(/falling back to true/);
  });
});

// ─── resolveSummaryReuseJudge*  (FR-16 H3-B Review fix) ─────────────

describe('Daemon host runtime options — resolveSummaryReuseJudgeSampleRate', () => {
  it('returns undefined when env unset', () => {
    expect(resolveSummaryReuseJudgeSampleRate({}, makeLogger())).toBeUndefined();
  });
  it('accepts valid floats in [0, 1]', () => {
    expect(resolveSummaryReuseJudgeSampleRate({ TABTIN_SUMMARY_REUSE_JUDGE_SAMPLE_RATE: '0.5' }, makeLogger())).toBe(0.5);
  });
  it('warns and falls back on out-of-range', () => {
    const logger = makeLogger();
    expect(resolveSummaryReuseJudgeSampleRate({ TABTIN_SUMMARY_REUSE_JUDGE_SAMPLE_RATE: '1.5' }, logger)).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const msg = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(String(msg)).toMatch(/DaemonAgentHost/);
  });
});

describe('Daemon host runtime options — resolveSummaryReuseJudgeWindowSize', () => {
  it('accepts integer ≥ 10', () => {
    expect(resolveSummaryReuseJudgeWindowSize({ TABTIN_SUMMARY_REUSE_JUDGE_WINDOW_SIZE: '50' }, makeLogger())).toBe(50);
  });
  it('falls back on < 10', () => {
    expect(resolveSummaryReuseJudgeWindowSize({ TABTIN_SUMMARY_REUSE_JUDGE_WINDOW_SIZE: '9' }, makeLogger())).toBeUndefined();
  });
});

describe('Daemon host runtime options — resolveSummaryReuseJudgeThreshold', () => {
  it('accepts [0, 1] floats', () => {
    expect(resolveSummaryReuseJudgeThreshold({ TABTIN_SUMMARY_REUSE_JUDGE_THRESHOLD: '0.9' }, makeLogger())).toBe(0.9);
  });
});

describe('Daemon host runtime options — resolveSummaryReuseMaxAgeMs', () => {
  it('accepts non-negative integer', () => {
    expect(resolveSummaryReuseMaxAgeMs({ TABTIN_SUMMARY_REUSE_MAX_AGE_MS: '60000' }, makeLogger())).toBe(60000);
  });
  it('treats 0 as unlimited (returns undefined)', () => {
    expect(resolveSummaryReuseMaxAgeMs({ TABTIN_SUMMARY_REUSE_MAX_AGE_MS: '0' }, makeLogger())).toBeUndefined();
  });
});

describe('Daemon host runtime options — resolveSummaryReuseMinAddedMessages', () => {
  it('accepts integer ≥ 1', () => {
    expect(resolveSummaryReuseMinAddedMessages({ TABTIN_SUMMARY_REUSE_MIN_ADDED_MESSAGES: '5' }, makeLogger())).toBe(5);
  });
  it('falls back on 0', () => {
    expect(resolveSummaryReuseMinAddedMessages({ TABTIN_SUMMARY_REUSE_MIN_ADDED_MESSAGES: '0' }, makeLogger())).toBeUndefined();
  });
});

describe('Daemon host runtime options — resolveAttachmentStrategy (FR-18 Phase 2)', () => {
  it("defaults to 'local_first' when env unset", () => {
    const logger = makeLogger();
    expect(resolveAttachmentStrategy({}, logger)).toBe('local_first');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('treats empty / whitespace as unset', () => {
    const logger = makeLogger();
    expect(
      resolveAttachmentStrategy({ TABTIN_ATTACHMENT_STRATEGY: '' }, logger),
    ).toBe('local_first');
    expect(
      resolveAttachmentStrategy({ TABTIN_ATTACHMENT_STRATEGY: '   ' }, logger),
    ).toBe('local_first');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('accepts the two valid values (case-insensitive, trimmed)', () => {
    const logger = makeLogger();
    expect(
      resolveAttachmentStrategy({ TABTIN_ATTACHMENT_STRATEGY: 'local_first' }, logger),
    ).toBe('local_first');
    expect(
      resolveAttachmentStrategy({ TABTIN_ATTACHMENT_STRATEGY: '  cloud_only  ' }, logger),
    ).toBe('cloud_only');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  // W4 (2026-05-13)：cloud_first 已退役（T8 / D1 不留兼容）。env 写 cloud_first
  // 走 fallback warn —— 不再悄悄等价 cloud_only。
  it('rejects deprecated cloud_first env value with warn fallback (W4 T8)', () => {
    const logger = makeLogger();
    expect(
      resolveAttachmentStrategy({ TABTIN_ATTACHMENT_STRATEGY: 'cloud_first' }, logger),
    ).toBe('local_first');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const msg = String((logger.warn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? '');
    expect(msg).toMatch(/cloud_first.*no longer accepted/i);
    expect(msg).toMatch(/DaemonAgentHost/);
  });

  it('falls back + warns with DaemonAgentHost tag on common typos', () => {
    const logger = makeLogger();
    // 用户经常打成 'local-first' 或 'localfirst' — 不能静默回落
    expect(
      resolveAttachmentStrategy({ TABTIN_ATTACHMENT_STRATEGY: 'local-first' }, logger),
    ).toBe('local_first');
    expect(
      resolveAttachmentStrategy({ TABTIN_ATTACHMENT_STRATEGY: 'localfirst' }, logger),
    ).toBe('local_first');
    expect(logger.warn).toHaveBeenCalledTimes(2);
    for (const call of (logger.warn as ReturnType<typeof vi.fn>).mock.calls) {
      const msg = String(call[0]);
      expect(msg).toMatch(/DaemonAgentHost/);
      expect(msg).toMatch(/TABTIN_ATTACHMENT_STRATEGY/);
    }
  });
});

// FR-18 Phase 2 (H2-E)：本地解析体积上限 knob。
// Daemon 默认 20MB（NAS / 老服务器友好），上限 200MB 防 OOM。
describe('Daemon host runtime options — resolveMaxLocalFileSizeMb (FR-18 Phase 2)', () => {
  it('defaults to DAEMON_DEFAULT_MAX_LOCAL_FILE_SIZE_MB (20MB)', () => {
    const logger = makeLogger();
    expect(resolveMaxLocalFileSizeMb({}, logger)).toBe(DAEMON_DEFAULT_MAX_LOCAL_FILE_SIZE_MB);
    expect(DAEMON_DEFAULT_MAX_LOCAL_FILE_SIZE_MB).toBe(20);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('treats empty / whitespace as unset', () => {
    const logger = makeLogger();
    expect(
      resolveMaxLocalFileSizeMb({ TABTIN_LOCAL_DOCPARSE_MAX_MB: '' }, logger),
    ).toBe(DAEMON_DEFAULT_MAX_LOCAL_FILE_SIZE_MB);
    expect(
      resolveMaxLocalFileSizeMb({ TABTIN_LOCAL_DOCPARSE_MAX_MB: '  ' }, logger),
    ).toBe(DAEMON_DEFAULT_MAX_LOCAL_FILE_SIZE_MB);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('accepts a positive integer in (0, 200]', () => {
    const logger = makeLogger();
    expect(
      resolveMaxLocalFileSizeMb({ TABTIN_LOCAL_DOCPARSE_MAX_MB: '50' }, logger),
    ).toBe(50);
    expect(
      resolveMaxLocalFileSizeMb({ TABTIN_LOCAL_DOCPARSE_MAX_MB: '200' }, logger),
    ).toBe(200);
    expect(
      resolveMaxLocalFileSizeMb({ TABTIN_LOCAL_DOCPARSE_MAX_MB: '  100  ' }, logger),
    ).toBe(100);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('floors a positive float', () => {
    const logger = makeLogger();
    expect(
      resolveMaxLocalFileSizeMb({ TABTIN_LOCAL_DOCPARSE_MAX_MB: '37.8' }, logger),
    ).toBe(37);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('falls back + warns on 0 / negative / NaN / Infinity', () => {
    const logger = makeLogger();
    for (const bad of ['0', '-5', 'big', 'NaN', 'Infinity']) {
      expect(
        resolveMaxLocalFileSizeMb({ TABTIN_LOCAL_DOCPARSE_MAX_MB: bad }, logger),
      ).toBe(DAEMON_DEFAULT_MAX_LOCAL_FILE_SIZE_MB);
    }
    expect(logger.warn).toHaveBeenCalledTimes(5);
    for (const call of (logger.warn as ReturnType<typeof vi.fn>).mock.calls) {
      expect(String(call[0])).toMatch(/DaemonAgentHost/);
      expect(String(call[0])).toMatch(/TABTIN_LOCAL_DOCPARSE_MAX_MB/);
    }
  });

  it('clamps + warns when exceeding hard cap (200MB)', () => {
    const logger = makeLogger();
    expect(
      resolveMaxLocalFileSizeMb({ TABTIN_LOCAL_DOCPARSE_MAX_MB: '500' }, logger),
    ).toBe(200);
    expect(
      resolveMaxLocalFileSizeMb({ TABTIN_LOCAL_DOCPARSE_MAX_MB: '9999' }, logger),
    ).toBe(200);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    for (const call of (logger.warn as ReturnType<typeof vi.fn>).mock.calls) {
      expect(String(call[0])).toMatch(/exceeds hard cap/);
    }
  });
});

// FR-17.1 / FR-17.2 (H3-C)：子 Agent 治理 knob 与 Electron 对称。
describe('Daemon host runtime options — resolveMaxConcurrentChildren (FR-17.1 H3-C)', () => {
  it(`defaults to ${5} when env unset`, () => {
    const logger = makeLogger();
    expect(resolveMaxConcurrentChildren({}, logger)).toBe(DEFAULT_MAX_CONCURRENT_CHILDREN);
    expect(DEFAULT_MAX_CONCURRENT_CHILDREN).toBe(5);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("accepts 'unlimited' / '0' as Infinity", () => {
    const logger = makeLogger();
    expect(
      resolveMaxConcurrentChildren({ TABTIN_MAX_CONCURRENT_CHILDREN: 'unlimited' }, logger),
    ).toBe(Number.POSITIVE_INFINITY);
    expect(
      resolveMaxConcurrentChildren({ TABTIN_MAX_CONCURRENT_CHILDREN: '0' }, logger),
    ).toBe(Number.POSITIVE_INFINITY);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('accepts positive integer; floors floats; falls back on bad values', () => {
    const logger = makeLogger();
    expect(
      resolveMaxConcurrentChildren({ TABTIN_MAX_CONCURRENT_CHILDREN: '12' }, logger),
    ).toBe(12);
    expect(
      resolveMaxConcurrentChildren({ TABTIN_MAX_CONCURRENT_CHILDREN: '7.6' }, logger),
    ).toBe(7);
    for (const bad of ['-3', 'NaN', 'abc']) {
      expect(
        resolveMaxConcurrentChildren({ TABTIN_MAX_CONCURRENT_CHILDREN: bad }, logger),
      ).toBe(DEFAULT_MAX_CONCURRENT_CHILDREN);
    }
    expect(logger.warn).toHaveBeenCalledTimes(3);
    for (const call of (logger.warn as ReturnType<typeof vi.fn>).mock.calls) {
      expect(String(call[0])).toMatch(/DaemonAgentHost/);
      expect(String(call[0])).toMatch(/TABTIN_MAX_CONCURRENT_CHILDREN/);
    }
  });
});

describe('Daemon host runtime options — resolveSubagentResultCompact (FR-17.2 H3-C)', () => {
  it('defaults to true when env unset', () => {
    const logger = makeLogger();
    expect(resolveSubagentResultCompact({}, logger)).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('accepts truthy / falsy aliases', () => {
    const logger = makeLogger();
    expect(resolveSubagentResultCompact({ TABTIN_SUBAGENT_RESULT_COMPACT: 'on' }, logger)).toBe(true);
    expect(resolveSubagentResultCompact({ TABTIN_SUBAGENT_RESULT_COMPACT: 'true' }, logger)).toBe(true);
    expect(resolveSubagentResultCompact({ TABTIN_SUBAGENT_RESULT_COMPACT: '1' }, logger)).toBe(true);
    expect(resolveSubagentResultCompact({ TABTIN_SUBAGENT_RESULT_COMPACT: 'off' }, logger)).toBe(false);
    expect(resolveSubagentResultCompact({ TABTIN_SUBAGENT_RESULT_COMPACT: 'false' }, logger)).toBe(false);
    expect(resolveSubagentResultCompact({ TABTIN_SUBAGENT_RESULT_COMPACT: '0' }, logger)).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns + falls back to true on typo', () => {
    const logger = makeLogger();
    expect(
      resolveSubagentResultCompact({ TABTIN_SUBAGENT_RESULT_COMPACT: 'maybe' }, logger),
    ).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(
      String((logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0]),
    ).toMatch(/TABTIN_SUBAGENT_RESULT_COMPACT/);
  });
});

// FR-18 Phase 2 (H2-E)：从 prompt.forward payload 解出 attachment_strategy。
// 旧版 daemon.ts 把这 5 行白名单 inline 在私有方法里 → 不可单测，
// 任何 Django 端字段升级（如新增 'cloud_first_with_quota'）极易漏改。
// H2-E review 将它抽到 host-knobs 后由本组测试守住白名单契约。
describe('Daemon host runtime options — decodeAttachmentStrategyFromPayload (FR-18 Phase 2)', () => {
  it('returns undefined when payload has no attachment_strategy field', () => {
    expect(decodeAttachmentStrategyFromPayload({})).toBeUndefined();
  });

  it('returns undefined when payload.attachment_strategy is null / non-string', () => {
    expect(decodeAttachmentStrategyFromPayload({ attachment_strategy: null })).toBeUndefined();
    expect(decodeAttachmentStrategyFromPayload({ attachment_strategy: 123 })).toBeUndefined();
    expect(
      decodeAttachmentStrategyFromPayload({ attachment_strategy: ['local_first'] }),
    ).toBeUndefined();
    expect(
      decodeAttachmentStrategyFromPayload({ attachment_strategy: { value: 'local_first' } }),
    ).toBeUndefined();
  });

  it("accepts the two valid string values: 'local_first' / 'cloud_only'", () => {
    expect(decodeAttachmentStrategyFromPayload({ attachment_strategy: 'local_first' })).toBe('local_first');
    expect(decodeAttachmentStrategyFromPayload({ attachment_strategy: 'cloud_only' })).toBe('cloud_only');
  });

  // W4 (2026-05-13)：cloud_first 字面值已退役（T8）。payload decoder 静默返
  // undefined 让上层 env fallback 链接管——不悄悄等价 cloud_only。
  it('rejects deprecated cloud_first payload value (W4 T8) — silently undefined', () => {
    expect(decodeAttachmentStrategyFromPayload({ attachment_strategy: 'cloud_first' })).toBeUndefined();
  });

  it('is case-sensitive — UPPER / mixed case returns undefined (vs env decoder which is case-insensitive)', () => {
    // 这是有意为之：payload 来自 Django 后端代码（标准化字符串），
    // 不是用户配置的 env（人类容易打错大小写）。后端字段升级若改大小写
    // 会被这里 caught 而非静默回落。
    expect(decodeAttachmentStrategyFromPayload({ attachment_strategy: 'LOCAL_FIRST' })).toBeUndefined();
    expect(decodeAttachmentStrategyFromPayload({ attachment_strategy: 'Local_First' })).toBeUndefined();
  });

  it('does not trim — leading/trailing whitespace returns undefined (Django 应规范化)', () => {
    expect(decodeAttachmentStrategyFromPayload({ attachment_strategy: ' local_first' })).toBeUndefined();
    expect(decodeAttachmentStrategyFromPayload({ attachment_strategy: 'cloud_only ' })).toBeUndefined();
  });

  it('returns undefined for known typos (so DaemonAgentHost will fall through to env / default)', () => {
    // 'local-first'（连字符 vs 下划线）/ 'localfirst'（缺分隔符）等常见错写
    // 在 env decoder 里会被 warn + fallback 'local_first'；payload decoder 静默
    // 返回 undefined 让上层兜底链生效（按 doc 所述 — 不打 warn 是有意为之）。
    expect(decodeAttachmentStrategyFromPayload({ attachment_strategy: 'local-first' })).toBeUndefined();
    expect(decodeAttachmentStrategyFromPayload({ attachment_strategy: 'localfirst' })).toBeUndefined();
    expect(decodeAttachmentStrategyFromPayload({ attachment_strategy: 'cloud' })).toBeUndefined();
  });

  it("treats empty string as 'no value' (returns undefined, no throw)", () => {
    expect(decodeAttachmentStrategyFromPayload({ attachment_strategy: '' })).toBeUndefined();
  });
});

// ─── resolveIterationBudget (FR-15) ──────────────────────────────────

describe('Daemon host runtime options — resolveIterationBudget', () => {
  it('returns DEFAULT_ITERATION_BUDGET when no env vars set', () => {
    const logger = makeLogger();
    expect(resolveIterationBudget({}, logger)).toEqual(DEFAULT_ITERATION_BUDGET);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('parses all four env keys correctly (mirrors Electron parity)', () => {
    const logger = makeLogger();
    const out = resolveIterationBudget(
      {
        TABTIN_ITERATION_BUDGET_WARN_ITER: '0.6',
        TABTIN_ITERATION_BUDGET_GRACE_ITER: '0.85',
        TABTIN_ITERATION_BUDGET_WARN_TOKEN: '0.8',
        TABTIN_ITERATION_BUDGET_GRACE_TOKEN: '0.9',
      },
      logger,
    );
    expect(out.iteration).toEqual({ warn: 0.6, grace: 0.85, terminate: 1.0 });
    expect(out.token).toEqual({ warn: 0.8, grace: 0.9, terminate: 1.0 });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('terminate is locked to 1.0 (env cannot override)', () => {
    const logger = makeLogger();
    const out = resolveIterationBudget(
      {
        TABTIN_ITERATION_BUDGET_WARN_ITER: '0.5',
      },
      logger,
    );
    expect(out.iteration.terminate).toBe(1.0);
    expect(out.token.terminate).toBe(1.0);
  });

  it('warns and falls back when value is out of (0, 1] range', () => {
    const logger = makeLogger();
    const out = resolveIterationBudget(
      { TABTIN_ITERATION_BUDGET_GRACE_TOKEN: '1.5' },
      logger,
    );
    expect(out.token.grace).toBe(DEFAULT_ITERATION_BUDGET.token.grace);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(
      String((logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0]),
    ).toMatch(/TABTIN_ITERATION_BUDGET_GRACE_TOKEN/);
    // Daemon 用 [DaemonAgentHost] 前缀（与 Electron 的 [AgentHost] 区分）
    expect(
      String((logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0]),
    ).toMatch(/DaemonAgentHost/);
  });

  it('warns + falls back for non-numeric / 0 / negative', () => {
    const logger = makeLogger();
    const out = resolveIterationBudget(
      {
        TABTIN_ITERATION_BUDGET_WARN_ITER: 'abc',
        TABTIN_ITERATION_BUDGET_GRACE_ITER: '0',
        TABTIN_ITERATION_BUDGET_WARN_TOKEN: '-0.1',
      },
      logger,
    );
    expect(out.iteration.warn).toBe(DEFAULT_ITERATION_BUDGET.iteration.warn);
    expect(out.iteration.grace).toBe(DEFAULT_ITERATION_BUDGET.iteration.grace);
    expect(out.token.warn).toBe(DEFAULT_ITERATION_BUDGET.token.warn);
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });

  it('handles empty / whitespace string as unset', () => {
    const logger = makeLogger();
    const out = resolveIterationBudget(
      {
        TABTIN_ITERATION_BUDGET_WARN_ITER: '',
        TABTIN_ITERATION_BUDGET_GRACE_TOKEN: '   \t  ',
      },
      logger,
    );
    expect(out).toEqual(DEFAULT_ITERATION_BUDGET);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

// 跨宿主对称性不做 import 级断言（跨 monorepo 包 import 源文件在 vitest
// resolve 下脆弱）。Electron / Daemon 各自的测试分别覆盖同一组不变量
// （empty→default、typo→fallback+warn、'soft'|'strict' 通过、0/负→fallback
// 等），两边同时维护即形成对称保障。如果未来一侧添加新 env key，新
// key 也应在另一侧出现 + 两边测试同步扩充。
