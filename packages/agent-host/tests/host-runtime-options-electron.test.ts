/**
 * FR-01 / FR-03 / FR-04 / FR-07 / FR-09 回归：Electron 宿主对 runtime
 * knob 环境变量的解析。
 *
 * 不启动完整的 `ElectronAgentHost`（会拉起 ipcMain / app 副作用，jsdom
 * 跑不了），直接对纯函数 `resolveDoomLoopPolicy` /
 * `resolveMaxMessageChars` / `resolveNormalizationLevel` /
 * `resolveToolSchemaValidation` / `resolveToolOutputScan` 做断言。
 * 生产代码里这五个 helper 被 `createRuntimeForSession` 消费，本测试锁死
 * "env → EngineConfig 值"这一层契约，确保运维通过 env 翻策略 / 上限 /
 * 校验级别 / 输出扫描时不会被 typo 或非法值静默吞掉。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  DEFAULT_MAX_CONCURRENT_CHILDREN,
  ELECTRON_DEFAULT_MAX_LOCAL_FILE_SIZE_MB,
  electronHostRuntimeOptions,
  type HostRuntimeOptionsLogger,
} from '../src/configuration/host-runtime-options.js'
const {
  resolveAttachmentStrategy,
  resolveDoomLoopPolicy,
  resolveIterationBudget,
  resolveMaxConcurrentChildren,
  resolveMaxLocalFileSizeMb,
  resolveMaxMessageChars,
  resolveNormalizationLevel,
  resolveSubagentResultCompact,
  resolveToolSchemaValidation,
  resolveToolOutputScan,
  resolveSyncPersistence,
  resolveSummaryReuse,
  resolveSummaryReuseJudgeSampleRate,
  resolveSummaryReuseJudgeWindowSize,
  resolveSummaryReuseJudgeThreshold,
  resolveSummaryReuseMaxAgeMs,
  resolveSummaryReuseMinAddedMessages,
  resolveTimeBasedMicroCompact,
  resolvePressureThresholds,
  decodeCloudPressureThresholds,
} = electronHostRuntimeOptions
import {
  DEFAULT_ITERATION_BUDGET,
  DEFAULT_MAX_MESSAGE_CHARS,
  DEFAULT_NORMALIZATION_LEVEL,
  DEFAULT_TOOL_SCHEMA_VALIDATION,
} from '@tabtin/agent-runtime/engine'

function makeLogger(): HostRuntimeOptionsLogger & { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn() }
}

// ─── resolveDoomLoopPolicy ───────────────────────────────────────────

describe('Electron host runtime options — resolveDoomLoopPolicy', () => {
  it("defaults to 'soft' when TABTIN_DOOM_LOOP_POLICY is unset", () => {
    const logger = makeLogger()
    const out = resolveDoomLoopPolicy({}, logger)
    expect(out).toBe('soft')
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it("defaults to 'soft' when env var is an empty string", () => {
    const logger = makeLogger()
    expect(resolveDoomLoopPolicy({ TABTIN_DOOM_LOOP_POLICY: '' }, logger)).toBe('soft')
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it("defaults to 'soft' when env var is whitespace-only", () => {
    const logger = makeLogger()
    expect(
      resolveDoomLoopPolicy({ TABTIN_DOOM_LOOP_POLICY: '   \t  ' }, logger),
    ).toBe('soft')
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it("accepts 'soft' (exact lower-case)", () => {
    const logger = makeLogger()
    expect(
      resolveDoomLoopPolicy({ TABTIN_DOOM_LOOP_POLICY: 'soft' }, logger),
    ).toBe('soft')
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it("accepts 'strict' (exact lower-case)", () => {
    const logger = makeLogger()
    expect(
      resolveDoomLoopPolicy({ TABTIN_DOOM_LOOP_POLICY: 'strict' }, logger),
    ).toBe('strict')
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it("accepts 'STRICT' / 'Soft' (case-insensitive)", () => {
    const logger = makeLogger()
    expect(
      resolveDoomLoopPolicy({ TABTIN_DOOM_LOOP_POLICY: 'STRICT' }, logger),
    ).toBe('strict')
    expect(
      resolveDoomLoopPolicy({ TABTIN_DOOM_LOOP_POLICY: 'Soft' }, logger),
    ).toBe('soft')
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it("trims surrounding whitespace before validation", () => {
    const logger = makeLogger()
    expect(
      resolveDoomLoopPolicy({ TABTIN_DOOM_LOOP_POLICY: '  strict  ' }, logger),
    ).toBe('strict')
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it("falls back to 'soft' on typo and warns once with offending value", () => {
    const logger = makeLogger()
    const out = resolveDoomLoopPolicy(
      { TABTIN_DOOM_LOOP_POLICY: 'strictt' },
      logger,
    )
    expect(out).toBe('soft')
    expect(logger.warn).toHaveBeenCalledTimes(1)
    const msg = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(msg).toMatch(/TABTIN_DOOM_LOOP_POLICY/)
    expect(msg).toMatch(/strictt/)
    expect(msg).toMatch(/fall(ing)?\s+back to 'soft'/i)
  })

  it("falls back to 'soft' on 'off' / 'disabled' / random value (no off-switch semantic)", () => {
    // off/disabled 看起来像一个"关 DoomLoop"的语义，但本 knob 没有这个
    // 概念（关闭 DoomLoop 的方式是不安装 middleware）。混淆写法一律当
    // typo 处理，回到 soft。
    const logger = makeLogger()
    expect(
      resolveDoomLoopPolicy({ TABTIN_DOOM_LOOP_POLICY: 'off' }, logger),
    ).toBe('soft')
    expect(
      resolveDoomLoopPolicy({ TABTIN_DOOM_LOOP_POLICY: 'disabled' }, logger),
    ).toBe('soft')
    expect(logger.warn).toHaveBeenCalledTimes(2)
  })
})

// ─── resolveMaxMessageChars ──────────────────────────────────────────

describe('Electron host runtime options — resolveMaxMessageChars', () => {
  it('defaults to DEFAULT_MAX_MESSAGE_CHARS when unset', () => {
    const logger = makeLogger()
    expect(resolveMaxMessageChars({}, logger)).toBe(DEFAULT_MAX_MESSAGE_CHARS)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('accepts a positive finite integer', () => {
    const logger = makeLogger()
    expect(
      resolveMaxMessageChars({ TABTIN_MAX_MESSAGE_CHARS: '2000000' }, logger),
    ).toBe(2_000_000)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('floors a positive float (integer-only semantic)', () => {
    const logger = makeLogger()
    expect(
      resolveMaxMessageChars({ TABTIN_MAX_MESSAGE_CHARS: '500000.9' }, logger),
    ).toBe(500_000)
  })

  it('trims whitespace before parsing', () => {
    const logger = makeLogger()
    expect(
      resolveMaxMessageChars({ TABTIN_MAX_MESSAGE_CHARS: '  123456  ' }, logger),
    ).toBe(123_456)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('falls back + warns on 0 (FR-04 safety net must stay armed)', () => {
    const logger = makeLogger()
    const out = resolveMaxMessageChars(
      { TABTIN_MAX_MESSAGE_CHARS: '0' },
      logger,
    )
    expect(out).toBe(DEFAULT_MAX_MESSAGE_CHARS)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('falls back + warns on negative number', () => {
    const logger = makeLogger()
    expect(
      resolveMaxMessageChars({ TABTIN_MAX_MESSAGE_CHARS: '-1' }, logger),
    ).toBe(DEFAULT_MAX_MESSAGE_CHARS)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('falls back + warns on non-numeric string', () => {
    const logger = makeLogger()
    expect(
      resolveMaxMessageChars({ TABTIN_MAX_MESSAGE_CHARS: 'big' }, logger),
    ).toBe(DEFAULT_MAX_MESSAGE_CHARS)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    const msg = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(msg).toMatch(/TABTIN_MAX_MESSAGE_CHARS/)
    expect(msg).toMatch(/big/)
  })

  it('falls back + warns on Infinity', () => {
    const logger = makeLogger()
    expect(
      resolveMaxMessageChars(
        { TABTIN_MAX_MESSAGE_CHARS: 'Infinity' },
        logger,
      ),
    ).toBe(DEFAULT_MAX_MESSAGE_CHARS)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('returns default (no warn) on empty / whitespace-only env', () => {
    const logger = makeLogger()
    expect(
      resolveMaxMessageChars({ TABTIN_MAX_MESSAGE_CHARS: '' }, logger),
    ).toBe(DEFAULT_MAX_MESSAGE_CHARS)
    expect(
      resolveMaxMessageChars({ TABTIN_MAX_MESSAGE_CHARS: '   ' }, logger),
    ).toBe(DEFAULT_MAX_MESSAGE_CHARS)
    expect(logger.warn).not.toHaveBeenCalled()
  })
})

// ─── resolveNormalizationLevel ───────────────────────────────────────

describe('Electron host runtime options — resolveNormalizationLevel', () => {
  it('defaults to DEFAULT_NORMALIZATION_LEVEL when env is unset', () => {
    const logger = makeLogger()
    expect(resolveNormalizationLevel({}, logger)).toBe(
      DEFAULT_NORMALIZATION_LEVEL,
    )
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it("accepts 'off' / 'conservative' / 'full' (exact lower-case)", () => {
    const logger = makeLogger()
    expect(
      resolveNormalizationLevel({ TABTIN_NORMALIZATION_LEVEL: 'off' }, logger),
    ).toBe('off')
    expect(
      resolveNormalizationLevel(
        { TABTIN_NORMALIZATION_LEVEL: 'conservative' },
        logger,
      ),
    ).toBe('conservative')
    expect(
      resolveNormalizationLevel({ TABTIN_NORMALIZATION_LEVEL: 'full' }, logger),
    ).toBe('full')
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('is case-insensitive and trims whitespace', () => {
    const logger = makeLogger()
    expect(
      resolveNormalizationLevel(
        { TABTIN_NORMALIZATION_LEVEL: '  FULL  ' },
        logger,
      ),
    ).toBe('full')
    expect(
      resolveNormalizationLevel(
        { TABTIN_NORMALIZATION_LEVEL: 'Off' },
        logger,
      ),
    ).toBe('off')
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('falls back + warns on typos like "ful" / "conserv"', () => {
    const logger = makeLogger()
    expect(
      resolveNormalizationLevel(
        { TABTIN_NORMALIZATION_LEVEL: 'ful' },
        logger,
      ),
    ).toBe(DEFAULT_NORMALIZATION_LEVEL)
    expect(
      resolveNormalizationLevel(
        { TABTIN_NORMALIZATION_LEVEL: 'conserv' },
        logger,
      ),
    ).toBe(DEFAULT_NORMALIZATION_LEVEL)
    expect(logger.warn).toHaveBeenCalledTimes(2)
    const msg = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(msg).toMatch(/TABTIN_NORMALIZATION_LEVEL/)
    expect(msg).toMatch(/ful/)
    expect(msg).toMatch(/falling back to 'conservative'/i)
  })

  it('does not warn on empty or whitespace-only env', () => {
    const logger = makeLogger()
    expect(
      resolveNormalizationLevel({ TABTIN_NORMALIZATION_LEVEL: '' }, logger),
    ).toBe(DEFAULT_NORMALIZATION_LEVEL)
    expect(
      resolveNormalizationLevel(
        { TABTIN_NORMALIZATION_LEVEL: '   ' },
        logger,
      ),
    ).toBe(DEFAULT_NORMALIZATION_LEVEL)
    expect(logger.warn).not.toHaveBeenCalled()
  })
})

// ─── resolveToolSchemaValidation (FR-07) ─────────────────────────────

describe('Electron host runtime options — resolveToolSchemaValidation', () => {
  it('defaults to warn when env is unset', () => {
    const logger = makeLogger()
    expect(resolveToolSchemaValidation({}, logger)).toBe(DEFAULT_TOOL_SCHEMA_VALIDATION)
    expect(DEFAULT_TOOL_SCHEMA_VALIDATION).toBe('warn')
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('accepts off / warn / strict (case-insensitive, trimmed)', () => {
    const logger = makeLogger()
    expect(resolveToolSchemaValidation({ TABTIN_TOOL_SCHEMA_VALIDATION: 'off' }, logger)).toBe('off')
    expect(resolveToolSchemaValidation({ TABTIN_TOOL_SCHEMA_VALIDATION: 'WARN' }, logger)).toBe('warn')
    expect(resolveToolSchemaValidation({ TABTIN_TOOL_SCHEMA_VALIDATION: '  Strict  ' }, logger)).toBe('strict')
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('warns + falls back when value is malformed', () => {
    const logger = makeLogger()
    expect(
      resolveToolSchemaValidation({ TABTIN_TOOL_SCHEMA_VALIDATION: 'strikt' }, logger),
    ).toBe('warn')
    expect(logger.warn).toHaveBeenCalledTimes(1)
    const msg = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(msg).toMatch(/TABTIN_TOOL_SCHEMA_VALIDATION/)
    expect(msg).toMatch(/falling back to 'warn'/)
  })

  it('does not warn on empty / whitespace-only env', () => {
    const logger = makeLogger()
    expect(resolveToolSchemaValidation({ TABTIN_TOOL_SCHEMA_VALIDATION: '' }, logger)).toBe('warn')
    expect(resolveToolSchemaValidation({ TABTIN_TOOL_SCHEMA_VALIDATION: '   ' }, logger)).toBe('warn')
    expect(logger.warn).not.toHaveBeenCalled()
  })
})

// ─── resolveToolOutputScan (FR-09) ───────────────────────────────────

describe('Electron host runtime options — resolveToolOutputScan', () => {
  it('defaults to true when unset', () => {
    const logger = makeLogger()
    expect(resolveToolOutputScan({}, logger)).toBe(true)
  })

  it('parses common truthy / falsy aliases', () => {
    const logger = makeLogger()
    expect(resolveToolOutputScan({ TABTIN_TOOL_OUTPUT_SCAN: 'on' }, logger)).toBe(true)
    expect(resolveToolOutputScan({ TABTIN_TOOL_OUTPUT_SCAN: 'true' }, logger)).toBe(true)
    expect(resolveToolOutputScan({ TABTIN_TOOL_OUTPUT_SCAN: '1' }, logger)).toBe(true)
    expect(resolveToolOutputScan({ TABTIN_TOOL_OUTPUT_SCAN: 'enabled' }, logger)).toBe(true)
    expect(resolveToolOutputScan({ TABTIN_TOOL_OUTPUT_SCAN: 'OFF' }, logger)).toBe(false)
    expect(resolveToolOutputScan({ TABTIN_TOOL_OUTPUT_SCAN: 'false' }, logger)).toBe(false)
    expect(resolveToolOutputScan({ TABTIN_TOOL_OUTPUT_SCAN: '0' }, logger)).toBe(false)
    expect(resolveToolOutputScan({ TABTIN_TOOL_OUTPUT_SCAN: 'disabled' }, logger)).toBe(false)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('warns + falls back to on when value is malformed', () => {
    const logger = makeLogger()
    expect(resolveToolOutputScan({ TABTIN_TOOL_OUTPUT_SCAN: 'maybe' }, logger)).toBe(true)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    const msg = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(msg).toMatch(/TABTIN_TOOL_OUTPUT_SCAN/)
    expect(msg).toMatch(/falling back to 'on'/)
  })
})

// ─── resolveSyncPersistence (FR-14) ──────────────────────────────────

describe('Electron host runtime options — resolveSyncPersistence', () => {
  // 默认 true（dogfood 修复 5/2 起：InMemoryPersistentQueue 导致 Electron 重载后未
  // 同步消息丢失，改默认开启文件持久化）。旧测试断言 false 是"全绿信号不可信"的
  // 表现——实际默认早已是 true（host-runtime-options.ts:685）。
  it('defaults to true when env unset (持久化默认开启)', () => {
    const logger = makeLogger()
    expect(resolveSyncPersistence({}, logger)).toBe(true)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('treats empty / whitespace env as unset (no warn, defaults true)', () => {
    const logger = makeLogger()
    expect(resolveSyncPersistence({ TABTIN_SYNC_PERSISTENCE: '' }, logger)).toBe(true)
    expect(resolveSyncPersistence({ TABTIN_SYNC_PERSISTENCE: '   ' }, logger)).toBe(true)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it("accepts truthy values: '1' / 'true' / 'on' (case-insensitive, trimmed)", () => {
    const logger = makeLogger()
    for (const raw of ['1', 'true', 'TRUE', 'on', ' On ']) {
      expect(resolveSyncPersistence({ TABTIN_SYNC_PERSISTENCE: raw }, logger)).toBe(true)
    }
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it("accepts falsy values: '0' / 'false' / 'off'", () => {
    const logger = makeLogger()
    for (const raw of ['0', 'false', 'FALSE', 'off']) {
      expect(resolveSyncPersistence({ TABTIN_SYNC_PERSISTENCE: raw }, logger)).toBe(false)
    }
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('warns + falls back to false on typo', () => {
    const logger = makeLogger()
    expect(resolveSyncPersistence({ TABTIN_SYNC_PERSISTENCE: 'enabled' }, logger)).toBe(false)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    const msg = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(String(msg)).toMatch(/TABTIN_SYNC_PERSISTENCE/)
    expect(String(msg)).toMatch(/falling back to false/)
  })
})

// ─── resolveSummaryReuse (FR-16 H3-B) ───────────────────────────────

describe('Electron host runtime options — resolveSummaryReuse', () => {
  it('defaults to true when env unset', () => {
    const logger = makeLogger()
    expect(resolveSummaryReuse({}, logger)).toBe(true)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('treats empty / whitespace env as unset (no warn)', () => {
    const logger = makeLogger()
    expect(resolveSummaryReuse({ TABTIN_SUMMARY_REUSE: '' }, logger)).toBe(true)
    expect(resolveSummaryReuse({ TABTIN_SUMMARY_REUSE: '   ' }, logger)).toBe(true)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('accepts on / true / 1 / enabled (case-insensitive, trimmed)', () => {
    const logger = makeLogger()
    expect(resolveSummaryReuse({ TABTIN_SUMMARY_REUSE: 'on' }, logger)).toBe(true)
    expect(resolveSummaryReuse({ TABTIN_SUMMARY_REUSE: 'TRUE' }, logger)).toBe(true)
    expect(resolveSummaryReuse({ TABTIN_SUMMARY_REUSE: '1' }, logger)).toBe(true)
    expect(resolveSummaryReuse({ TABTIN_SUMMARY_REUSE: '  Enabled  ' }, logger)).toBe(true)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('accepts off / false / 0 / disabled', () => {
    const logger = makeLogger()
    expect(resolveSummaryReuse({ TABTIN_SUMMARY_REUSE: 'off' }, logger)).toBe(false)
    expect(resolveSummaryReuse({ TABTIN_SUMMARY_REUSE: 'False' }, logger)).toBe(false)
    expect(resolveSummaryReuse({ TABTIN_SUMMARY_REUSE: '0' }, logger)).toBe(false)
    expect(resolveSummaryReuse({ TABTIN_SUMMARY_REUSE: 'disabled' }, logger)).toBe(false)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('falls back to true on typos and warns once', () => {
    const logger = makeLogger()
    expect(resolveSummaryReuse({ TABTIN_SUMMARY_REUSE: 'maybe' }, logger)).toBe(true)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    const msg = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(String(msg)).toMatch(/TABTIN_SUMMARY_REUSE/)
    expect(String(msg)).toMatch(/falling back to true/)
  })
})

// ─── resolveSummaryReuseJudge*  (FR-16 H3-B Review fix) ─────────────

describe('Electron host runtime options — resolveSummaryReuseJudgeSampleRate', () => {
  it('returns undefined when env unset', () => {
    expect(resolveSummaryReuseJudgeSampleRate({}, makeLogger())).toBeUndefined()
  })

  it('accepts valid floats in [0, 1]', () => {
    const logger = makeLogger()
    expect(resolveSummaryReuseJudgeSampleRate({ TABTIN_SUMMARY_REUSE_JUDGE_SAMPLE_RATE: '0' }, logger)).toBe(0)
    expect(resolveSummaryReuseJudgeSampleRate({ TABTIN_SUMMARY_REUSE_JUDGE_SAMPLE_RATE: '0.5' }, logger)).toBe(0.5)
    expect(resolveSummaryReuseJudgeSampleRate({ TABTIN_SUMMARY_REUSE_JUDGE_SAMPLE_RATE: '1' }, logger)).toBe(1)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('warns and falls back on out-of-range / invalid', () => {
    const logger = makeLogger()
    expect(resolveSummaryReuseJudgeSampleRate({ TABTIN_SUMMARY_REUSE_JUDGE_SAMPLE_RATE: '1.5' }, logger)).toBeUndefined()
    expect(resolveSummaryReuseJudgeSampleRate({ TABTIN_SUMMARY_REUSE_JUDGE_SAMPLE_RATE: '-0.1' }, logger)).toBeUndefined()
    expect(resolveSummaryReuseJudgeSampleRate({ TABTIN_SUMMARY_REUSE_JUDGE_SAMPLE_RATE: 'abc' }, logger)).toBeUndefined()
    expect(logger.warn).toHaveBeenCalledTimes(3)
  })
})

describe('Electron host runtime options — resolveSummaryReuseJudgeWindowSize', () => {
  it('returns undefined when env unset', () => {
    expect(resolveSummaryReuseJudgeWindowSize({}, makeLogger())).toBeUndefined()
  })

  it('accepts integer ≥ 10', () => {
    expect(resolveSummaryReuseJudgeWindowSize({ TABTIN_SUMMARY_REUSE_JUDGE_WINDOW_SIZE: '10' }, makeLogger())).toBe(10)
    expect(resolveSummaryReuseJudgeWindowSize({ TABTIN_SUMMARY_REUSE_JUDGE_WINDOW_SIZE: '500' }, makeLogger())).toBe(500)
  })

  it('warns and falls back on < 10 / float / non-numeric', () => {
    const logger = makeLogger()
    expect(resolveSummaryReuseJudgeWindowSize({ TABTIN_SUMMARY_REUSE_JUDGE_WINDOW_SIZE: '5' }, logger)).toBeUndefined()
    expect(resolveSummaryReuseJudgeWindowSize({ TABTIN_SUMMARY_REUSE_JUDGE_WINDOW_SIZE: '10.5' }, logger)).toBeUndefined()
    expect(resolveSummaryReuseJudgeWindowSize({ TABTIN_SUMMARY_REUSE_JUDGE_WINDOW_SIZE: 'abc' }, logger)).toBeUndefined()
    expect(logger.warn).toHaveBeenCalledTimes(3)
  })
})

describe('Electron host runtime options — resolveSummaryReuseJudgeThreshold', () => {
  it('accepts [0, 1] floats', () => {
    expect(resolveSummaryReuseJudgeThreshold({ TABTIN_SUMMARY_REUSE_JUDGE_THRESHOLD: '0.9' }, makeLogger())).toBe(0.9)
    expect(resolveSummaryReuseJudgeThreshold({ TABTIN_SUMMARY_REUSE_JUDGE_THRESHOLD: '0' }, makeLogger())).toBe(0)
  })
  it('falls back on out-of-range', () => {
    const logger = makeLogger()
    expect(resolveSummaryReuseJudgeThreshold({ TABTIN_SUMMARY_REUSE_JUDGE_THRESHOLD: '1.1' }, logger)).toBeUndefined()
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })
})

describe('Electron host runtime options — resolveSummaryReuseMaxAgeMs', () => {
  it('accepts non-negative integer', () => {
    expect(resolveSummaryReuseMaxAgeMs({ TABTIN_SUMMARY_REUSE_MAX_AGE_MS: '60000' }, makeLogger())).toBe(60000)
  })
  it('treats 0 as "no limit" (returns undefined)', () => {
    expect(resolveSummaryReuseMaxAgeMs({ TABTIN_SUMMARY_REUSE_MAX_AGE_MS: '0' }, makeLogger())).toBeUndefined()
  })
  it('falls back on negative / float / non-numeric', () => {
    const logger = makeLogger()
    expect(resolveSummaryReuseMaxAgeMs({ TABTIN_SUMMARY_REUSE_MAX_AGE_MS: '-1' }, logger)).toBeUndefined()
    expect(resolveSummaryReuseMaxAgeMs({ TABTIN_SUMMARY_REUSE_MAX_AGE_MS: '10.5' }, logger)).toBeUndefined()
    expect(logger.warn).toHaveBeenCalledTimes(2)
  })
})

describe('Electron host runtime options — resolveSummaryReuseMinAddedMessages', () => {
  it('accepts integer ≥ 1', () => {
    expect(resolveSummaryReuseMinAddedMessages({ TABTIN_SUMMARY_REUSE_MIN_ADDED_MESSAGES: '1' }, makeLogger())).toBe(1)
    expect(resolveSummaryReuseMinAddedMessages({ TABTIN_SUMMARY_REUSE_MIN_ADDED_MESSAGES: '5' }, makeLogger())).toBe(5)
  })
  it('falls back on 0 / negative / float', () => {
    const logger = makeLogger()
    expect(resolveSummaryReuseMinAddedMessages({ TABTIN_SUMMARY_REUSE_MIN_ADDED_MESSAGES: '0' }, logger)).toBeUndefined()
    expect(resolveSummaryReuseMinAddedMessages({ TABTIN_SUMMARY_REUSE_MIN_ADDED_MESSAGES: '-1' }, logger)).toBeUndefined()
    expect(resolveSummaryReuseMinAddedMessages({ TABTIN_SUMMARY_REUSE_MIN_ADDED_MESSAGES: '1.5' }, logger)).toBeUndefined()
    expect(logger.warn).toHaveBeenCalledTimes(3)
  })
})

// ─── resolveAttachmentStrategy (FR-18 Phase 2) ──────────────────────

describe('Electron host runtime options — resolveAttachmentStrategy', () => {
  it("defaults to 'local_first' when env unset", () => {
    const logger = makeLogger()
    expect(resolveAttachmentStrategy({}, logger)).toBe('local_first')
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('treats empty / whitespace env as unset (no warn)', () => {
    const logger = makeLogger()
    expect(resolveAttachmentStrategy({ TABTIN_ATTACHMENT_STRATEGY: '' }, logger)).toBe('local_first')
    expect(resolveAttachmentStrategy({ TABTIN_ATTACHMENT_STRATEGY: '   ' }, logger)).toBe('local_first')
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('accepts the three valid values (case-insensitive, trimmed)', () => {
    const logger = makeLogger()
    expect(
      resolveAttachmentStrategy({ TABTIN_ATTACHMENT_STRATEGY: 'local_first' }, logger),
    ).toBe('local_first')
    expect(
      resolveAttachmentStrategy({ TABTIN_ATTACHMENT_STRATEGY: '  cloud_only  ' }, logger),
    ).toBe('cloud_only')
    expect(logger.warn).not.toHaveBeenCalled()
  })

  // W4 (2026-05-13)：cloud_first 已退役（T8 / D1 不留兼容）。env 写 cloud_first
  // 走 fallback warn —— 不再悄悄等价 cloud_only。
  it('rejects deprecated cloud_first env value with warn fallback (W4 T8)', () => {
    const logger = makeLogger()
    expect(
      resolveAttachmentStrategy({ TABTIN_ATTACHMENT_STRATEGY: 'cloud_first' }, logger),
    ).toBe('local_first')
    expect(logger.warn).toHaveBeenCalledTimes(1)
    const msg = String((logger.warn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? '')
    expect(msg).toMatch(/cloud_first.*no longer accepted/i)
  })

  it('falls back + warns on common typos (local-first / localfirst)', () => {
    const logger = makeLogger()
    expect(
      resolveAttachmentStrategy({ TABTIN_ATTACHMENT_STRATEGY: 'local-first' }, logger),
    ).toBe('local_first')
    expect(
      resolveAttachmentStrategy({ TABTIN_ATTACHMENT_STRATEGY: 'localfirst' }, logger),
    ).toBe('local_first')
    expect(logger.warn).toHaveBeenCalledTimes(2)
    for (const call of (logger.warn as ReturnType<typeof vi.fn>).mock.calls) {
      const msg = String(call[0])
      expect(msg).toMatch(/AgentHost/)
      expect(msg).toMatch(/TABTIN_ATTACHMENT_STRATEGY/)
    }
  })
})

// ─── resolveMaxLocalFileSizeMb (FR-18 Phase 2) ──────────────────────

describe('Electron host runtime options — resolveMaxLocalFileSizeMb', () => {
  it('defaults to ELECTRON_DEFAULT_MAX_LOCAL_FILE_SIZE_MB (50MB)', () => {
    const logger = makeLogger()
    expect(resolveMaxLocalFileSizeMb({}, logger)).toBe(ELECTRON_DEFAULT_MAX_LOCAL_FILE_SIZE_MB)
    expect(ELECTRON_DEFAULT_MAX_LOCAL_FILE_SIZE_MB).toBe(50)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('treats empty / whitespace as unset', () => {
    const logger = makeLogger()
    expect(
      resolveMaxLocalFileSizeMb({ TABTIN_LOCAL_DOCPARSE_MAX_MB: '' }, logger),
    ).toBe(ELECTRON_DEFAULT_MAX_LOCAL_FILE_SIZE_MB)
    expect(
      resolveMaxLocalFileSizeMb({ TABTIN_LOCAL_DOCPARSE_MAX_MB: '  ' }, logger),
    ).toBe(ELECTRON_DEFAULT_MAX_LOCAL_FILE_SIZE_MB)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('accepts a positive integer in (0, 200]', () => {
    const logger = makeLogger()
    expect(
      resolveMaxLocalFileSizeMb({ TABTIN_LOCAL_DOCPARSE_MAX_MB: '100' }, logger),
    ).toBe(100)
    expect(
      resolveMaxLocalFileSizeMb({ TABTIN_LOCAL_DOCPARSE_MAX_MB: '200' }, logger),
    ).toBe(200)
    expect(
      resolveMaxLocalFileSizeMb({ TABTIN_LOCAL_DOCPARSE_MAX_MB: '  75  ' }, logger),
    ).toBe(75)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('falls back + warns on 0 / negative / NaN', () => {
    const logger = makeLogger()
    for (const bad of ['0', '-5', 'big', 'NaN']) {
      expect(
        resolveMaxLocalFileSizeMb({ TABTIN_LOCAL_DOCPARSE_MAX_MB: bad }, logger),
      ).toBe(ELECTRON_DEFAULT_MAX_LOCAL_FILE_SIZE_MB)
    }
    expect(logger.warn).toHaveBeenCalledTimes(4)
    for (const call of (logger.warn as ReturnType<typeof vi.fn>).mock.calls) {
      expect(String(call[0])).toMatch(/AgentHost/)
      expect(String(call[0])).toMatch(/TABTIN_LOCAL_DOCPARSE_MAX_MB/)
    }
  })

  it('clamps + warns when exceeding hard cap (200MB)', () => {
    const logger = makeLogger()
    expect(
      resolveMaxLocalFileSizeMb({ TABTIN_LOCAL_DOCPARSE_MAX_MB: '500' }, logger),
    ).toBe(200)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(String((logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0])).toMatch(/exceeds hard cap/)
  })
})

// ─── resolveMaxConcurrentChildren (FR-17.1 H3-C) ─────────────────────

describe('Electron host runtime options — resolveMaxConcurrentChildren', () => {
  it(`defaults to ${5} when env unset`, () => {
    const logger = makeLogger()
    expect(resolveMaxConcurrentChildren({}, logger)).toBe(DEFAULT_MAX_CONCURRENT_CHILDREN)
    expect(DEFAULT_MAX_CONCURRENT_CHILDREN).toBe(5)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('treats empty / whitespace as unset (no warn)', () => {
    const logger = makeLogger()
    expect(
      resolveMaxConcurrentChildren({ TABTIN_MAX_CONCURRENT_CHILDREN: '' }, logger),
    ).toBe(DEFAULT_MAX_CONCURRENT_CHILDREN)
    expect(
      resolveMaxConcurrentChildren({ TABTIN_MAX_CONCURRENT_CHILDREN: '  ' }, logger),
    ).toBe(DEFAULT_MAX_CONCURRENT_CHILDREN)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('accepts positive integer', () => {
    const logger = makeLogger()
    expect(
      resolveMaxConcurrentChildren({ TABTIN_MAX_CONCURRENT_CHILDREN: '10' }, logger),
    ).toBe(10)
    expect(
      resolveMaxConcurrentChildren({ TABTIN_MAX_CONCURRENT_CHILDREN: '  3  ' }, logger),
    ).toBe(3)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it("accepts 'unlimited' / 'infinity' / '0' as Infinity (disable)", () => {
    const logger = makeLogger()
    expect(
      resolveMaxConcurrentChildren({ TABTIN_MAX_CONCURRENT_CHILDREN: 'unlimited' }, logger),
    ).toBe(Number.POSITIVE_INFINITY)
    expect(
      resolveMaxConcurrentChildren({ TABTIN_MAX_CONCURRENT_CHILDREN: 'INFINITY' }, logger),
    ).toBe(Number.POSITIVE_INFINITY)
    expect(
      resolveMaxConcurrentChildren({ TABTIN_MAX_CONCURRENT_CHILDREN: '0' }, logger),
    ).toBe(Number.POSITIVE_INFINITY)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('falls back + warns on negative / NaN / non-numeric', () => {
    const logger = makeLogger()
    for (const bad of ['-1', 'NaN', 'foo']) {
      expect(
        resolveMaxConcurrentChildren({ TABTIN_MAX_CONCURRENT_CHILDREN: bad }, logger),
      ).toBe(DEFAULT_MAX_CONCURRENT_CHILDREN)
    }
    expect(logger.warn).toHaveBeenCalledTimes(3)
    for (const call of (logger.warn as ReturnType<typeof vi.fn>).mock.calls) {
      expect(String(call[0])).toMatch(/TABTIN_MAX_CONCURRENT_CHILDREN/)
      expect(String(call[0])).toMatch(/Falling back to 5/)
    }
  })

  it('floors a positive float', () => {
    const logger = makeLogger()
    expect(
      resolveMaxConcurrentChildren({ TABTIN_MAX_CONCURRENT_CHILDREN: '7.9' }, logger),
    ).toBe(7)
  })
})

// ─── resolveSubagentResultCompact (FR-17.2 H3-C) ─────────────────────

describe('Electron host runtime options — resolveSubagentResultCompact', () => {
  it('defaults to true when env unset', () => {
    const logger = makeLogger()
    expect(resolveSubagentResultCompact({}, logger)).toBe(true)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('accepts truthy / falsy aliases', () => {
    const logger = makeLogger()
    expect(resolveSubagentResultCompact({ TABTIN_SUBAGENT_RESULT_COMPACT: 'on' }, logger)).toBe(true)
    expect(resolveSubagentResultCompact({ TABTIN_SUBAGENT_RESULT_COMPACT: '1' }, logger)).toBe(true)
    expect(resolveSubagentResultCompact({ TABTIN_SUBAGENT_RESULT_COMPACT: 'false' }, logger)).toBe(false)
    expect(resolveSubagentResultCompact({ TABTIN_SUBAGENT_RESULT_COMPACT: '0' }, logger)).toBe(false)
    expect(resolveSubagentResultCompact({ TABTIN_SUBAGENT_RESULT_COMPACT: 'OFF' }, logger)).toBe(false)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('warns + falls back to on when value is malformed', () => {
    const logger = makeLogger()
    expect(
      resolveSubagentResultCompact({ TABTIN_SUBAGENT_RESULT_COMPACT: 'maybe' }, logger),
    ).toBe(true)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(
      String((logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0]),
    ).toMatch(/TABTIN_SUBAGENT_RESULT_COMPACT/)
  })
})

// ─── 接线契约：ElectronAgentHost.ts 真的把 helper 喂进了 EngineConfig ──
//
// FR-07 / FR-09 落地后期发现 Electron host **import 了 helper 但没把
// 返回值赋给 EngineConfig** 字面量（Daemon 已正确接通），导致 `'strict'`
// / `outputScan: false` 这种 env 翻策略在 Electron 端完全失效。
// TypeScript 没报 unused（因为同名变量出现在多个上下文），lint 也没拦
// 住——唯一的兜底是这条契约测试。
//
// 测试做法：直接读 ElectronAgentHost.ts 源代码，断言以下两组 anchor
// 同时存在。如果未来有人再次只删字面量赋值（'toolSchemaValidation,'）
// 但保留 import / `resolveTool*` 调用，本测试立刻红：
//   1. `resolveToolSchemaValidation(process.env, ...)` 调用
//   2. `resolveToolOutputScan(process.env, ...)` 调用
//   3. EngineConfig 字面量内出现 `toolSchemaValidation,` 字段
//   4. EngineConfig 字面量内出现 `toolOutputScan,` 字段
//
// 不优雅，但**直接对应了曾经发生过的回归形态**——任何更"重量"的方法
// （构造 ElectronAgentHost / 跑 createRuntimeForSession）都需要拉起
// ipcMain / app 模块，jsdom 跑不了；这条源码级契约是最低成本的兜底。
describe('Electron host runtime options — wire-up contract (FR-07 / FR-09)', () => {
  it('electron-runtime-assembly.ts 同时调用 helper 并赋值给 EngineConfig 字面量', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    // 测试通过领域目录上溯到 Agent 装配入口。
    const sourcePath = path.join(
      __dirname,
      '..',
      '..',
      '..',
      'apps',
      'tabtin-electron',
      'src',
      'main',
      'agent',
      'runtime',
      'electron-runtime-assembly.ts',
    )
    const source = await fs.readFile(sourcePath, 'utf8')

    // 1. helper 被调用
    expect(source).toMatch(/resolveToolSchemaValidation\s*\(\s*process\.env/)
    expect(source).toMatch(/resolveToolOutputScan\s*\(\s*process\.env/)

    // 2. EngineConfig 字面量出现这两个字段（值为同名变量，省略写法）
    expect(source).toMatch(/\btoolSchemaValidation\s*,/)
    expect(source).toMatch(/\btoolOutputScan\s*,/)

    // 3. 与 daemon parity：daemon 同名 env，文件中应写明对齐意图
    expect(source).toMatch(/FR-07|FR-09/)
  })
})

// ─── resolveIterationBudget (FR-15) ──────────────────────────────────

describe('Electron host runtime options — resolveIterationBudget', () => {
  it('returns DEFAULT_ITERATION_BUDGET when no env vars set', () => {
    const logger = makeLogger()
    expect(resolveIterationBudget({}, logger)).toEqual(DEFAULT_ITERATION_BUDGET)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('parses all four env keys correctly', () => {
    const logger = makeLogger()
    const out = resolveIterationBudget(
      {
        TABTIN_ITERATION_BUDGET_WARN_ITER: '0.6',
        TABTIN_ITERATION_BUDGET_GRACE_ITER: '0.85',
        TABTIN_ITERATION_BUDGET_WARN_TOKEN: '0.8',
        TABTIN_ITERATION_BUDGET_GRACE_TOKEN: '0.9',
      },
      logger,
    )
    expect(out.iteration).toEqual({ warn: 0.6, grace: 0.85, terminate: 1.0 })
    expect(out.token).toEqual({ warn: 0.8, grace: 0.9, terminate: 1.0 })
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('terminate is locked to 1.0 (env cannot override it)', () => {
    const logger = makeLogger()
    const out = resolveIterationBudget(
      {
        TABTIN_ITERATION_BUDGET_WARN_ITER: '0.6',
        TABTIN_ITERATION_BUDGET_GRACE_ITER: '0.85',
        // 没有 TABTIN_ITERATION_BUDGET_TERMINATE_ITER（不支持）
      },
      logger,
    )
    expect(out.iteration.terminate).toBe(1.0)
    expect(out.token.terminate).toBe(1.0)
  })

  it('warns and falls back when value is out of (0, 1] range', () => {
    const logger = makeLogger()
    const out = resolveIterationBudget(
      { TABTIN_ITERATION_BUDGET_WARN_ITER: '1.5' },
      logger,
    )
    expect(out.iteration.warn).toBe(DEFAULT_ITERATION_BUDGET.iteration.warn)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(
      String((logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0]),
    ).toMatch(/TABTIN_ITERATION_BUDGET_WARN_ITER/)
  })

  it('warns and falls back when value is non-numeric', () => {
    const logger = makeLogger()
    resolveIterationBudget(
      {
        TABTIN_ITERATION_BUDGET_WARN_ITER: 'abc',
        TABTIN_ITERATION_BUDGET_GRACE_TOKEN: 'NaN',
      },
      logger,
    )
    expect(logger.warn).toHaveBeenCalledTimes(2)
  })

  it('warns and falls back when value is 0 or negative', () => {
    const logger = makeLogger()
    const out = resolveIterationBudget(
      {
        TABTIN_ITERATION_BUDGET_WARN_ITER: '0',
        TABTIN_ITERATION_BUDGET_GRACE_ITER: '-0.5',
      },
      logger,
    )
    expect(out.iteration.warn).toBe(DEFAULT_ITERATION_BUDGET.iteration.warn)
    expect(out.iteration.grace).toBe(DEFAULT_ITERATION_BUDGET.iteration.grace)
    expect(logger.warn).toHaveBeenCalledTimes(2)
  })

  it('handles empty / whitespace string as unset', () => {
    const logger = makeLogger()
    const out = resolveIterationBudget(
      {
        TABTIN_ITERATION_BUDGET_WARN_ITER: '',
        TABTIN_ITERATION_BUDGET_GRACE_ITER: '   \t  ',
      },
      logger,
    )
    expect(out).toEqual(DEFAULT_ITERATION_BUDGET)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('warning message contains the env key + bad value for ops debugging', () => {
    const logger = makeLogger()
    resolveIterationBudget(
      { TABTIN_ITERATION_BUDGET_WARN_TOKEN: '2.0' },
      logger,
    )
    const msg = String(
      (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0],
    )
    expect(msg).toContain('TABTIN_ITERATION_BUDGET_WARN_TOKEN')
    expect(msg).toContain('2.0')
    expect(msg).toMatch(/falling back/i)
  })
})

// ─── resolveTimeBasedMicroCompact  ────────────────────────────

describe('Electron host runtime options — resolveTimeBasedMicroCompact', () => {
  it('defaults to enabled with conservative gap/keep when env unset', () => {
    const logger = makeLogger()
    expect(resolveTimeBasedMicroCompact({}, logger)).toEqual({
      enabled: true,
      gapThresholdMinutes: 30,
      keepRecent: 4,
    })
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('honors TABTIN_TIME_BASED_MICROCOMPACT=off', () => {
    const logger = makeLogger()
    expect(
      resolveTimeBasedMicroCompact({ TABTIN_TIME_BASED_MICROCOMPACT: 'off' }, logger),
    ).toEqual({
      enabled: false,
      gapThresholdMinutes: 30,
      keepRecent: 4,
    })
  })

  it('warns and falls back when env value is invalid', () => {
    const logger = makeLogger()
    expect(
      resolveTimeBasedMicroCompact({ TABTIN_TIME_BASED_MICROCOMPACT: 'maybe' }, logger),
    ).toEqual({
      enabled: true,
      gapThresholdMinutes: 30,
      keepRecent: 4,
    })
    expect(logger.warn).toHaveBeenCalled()
  })
})

// ─── timeBasedMicroCompact host wire-up contract  ─────────────

describe('Electron host runtime options — timeBasedMicroCompact wire-up contract', () => {
  it('electron-runtime-assembly.ts calls resolveTimeBasedMicroCompact and assigns EngineConfig field', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const sourcePath = path.join(
      __dirname,
      '..',
      '..',
      '..',
      'apps',
      'tabtin-electron',
      'src',
      'main',
      'agent',
      'runtime',
      'electron-runtime-assembly.ts',
    )
    const source = await fs.readFile(sourcePath, 'utf8')

    expect(source).toMatch(/resolveTimeBasedMicroCompact\s*\(\s*process\.env/)
    expect(source).toMatch(/\btimeBasedMicroCompact\s*,/)
  })
})

// ─── resolvePressureThresholds  ───────────────────────────────

describe('Electron host runtime options — resolvePressureThresholds', () => {
  it('returns undefined when env unset (runtime defaults apply)', () => {
    const logger = makeLogger()
    expect(resolvePressureThresholds({}, logger)).toBeUndefined()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('parses three comma-separated thresholds', () => {
    const logger = makeLogger()
    expect(
      resolvePressureThresholds({ TABTIN_PRESSURE_THRESHOLDS: '0.7, 0.8, 0.9' }, logger),
    ).toEqual({
      microCompactStart: 0.7,
      llmSummaryStart: 0.8,
      emergencyStart: 0.9,
    })
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('accepts micro == summary (parallel tiers, same rule as cloud decode)', () => {
    const logger = makeLogger()
    expect(
      resolvePressureThresholds({ TABTIN_PRESSURE_THRESHOLDS: '0.85,0.85,0.95' }, logger),
    ).toEqual({
      microCompactStart: 0.85,
      llmSummaryStart: 0.85,
      emergencyStart: 0.95,
    })
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('warns and returns undefined on non-increasing values', () => {
    const logger = makeLogger()
    expect(
      resolvePressureThresholds({ TABTIN_PRESSURE_THRESHOLDS: '0.9,0.8,0.95' }, logger),
    ).toBeUndefined()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('warns and returns undefined on malformed input', () => {
    const logger = makeLogger()
    expect(
      resolvePressureThresholds({ TABTIN_PRESSURE_THRESHOLDS: '0.8,not-a-number' }, logger),
    ).toBeUndefined()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('warns and returns undefined on out-of-range values', () => {
    const logger = makeLogger()
    expect(
      resolvePressureThresholds({ TABTIN_PRESSURE_THRESHOLDS: '0,0.85,1.5' }, logger),
    ).toBeUndefined()
    expect(logger.warn).toHaveBeenCalled()
  })
})

// ─── pressureThresholds host wire-up contract  ────────────────

describe('Electron host runtime options — pressureThresholds wire-up contract', () => {
  it('electron-runtime-assembly.ts calls resolvePressureThresholds and assigns EngineConfig field', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const sourcePath = path.join(
      __dirname,
      '..',
      '..',
      '..',
      'apps',
      'tabtin-electron',
      'src',
      'main',
      'agent',
      'runtime',
      'electron-runtime-assembly.ts',
    )
    const source = await fs.readFile(sourcePath, 'utf8')

    expect(source).toMatch(/resolvePressureThresholds\s*\(\s*process\.env/)
    expect(source).toMatch(/\bpressureThresholds\s*,/)
  })

  it('electron-runtime-assembly.ts prefers cloud thresholds over env ( 第三波)', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const runtimeSource = await fs.readFile(
      path.join(
        __dirname,
        '..',
        '..',
        '..',
        'apps',
        'tabtin-electron',
        'src',
        'main',
        'agent',
        'runtime',
        'electron-runtime-assembly.ts',
      ),
      'utf8',
    )
    const ingressSource = await fs.readFile(
      path.join(__dirname, '..', 'src', 'conversation', 'forward-request-decoder.ts'),
      'utf8',
    )

    // 云端 > env：runtime assembly 合成优先级与 ingress forward 解码两端都必须在。
    expect(runtimeSource).toMatch(/cloudPressureThresholds\s*\?\?\s*resolvePressureThresholds\s*\(\s*process\.env/)
    expect(ingressSource).toMatch(/decodeCloudPressureThresholds\(payload\.pressure_thresholds,\s*logger\)/)
  })
})

// ─── decodeCloudPressureThresholds ( 第三波) ─────────────────────

describe('Electron host runtime options — decodeCloudPressureThresholds', () => {
  it('decodes a valid snake_case wire payload to camelCase', () => {
    const logger = makeLogger()
    expect(
      decodeCloudPressureThresholds(
        { micro_compact_start: 0.7, llm_summary_start: 0.8, emergency_start: 0.9 },
        logger,
      ),
    ).toEqual({ microCompactStart: 0.7, llmSummaryStart: 0.8, emergencyStart: 0.9 })
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('allows micro == llmSummary (micro tier collapses, runtime parity)', () => {
    const logger = makeLogger()
    expect(
      decodeCloudPressureThresholds(
        { micro_compact_start: 0.85, llm_summary_start: 0.85, emergency_start: 0.95 },
        logger,
      ),
    ).toEqual({ microCompactStart: 0.85, llmSummaryStart: 0.85, emergencyStart: 0.95 })
  })

  it('returns undefined silently when payload is absent (older Django)', () => {
    const logger = makeLogger()
    expect(decodeCloudPressureThresholds(undefined, logger)).toBeUndefined()
    expect(decodeCloudPressureThresholds(null, logger)).toBeUndefined()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('warns and returns undefined on invalid ordering', () => {
    const logger = makeLogger()
    expect(
      decodeCloudPressureThresholds(
        { micro_compact_start: 0.9, llm_summary_start: 0.85, emergency_start: 0.95 },
        logger,
      ),
    ).toBeUndefined()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('warns and returns undefined on out-of-range / non-numeric values', () => {
    const logger = makeLogger()
    expect(
      decodeCloudPressureThresholds(
        { micro_compact_start: 0, llm_summary_start: 0.85, emergency_start: 0.95 },
        logger,
      ),
    ).toBeUndefined()
    expect(
      decodeCloudPressureThresholds(
        { micro_compact_start: 'x', llm_summary_start: 0.85, emergency_start: 0.95 },
        logger,
      ),
    ).toBeUndefined()
    expect(logger.warn).toHaveBeenCalledTimes(2)
  })
})
