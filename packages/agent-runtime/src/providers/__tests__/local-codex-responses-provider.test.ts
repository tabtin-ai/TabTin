import { describe, expect, it, vi } from 'vitest';
import { AgentError } from '../../engine/contracts/kernel.js';
import { classifyError } from '../../engine/errors/error-classifier.js';
import { buildClassifiedTerminalErrorInfo } from '../../engine/wire/done-payloads.js';
import type { ContentBlockEnvelopeHint, LLMRequest } from '../../engine/contracts/model-llm.js';
import { ContentBlockEvents } from '../../engine/contracts/stream-events.js';
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../../prompts/engine/dynamic-boundary.js';
import {
  LocalCodexResponsesProvider,
  resolveReasoningEffort,
  resolveServiceTier,
} from '../local-codex-responses-provider.js';

const encoder = new TextEncoder();

const request: LLMRequest = {
  model: 'gpt-5.6-sol',
  messages: [{ role: 'user', content: '你好' }],
  maxTokens: 512,
};

function sseResponse(events: unknown[]): Response {
  return new Response(new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function collect(provider: LocalCodexResponsesProvider) {
  const chunks = [];
  for await (const chunk of provider.createStream(request)) chunks.push(chunk);
  return chunks;
}

describe('LocalCodexResponsesProvider', () => {
  it('streams text and final usage from the Codex Responses endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([
      { type: 'response.output_text.delta', delta: '你好，' },
      { type: 'response.output_text.delta', delta: '世界' },
      {
        type: 'response.completed',
        response: {
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      },
    ]));
    const provider = new LocalCodexResponsesProvider({
      resolveAuth: async () => ({ accessToken: 'secret-token', accountId: 'account-1' }),
      baseUrl: 'https://example.test/backend-api/codex',
      fetchImpl,
    });

    await expect(collect(provider)).resolves.toEqual([
      { type: 'text_delta', text: '你好，' },
      { type: 'text_delta', text: '世界' },
      { type: 'usage', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
      { type: 'stop', stopReason: 'end_turn' },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.test/backend-api/codex/responses',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer secret-token',
          'chatgpt-account-id': 'account-1',
          'OpenAI-Beta': 'responses=experimental',
          accept: 'text/event-stream',
          'content-type': 'application/json',
          originator: 'tabtin',
          'session-id': expect.any(String),
          'x-client-request-id': expect.any(String),
        }),
      }),
    );
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      model: 'gpt-5.6-sol',
      store: false,
      stream: true,
      parallel_tool_calls: true,
      instructions: 'You are a helpful assistant.',
    });
    expect(body.prompt_cache_key).toMatch(/^[a-f0-9]{64}$/);
    expect(body.input).toEqual([
      {
        role: 'developer',
        content: [{
          type: 'input_text',
          text: 'Apply the preceding instructions throughout this response.',
        }],
      },
      { role: 'user', content: [{ type: 'input_text', text: '你好' }] },
    ]);
  });

  it.each([
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
  ])('builds a stable Codex prefix with an account cache key for %s', async (model) => {
    const fetchImpl = vi.fn().mockImplementation(async () => sseResponse([{
      type: 'response.completed',
      response: { usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } },
    }]));
    const provider = new LocalCodexResponsesProvider({
      resolveAuth: async () => ({ accessToken: 'secret-token', accountId: 'account-1' }),
      fetchImpl,
      threadId: 'conversation-1',
    });
    const tools: LLMRequest['tools'] = [{
      name: 'read_file',
      description: 'Read a file',
      input_schema: { type: 'object', properties: {} },
    }];

    for (const dynamicText of ['dynamic-one', 'dynamic-two']) {
      for await (const _chunk of provider.createStream({
        ...request,
        model,
        system: `stable-policy${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}${dynamicText}`,
        messages: [{ role: 'user', content: dynamicText }],
        tools,
      })) {
        // drain
      }
    }

    const firstBody = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(firstBody.instructions).toBe('stable-policy');
    expect(firstBody.prompt_cache_options).toBeUndefined();
    expect(firstBody.prompt_cache_key).toMatch(/^[a-f0-9]{64}$/);
    expect(secondBody.prompt_cache_key).toBe(firstBody.prompt_cache_key);
    const firstHeaders = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    const secondHeaders = new Headers(fetchImpl.mock.calls[1]?.[1]?.headers);
    expect(firstHeaders.get('session-id')).toBe('conversation-1');
    expect(secondHeaders.get('session-id')).toBe('conversation-1');
    expect(firstHeaders.get('x-client-request-id')).not.toBe(
      secondHeaders.get('x-client-request-id'),
    );
    expect(firstBody.input[0]).toMatchObject({
      role: 'developer',
      content: [{
        type: 'input_text',
        text: 'Apply the preceding instructions throughout this response.',
      }],
    });
    expect(firstBody.input[1]).toEqual({
      role: 'developer',
      content: [{ type: 'input_text', text: 'dynamic-one' }],
    });
    expect(secondBody.input[1]).toEqual({
      role: 'developer',
      content: [{ type: 'input_text', text: 'dynamic-two' }],
    });
  });

  it('keeps a stable cache prefix when the conversation environment changes', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => sseResponse([{
      type: 'response.completed',
      response: { usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } },
    }]));
    const provider = new LocalCodexResponsesProvider({
      resolveAuth: async () => ({ accessToken: 'secret-token', accountId: 'account-1' }),
      fetchImpl,
    });
    const makeSystem = (sessionId: string) => [
      'stable-policy',
      `<environment>\norganization: org-1\nsession: ${sessionId}\n</environment>`,
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      'dynamic-policy',
    ].join('\n');

    for (const sessionId of ['session-1', 'session-2']) {
      for await (const _chunk of provider.createStream({
        ...request,
        system: makeSystem(sessionId),
      })) {
        // drain
      }
    }

    const firstBody = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(firstBody.instructions).toBe('stable-policy');
    expect(secondBody.instructions).toBe('stable-policy');
    expect(secondBody.prompt_cache_key).toBe(firstBody.prompt_cache_key);
    expect(firstBody.input[1].content[0].text).toContain('session-1');
    expect(secondBody.input[1].content[0].text).toContain('session-2');
  });

  it('retries once without cache fields when the Codex endpoint rejects them', async () => {
    const onPromptCacheFallback = vi.fn();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: 'unknown_parameter', message: 'Unknown parameter: prompt_cache_key' },
      }), { status: 400, headers: { 'x-request-id': 'req-cache-rejected' } }))
      .mockResolvedValueOnce(sseResponse([{
        type: 'response.completed',
        response: { usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } },
      }]));
    const provider = new LocalCodexResponsesProvider({
      resolveAuth: async () => ({ accessToken: 'secret-token', accountId: 'account-1' }),
      fetchImpl,
      onPromptCacheFallback,
    });
    const system = `stable-policy${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}dynamic-policy`;

    for await (const _chunk of provider.createStream({ ...request, system })) {
      // drain
    }

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const cachedBody = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    const fallbackBody = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(cachedBody.prompt_cache_key).toBeDefined();
    expect(fallbackBody.prompt_cache_key).toBeUndefined();
    expect(fallbackBody.prompt_cache_options).toBeUndefined();
    expect(fallbackBody.instructions).toBe(system);
    expect(fallbackBody.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: '你好' }] },
    ]);
    expect(onPromptCacheFallback).toHaveBeenCalledWith({
      model: 'gpt-5.6-sol',
      status: 400,
      errorCode: 'unknown_parameter',
      errorMessage: 'Unknown parameter: prompt_cache_key',
      requestId: 'req-cache-rejected',
    });
  });

  it('maps transport fetch failures to a retryable Chinese Codex error', async () => {
    const cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const provider = new LocalCodexResponsesProvider({
      resolveAuth: async () => ({ accessToken: 'secret-token', accountId: 'account-1' }),
      fetchImpl: vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause })),
    });

    const error = await collect(provider).then(
      () => {
        throw new Error('expected Codex transport failure');
      },
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({
      message: expect.stringMatching(/连接 ChatGPT Codex 失败.*ECONNRESET/),
      details: {
        networkError: true,
        stage: 'codex_responses_transport',
      },
    });
    expect(classifyError(error)).toMatchObject({
      category: 'network',
      userMessage: '网络连接不稳定，请检查网络后重试',
    });
  });

  it('guides the user to log in again after a 401 response', async () => {
    const provider = new LocalCodexResponsesProvider({
      resolveAuth: async () => ({ accessToken: 'secret-token', accountId: 'account-1' }),
      fetchImpl: vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 })),
    });

    await expect(collect(provider)).rejects.toThrow('请重新登录');
  });

  it('reports a readable Chinese message when Codex quota is exhausted', async () => {
    const provider = new LocalCodexResponsesProvider({
      resolveAuth: async () => ({ accessToken: 'secret-token', accountId: 'account-1' }),
      fetchImpl: vi.fn().mockResolvedValue(
        new Response('usage limit reached', { status: 429 }),
      ),
    });

    await expect(collect(provider)).rejects.toThrow('Codex 额度已用尽');
  });

  it('preserves safe structured diagnostics for a Codex stream internal error', async () => {
    const provider = new LocalCodexResponsesProvider({
      resolveAuth: async () => ({ accessToken: 'secret-token', accountId: 'account-1' }),
      fetchImpl: vi.fn().mockResolvedValue(sseResponse([{
        type: 'error',
        error: {
          type: 'server_error',
          code: 'internal_error',
          message: 'Internal server error',
        },
      }])),
    });

    const error = await collect(provider).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentError);
    expect(error).toMatchObject({
      code: 'LLM_ERROR',
      statusCode: 500,
      retryable: true,
      details: {
        stage: 'codex_responses_stream',
        error_type: 'server_error',
        provider_error_code: 'internal_error',
      },
    });
    expect(JSON.stringify((error as AgentError).details)).not.toContain('secret-token');
  });

  it('reads structured diagnostics from response.failed response.error', async () => {
    const provider = new LocalCodexResponsesProvider({
      resolveAuth: async () => ({ accessToken: 'secret-token', accountId: 'account-1' }),
      fetchImpl: vi.fn().mockResolvedValue(sseResponse([{
        type: 'response.failed',
        response: {
          error: {
            type: 'server_error',
            code: 'internal_error',
            message: 'Internal server error',
          },
        },
      }])),
    });

    const error = await collect(provider).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      statusCode: 500,
      retryable: true,
      details: {
        stage: 'codex_responses_stream',
        error_type: 'server_error',
        provider_error_code: 'internal_error',
      },
    });
    const classified = classifyError(error);
    expect(buildClassifiedTerminalErrorInfo({
      classified,
      errorClass: classified.code,
      errorMessage: classified.userMessage,
      partialReason: 'message_stop_fallback',
    })).toMatchObject({
      category: 'runtime_failed',
      suggested_action: 'retry_later',
      error_extras: {
        classified_category: 'server_error',
        error_type: 'server_error',
        provider_error_code: 'internal_error',
      },
    });
  });

  // ：UI BlockTimeline 只认 content_block_*；Codex 必须经 onContentBlockEvent 推块。
  it('emits content_block start/delta/stop via onContentBlockEvent for text deltas', async () => {
    const hints: ContentBlockEnvelopeHint[] = [];
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([
      { type: 'response.output_text.delta', delta: '你好，' },
      { type: 'response.output_text.delta', delta: '世界' },
      {
        type: 'response.completed',
        response: {
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      },
    ]));
    const provider = new LocalCodexResponsesProvider({
      resolveAuth: async () => ({ accessToken: 'secret-token', accountId: 'account-1' }),
      fetchImpl,
    });

    const chunks = [];
    for await (const chunk of provider.createStream({
      ...request,
      onContentBlockEvent: (hint) => hints.push(hint),
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { type: 'text_delta', text: '你好，' },
      { type: 'text_delta', text: '世界' },
      { type: 'usage', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
      { type: 'stop', stopReason: 'end_turn' },
    ]);
    expect(hints.map((h) => h.kind)).toEqual([
      ContentBlockEvents.CONTENT_BLOCK_START,
      ContentBlockEvents.CONTENT_BLOCK_DELTA,
      ContentBlockEvents.CONTENT_BLOCK_DELTA,
      ContentBlockEvents.CONTENT_BLOCK_STOP,
      ContentBlockEvents.MESSAGE_DELTA,
    ]);
    expect(hints[0]).toMatchObject({
      kind: ContentBlockEvents.CONTENT_BLOCK_START,
      index: 0,
      block: { type: 'text', text: '' },
    });
    expect(hints[1]).toMatchObject({
      kind: ContentBlockEvents.CONTENT_BLOCK_DELTA,
      index: 0,
      delta: { type: 'text_delta', text: '你好，' },
    });
    expect(hints[2]).toMatchObject({
      kind: ContentBlockEvents.CONTENT_BLOCK_DELTA,
      index: 0,
      delta: { type: 'text_delta', text: '世界' },
    });
    expect(hints[3]).toMatchObject({
      kind: ContentBlockEvents.CONTENT_BLOCK_STOP,
      index: 0,
    });
    expect(hints[4]).toMatchObject({
      kind: ContentBlockEvents.MESSAGE_DELTA,
      delta: { stop_reason: 'end_turn' },
    });
  });

  it('serializes image blocks as input_image and reasoning.effort from overrides', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([
      { type: 'response.output_text.delta', delta: '看到了' },
      {
        type: 'response.completed',
        response: { usage: { input_tokens: 20, output_tokens: 2, total_tokens: 22 } },
      },
    ]));
    const provider = new LocalCodexResponsesProvider({
      resolveAuth: async () => ({ accessToken: 'secret-token', accountId: 'account-1' }),
      fetchImpl,
      requestParamOverrides: { v: 2, thinking_mode: 'deep' },
    });

    const chunks = [];
    for await (const chunk of provider.createStream({
      model: 'gpt-5.6-sol',
      maxTokens: 512,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '这是什么' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
            detail: 'high',
          },
        ],
      }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks[0]).toEqual({ type: 'text_delta', text: '看到了' });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.reasoning).toEqual({ effort: 'high' });
    expect(body.input.at(-1)).toEqual({
      role: 'user',
      content: [
        { type: 'input_text', text: '这是什么' },
        {
          type: 'input_image',
          image_url: 'data:image/png;base64,AAAA',
          detail: 'high',
        },
      ],
    });
  });

  it('inlines remote http image URLs to data: before calling Codex (local-object / 407)', async () => {
    const localUrl = 'http://127.0.0.1:6060/api/services/oss/local-object?object_key=chat%2Fa.png';
    const resolveRemoteImageUrl = vi.fn().mockResolvedValue('data:image/png;base64,BBBB');
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([
      { type: 'response.output_text.delta', delta: '这是一张图' },
      {
        type: 'response.completed',
        response: { usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } },
      },
    ]));
    const provider = new LocalCodexResponsesProvider({
      resolveAuth: async () => ({ accessToken: 'secret-token', accountId: 'account-1' }),
      fetchImpl,
      resolveRemoteImageUrl,
    });

    for await (const _chunk of provider.createStream({
      model: 'gpt-5.6-sol',
      maxTokens: 512,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '这个是谁' },
          { type: 'image', source: { type: 'url', url: localUrl }, detail: 'auto' },
        ],
      }],
    })) {
      // drain
    }

    expect(resolveRemoteImageUrl).toHaveBeenCalledWith(localUrl);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.input.at(-1)).toEqual({
      role: 'user',
      content: [
        { type: 'input_text', text: '这个是谁' },
        {
          type: 'input_image',
          image_url: 'data:image/png;base64,BBBB',
          detail: 'auto',
        },
      ],
    });
    // Codex POST 不应再携带本机 URL，避免上游 407
    expect(JSON.stringify(body)).not.toContain('127.0.0.1');
  });

  it('maps thinking_mode / reasoning_effort independently of Fast service_tier', () => {
    expect(resolveReasoningEffort({ thinking_mode: 'off' })).toBe('none');
    expect(resolveReasoningEffort({ thinking_mode: 'standard' })).toBe('medium');
    expect(resolveReasoningEffort({ reasoning_effort: 'low' })).toBe('low');
    expect(resolveReasoningEffort({ reasoning_effort: 'xhigh' })).toBe('xhigh');
    expect(resolveReasoningEffort({ reasoning_effort: 'max' })).toBe('max');
    expect(resolveReasoningEffort(undefined)).toBeUndefined();
    // ChatGPT Codex wire 值是 priority；fast 只是本地/UI 别名
    expect(resolveServiceTier({ service_tier: 'fast' })).toBe('priority');
    expect(resolveServiceTier({ service_tier: 'priority' })).toBe('priority');
    expect(resolveServiceTier({ service_tier: 'default' })).toBeUndefined();
    expect(resolveServiceTier({ reasoning_effort: 'none' })).toBeUndefined();
  });

  it('serializes Fast as service_tier=priority alongside reasoning.effort', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([
      { type: 'response.output_text.delta', delta: 'ok' },
      {
        type: 'response.completed',
        response: { usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } },
      },
    ]));
    const provider = new LocalCodexResponsesProvider({
      resolveAuth: async () => ({ accessToken: 'secret-token', accountId: 'account-1' }),
      fetchImpl,
      requestParamOverrides: { reasoning_effort: 'medium', service_tier: 'fast' },
    });

    for await (const _chunk of provider.createStream({
      model: 'gpt-5.6-sol',
      maxTokens: 128,
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      // drain
    }

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.reasoning).toEqual({ effort: 'medium' });
    expect(body.service_tier).toBe('priority');
  });

  it('emits tool_use content_block envelope before closing the stream', async () => {
    const hints: ContentBlockEnvelopeHint[] = [];
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([
      {
        type: 'response.function_call_arguments.done',
        call_id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"a.txt"}',
      },
      {
        type: 'response.completed',
        response: { usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } },
      },
    ]));
    const provider = new LocalCodexResponsesProvider({
      resolveAuth: async () => ({ accessToken: 'secret-token', accountId: 'account-1' }),
      fetchImpl,
    });

    const chunks = [];
    for await (const chunk of provider.createStream({
      ...request,
      onContentBlockEvent: (hint) => hints.push(hint),
    })) {
      chunks.push(chunk);
    }

    expect(chunks[0]).toEqual({
      type: 'tool_use',
      toolUse: { id: 'call_1', name: 'read_file', input: { path: 'a.txt' } },
    });
    expect(chunks.at(-1)).toEqual({ type: 'stop', stopReason: 'tool_use' });
    expect(hints.map((h) => h.kind)).toEqual([
      ContentBlockEvents.CONTENT_BLOCK_START,
      ContentBlockEvents.CONTENT_BLOCK_STOP,
      ContentBlockEvents.MESSAGE_DELTA,
    ]);
    expect(hints[0]).toMatchObject({
      kind: ContentBlockEvents.CONTENT_BLOCK_START,
      index: 0,
      block: {
        type: 'tool_use',
        id: 'call_1',
        name: 'read_file',
        input: { path: 'a.txt' },
      },
    });
  });
});
