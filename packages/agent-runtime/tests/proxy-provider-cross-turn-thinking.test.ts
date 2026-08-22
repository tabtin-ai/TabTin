/**
 *  — proxy-provider 出口 strip 跨轮 thinking，避免 DeepSeek 等 400。
 *
 * 入口 select-recent-history 装填时已丢弃 thinking；本测试锁定出口
 * convertAssistantMessage / buildRequestBody 不再把 thinking 合并进
 * reasoning_content。
 */

import { describe, expect, it } from 'vitest';
import {
  TabTinProxyProvider,
  convertAssistantMessage,
} from '../src/providers/proxy-provider.js';
import {
  FALLBACK_MODEL_CAPABILITIES,
  type LLMRequest,
  type ModelCapabilities,
} from '../src/engine/contracts/model-llm.js';

function makeProvider(cacheType: ModelCapabilities['cacheType']): TabTinProxyProvider {
  return new TabTinProxyProvider({
    proxyUrl: 'http://localhost:0/llm/proxy',
    deviceToken: 'tok',
    agentId: 'ag',
    threadId: 'ss',
    maxRetries: 0,
    modelCapabilities: { ...FALLBACK_MODEL_CAPABILITIES, cacheType },
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

describe('convertAssistantMessage — strip cross-turn thinking ', () => {
  it('thinking + text + tool_use：只导出 text 与 tool_calls，不含 reasoning_content', () => {
    const out = convertAssistantMessage([
      { type: 'thinking', thinking: 'prior turn reasoning', signature: 'sig-old' },
      { type: 'text', text: 'final answer' },
      { type: 'tool_use', id: 'tc1', name: 'read_file', input: { path: 'a.txt' } },
    ]);
    expect(out.content).toBe('final answer');
    expect(out.tool_calls).toHaveLength(1);
    expect(out).not.toHaveProperty('reasoning_content');
  });

  it('thinking-only assistant：content 为空串，不含 reasoning_content', () => {
    const out = convertAssistantMessage([
      { type: 'thinking', thinking: 'orphan reasoning only', signature: 'sig' },
    ]);
    expect(out.content).toBe('');
    expect(out).not.toHaveProperty('reasoning_content');
  });
});

describe('buildRequestBody — cross-turn assistant messages ', () => {
  const crossTurnMessages = msgs([
    { role: 'user', content: 'turn 1 question' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'turn1 internal', signature: 'sig-1' },
        { type: 'text', text: 'turn 1 answer' },
      ],
    },
    { role: 'user', content: 'turn 2 question' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'turn2 internal', signature: 'sig-2' },
        { type: 'tool_use', id: 'tc1', name: 'list_directory', input: { path: '.' } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'SKILL.md' }],
    },
    { role: 'user', content: 'turn 3 question' },
  ]);

  const baseRequest = (provider: TabTinProxyProvider): LLMRequest => ({
    model: 'deepseek-chat',
    messages: crossTurnMessages,
    maxTokens: 256,
  });

  it('implicit cache（DeepSeek / OpenAI 兼容）：历史 assistant 均无 reasoning_content', () => {
    const body = buildBody(makeProvider('implicit'), baseRequest(makeProvider('implicit')));
    const assistants = body.messages.filter((m) => m.role === 'assistant');
    expect(assistants.length).toBeGreaterThanOrEqual(2);
    for (const asst of assistants) {
      expect(asst).not.toHaveProperty('reasoning_content');
    }
    expect(assistants[0]?.content).toBe('turn 1 answer');
    expect(assistants[1]?.tool_calls).toBeTruthy();
    expect(body.messages.some((m) => 'reasoning_content' in m)).toBe(false);
  });

  it('Claude explicit cache：历史 assistant 同样不含 reasoning_content', () => {
    const body = buildBody(makeProvider('explicit'), baseRequest(makeProvider('explicit')));
    const assistants = body.messages.filter((m) => m.role === 'assistant');
    for (const asst of assistants) {
      expect(asst).not.toHaveProperty('reasoning_content');
    }
  });
});
