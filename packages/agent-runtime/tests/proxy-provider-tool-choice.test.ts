/**
 * 登录墙门禁轮 tool_choice 出口行为。
 *
 * 1. 带 tools 时 request.toolChoice 透传为 body.tool_choice；
 * 2. toolChoice='required' 与 thinking 互斥——Kimi/Anthropic 上游会 400
 *    （"tool_choice 'required' is incompatible with thinking enabled"，
 *    2026-07-22 dogfood 实测），门禁轮必须不带 thinking；
 * 3. 普通轮 thinking 照常带。
 */

import { describe, expect, it } from 'vitest';
import { TabTinProxyProvider } from '../src/providers/proxy-provider.js';
import {
  FALLBACK_MODEL_CAPABILITIES,
  type LLMRequest,
} from '../src/engine/contracts/model-llm.js';

function makeProvider(
  thinkingBudgetTokens?: number,
  requestParamOverrides?: Record<string, string | number | boolean | null>,
): TabTinProxyProvider {
  return new TabTinProxyProvider({
    proxyUrl: 'http://localhost:0/llm/proxy',
    deviceToken: 'tok',
    agentId: 'ag',
    threadId: 'ss',
    maxRetries: 0,
    thinkingBudgetTokens,
    requestParamOverrides,
    modelCapabilities: { ...FALLBACK_MODEL_CAPABILITIES },
  });
}

function buildBody(
  provider: TabTinProxyProvider,
  request: LLMRequest,
): Record<string, unknown> {
  const build = (
    provider as unknown as { buildRequestBody: (r: LLMRequest) => Record<string, unknown> }
  ).buildRequestBody.bind(provider);
  return build(request);
}

const baseRequest = (overrides: Partial<LLMRequest>): LLMRequest => ({
  model: 'kimi-k2.6',
  messages: [{ role: 'user', content: 'hi' }] as LLMRequest['messages'],
  tools: [
    { name: 'ask_user', description: 'ask', input_schema: { type: 'object' } },
  ] as unknown as LLMRequest['tools'],
  maxTokens: 256,
  ...overrides,
});

describe('buildRequestBody — tool_choice 透传与 thinking 互斥', () => {
  it('toolChoice=required 透传为 body.tool_choice', () => {
    const body = buildBody(makeProvider(), baseRequest({ toolChoice: 'required' }));
    expect(body.tool_choice).toBe('required');
  });

  it('未设 toolChoice 时 body 不带 tool_choice（序列化后消失）', () => {
    const body = buildBody(makeProvider(), baseRequest({}));
    expect(body.tool_choice).toBeUndefined();
    expect(JSON.parse(JSON.stringify(body))).not.toHaveProperty('tool_choice');
  });

  it('无 tools 时即使设了 toolChoice 也不带（避免上游 400）', () => {
    const body = buildBody(
      makeProvider(),
      baseRequest({ tools: undefined, toolChoice: 'required' }),
    );
    expect(body.tool_choice).toBeUndefined();
  });

  it('#11207 有 tools 时显式打开 parallel_tool_calls', () => {
    const body = buildBody(makeProvider(), baseRequest({}));
    expect(body.parallel_tool_calls).toBe(true);
  });

  it('#11207 无 tools 时不带 parallel_tool_calls', () => {
    const body = buildBody(
      makeProvider(),
      baseRequest({ tools: undefined }),
    );
    expect(body.parallel_tool_calls).toBeUndefined();
    expect(JSON.parse(JSON.stringify(body))).not.toHaveProperty('parallel_tool_calls');
  });

  it('toolChoice=required 时显式关闭 thinking（Kimi 服务端默认开，省略字段不等于关闭）', () => {
    const body = buildBody(makeProvider(4096), baseRequest({ toolChoice: 'required' }));
    expect(body.tool_choice).toBe('required');
    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  it('会话未配置 thinking 时 required 轮同样显式关闭（思考模型默认开）', () => {
    const body = buildBody(makeProvider(), baseRequest({ toolChoice: 'required' }));
    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  it('普通轮 thinking 照常带', () => {
    const body = buildBody(makeProvider(4096), baseRequest({}));
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
  });

  it('#8793 嵌套 param_path 不再在客户端展开（服务端白名单不认，展开即丢弃）', () => {
    const body = buildBody(
      makeProvider(undefined, {
        'reasoning.effort': 'xhigh',
      }),
      baseRequest({}),
    );

    expect(body.reasoning).toBeUndefined();
    // key 仍原样上报，服务端可据此发现配置问题
    expect(body.model_param_overrides).toEqual({
      'reasoning.effort': 'xhigh',
    });
  });

  it('#8793 嵌套 override 不再抑制 thinking budget（它本来就不生效）', () => {
    const body = buildBody(
      makeProvider(4096, {
        'reasoning.effort': 'xhigh',
      }),
      baseRequest({}),
    );

    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
  });

  it('顶层 canonical override 照旧写入 body（Django 白名单读顶层字段）', () => {
    const body = buildBody(
      makeProvider(undefined, {
        temperature: 0.3,
      }),
      baseRequest({}),
    );

    expect(body.temperature).toBe(0.3);
    expect(body.model_param_overrides).toEqual({ temperature: 0.3 });
  });

  it('显式思考强度优先于通用 thinking budget', () => {
    const body = buildBody(
      makeProvider(4096, {
        reasoning_effort: 'high',
      }),
      baseRequest({}),
    );

    expect(body.reasoning_effort).toBe('high');
    expect(body.thinking).toBeUndefined();
  });
});
