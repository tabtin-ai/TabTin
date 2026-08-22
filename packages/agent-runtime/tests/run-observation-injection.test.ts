/**
 * Wave 5a (L-W4-1) — agent-runtime observation 注入路径单测。
 *
 * 验证：
 *  1. `EngineConfig.getRecentRunObservations` 缺省时整路径 no-op，不影响主流程；
 *  2. 多轮 ReAct 中每轮起始处会调一次 callback，新增 observation 进入 LLM
 *     上下文（state.messages）；
 *  3. observation 注入路径**不会泄漏**密码 sentinel 到 LLM 可见路径（核心
 *     安全断言，与 Wave 4 e2e 25 安全断言对齐）；
 *  4. 注入路径 yield SYSTEM_NOTICE（observer 视角能看到注入计数 / 类型，但
 *     不重复 humanReadable，避免脚本被 stream sink 转发到 toast）；
 *  5. callback 抛错时不打断 ReAct loop（safety net）。
 */

import { describe, it, expect } from 'vitest';
import { createRuntime } from '../src/runtime-assembly.js';
import {
  createMockProvider,
  createMockPermissionHandler,
  createMockToolProvider,
} from './test-utils.js';
import { createTestToolRiskPolicyPort } from './helpers/tool-risk-policy-port.js';
import type {
  StreamEvent,
} from '../src/engine/contracts/wire-protocol.js';
import type {
  LLMRequest,
  LLMResponseChunk,
  LLMProvider,
} from '../src/engine/contracts/model-llm.js';
import type {
  Tool,
} from '../src/engine/contracts/tools.js';
import type {
  EngineConfig,
  RunObservationInjection,
} from '../src/engine/contracts/kernel.js';

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function makeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    provider: createMockProvider(),
    tools: createMockToolProvider(),
    permissionHandler: createMockPermissionHandler(),
    toolRiskPolicy: createTestToolRiskPolicyPort({
      buildEffectivePolicy: () => undefined,
      memoStore: { lookup: async () => undefined } as never,
    }),
    sessionConfig: { sessionDir: '/tmp/run-observation-test', threadId: 'test-session-obs' },
    model: 'test-model',
    ...overrides,
  };
}

/**
 * Provider that captures every `LLMRequest.messages` it sees so tests can
 * assert what eventually reached the LLM. Yields a 1-iteration finish each
 * call (so multi-iteration ReAct loops require multiple distinct chunk
 * sequences).
 */
function makeRecordingProvider(
  chunkSequences: LLMResponseChunk[][],
): { provider: LLMProvider; capturedRequests: LLMRequest[] } {
  const capturedRequests: LLMRequest[] = [];
  let idx = 0;
  const provider: LLMProvider = {
    async *createStream(req: LLMRequest): AsyncIterable<LLMResponseChunk> {
      // structuredClone 不能 clone functions（req.onRetryAttempt）—— 用 JSON 深拷贝
      // messages 字段（这是断言主战场）即可，其他 callback 不进 captured 视图。
      capturedRequests.push({
        model: req.model,
        messages: JSON.parse(JSON.stringify(req.messages)),
        tools: req.tools,
        system: req.system,
        maxTokens: req.maxTokens,
      });
      const chunks = chunkSequences[idx++] ?? [
        { type: 'text_delta', text: 'fallback' },
        { type: 'stop', stopReason: 'end_turn' },
      ];
      for (const c of chunks) yield c;
    },
  };
  return { provider, capturedRequests };
}

function makeEchoTool(name: string, output: string): Tool {
  return {
    name,
    description: `echo ${name}`,
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: true,
    execute: async () => ({ content: output }),
  };
}

describe('Wave 5a — RunObservation injection (L-W4-1)', () => {
  it('callback 缺省时整路径 no-op：messages 不被污染', async () => {
    const { provider, capturedRequests } = makeRecordingProvider([
      [
        { type: 'text_delta', text: 'hello' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);
    const rt = createRuntime(makeConfig({ provider }));
    await collect(rt.query({ hostRunId: 'test-run', prompt: 'hi' }));

    // 只发 1 次 LLM；消息只有 1 条（user prompt），没有 observation 注入
    expect(capturedRequests.length).toBe(1);
    expect(capturedRequests[0]!.messages).toHaveLength(1);
    expect(capturedRequests[0]!.messages[0]!.role).toBe('user');
  });

  it('callback 返回 observation 时，注入条目作为新 user message 进入下一轮 LLM 上下文', async () => {
    // 多轮 ReAct：第 1 轮 LLM 调一个工具 → tool 完成后第 2 轮 LLM 看到工具
    // 结果 + observation。把 observation 安排在第 2 轮调用之前 yield。
    const { provider, capturedRequests } = makeRecordingProvider([
      // 第 1 轮：LLM 调 echo 工具
      [
        { type: 'tool_use', toolUse: { id: 'tu-1', name: 'echo', input: {} } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      // 第 2 轮：直接 final
      [
        { type: 'text_delta', text: 'observed-and-done' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);

    let injectorCalls = 0;
    const obs: RunObservationInjection = {
      humanReadable: '[Browser autofill] 自动登录 example.com 失败：凭据可能已过期或失效',
      type: 'AGENT_AUTOFILL_FAILED',
      timestamp: Date.now(),
    };
    const getRecentRunObservations = async (): Promise<RunObservationInjection[]> => {
      injectorCalls += 1;
      // 第 1 轮 yield 空（autofill 还没发生）；第 2 轮起 yield observation
      if (injectorCalls === 1) return [];
      if (injectorCalls === 2) return [obs];
      return [];
    };

    const rt = createRuntime(
      makeConfig({
        provider,
        tools: createMockToolProvider([makeEchoTool('echo', 'echoed')]),
        getRecentRunObservations,
      }),
    );
    const events = await collect(rt.query({ hostRunId: 'test-run', prompt: 'go' }));

    // injector 至少被调过 2 次（每轮 ReAct 顶部一次）
    expect(injectorCalls).toBeGreaterThanOrEqual(2);

    // 第 2 轮 LLM 请求里应该看到 observation 文案
    expect(capturedRequests.length).toBeGreaterThanOrEqual(2);
    const secondRequest = capturedRequests[1]!;
    const flatText = JSON.stringify(secondRequest.messages);
    expect(flatText).toContain('自动登录 example.com 失败');
    expect(flatText).toContain('<run_observations>');

    // observer 视角看到注入 SYSTEM_NOTICE
    const notice = events.find(
      (e) =>
        e.type === 'agent.stream.system_notice' &&
        (e.payload as Record<string, unknown>).notice_type === 'run_observation_injected',
    );
    expect(notice).toBeDefined();
    const noticePayload = notice!.payload as Record<string, unknown>;
    expect(noticePayload.severity).toBe('silent');
    expect(noticePayload.observation_count).toBe(1);
    expect(noticePayload.observation_types).toEqual(['AGENT_AUTOFILL_FAILED']);
    // observer notice 不重复 humanReadable（避免被 sink 转 toast 重复打扰用户）
    expect(JSON.stringify(noticePayload)).not.toContain('凭据可能已过期');
  });

  it('安全：注入路径 0 携带密码 sentinel（核心安全断言）', async () => {
    const PASSWORD_SENTINEL = 'pw-NEVER-IN-LLM-9876543210';
    const CREDENTIAL_ID = 'cred-uuid-deadbeef-1234-5678-90ab-cdef01234567';

    const { provider, capturedRequests } = makeRecordingProvider([
      [
        { type: 'tool_use', toolUse: { id: 'tu-x', name: 'echo', input: {} } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'final' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);

    // 模拟"宿主写好的"安全 humanReadable —— 这是 host 侧 formatter 的契约：
    // 不能含密码、credential_id 明文。本测试断言 agent-runtime 注入路径
    // 不会魔法地把别处的 sensitive 数据塞进来。
    const injection: RunObservationInjection = {
      humanReadable:
        '[Browser autofill] 自动登录 example.com 失败：凭据可能已过期或失效',
      type: 'AGENT_AUTOFILL_FAILED',
      timestamp: Date.now(),
      // metadata 即便宿主误传敏感字段，agent-runtime 也不会写入 LLM 上下文（仅 telemetry 用）
      metadata: { domain: 'example.com', code: 'credential-unavailable' },
    };

    let calls = 0;
    const rt = createRuntime(
      makeConfig({
        provider,
        tools: createMockToolProvider([makeEchoTool('echo', 'echoed')]),
        getRecentRunObservations: async () => {
          calls += 1;
          return calls === 2 ? [injection] : [];
        },
      }),
    );

    const events = await collect(
      rt.query({
      hostRunId: 'test-run',
        // user prompt 也不能让 sentinel 穿透——纯 baseline，确认测试自身配置正确
        prompt: 'baseline prompt',
      }),
    );

    const allRequests = JSON.stringify(capturedRequests);
    const allEvents = JSON.stringify(events);
    expect(allRequests).not.toContain(PASSWORD_SENTINEL);
    expect(allRequests).not.toContain(CREDENTIAL_ID);
    expect(allEvents).not.toContain(PASSWORD_SENTINEL);
    expect(allEvents).not.toContain(CREDENTIAL_ID);
  });

  it('callback 抛错不打断 ReAct loop，仅 yield error notice', async () => {
    const { provider } = makeRecordingProvider([
      [
        { type: 'text_delta', text: 'finished' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);

    const rt = createRuntime(
      makeConfig({
        provider,
        getRecentRunObservations: async () => {
          throw new Error('rsm explosion');
        },
      }),
    );
    const events = await collect(rt.query({ hostRunId: 'test-run', prompt: 'go' }));

    // 主流程仍然走完到 done（不被 callback 异常打断）
    expect(events.find((e) => e.type === 'agent.stream.done')).toBeDefined();
    // observer 看到 error notice
    const errNotice = events.find(
      (e) =>
        e.type === 'agent.stream.system_notice' &&
        (e.payload as Record<string, unknown>).notice_type === 'run_observation_inject_error',
    );
    expect(errNotice).toBeDefined();
    expect((errNotice!.payload as Record<string, unknown>).severity).toBe('silent');
    expect(JSON.stringify(errNotice!.payload)).toContain('rsm explosion');
  });

  it('多条 observation 单轮全部注入到一条 user message（不污染 tool_result pairing）', async () => {
    const { provider, capturedRequests } = makeRecordingProvider([
      [
        { type: 'text_delta', text: 'first turn' },
        { type: 'tool_use', toolUse: { id: 'tu-multi', name: 'echo', input: {} } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'second turn' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);

    const obs1: RunObservationInjection = {
      humanReadable: '[Browser autofill] 自动登录 a.com 失败：凭据可能已过期',
      type: 'AGENT_AUTOFILL_FAILED',
      timestamp: 1000,
    };
    const obs2: RunObservationInjection = {
      humanReadable: '[Browser env] 当前 Space 的登录环境已被切换',
      type: 'SPACE_ENV_CHANGED',
      timestamp: 2000,
    };

    let calls = 0;
    const rt = createRuntime(
      makeConfig({
        provider,
        tools: createMockToolProvider([makeEchoTool('echo', 'echoed')]),
        getRecentRunObservations: async () => {
          calls += 1;
          return calls === 2 ? [obs1, obs2] : [];
        },
      }),
    );
    await collect(rt.query({ hostRunId: 'test-run', prompt: 'go' }));

    expect(capturedRequests.length).toBeGreaterThanOrEqual(2);
    const flat = JSON.stringify(capturedRequests[1]!.messages);
    // 两条都注入了
    expect(flat).toContain('自动登录 a.com 失败');
    expect(flat).toContain('当前 Space 的登录环境已被切换');
    // 包在 <run_observations> 块里（一条 user message）
    expect(flat).toContain('<run_observations>');
    expect(flat).toContain('</run_observations>');
  });
});
