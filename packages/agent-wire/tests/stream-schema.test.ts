/**
 * H2-B FR-06 / FR-11 — `agent.stream.*` schema 契约锁定。
 *
 * 这些测试不验证 Runtime 实现，只锁定 wire schema 的**向后兼容契约**：
 *
 * 1. `StreamDoneSchema`：
 *    - 旧消费者（缺 error_class / suggested_action / trace_id）仍能 parse；
 *    - 新字段都是 optional（向后兼容，PRD §6.1）；
 *    - `error_class` 接受任意 string（故意不强约束 enum，避免 Runtime 新增枚举值时
 *      旧消费者校验失败）；
 *    - 完整新字段都能写入并 round-trip；
 *    - 未声明字段经 `.merge(SourceMetaSchema.partial())` 默认走 strip（不会破坏）。
 *
 * 2. `CompactionStatsSchema`：
 *    - 全部新字段（messages_before/after/tokens_before/after/tokens_freed/
 *      tool_uses_retained/summary_length）optional；
 *    - `passthrough()` 行为：宿主可附加路径专属字段（pressure_before / chars_*）
 *      不会被 schema 拒绝；
 *    - `phase: 'start'` 时 stats 全缺也合法。
 *
 * 3. `StreamCompactionSchema.mode` 接受 string：
 *    - Runtime 字面量（auto / reactive / emergency_blocking / recovery_413 / hard_trim）✅
 *    - 云端历史字面量（auto_condense / emergency）✅（前端 miscHandler 自行映射）
 *
 * 这些契约一旦破坏，旧消费者（mobile / Cloud Agents / 前端老版本）会立刻 schema parse 失败，
 * 影响范围远超 Runtime 单包；所以本文件被改动时**必须**伴随一份 BREAKING change 说明。
 */

import { describe, it, expect } from 'vitest';
// 通过包入口 import — 走 package.json `exports` 解析到 dist/index.js，
// 这是真实消费者（runtime / mobile / cloud）拿到的版本。
//
// **不**直接 `from '../src/stream.js'`：本仓 `src/` 同时含 `*.ts` 与陈旧
// `*.js` build 产物（git 历史遗留，非 H2-B scope）；vitest 解析 `.js` 后缀
// 时优先命中陈旧 `src/stream.js` —— 那份没有 H2-B 新增的
// `error_class` / `CompactionStatsSchema` / `StreamCompactionSchema`，
// 会让本测试假阳性失败。改走包入口可绕开这一污染，同时测的是真实公共 API。
import {
  StreamDoneSchema,
  StreamLifecycleSchema,
  CompactionStatsSchema,
  StreamCompactionSchema,
} from '@tabtin/agent-wire';

describe('FR-06 — StreamDoneSchema 向后兼容', () => {
  it('旧消费者 — 缺所有新字段时仍能 parse 成功 done', () => {
    const legacy = {
      content: 'final answer',
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const parsed = StreamDoneSchema.parse(legacy);
    expect(parsed.error).toBeUndefined();
    expect(parsed.error_class).toBeUndefined();
    expect(parsed.suggested_action).toBeUndefined();
    expect(parsed.trace_id).toBeUndefined();
  });

  it('旧消费者 — 缺所有新字段时仍能 parse 失败 done（仅 error + error_message）', () => {
    const legacy = {
      error: true,
      error_message: 'something broke',
    };
    const parsed = StreamDoneSchema.parse(legacy);
    expect(parsed.error).toBe(true);
    expect(parsed.error_message).toBe('something broke');
    expect(parsed.error_class).toBeUndefined();
    expect(parsed.suggested_action).toBeUndefined();
    expect(parsed.trace_id).toBeUndefined();
  });

  it('新消费者 — 完整新字段都能写入并 round-trip', () => {
    const next = {
      error: true,
      error_message: 'LLM call failed',
      error_class: 'LLM_ERROR',
      suggested_action: '请稍后重试',
      trace_id: 'abc-123',
      usage: { input_tokens: 100, output_tokens: 50, cost_usd: 0.01 },
    };
    const parsed = StreamDoneSchema.parse(next);
    expect(parsed.error_class).toBe('LLM_ERROR');
    expect(parsed.suggested_action).toBe('请稍后重试');
    expect(parsed.trace_id).toBe('abc-123');
  });

  it('error_class 不强约束 enum — 接受未来新增的字符串值（避免老消费者破坏）', () => {
    // 关键设计决策：Runtime AgentErrorCode 是真相源，但 wire schema **不复刻** enum，
    // 这样 H3+ 新增 code（比如 'NETWORK_DISCONNECTED'）时旧消费者不会 schema fail。
    const futureCode = {
      error: true,
      error_class: 'FUTURE_NEW_CLASS_NOT_IN_H1',
      suggested_action: 'fallback',
      trace_id: 't1',
    };
    expect(() => StreamDoneSchema.parse(futureCode)).not.toThrow();
  });

  it('成功 done 也带 trace_id — H2-A 协同（AdminDash 取 trace_id 不区分成功失败）', () => {
    const success = {
      content: 'all good',
      trace_id: 'success-trace-1',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const parsed = StreamDoneSchema.parse(success);
    expect(parsed.trace_id).toBe('success-trace-1');
    expect(parsed.error).toBeUndefined();
  });

  it('未声明字段默认 strip — 不会破坏旧 schema 且未知键不进入 parsed 输出', () => {
    const withExtras = {
      content: 'a',
      __runtime_internal__: 'should be stripped or ignored',
      _legacy_field: 42,
    };
    const parsed = StreamDoneSchema.parse(withExtras);
    // strip 行为契约：parse 不抛 + 未知顶层键不出现在结果对象
    // （Zod object 默认 strip——若未来某次重构无意改成 passthrough，
    // 旧消费者会突然看到不该看到的内部字段，本断言抓死这一回归）。
    expect(parsed.content).toBe('a');
    expect('__runtime_internal__' in parsed).toBe(false);
    expect('_legacy_field' in parsed).toBe(false);
  });
});

describe(' — StreamLifecycleSchema waterfall fields', () => {
  it('round-trips run/turn timing and tool duration summary fields', () => {
    const lifecycle = {
      phase: 'turn_end' as const,
      run_id: 'run-1',
      trace_id: 'run-1',
      turn_id: 'run-1-turn-2',
      iteration: 2,
      status: 'completed',
      started_at: 1_000,
      ended_at: 1_250,
      duration_ms: 250,
      tool_call_count: 1,
      tool_duration_ms: 180,
      tool_durations: [
        {
          tool_name: 'read_file',
          tool_call_id: 'tool-1',
          duration_ms: 180,
          status: 'completed' as const,
        },
      ],
      reason: 'run_finished',
    };

    const parsed = StreamLifecycleSchema.parse(lifecycle);

    expect(parsed.run_id).toBe('run-1');
    expect(parsed.trace_id).toBe('run-1');
    expect(parsed.iteration).toBe(2);
    expect(parsed.ended_at).toBe(1_250);
    expect(parsed.tool_duration_ms).toBe(180);
    expect(parsed.tool_durations?.[0]?.tool_call_id).toBe('tool-1');
    expect(parsed.reason).toBe('run_finished');
  });
});

describe('FR-11 — CompactionStatsSchema 向后兼容', () => {
  it('全部字段缺省 — 合法（phase=start 场景或宿主仅 emit 部分 stats）', () => {
    const empty = {};
    const parsed = CompactionStatsSchema.parse(empty);
    expect(parsed.messages_before).toBeUndefined();
    expect(parsed.messages_after).toBeUndefined();
    expect(parsed.tokens_before).toBeUndefined();
    expect(parsed.tokens_after).toBeUndefined();
    expect(parsed.tokens_freed).toBeUndefined();
    expect(parsed.tool_uses_retained).toBeUndefined();
    expect(parsed.summary_length).toBeUndefined();
  });

  it('reactive 路径 — 全字段填齐能 round-trip', () => {
    const reactive = {
      messages_before: 12,
      messages_after: 4,
      tokens_before: 50_000,
      tokens_after: 8_000,
      tokens_freed: 42_000,
      tool_uses_retained: 1,
      summary_length: 1_234,
    };
    const parsed = CompactionStatsSchema.parse(reactive);
    expect(parsed.messages_before).toBe(12);
    expect(parsed.summary_length).toBe(1_234);
  });

  it('passthrough — 宿主附加 pressure_before / chars_* 不被拒绝', () => {
    const withExtras = {
      messages_before: 10,
      messages_after: 5,
      pressure_before: 0.92, // auto 路径独有，非 schema 字段
      chars_before: 1_000_000, // 云端老路径独有
    };
    const parsed = CompactionStatsSchema.parse(withExtras);
    // passthrough 行为：未知字段保留在 parsed 上
    expect((parsed as Record<string, unknown>).pressure_before).toBe(0.92);
    expect((parsed as Record<string, unknown>).chars_before).toBe(1_000_000);
  });

  it('字段类型校验 — 数字型字段拒绝字符串', () => {
    const invalid = { messages_before: 'twelve' };
    expect(() => CompactionStatsSchema.parse(invalid)).toThrow();
  });
});

describe('FR-11 — StreamCompactionSchema 向后兼容', () => {
  const goodModes = [
    'auto',
    'reactive',
    'emergency_blocking',
    'recovery_413',
    'hard_trim',
    'auto_condense', // 云端历史
    'emergency', // 云端历史
    'native',
    'micro',
    'unknown_future_mode', // 未来扩展
  ];

  for (const mode of goodModes) {
    it(`mode='${mode}' 接受为 string（不强约束 enum）`, () => {
      const ev = {
        phase: 'end' as const,
        mode,
        stats: { messages_before: 5, messages_after: 2 },
      };
      expect(() => StreamCompactionSchema.parse(ev)).not.toThrow();
    });
  }

  it('phase=start — stats 缺省合法', () => {
    const start = { phase: 'start' as const, mode: 'reactive' };
    const parsed = StreamCompactionSchema.parse(start);
    expect(parsed.phase).toBe('start');
    expect(parsed.stats).toBeUndefined();
  });

  it('phase 必须是 start 或 end', () => {
    expect(() =>
      StreamCompactionSchema.parse({ phase: 'middle', mode: 'auto' }),
    ).toThrow();
  });
});
