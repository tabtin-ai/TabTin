/**
 * DeepSeek V4 思考模式：工具轮 reasoning_content 回传（在  全局 drop 之上开的
 * 能力驱动例外）。
 *
 * DeepSeek 要求：发生工具调用的 assistant 消息，其 reasoning 必须随 reasoning_content
 * 回传，否则上游 400。故 `reasoningHistoryPolicy: 'preserve_for_tools'` + 含 tool_calls
 * 时保留 reasoning_content；其余（drop / 非工具轮）维持现状不回传，不影响其它 provider。
 */

import { describe, expect, it } from 'vitest';
import {
  TabTinProxyProvider,
  convertAssistantMessage,
} from '../src/providers/proxy-provider.js';
import {
  deriveReasoningHistoryPolicy,
  FALLBACK_MODEL_CAPABILITIES,
  type LLMRequest,
  type ModelCapabilities,
} from '../src/engine/contracts/model-llm.js';

function makeProvider(
  reasoningHistoryPolicy: ModelCapabilities['reasoningHistoryPolicy'],
): TabTinProxyProvider {
  return new TabTinProxyProvider({
    proxyUrl: 'http://localhost:0/llm/proxy',
    deviceToken: 'tok',
    agentId: 'ag',
    threadId: 'ss',
    maxRetries: 0,
    modelCapabilities: { ...FALLBACK_MODEL_CAPABILITIES, reasoningHistoryPolicy },
  });
}

function buildBody(
  provider: TabTinProxyProvider,
  request: LLMRequest,
): { messages: Array<Record<string, unknown>> } {
  const build = (
    provider as unknown as { buildRequestBody: (r: LLMRequest) => { messages: unknown[] } }
  ).buildRequestBody.bind(provider);
  return build(request) as { messages: Array<Record<string, unknown>> };
}

function msgs(arr: unknown[]): LLMRequest['messages'] {
  return arr as unknown as LLMRequest['messages'];
}

describe('deriveReasoningHistoryPolicy', () => {
  it('deepseek → preserve_for_tools', () => {
    expect(deriveReasoningHistoryPolicy('deepseek')).toBe('preserve_for_tools');
    expect(deriveReasoningHistoryPolicy('DeepSeek')).toBe('preserve_for_tools');
  });

  it('其它 provider → drop（安全默认）', () => {
    expect(deriveReasoningHistoryPolicy('openai')).toBe('drop');
    expect(deriveReasoningHistoryPolicy('claude')).toBe('drop');
    expect(deriveReasoningHistoryPolicy('moonshot')).toBe('drop');
    expect(deriveReasoningHistoryPolicy(undefined)).toBe('drop');
  });

  it('capabilities_config 显式 override 生效', () => {
    expect(
      deriveReasoningHistoryPolicy('openai', { reasoning_history_roundtrip: 'preserve_for_tools' }),
    ).toBe('preserve_for_tools');
    expect(
      deriveReasoningHistoryPolicy('moonshot', { reasoning_history_roundtrip: 'preserve' }),
    ).toBe('preserve');
  });
});

describe('convertAssistantMessage — preserve（Kimi K3）', () => {
  it('preserve + thinking 无 tool_use → 仍带 reasoning_content', () => {
    const out = convertAssistantMessage(
      [
        { type: 'thinking', thinking: 'k3 always thinks', signature: 's' },
        { type: 'text', text: 'final answer' },
      ],
      'preserve',
    );
    expect(out.content).toBe('final answer');
    expect(out.reasoning_content).toBe('k3 always thinks');
  });

  it('preserve + thinking + tool_use → 带 reasoning_content', () => {
    const out = convertAssistantMessage(
      [
        { type: 'thinking', thinking: 'plan tool', signature: 's' },
        { type: 'tool_use', id: 'tc1', name: 'read_file', input: { path: 'a.txt' } },
      ],
      'preserve',
    );
    expect(out.tool_calls).toHaveLength(1);
    expect(out.reasoning_content).toBe('plan tool');
  });
});

describe('convertAssistantMessage — preserve_for_tools', () => {
  it('preserve_for_tools + thinking + tool_use → 带 reasoning_content', () => {
    const out = convertAssistantMessage(
      [
        { type: 'thinking', thinking: 'why I call the tool', signature: 's' },
        { type: 'tool_use', id: 'tc1', name: 'read_file', input: { path: 'a.txt' } },
      ],
      'preserve_for_tools',
    );
    expect(out.tool_calls).toHaveLength(1);
    expect(out.reasoning_content).toBe('why I call the tool');
  });

  it('preserve_for_tools + thinking 但无 tool_use → 不带 reasoning_content（非工具轮）', () => {
    const out = convertAssistantMessage(
      [
        { type: 'thinking', thinking: 'pure chat reasoning', signature: 's' },
        { type: 'text', text: 'final answer' },
      ],
      'preserve_for_tools',
    );
    expect(out.content).toBe('final answer');
    expect(out).not.toHaveProperty('reasoning_content');
  });

  it('drop（默认）+ thinking + tool_use → 不带 reasoning_content（不回归 ）', () => {
    const out = convertAssistantMessage([
      { type: 'thinking', thinking: 'should be dropped', signature: 's' },
      { type: 'tool_use', id: 'tc1', name: 'read_file', input: {} },
    ]);
    expect(out.tool_calls).toHaveLength(1);
    expect(out).not.toHaveProperty('reasoning_content');
  });
});

describe('buildRequestBody — preserve_for_tools 端到端', () => {
  const messages = msgs([
    { role: 'user', content: 'do a task' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'tool turn reasoning', signature: 's1' },
        { type: 'tool_use', id: 'tc1', name: 'list_directory', input: { path: '.' } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'ok' }] },
  ]);

  const request = (): LLMRequest => ({ model: 'deepseek-v4-flash', messages, maxTokens: 128 });

  it('preserve_for_tools：工具轮 assistant 带 reasoning_content', () => {
    const body = buildBody(makeProvider('preserve_for_tools'), request());
    const toolAsst = body.messages.find((m) => m.role === 'assistant' && m.tool_calls);
    expect(toolAsst?.reasoning_content).toBe('tool turn reasoning');
  });

  it('drop（其它 provider）：同样历史不带 reasoning_content', () => {
    const body = buildBody(makeProvider('drop'), request());
    for (const m of body.messages) {
      expect(m).not.toHaveProperty('reasoning_content');
    }
  });
});
