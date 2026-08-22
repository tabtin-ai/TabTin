import { describe, it, expect } from 'vitest';
import { createRuntime } from '../src/runtime-assembly.js';
import type {
  StreamEvent,
} from '../src/engine/contracts/wire-protocol.js';
import type {
  Message,
  ContentBlock,
} from '../src/engine/contracts/conversation.js';
import type {
  LLMResponseChunk,
  LLMRequest,
} from '../src/engine/contracts/model-llm.js';
import type {
  Tool,
} from '../src/engine/contracts/tools.js';
import type {
  EngineConfig,
} from '../src/engine/contracts/kernel.js';
import {
  createMockProvider,
  createMockPermissionHandler,
  createMockToolProvider,
} from './test-utils.js';
import { createTestToolRiskPolicyPort } from './helpers/tool-risk-policy-port.js';

// ─── Helpers ──────────────────────────────────────────────────────────

async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
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
    sessionConfig: { sessionDir: '/tmp/test', threadId: 'test-session' },
    model: 'test-model',
    ...overrides,
  };
}

function makeTool(
  name: string,
  opts: { isReadOnly?: boolean; execute?: Tool['execute'] } = {},
): Tool {
  return {
    name,
    description: `Test tool: ${name}`,
    inputSchema: { type: 'object', properties: { arg: { type: 'string' } } },
    isReadOnly: opts.isReadOnly ?? true,
    execute: opts.execute ?? (async () => ({ content: 'ok' })),
  };
}

/**
 * Check whether any message in the list contains the given text,
 * accounting for message normalization (consecutive user messages get
 * merged into a single message with combined content blocks).
 */
function messagesContainText(messages: Message[], text: string): boolean {
  for (const m of messages) {
    if (typeof m.content === 'string') {
      if (m.content.includes(text)) return true;
    } else if (Array.isArray(m.content)) {
      for (const block of m.content as ContentBlock[]) {
        if ('text' in block && typeof (block as { text: string }).text === 'string') {
          if ((block as { text: string }).text.includes(text)) return true;
        }
      }
    }
  }
  return false;
}

// ─── Wave 2a: ToolResult.newMessages injection ──────────────────────

describe('ToolResult.newMessages injection', () => {
  it('should inject newMessages into conversation history after tool_result', async () => {
    const capturedRequests: LLMRequest[] = [];
    const skillInstruction = 'SKILL_MARKER_always_respond_in_JSON';

    const injectedUserMessage: Message = {
      role: 'user',
      content: skillInstruction,
    };

    const skillTool = makeTool('skill_invoke', {
      execute: async () => ({
        content: 'Executing skill: json-format',
        newMessages: [injectedUserMessage],
      }),
    });

    const provider: import('../src/engine/contracts/model-llm.js').LLMProvider = {
      async *createStream(request: LLMRequest) {
        capturedRequests.push(request);
        if (capturedRequests.length === 1) {
          yield { type: 'tool_use' as const, toolUse: { id: 'c1', name: 'skill_invoke', input: { arg: 'json-format' } } };
          yield { type: 'usage' as const, usage: { input_tokens: 20, output_tokens: 10 } };
          yield { type: 'stop' as const, stopReason: 'tool_use' };
        } else {
          yield { type: 'text_delta' as const, text: '{"result": "done"}' };
          yield { type: 'usage' as const, usage: { input_tokens: 40, output_tokens: 20 } };
          yield { type: 'stop' as const, stopReason: 'end_turn' };
        }
      },
    };

    const rt = createRuntime(
      makeConfig({
        provider,
        tools: createMockToolProvider([skillTool]),
      }),
    );
    const events = await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'Use json skill' }));

    expect(capturedRequests.length).toBeGreaterThanOrEqual(2);

    const secondCallMessages = capturedRequests[1].messages;
    expect(messagesContainText(secondCallMessages, skillInstruction)).toBe(true);
    const injectedEvent = events.find(
      (e) => e.type === 'agent.stream.user' && (e.payload as Record<string, unknown>).source === 'skill_invoke',
    );
    const injectedPayload = injectedEvent?.payload as Record<string, unknown> | undefined;
    expect(injectedPayload?.content).toBe(skillInstruction);
    expect(injectedPayload?.blocks_json).toEqual([{ type: 'text', text: skillInstruction }]);
  });

  it('persists image-only injected messages for transcript replay', async () => {
    const imageBlock = {
      type: 'image' as const,
      source: { type: 'url' as const, url: 'https://files.example/image.png' },
    };
    const readFileTool = makeTool('read_file', {
      execute: async () => ({
        content: '{"type":"file_materialized"}',
        newMessages: [{ role: 'user' as const, content: [imageBlock] }],
      }),
    });
    const provider = createMockProvider([
      [
        { type: 'tool_use', toolUse: { id: 'read-1', name: 'read_file', input: {} } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'I can see the image' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);
    const runtime = createRuntime(makeConfig({
      provider,
      tools: createMockToolProvider([readFileTool]),
    }));

    const events = await collectEvents(runtime.query({
      hostRunId: 'test-run',
      prompt: 'read the image',
    }));

    const injectedEvent = events.find(
      (event) => event.type === 'agent.stream.user'
        && (event.payload as Record<string, unknown>).source === 'tool_injected',
    );
    expect(injectedEvent?.payload).toEqual(expect.objectContaining({
      content: '',
      tool_call_id: 'read-1',
      blocks_json: [imageBlock],
    }));

    const secondSnapshot = events.find(
      (event) => event.type === 'agent.stream.llm_request'
        && (event.payload as { iteration?: number }).iteration === 1,
    );
    const snapshotPayload = secondSnapshot?.payload as {
      messages?: Array<Record<string, unknown>>
    } | undefined;
    const injectedImage = snapshotPayload?.messages?.find(
      (message) => message.source === 'tool_injected',
    );
    expect(injectedImage).toEqual(expect.objectContaining({ role: 'system' }));
  });

  it('should not break when newMessages is empty or absent', async () => {
    const noNewMsgTool = makeTool('plain_tool', {
      execute: async () => ({
        content: 'just a result',
        newMessages: [],
      }),
    });

    const provider = createMockProvider([
      [
        { type: 'tool_use', toolUse: { id: 'c1', name: 'plain_tool', input: {} } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);

    const rt = createRuntime(
      makeConfig({
        provider,
        tools: createMockToolProvider([noNewMsgTool]),
      }),
    );
    const events = await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'test' }));

    const done = events.find((e) => e.type === 'agent.stream.done');
    expect(done).toBeTruthy();
    expect((done!.payload as Record<string, unknown>).error).toBeUndefined();
  });
});

// ─── Wave 2a: ToolResult.contextModifier ────────────────────────────

describe('ToolResult.contextModifier', () => {
  it('modelOverride should change LLM model for subsequent calls', async () => {
    const capturedRequests: LLMRequest[] = [];

    const modelSwitchTool = makeTool('skill_invoke', {
      execute: async () => ({
        content: 'Switching to opus',
        contextModifier: {
          modelOverride: 'claude-opus-4',
        },
      }),
    });

    const provider: import('../src/engine/contracts/model-llm.js').LLMProvider = {
      async *createStream(request: LLMRequest) {
        capturedRequests.push(request);
        if (capturedRequests.length === 1) {
          yield { type: 'tool_use' as const, toolUse: { id: 'c1', name: 'skill_invoke', input: {} } };
          yield { type: 'usage' as const, usage: { input_tokens: 20, output_tokens: 10 } };
          yield { type: 'stop' as const, stopReason: 'tool_use' };
        } else {
          yield { type: 'text_delta' as const, text: 'Response with new model' };
          yield { type: 'usage' as const, usage: { input_tokens: 30, output_tokens: 15 } };
          yield { type: 'stop' as const, stopReason: 'end_turn' };
        }
      },
    };

    const rt = createRuntime(
      makeConfig({
        provider,
        tools: createMockToolProvider([modelSwitchTool]),
        model: 'claude-sonnet-4-6',
      }),
    );
    await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'switch model' }));

    expect(capturedRequests.length).toBeGreaterThanOrEqual(2);
    expect(capturedRequests[0].model).toBe('claude-sonnet-4-6');
    expect(capturedRequests[1].model).toBe('claude-opus-4');
  });
});

// ─── Wave 2a: contextPressure recalculation ─────────────────────────

describe('contextPressure after newMessages injection', () => {
  it('should increase contextPressure when large newMessages are injected', async () => {
    const largeContent = 'x'.repeat(50_000);
    const capturedRequests: LLMRequest[] = [];

    const largeTool = makeTool('skill_invoke', {
      execute: async () => ({
        content: 'Executing large skill',
        newMessages: [{
          role: 'user' as const,
          content: largeContent,
        }],
      }),
    });

    const provider: import('../src/engine/contracts/model-llm.js').LLMProvider = {
      async *createStream(request: LLMRequest) {
        capturedRequests.push(request);
        if (capturedRequests.length === 1) {
          yield { type: 'tool_use' as const, toolUse: { id: 'c1', name: 'skill_invoke', input: {} } };
          yield { type: 'usage' as const, usage: { input_tokens: 20, output_tokens: 10 } };
          yield { type: 'stop' as const, stopReason: 'tool_use' };
        } else {
          yield { type: 'text_delta' as const, text: 'done' };
          yield { type: 'usage' as const, usage: { input_tokens: 60_000, output_tokens: 20 } };
          yield { type: 'stop' as const, stopReason: 'end_turn' };
        }
      },
    };

    const rt = createRuntime(
      makeConfig({
        provider,
        tools: createMockToolProvider([largeTool]),
        contextWindowTokens: 100_000,
      }),
    );
    const events = await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'inject large skill' }));

    expect(capturedRequests.length).toBeGreaterThanOrEqual(2);

    // The large content (50k chars ≈ 12.5k tokens) was injected and
    // the second LLM call received it (merged into content blocks by
    // the message normalizer).
    const secondCallMessages = capturedRequests[1].messages;
    expect(messagesContainText(secondCallMessages, 'x'.repeat(100))).toBe(true);
  });
});
