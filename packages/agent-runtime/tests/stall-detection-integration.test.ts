/**
 * W3 — Stall detector + 主循环 nudge 集成测试。
 *
 * 验证 `query.ts` 主循环：
 *   1. 工具结束后 record 失败 / 成功；连续 3 次同 (tool, kind) 失败 →
 *      stream yield SYSTEM_NOTICE { notice_type: 'tool_failure_notice' }。
 *   2. 连续 5 次同 (tool, kind) 失败 → stream yield SYSTEM_NOTICE
 *      { notice_type: 'tool_failure_nudge' } + 下一轮 LLM request 的
 *      `system` 字段含 `[系统 / 停滞检测]` 注入。
 *   3. 中间夹一次成功 → streak 被打破，notice / nudge 不触发。
 *   4. 排除 kind（如 `runtime_misconfig`）连续撞 5 次 → 不触发任何 notice。
 *   5. 升级 stage 后再触发同 stage（streak 持续增长）不重复 yield notice。
 *   6. telemetry：tool_failure.notice / tool_failure.nudge 各发一次。
 *
 * 单元测试（tracker 状态机本身）见 `tool-failure-tracker.test.ts`。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createRuntime } from '../src/runtime-assembly.js';
import {
  createMockPermissionHandler,
  createMockToolProvider,
} from './test-utils.js';
import {
  setTelemetrySink,
  resetTelemetrySink,
} from '../src/telemetry/emitter.js';
import type { TelemetryRecord } from '../src/telemetry/types.js';
import type {
  StreamEvent,
} from '../src/engine/contracts/wire-protocol.js';
import type {
  SystemBlock,
} from '../src/engine/contracts/conversation.js';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponseChunk,
} from '../src/engine/contracts/model-llm.js';
import type {
  Tool,
} from '../src/engine/contracts/tools.js';
import type {
  EngineConfig,
} from '../src/engine/contracts/kernel.js';
import { jsonError } from '../src/capability/core/_utils.js';
import { createTestToolRiskPolicyPort } from './helpers/tool-risk-policy-port.js';
import { INVALID_PARAM_FORMAT, NETWORK_FAILED, RUNTIME_MISCONFIG } from '../src/engine/errors/error-kinds.js';
import { createTestToolRiskPolicyPort } from './helpers/tool-risk-policy-port.js';

// ─── helpers ─────────────────────────────────────────────────────────

async function collectEvents(
  gen: AsyncGenerator<StreamEvent>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

function noticesOfType(events: StreamEvent[], type: string): StreamEvent[] {
  return events.filter(
    (e) =>
      e.type === 'agent.stream.system_notice' &&
      (e.payload as Record<string, unknown>).notice_type === type,
  );
}

function flattenSystemPrompt(s: string | SystemBlock[] | undefined): string {
  if (!s) return '';
  if (typeof s === 'string') return s;
  return s.map((b) => b.text).join('\n\n');
}

interface CapturedRequest {
  system: LLMRequest['system'];
  iteration: number;
}

/**
 * Provider 在每轮 LLM 调用前记录 `system` 字段，让测试断言"第 6 轮 LLM
 * 调用看到 [系统 / 停滞检测] 注入"。
 *
 * `failuresBeforeFinal` 控制前 N 轮都让 LLM 调用 stall_tool 一次（每次
 * stall_tool 返回同一个 error_kind），第 N+1 轮起改为 final text 退出。
 */
function makeStallProvider(
  failuresBeforeFinal: number,
  toolName = 'stall_tool',
): { provider: LLMProvider; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  let i = 0;
  const provider: LLMProvider = {
    async *createStream(req: LLMRequest): AsyncIterable<LLMResponseChunk> {
      captured.push({ system: req.system, iteration: i });
      const isToolRound = i < failuresBeforeFinal;
      i++;
      if (isToolRound) {
        yield {
          type: 'tool_use',
          toolUse: { id: `c${i}`, name: toolName, input: {} },
        };
        yield {
          type: 'usage',
          usage: { input_tokens: 50, output_tokens: 50 },
        };
        yield { type: 'stop', stopReason: 'tool_use' };
      } else {
        yield { type: 'text_delta', text: 'final answer' };
        yield {
          type: 'usage',
          usage: { input_tokens: 50, output_tokens: 50 },
        };
        yield { type: 'stop', stopReason: 'end_turn' };
      }
    },
  };
  return { provider, captured };
}

/**
 * 一个永远失败的工具，固定返回同一个 (error_kind, hint)。模拟 LLM
 * 反复撞同一类墙的 dogfood 场景。
 */
function makeFailingTool(name: string, errorKind: string): Tool {
  return {
    name,
    description: `Stall test tool: ${name}`,
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: true,
    execute: async () =>
      jsonError('Simulated failure for stall detection test', {
        error_kind: errorKind,
        hint: 'Try a different approach.',
      }),
  };
}

/**
 * 一个工具，前 N 次 fail 同一 kind，第 N+1 次起 success。用于"成功 reset"
 * 集成测试场景。
 */
function makeIntermittentTool(
  name: string,
  failBefore: number,
  errorKind: string,
): Tool {
  let count = 0;
  return {
    name,
    description: `Intermittent tool: ${name}`,
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: true,
    execute: async () => {
      const isFailing = count < failBefore;
      count++;
      if (isFailing) {
        return jsonError('Intermittent failure', {
          error_kind: errorKind,
          hint: 'Wait then retry.',
        });
      }
      return { content: 'ok' };
    },
  };
}

function makeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    provider: overrides.provider!,
    tools: overrides.tools!,
    permissionHandler: createMockPermissionHandler(),
    toolRiskPolicy: createTestToolRiskPolicyPort({
      buildEffectivePolicy: () => undefined,
      memoStore: { lookup: async () => undefined } as never,
    }),
    sessionConfig: { sessionDir: '/tmp/test', threadId: 'stall-test-session' },
    model: 'test-model',
    toolRiskPolicy: createTestToolRiskPolicyPort({
      buildEffectivePolicy: () => undefined,
      memoStore: { lookup: async () => undefined } as never,
    }),
    ...overrides,
  };
}

function withTelemetrySink<T>(
  fn: (sink: { records: TelemetryRecord[] }) => Promise<T>,
): Promise<T> {
  const sink = { records: [] as TelemetryRecord[] };
  setTelemetrySink((rec) => {
    sink.records.push(rec);
  });
  return fn(sink).finally(() => {
    resetTelemetrySink();
  });
}

afterEach(() => {
  resetTelemetrySink();
});

// ─── 主路径：3 → 5 升级链 ───────────────────────────────────────────

describe('W3 stall detector — 3 / 5 thresholds + system injection', () => {
  it('emits tool_failure_notice on 3rd consecutive failure, before nudge', async () => {
    const { provider } = makeStallProvider(5);
    const tool = makeFailingTool('stall_tool', NETWORK_FAILED);

    const events = await collectEvents(
      createRuntime(
        makeConfig({
          provider,
          tools: createMockToolProvider([tool]),
          maxTurns: 50,
        }),
      ).query({ hostRunId: 'test-run', prompt: 'kick' }),
    );

    const noticeEvents = noticesOfType(events, 'tool_failure_notice');
    expect(noticeEvents.length).toBe(1);
    const payload = noticeEvents[0]!.payload as Record<string, unknown>;
    // 结构化字段：tool / error_kind / streak 都在 payload 顶层（前端按字段渲染，
    // 不依赖 content 文本里嵌入的 raw 字面量——见 W3-R2 阻塞 1 修复）
    expect(payload.tool).toBe('stall_tool');
    expect(payload.error_kind).toBe(NETWORK_FAILED);
    expect(payload.streak).toBe(3);
    // content 是中文 fallback 兜底文本（i18n 缺失时显示）；主语是工具名，
    // 并暴露 raw tool/kind 让 jsonl 离线排查精确定位
    expect(typeof payload.content).toBe('string');
    expect(payload.content).toMatch(/已连续失败.*次/);
    expect(payload.content).toContain('stall_tool');
    expect(payload.content).toContain('network_failed');
    expect(payload.content).not.toMatch(/Agent\s*在.*反复/);
  });

  it('emits tool_failure_nudge on 5th consecutive failure + injects 中文 reminder next turn', async () => {
    const { provider, captured } = makeStallProvider(5);
    const tool = makeFailingTool('stall_tool', NETWORK_FAILED);

    await withTelemetrySink(async (sink) => {
      const events = await collectEvents(
        createRuntime(
          makeConfig({
            provider,
            tools: createMockToolProvider([tool]),
            maxTurns: 50,
          }),
        ).query({ hostRunId: 'test-run', prompt: 'kick' }),
      );

      const nudgeEvents = noticesOfType(events, 'tool_failure_nudge');
      expect(nudgeEvents.length).toBe(1);
      const nudgePayload = nudgeEvents[0]!.payload as Record<string, unknown>;
      expect(nudgePayload.tool).toBe('stall_tool');
      expect(nudgePayload.error_kind).toBe(NETWORK_FAILED);
      expect(nudgePayload.streak).toBe(5);

      // 第 6 轮 LLM 调用（index=5）的 system prompt 应含 [系统 / 停滞检测]
      // 注入。前 5 轮都没注入（streak 还没到 nudge 阈值）。
      const round6 = captured[5];
      expect(round6).toBeDefined();
      const sys6 = flattenSystemPrompt(round6!.system);
      expect(sys6).toContain('[系统 / 停滞检测]');
      expect(sys6).toContain('stall_tool');
      expect(sys6).toContain(NETWORK_FAILED);
      // nudge 引导按场景智能选择，注入文案至少引用真实存在的 ask 工具之一
      // （具体哪个由 error_kind 决定）；不应再出现已退役的 ask_question /
      // request_approval。
      expect(sys6).toMatch(/ask_user|ask_form/);
      expect(sys6).not.toContain('ask_question');
      expect(sys6).not.toContain('request_approval');

      const round5 = captured[4];
      expect(round5).toBeDefined();
      const sys5 = flattenSystemPrompt(round5!.system);
      expect(sys5).not.toContain('[系统 / 停滞检测]');

      // telemetry 验证：notice + nudge 各一次
      const noticeTel = sink.records.filter(
        (r) => r.event_name === 'tool_failure.notice',
      );
      const nudgeTel = sink.records.filter(
        (r) => r.event_name === 'tool_failure.nudge',
      );
      expect(noticeTel.length).toBe(1);
      expect(nudgeTel.length).toBe(1);
      expect(noticeTel[0]!.payload.tool).toBe('stall_tool');
      expect(noticeTel[0]!.payload.error_kind).toBe(NETWORK_FAILED);
      expect(noticeTel[0]!.payload.streak).toBe(3);
      expect(nudgeTel[0]!.payload.streak).toBe(5);
      expect(nudgeTel[0]!.payload.injection_pending).toBe(true);
    });
  });

  it('does not double-emit when streak grows past nudge threshold (single-shot)', async () => {
    // 让 LLM 调 8 轮工具，全失败 → streak 升到 8，但 notice / nudge 各只触发一次
    const { provider } = makeStallProvider(8);
    const tool = makeFailingTool('stall_tool', NETWORK_FAILED);

    const events = await collectEvents(
      createRuntime(
        makeConfig({
          provider,
          tools: createMockToolProvider([tool]),
          maxTurns: 50,
        }),
      ).query({ hostRunId: 'test-run', prompt: 'kick' }),
    );

    const noticeEvents = noticesOfType(events, 'tool_failure_notice');
    const nudgeEvents = noticesOfType(events, 'tool_failure_nudge');
    expect(noticeEvents.length).toBe(1);
    expect(nudgeEvents.length).toBe(1);
  });

  it('only injects [系统 / 停滞检测] once after nudge upgrade (not every turn)', async () => {
    const { provider, captured } = makeStallProvider(8);
    const tool = makeFailingTool('stall_tool', NETWORK_FAILED);

    await collectEvents(
      createRuntime(
        makeConfig({
          provider,
          tools: createMockToolProvider([tool]),
          maxTurns: 50,
        }),
      ).query({ hostRunId: 'test-run', prompt: 'kick' }),
    );

    const injectionTurns = captured.filter((r) =>
      flattenSystemPrompt(r.system).includes('[系统 / 停滞检测]'),
    );
    // 升级 nudge 后 pending 立即被消费 → 仅那一轮（index=5，第 6 轮）注入；
    // 后续即使 streak 升到 8，stage 仍是 nudge 但不再升级 → 不重复注入。
    expect(injectionTurns.length).toBe(1);
    expect(injectionTurns[0]!.iteration).toBe(5);
  });
});

// ─── 异常场景：success reset / 排除 kind / 不同 kind ────────────────

describe('W3 stall detector — streak break scenarios', () => {
  it('intermittent success between failures resets streak — no notice', async () => {
    // 工具策略：第 1 次 fail，第 2 次 success，再 fail 2 次 → streak 不到 3
    const { provider } = makeStallProvider(4);
    const tool = makeIntermittentTool('intermittent', 1, NETWORK_FAILED);

    const events = await collectEvents(
      createRuntime(
        makeConfig({
          provider,
          tools: createMockToolProvider([tool]),
          maxTurns: 50,
        }),
      ).query({ hostRunId: 'test-run', prompt: 'kick' }),
    );

    expect(noticesOfType(events, 'tool_failure_notice').length).toBe(0);
    expect(noticesOfType(events, 'tool_failure_nudge').length).toBe(0);
  });

  it('excluded kind (runtime_misconfig) does not trigger notice/nudge even at 5 in a row', async () => {
    const { provider } = makeStallProvider(5);
    const tool = makeFailingTool('misconfig_tool', RUNTIME_MISCONFIG);

    const events = await collectEvents(
      createRuntime(
        makeConfig({
          provider,
          tools: createMockToolProvider([tool]),
          maxTurns: 50,
        }),
      ).query({ hostRunId: 'test-run', prompt: 'kick' }),
    );

    expect(noticesOfType(events, 'tool_failure_notice').length).toBe(0);
    expect(noticesOfType(events, 'tool_failure_nudge').length).toBe(0);
  });

  it('different error_kinds in same tool do not accumulate streak', async () => {
    // 自定义 provider：每轮调用同 tool 但工具内部交替返回不同 kind
    let kindIdx = 0;
    const kinds = ['network_failed', 'request_timeout'];
    const TOOL_NAME = 'flaky_tool';
    const tool: Tool = {
      name: TOOL_NAME,
      description: 'returns alternating kinds',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: true,
      execute: async () => {
        const kind = kinds[kindIdx % kinds.length]!;
        kindIdx++;
        return jsonError('flaky', { error_kind: kind, hint: 'try again' });
      },
    };
    const { provider } = makeStallProvider(6, TOOL_NAME);

    const events = await collectEvents(
      createRuntime(
        makeConfig({
          provider,
          tools: createMockToolProvider([tool]),
          maxTurns: 50,
        }),
      ).query({ hostRunId: 'test-run', prompt: 'kick' }),
    );

    // 6 轮失败但 kind 交替 → 末尾连续同 kind 的 streak 永远 ≤ 1 → 不到 notice
    expect(noticesOfType(events, 'tool_failure_notice').length).toBe(0);
    expect(noticesOfType(events, 'tool_failure_nudge').length).toBe(0);
  });

  // W3-R1 H3 修复：失败但 error_kind 无法提取（非 W2 envelope / 第三方工具 isError=true
  // 但 metadata 没 error_kind）时，runtime 不能静默丢弃失败让旧 streak 错误延续。
  // 改为 sentinel 'unknown_error_kind'：保留事实但不累积 streak、不触发 nudge。
  it('failures with no extractable error_kind do not extend or trigger streak', async () => {
    const TOOL_NAME = 'no_kind_tool';
    const { provider } = makeStallProvider(8, TOOL_NAME);
    // 工具：所有失败都不带 error_kind metadata（模拟 W2 之前的旧路径 / 第三方工具）
    const tool: Tool = {
      name: TOOL_NAME,
      description: 'fails without metadata.error_kind',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: true,
      execute: async () => ({
        content: JSON.stringify({ ok: false, message: 'unstructured failure' }),
        isError: true,
      }),
    };

    const events = await collectEvents(
      createRuntime(
        makeConfig({
          provider,
          tools: createMockToolProvider([tool]),
          maxTurns: 50,
        }),
      ).query({ hostRunId: 'test-run', prompt: 'kick' }),
    );

    // 即使 8 次失败，sentinel 在 excludeKinds 里 → streak 永远 normal
    expect(noticesOfType(events, 'tool_failure_notice').length).toBe(0);
    expect(noticesOfType(events, 'tool_failure_nudge').length).toBe(0);
  });

  // 反向验证：3 次合法 streak 后，1 次"无 kind"失败应当打破累积——下一次再撞同 kind
  // 不会变成 streak=4，必须重新从 1 开始。
  it('a failure with no extractable error_kind breaks the streak (defensive)', async () => {
    let callIdx = 0;
    const TOOL_NAME = 'mixed_tool';
    const tool: Tool = {
      name: TOOL_NAME,
      description: '3 typed failures → 1 untyped → 3 typed (streak resets)',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: true,
      execute: async () => {
        const i = callIdx++;
        // 第 4 次（index=3）走"无 metadata"路径，前后都是合法 NETWORK_FAILED
        if (i === 3) {
          return {
            content: JSON.stringify({ ok: false, message: 'no kind' }),
            isError: true,
          };
        }
        return jsonError('typed', {
          error_kind: NETWORK_FAILED,
          hint: 'retry',
        });
      },
    };
    // 共 7 步：3 typed + 1 untyped + 3 typed —— 末尾 3 次同 kind 仅触发 notice，
    // 不会被前 3 次累计到 streak=6 触发 nudge
    // 关键：provider 必须让 LLM 调用真实存在的 mixed_tool（不是默认 stall_tool）
    const { provider } = makeStallProvider(7, TOOL_NAME);

    const events = await collectEvents(
      createRuntime(
        makeConfig({
          provider,
          tools: createMockToolProvider([tool]),
          maxTurns: 50,
        }),
      ).query({ hostRunId: 'test-run', prompt: 'kick' }),
    );

    // 第 1-3 步：streak 累到 3 → notice (1 次)
    // 第 4 步：sentinel 打破
    // 第 5-7 步：新 streak 累到 3 → notice (1 次)
    // 关键：nudge **不**触发（如果 sentinel 不打破 streak，第 7 步会是 streak=6 → nudge）
    expect(noticesOfType(events, 'tool_failure_nudge').length).toBe(0);
    // notice 总数 ≤ 2（两段独立 streak 各触发一次）
    expect(noticesOfType(events, 'tool_failure_notice').length).toBeLessThanOrEqual(2);
    expect(noticesOfType(events, 'tool_failure_notice').length).toBeGreaterThanOrEqual(1);
  });
});

// ─── R1 H1 / R3 中 5 修复：iteration-budget × stall detection 共存测试 ────────

describe('W3 stall detector — coexistence with iteration-budget', () => {
  it('does NOT inject [系统 / 停滞检测] during iteration-budget grace turn', async () => {
    // 让 stall nudge **正好**在 budget grace 同一轮触发：
    //   maxTurns=8 + iterationBudget grace=0.6 让第 6 轮顶部 (iteration=5, 62.5%) 触发 grace
    //   failuresBeforeFinal=8 让第 5 步 streak 升 nudge → pending 写入
    //   第 6 轮顶部：grace + pending 共存 → query.ts 闸门跳过 stall 注入
    const { provider, captured } = makeStallProvider(8);
    const tool = makeFailingTool('stall_tool', NETWORK_FAILED);

    await collectEvents(
      createRuntime(
        makeConfig({
          provider,
          tools: createMockToolProvider([tool]),
          maxTurns: 8,
          iterationBudget: {
            iteration: { warn: 0.4, grace: 0.6, terminate: 1.0 },
          },
        }),
      ).query({ hostRunId: 'test-run', prompt: 'kick' }),
    );

    // 第 6 轮顶部应当是 grace（含 budget grace 注入）
    const graceTurns = captured.filter((r) =>
      flattenSystemPrompt(r.system).includes('[系统 / 预算宽限轮]'),
    );
    expect(graceTurns.length).toBeGreaterThan(0);

    // 关键断言：grace turn **绝不**带 [系统 / 停滞检测]——双指令冲突
    // （grace 强制 LLM 不调工具仅总结，stall 让 LLM "换思路"——同轮叠加 LLM 困惑）
    for (const r of graceTurns) {
      const sys = flattenSystemPrompt(r.system);
      expect(sys).not.toContain('[系统 / 停滞检测]');
    }
  });

  it('co-injects [系统 / 预算预警] + [系统 / 停滞检测] in the same warn turn', async () => {
    // 让 stall nudge **正好**在 budget warn 同一轮触发：
    //   maxTurns=10 + iterationBudget warn=0.5 grace=0.8 让第 6 轮顶部 (iteration=5, 50%) 触发 warn
    //   failuresBeforeFinal=10 让第 5 步 streak 升 nudge → pending 写入
    //   第 6 轮顶部：warn + pending 共存 → 两段独立 section marker 共存于 system prompt
    const { provider, captured } = makeStallProvider(10);
    const tool = makeFailingTool('stall_tool', NETWORK_FAILED);

    await collectEvents(
      createRuntime(
        makeConfig({
          provider,
          tools: createMockToolProvider([tool]),
          maxTurns: 10,
          iterationBudget: {
            iteration: { warn: 0.5, grace: 0.8, terminate: 1.0 },
          },
        }),
      ).query({ hostRunId: 'test-run', prompt: 'kick' }),
    );

    // stall 注入仅 1 次（pending 一次性消费 + 不重复）
    const stallTurns = captured.filter((r) =>
      flattenSystemPrompt(r.system).includes('[系统 / 停滞检测]'),
    );
    expect(stallTurns.length).toBe(1);

    // 关键断言：stall 注入轮 system 同时含 budget warn 段（两机制正交共存）
    const stallTurn = stallTurns[0]!;
    const sys = flattenSystemPrompt(stallTurn.system);
    expect(sys).toContain('[系统 / 停滞检测]');
    expect(sys).toContain('[系统 / 预算预警]');
    // section marker 验证：两段各自有独立的 marker，互不覆盖
    expect(sys).toContain('section:stall_detection');
    expect(sys).toContain('section:budget_warn');
  });

  it('clears pendingStallNudgeInjection after consumption — does NOT re-inject every turn', async () => {
    // pending 字段必须被消费一次后立即清空。
    // 让 LLM 失败 8 次：streak 升到 5 触发 nudge（pending 写入），第 6 轮顶部消费 +
    // 清空，后续 streak=6/7/8 stage 仍 nudge 但 isStageUpgrade=false → 不再触发新的
    // pending 写入 → 不再重复注入。
    const { provider, captured } = makeStallProvider(8);
    const tool = makeFailingTool('stall_tool', NETWORK_FAILED);

    await collectEvents(
      createRuntime(
        makeConfig({
          provider,
          tools: createMockToolProvider([tool]),
          maxTurns: 50,
        }),
      ).query({ hostRunId: 'test-run', prompt: 'kick' }),
    );

    const injectionTurns = captured.filter((r) =>
      flattenSystemPrompt(r.system).includes('[系统 / 停滞检测]'),
    );
    expect(injectionTurns.length).toBe(1);
  });
});

// ─── W3-R3-P1-3 修复：跨 query 集成回归保护 ────────────────────────────────
//
// per-query fresh tracker 是核心契约（query.ts:1668）。新 query 应当能再次触发
// 完整的 normal → notice → nudge 循环。如果未来重构把 tracker 提升到 runtime
// 共享 / global state，这条集成测试会立刻失败——单测 cover 不到这种宿主层
// 装配回归。
describe('W3 stall detector — cross-query regression', () => {
  it('triggers nudge again on a fresh query after the previous query reached nudge', async () => {
    // 用同一组 tool / provider factory，两次独立 createRuntime() + query()：
    // 每次 query 都连续 5 次失败 → 各自必须 yield notice + nudge 一次。
    const TOOL_NAME = 'cross_query_tool';
    const tool = makeFailingTool(TOOL_NAME, NETWORK_FAILED);
    const cfg1 = (() => {
      const { provider } = makeStallProvider(5, TOOL_NAME);
      return { provider };
    })();
    const cfg2 = (() => {
      const { provider } = makeStallProvider(5, TOOL_NAME);
      return { provider };
    })();

    const events1 = await collectEvents(
      createRuntime(
        makeConfig({
          provider: cfg1.provider,
          tools: createMockToolProvider([tool]),
          maxTurns: 50,
        }),
      ).query({ hostRunId: 'test-run', prompt: 'first query' }),
    );
    expect(noticesOfType(events1, 'tool_failure_notice').length).toBe(1);
    expect(noticesOfType(events1, 'tool_failure_nudge').length).toBe(1);

    // 第二次 query：必须重新触发完整 stage 升级（不能因为"上次 query 已达 nudge"
    // 而被状态残留压制）
    const events2 = await collectEvents(
      createRuntime(
        makeConfig({
          provider: cfg2.provider,
          tools: createMockToolProvider([tool]),
          maxTurns: 50,
        }),
      ).query({ hostRunId: 'test-run', prompt: 'second query' }),
    );
    expect(noticesOfType(events2, 'tool_failure_notice').length).toBe(1);
    expect(noticesOfType(events2, 'tool_failure_nudge').length).toBe(1);
  });
});

// ─── W3-R3-P1-4 修复：单轮多 tool_use 的 batch 并发场景 ────────────────────
//
// 线上 LLM 一轮可发起多个并发工具调用（如 read_file × 5）。query.ts 主循环把
// `executionResults` 收齐后**顺序** record（line 3896-3917）。需要验证：
//   1. 单轮多 tool_use 失败时，buffer 顺序与 streak 计算正确
//   2. 失败 + 成功混合时，recordSuccess 只 pop 末尾连续同 (tool, kind)，不误清
//      早期累积的其他 streak
describe('W3 stall detector — batch tool_use within a single LLM turn', () => {
  it('counts streak correctly when a single LLM turn contains multiple same-tool failures', async () => {
    // 第 1 轮 yield 3 个 tool_use 全失败（同 tool 同 kind）→ buffer 末尾 streak=3
    // → 触发 notice 一次。第 2 轮 final。
    const TOOL_NAME = 'batch_tool';
    const tool = makeFailingTool(TOOL_NAME, NETWORK_FAILED);
    let calls = 0;
    const provider: LLMProvider = {
      async *createStream(): AsyncIterable<LLMResponseChunk> {
        calls++;
        if (calls === 1) {
          // 单轮 yield 3 个 tool_use（模拟 LLM 一次发起多个并发调用）
          yield {
            type: 'tool_use',
            toolUse: { id: 'b1', name: TOOL_NAME, input: {} },
          };
          yield {
            type: 'tool_use',
            toolUse: { id: 'b2', name: TOOL_NAME, input: {} },
          };
          yield {
            type: 'tool_use',
            toolUse: { id: 'b3', name: TOOL_NAME, input: {} },
          };
          yield {
            type: 'usage',
            usage: { input_tokens: 50, output_tokens: 50 },
          };
          yield { type: 'stop', stopReason: 'tool_use' };
        } else {
          yield { type: 'text_delta', text: 'final' };
          yield {
            type: 'usage',
            usage: { input_tokens: 50, output_tokens: 50 },
          };
          yield { type: 'stop', stopReason: 'end_turn' };
        }
      },
    };

    const events = await collectEvents(
      createRuntime(
        makeConfig({
          provider,
          tools: createMockToolProvider([tool]),
          maxTurns: 50,
        }),
      ).query({ hostRunId: 'test-run', prompt: 'kick' }),
    );

    // 单轮 3 次同 (tool, kind) 失败 → 触发 notice 一次
    expect(noticesOfType(events, 'tool_failure_notice').length).toBe(1);
    expect(noticesOfType(events, 'tool_failure_nudge').length).toBe(0);
    const noticePayload = noticesOfType(events, 'tool_failure_notice')[0]!
      .payload as Record<string, unknown>;
    expect(noticePayload.streak).toBe(3);
  });

  it('recordSuccess in a single turn only pops the matching tail, leaving earlier streak intact', async () => {
    // 单轮 yield [stall_tool fail × 2, helper_tool success, stall_tool fail]
    // 期望 buffer = [stall/X, stall/X, stall/X]（中间 helper success 是不同 tool，
    // 不影响 stall streak）；streak = 3 → notice
    const STALL_TOOL = 'stall_tool';
    const HELPER_TOOL = 'helper_tool';
    const stallTool = makeFailingTool(STALL_TOOL, NETWORK_FAILED);
    const helperTool: Tool = {
      name: HELPER_TOOL,
      description: 'always succeeds',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: true,
      execute: async () => ({ content: 'ok' }),
    };

    let calls = 0;
    const provider: LLMProvider = {
      async *createStream(): AsyncIterable<LLMResponseChunk> {
        calls++;
        if (calls === 1) {
          yield {
            type: 'tool_use',
            toolUse: { id: 's1', name: STALL_TOOL, input: {} },
          };
          yield {
            type: 'tool_use',
            toolUse: { id: 's2', name: STALL_TOOL, input: {} },
          };
          yield {
            type: 'tool_use',
            toolUse: { id: 'h1', name: HELPER_TOOL, input: {} },
          };
          yield {
            type: 'tool_use',
            toolUse: { id: 's3', name: STALL_TOOL, input: {} },
          };
          yield {
            type: 'usage',
            usage: { input_tokens: 50, output_tokens: 50 },
          };
          yield { type: 'stop', stopReason: 'tool_use' };
        } else {
          yield { type: 'text_delta', text: 'final' };
          yield {
            type: 'usage',
            usage: { input_tokens: 50, output_tokens: 50 },
          };
          yield { type: 'stop', stopReason: 'end_turn' };
        }
      },
    };

    const events = await collectEvents(
      createRuntime(
        makeConfig({
          provider,
          tools: createMockToolProvider([stallTool, helperTool]),
          maxTurns: 50,
        }),
      ).query({ hostRunId: 'test-run', prompt: 'kick' }),
    );

    // helper success 是不同 tool（recordSuccess(helper_tool) 不会 pop stall 的失败）
    // → buffer 末尾 streak (stall, NETWORK_FAILED) = 3 → 触发 notice 一次
    const notices = noticesOfType(events, 'tool_failure_notice');
    expect(notices.length).toBe(1);
    const payload = notices[0]!.payload as Record<string, unknown>;
    expect(payload.tool).toBe(STALL_TOOL);
    expect(payload.streak).toBe(3);
  });
});

// ─── 工具失败不升级为会话终态 ──────────────────────────────
describe('工具失败可恢复——query 主循环集成', () => {
  it('连续 12 次失败后仍允许模型进入下一轮并最终回答', async () => {
    // provider 连续调 12 轮失败工具，第 13 轮产出最终回答。
    const { provider, captured } = makeStallProvider(12);
    const tool = makeFailingTool('stall_tool', NETWORK_FAILED);

    await withTelemetrySink(async (sink) => {
      const events = await collectEvents(
        createRuntime(
          makeConfig({
            provider,
            tools: createMockToolProvider([tool]),
            maxTurns: 50,
          }),
        ).query({ hostRunId: 'test-run', prompt: 'kick' }),
      );

      expect(noticesOfType(events, 'tool_failure_terminate').length).toBe(0);

      const doneEvents = events.filter((e) => e.type === 'agent.stream.done');
      expect(doneEvents.length).toBe(1);
      const donePayload = doneEvents[0]!.payload as Record<string, unknown>;
      expect(donePayload.error).toBeFalsy();
      expect(donePayload.error_class).toBeUndefined();
      expect(donePayload.hard_stop_source).toBeUndefined();
      expect(donePayload.content).toContain('final answer');

      expect(captured.length).toBe(13);

      // 失败信息和 nudge 仍保留，只取消会话级硬停。
      expect(noticesOfType(events, 'tool_failure_notice').length).toBe(1);
      expect(noticesOfType(events, 'tool_failure_nudge').length).toBe(1);

      const termTel = sink.records.filter(
        (r) => r.event_name === 'tool_failure.terminate',
      );
      expect(termTel.length).toBe(0);
    });
  });

  it('ask_form 参数连续失败也不中止会话', async () => {
    const { provider, captured } = makeStallProvider(12, 'ask_form');
    const tool = makeFailingTool('ask_form', INVALID_PARAM_FORMAT);

    await withTelemetrySink(async (sink) => {
      const events = await collectEvents(
        createRuntime(
          makeConfig({
            provider,
            tools: createMockToolProvider([tool]),
            maxTurns: 50,
          }),
        ).query({ hostRunId: 'test-run', prompt: 'kick' }),
      );

      const doneEvents = events.filter((e) => e.type === 'agent.stream.done');
      expect(doneEvents.length).toBe(1);
      const donePayload = doneEvents[0]!.payload as Record<string, unknown>;
      expect(donePayload.error).toBeFalsy();
      expect(donePayload.error_class).toBeUndefined();
      expect(donePayload.hard_stop_source).toBeUndefined();
      expect(donePayload.content).toContain('final answer');

      expect(captured.length).toBe(13);
      expect(noticesOfType(events, 'tool_failure_notice').length).toBe(0);
      expect(noticesOfType(events, 'tool_failure_nudge').length).toBe(0);

      const termTel = sink.records.filter(
        (r) => r.event_name === 'tool_failure.terminate',
      );
      expect(termTel.length).toBe(0);
    });
  });
});
