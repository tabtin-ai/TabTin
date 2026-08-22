/**
 * WA-F 紧急修复（2026-04-19）— TabTinProxyProvider 前置工具名 sanity check
 *
 * 背景（真机根因）：
 *   Wave B 本地 Skill 模块把新工具注册为 `skills.read` / `skills.search`
 *   （点号），Moonshot / OpenAI 的 function name 规范是 `^[a-zA-Z0-9_-]+$`，
 *   点号被上游以 HTTP 400 "function name is invalid" 拒绝。而上游 400 在
 *   SSE 流式通道里被某些代理表现为"空 stream"，我们的 reader 静默卡到
 *   STALL_TIMEOUT_MS 才超时——用户真机发消息每条都"卡 30s 没响应"。
 *
 * 修法双保险：
 *   1. skills-tools.ts 改用下划线 `skills_read` / `skills_search`（已修）；
 *   2. 本文件覆盖的前置校验——在组装请求体时发现非法名字就立即抛
 *      `LLM_ERROR`，开发者第一时间看到违规工具名，不再等 30s。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabTinProxyProvider } from '../src/providers/proxy-provider.js';
import type {
  ToolParam,
} from '../src/engine/contracts/conversation.js';
import type {
  LLMRequest,
} from '../src/engine/contracts/model-llm.js';
import {
  AgentError,
} from '../src/engine/contracts/kernel.js';

function makeProvider(): TabTinProxyProvider {
  return new TabTinProxyProvider({
    proxyUrl: 'http://localhost:0/llm/proxy',
    deviceToken: 'test-token',
    agentId: 'ag-x',
    threadId: 'ss-x',
    maxRetries: 0,
  });
}

function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: 'unit-test',
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 256,
    ...overrides,
  };
}

function makeTool(name: string): ToolParam {
  return {
    name,
    description: 'test tool',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  };
}

/**
 * 跑 createStream 的所有 chunk，遇到异常收集（不冒到 test 本身，方便断言）。
 */
async function drainExpectError(
  provider: TabTinProxyProvider,
  req: LLMRequest,
): Promise<unknown> {
  try {
    for await (const _ of provider.createStream(req)) {
      void _;
    }
    return null;
  } catch (err) {
    return err;
  }
}

/**
 * 跑 createStream 成功路径（fetch 已被 stub 返回 200 空 SSE），确保非法名字
 * 能在 fetch **不被调用** 前抛出——不会真的走网络。
 */
describe('TabTinProxyProvider · 工具名前置 sanity check（WA-F）', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(async () => {
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // 用一个**纯构造**的非法名做反例（曾用 'skills.read' 但易跟 action-tools 旧命名
  // 混淆——后者已于 2026-04-30 改名为 skills_read）。
  it('点号工具名抛 LLM_ERROR，fetch 不被调用', async () => {
    const provider = makeProvider();
    const err = await drainExpectError(
      provider,
      makeRequest({ tools: [makeTool('legacy.dotted_name')] }),
    );
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code).toBe('LLM_ERROR');
    expect((err as AgentError).message).toContain('Invalid tool name');
    expect((err as AgentError).message).toContain('legacy.dotted_name');
    expect((err as AgentError).details?.invalidToolName).toBe(true);
    expect((err as AgentError).details?.toolName).toBe('legacy.dotted_name');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('中文工具名抛错，fetch 不被调用', async () => {
    const provider = makeProvider();
    const err = await drainExpectError(
      provider,
      makeRequest({ tools: [makeTool('读取技能')] }),
    );
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).message).toContain('Invalid tool name');
    expect((err as AgentError).message).toContain('读取技能');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('空格 / 冒号 / 路径分隔符都会被拦截', async () => {
    const provider = makeProvider();
    for (const bad of ['has space', 'user:skill', 'app/foo', 'foo.bar.baz', '']) {
      const err = await drainExpectError(
        provider,
        makeRequest({ tools: [makeTool(bad)] }),
      );
      expect(err, `should reject "${bad}"`).toBeInstanceOf(AgentError);
      expect((err as AgentError).code).toBe('LLM_ERROR');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('超长工具名（> 64 字符）被拦截', async () => {
    const provider = makeProvider();
    const longName = 'a'.repeat(65);
    const err = await drainExpectError(
      provider,
      makeRequest({ tools: [makeTool(longName)] }),
    );
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).details?.invalidToolName).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('混合情况：有一个非法名字就整批拦截（不让半成品请求进网络）', async () => {
    const provider = makeProvider();
    const err = await drainExpectError(
      provider,
      makeRequest({
        tools: [
          makeTool('good_tool'),
          makeTool('legacy.dotted_name'),
          makeTool('another_good_tool'),
        ],
      }),
    );
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).details?.toolName).toBe('legacy.dotted_name');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('合法工具名（下划线 / 中划线 / 大小写数字）正常通过 + fetch 被调用', async () => {
    const provider = makeProvider();
    // 成功路径：SSE 只吐 [DONE] → drain 正常结束
    await drainExpectError(
      provider,
      makeRequest({
        tools: [
          makeTool('skills_read'),
          makeTool('skills_search'),
          makeTool('todo'),
          makeTool('summarize_context'),
          makeTool('search-web'),
          makeTool('tool_123'),
          makeTool('A'),
        ],
      }),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('没有 tools 时跳过校验（向后兼容纯对话）', async () => {
    const provider = makeProvider();
    await drainExpectError(provider, makeRequest({}));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('错误为非 retryable（不会触发 retry 循环空耗）', async () => {
    // 用 maxRetries=5 看会不会错误被重试——不应该，因为 invalidToolName 不是
    // 429/502/503/529/network/retryable。
    const provider = new TabTinProxyProvider({
      proxyUrl: 'http://localhost:0/llm/proxy',
      deviceToken: 'test-token',
      maxRetries: 5,
    });
    const err = await drainExpectError(
      provider,
      makeRequest({ tools: [makeTool('legacy.dotted_name')] }),
    );
    expect(err).toBeInstanceOf(AgentError);
    // 应该只抛一次，立即冒泡；fetch 永远不会被调到
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
