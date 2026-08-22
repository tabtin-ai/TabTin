/**
 * FR-04 — Per-message size safeguard (OOM backstop).
 *
 * `query.ts` enforces `EngineConfig.maxMessageChars` (default
 * 1_000_000) before every `llmRequest` build by hard-truncating any
 * message whose content exceeds the budget and emitting a
 * `SystemNoticeEvent` with `notice_type: 'message_truncated'`.
 *
 * Existing per-tool / per-block limits (MAX_TOOL_RESULT_CHARS=10k,
 * enforceToolOutputBudget=150k, etc.) still apply — this test suite
 * only exercises the new global safety net.
 */

import { describe, it, expect } from 'vitest';
import { createRuntime } from '../src/runtime-assembly.js';
import {
  createMockProvider,
  createMockPermissionHandler,
  createMockToolProvider,
} from './test-utils.js';
import type {
  StreamEvent,
} from '../src/engine/contracts/wire-protocol.js';
import type {
  ContentBlock,
  Message,
} from '../src/engine/contracts/conversation.js';
import type {
  LLMRequest,
  LLMProvider,
  LLMResponseChunk,
} from '../src/engine/contracts/model-llm.js';
import type {
  EngineConfig,
} from '../src/engine/contracts/kernel.js';

async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

function makeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    provider: createMockProvider(),
    tools: createMockToolProvider(),
    permissionHandler: createMockPermissionHandler(),
    sessionConfig: { sessionDir: '/tmp/test', threadId: 'test-session' },
    model: 'test-model',
    ...overrides,
  };
}

/**
 * Capture the first `llmRequest.messages` the engine submits. Useful to
 * verify that truncation actually took effect on the payload sent to
 * the LLM (not just the event log).
 */
function captureRequestProvider(
  response: LLMResponseChunk[],
  sink: { request?: LLMRequest },
): LLMProvider {
  return {
    async *createStream(request: LLMRequest) {
      if (!sink.request) sink.request = request;
      for (const chunk of response) yield chunk;
    },
  };
}

function messageCharLength(content: Message['content']): number {
  if (typeof content === 'string') return content.length;
  let total = 0;
  for (const block of content) {
    switch (block.type) {
      case 'text':
        total += block.text.length;
        break;
      case 'thinking':
        total += block.thinking.length;
        break;
      case 'tool_use':
        total += JSON.stringify(block.input ?? '').length;
        break;
      case 'tool_result':
        if (typeof block.content === 'string') total += block.content.length;
        else total += messageCharLength(block.content);
        break;
      case 'image':
        total +=
          block.source.type === 'base64'
            ? block.source.data.length
            : block.source.url?.length ?? 0;
        break;
    }
  }
  return total;
}

// ─── typical scenarios ──────────────────────────────────────────────

describe('FR-04 — per-message size budget', () => {
  it('hard-truncates a string-content message that exceeds maxMessageChars', async () => {
    const sink: { request?: LLMRequest } = {};
    const provider = captureRequestProvider(
      [
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
      sink,
    );
    const MAX = 1_000;
    const huge = 'x'.repeat(MAX * 5); // 5_000 chars
    const initialMessages: Message[] = [{ role: 'user', content: huge }];

    const rt = createRuntime(makeConfig({ provider, maxMessageChars: MAX }));
    const events = await collectEvents(
      rt.query({ hostRunId: 'test-run', prompt: 'ignored', initialMessages }),
    );

    const notices = events.filter(
      (e) =>
        e.type === 'agent.stream.system_notice' &&
        (e.payload as Record<string, unknown>).notice_type === 'message_truncated',
    );
    expect(notices).toHaveLength(1);
    const payload = notices[0]!.payload as Record<string, unknown>;
    expect(payload.message_index).toBe(0);
    expect(payload.original_length).toBe(huge.length);
    expect(payload.max_chars).toBe(MAX);
    expect(payload.new_length).toBeLessThan(huge.length);

    // The actual request seen by the provider uses the truncated message
    const seen = sink.request!.messages[0]!;
    const seenLen = messageCharLength(seen.content);
    expect(seenLen).toBeLessThanOrEqual(MAX);
    // And the retained text shows our marker
    expect(String(seen.content)).toContain('[... truncated');
  });

  it('shrinks the largest compressible block inside ContentBlock[] but keeps tool_use id intact', async () => {
    const sink: { request?: LLMRequest } = {};
    const provider = captureRequestProvider(
      [
        { type: 'text_delta', text: 'done' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
      sink,
    );
    const MAX = 2_000;
    const bigResult = 'y'.repeat(MAX * 4);
    const content: ContentBlock[] = [
      { type: 'tool_result', tool_use_id: 'call-42', content: bigResult },
      { type: 'text', text: 'short text' },
    ];
    const initialMessages: Message[] = [
      { role: 'user', content: 'run noop' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call-42', name: 'noop', input: {} }],
      },
      { role: 'user', content },
    ];

    // Keep the shape structurally valid so the final pairing gate is a
    // no-op. We still disable broad normalization to isolate the
    // FR-04 size-budget shrink path on the `tool_result` block itself.
    const rt = createRuntime(
      makeConfig({ provider, maxMessageChars: MAX, normalizationLevel: 'off' }),
    );
    const events = await collectEvents(
      rt.query({ hostRunId: 'test-run', prompt: 'ignored', initialMessages }),
    );

    const notices = events.filter(
      (e) =>
        e.type === 'agent.stream.system_notice' &&
        (e.payload as Record<string, unknown>).notice_type === 'message_truncated',
    );
    expect(notices).toHaveLength(1);

    const seen = sink.request!.messages.find(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some(
          (block) => block.type === 'tool_result' && block.tool_use_id === 'call-42',
        ),
    );
    expect(seen).toBeDefined();
    expect(Array.isArray(seen!.content)).toBe(true);
    const blocks = seen!.content as ContentBlock[];

    // tool_use_id preserved so the LLM can still pair tool_use / tool_result
    const tr = blocks.find((b) => b.type === 'tool_result');
    expect(tr).toBeDefined();
    expect((tr as { tool_use_id: string }).tool_use_id).toBe('call-42');
    expect(
      typeof (tr as { content: string | ContentBlock[] }).content === 'string' &&
        ((tr as { content: string }).content.length < bigResult.length),
    ).toBe(true);

    // Sibling text block left untouched
    const text = blocks.find((b) => b.type === 'text');
    expect((text as { text: string }).text).toBe('short text');

    const totalLen = messageCharLength(blocks);
    // Budget allows some slack because marker + tail chars; just ensure well below original
    expect(totalLen).toBeLessThan(bigResult.length);
    expect(totalLen).toBeLessThanOrEqual(MAX);
  });

  it('emits one notice per truncated message when multiple messages exceed the limit', async () => {
    const sink: { request?: LLMRequest } = {};
    const provider = captureRequestProvider(
      [
        { type: 'text_delta', text: 'done' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
      sink,
    );
    const MAX = 500;
    const a = 'a'.repeat(MAX * 3);
    const b = 'b'.repeat(MAX * 4);
    const initialMessages: Message[] = [
      { role: 'user', content: a },
      { role: 'assistant', content: b },
    ];

    const rt = createRuntime(makeConfig({ provider, maxMessageChars: MAX }));
    const events = await collectEvents(
      rt.query({ hostRunId: 'test-run', prompt: 'ignored', initialMessages }),
    );

    const notices = events.filter(
      (e) =>
        e.type === 'agent.stream.system_notice' &&
        (e.payload as Record<string, unknown>).notice_type === 'message_truncated',
    );
    expect(notices).toHaveLength(2);
    const indices = notices
      .map((n) => (n.payload as Record<string, unknown>).message_index)
      .sort();
    expect(indices).toEqual([0, 1]);
  });

  it('respects maxMessageChars override vs the 1_000_000 default', async () => {
    const sink1: { request?: LLMRequest } = {};
    const sink2: { request?: LLMRequest } = {};
    const mkProvider = (sink: { request?: LLMRequest }): LLMProvider =>
      captureRequestProvider(
        [
          { type: 'text_delta', text: 'ok' },
          { type: 'stop', stopReason: 'end_turn' },
        ],
        sink,
      );

    const content = 'z'.repeat(2_000);
    const initialMessages: Message[] = [{ role: 'user', content }];

    // Default = 1_000_000 — 2k message should not trigger
    const rtDefault = createRuntime(makeConfig({ provider: mkProvider(sink1) }));
    const eventsDefault = await collectEvents(
      rtDefault.query({ hostRunId: 'test-run', prompt: 'ignored', initialMessages }),
    );
    expect(
      eventsDefault.filter(
        (e) =>
          e.type === 'agent.stream.system_notice' &&
          (e.payload as Record<string, unknown>).notice_type === 'message_truncated',
      ),
    ).toHaveLength(0);

    // Override = 1_000 — 2k message triggers truncation
    const rtOverride = createRuntime(
      makeConfig({ provider: mkProvider(sink2), maxMessageChars: 1_000 }),
    );
    const eventsOverride = await collectEvents(
      rtOverride.query({ hostRunId: 'test-run', prompt: 'ignored', initialMessages }),
    );
    expect(
      eventsOverride.filter(
        (e) =>
          e.type === 'agent.stream.system_notice' &&
          (e.payload as Record<string, unknown>).notice_type === 'message_truncated',
      ),
    ).toHaveLength(1);
  });

  it('does not emit a notice when all messages are under the budget (backward compatible)', async () => {
    const sink: { request?: LLMRequest } = {};
    const provider = captureRequestProvider(
      [
        { type: 'text_delta', text: 'hi' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
      sink,
    );
    const rt = createRuntime(
      makeConfig({ provider, maxMessageChars: 1_000 }),
    );
    const events = await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'normal' }));
    expect(
      events.filter(
        (e) =>
          e.type === 'agent.stream.system_notice' &&
          (e.payload as Record<string, unknown>).notice_type === 'message_truncated',
      ),
    ).toHaveLength(0);
  });

  it('survives extreme sizes (10 MB string) — truncates without OOM', async () => {
    const sink: { request?: LLMRequest } = {};
    const provider = captureRequestProvider(
      [
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
      sink,
    );
    const MAX = 100_000; // 100k chars budget
    const huge = 'x'.repeat(10_000_000); // 10 MB string
    const initialMessages: Message[] = [{ role: 'user', content: huge }];

    const rt = createRuntime(makeConfig({ provider, maxMessageChars: MAX }));
    const events = await collectEvents(
      rt.query({ hostRunId: 'test-run', prompt: 'ignored', initialMessages }),
    );

    const notices = events.filter(
      (e) =>
        e.type === 'agent.stream.system_notice' &&
        (e.payload as Record<string, unknown>).notice_type === 'message_truncated',
    );
    expect(notices).toHaveLength(1);
    const payload = notices[0]!.payload as Record<string, unknown>;
    expect(payload.original_length).toBe(huge.length);
    expect(payload.new_length).toBeLessThanOrEqual(MAX);

    // Actual payload to provider should be ≤ MAX
    const seen = sink.request!.messages[0]!;
    expect(messageCharLength(seen.content)).toBeLessThanOrEqual(MAX);
  });

  it('leaves tool_use-only messages alone (input JSON is not compressed to preserve schema)', async () => {
    const sink: { request?: LLMRequest } = {};
    const provider = captureRequestProvider(
      [
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
      sink,
    );
    const MAX = 1_000;
    const content: ContentBlock[] = [
      {
        type: 'tool_use',
        id: 'call-99',
        name: 'noop',
        input: { blob: 'q'.repeat(5_000) },
      },
    ];
    const initialMessages: Message[] = [{ role: 'user', content }];

    const rt = createRuntime(makeConfig({ provider, maxMessageChars: MAX }));
    const events = await collectEvents(
      rt.query({ hostRunId: 'test-run', prompt: 'ignored', initialMessages }),
    );
    expect(
      events.filter(
        (e) =>
          e.type === 'agent.stream.system_notice' &&
          (e.payload as Record<string, unknown>).notice_type === 'message_truncated',
      ),
    ).toHaveLength(0);
  });

  it('leaves base64 ImageBlock-only messages alone (breaking base64 would corrupt the image)', async () => {
    const sink: { request?: LLMRequest } = {};
    const provider = captureRequestProvider(
      [
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
      sink,
    );
    const MAX = 10_000;
    // A real base64 payload far over the per-message ceiling.
    const base64 = 'A'.repeat(50_000);
    const content: ContentBlock[] = [
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: base64 },
        detail: 'auto',
      },
    ];
    const initialMessages: Message[] = [{ role: 'user', content }];

    const rt = createRuntime(makeConfig({ provider, maxMessageChars: MAX }));
    const events = await collectEvents(
      rt.query({ hostRunId: 'test-run', prompt: 'ignored', initialMessages }),
    );

    // No misleading "truncated" notice — we intentionally leave base64
    // image bytes intact.
    expect(
      events.filter(
        (e) =>
          e.type === 'agent.stream.system_notice' &&
          (e.payload as Record<string, unknown>).notice_type === 'message_truncated',
      ),
    ).toHaveLength(0);

    // Verify the payload actually hit the provider unchanged.
    const seen = sink.request!.messages[0]!;
    expect(Array.isArray(seen.content)).toBe(true);
    const first = (seen.content as ContentBlock[])[0]!;
    expect(first.type).toBe('image');
    const image = first as Extract<ContentBlock, { type: 'image' }>;
    expect(image.source.type).toBe('base64');
    expect((image.source as { data: string }).data).toBe(base64);
  });

  it('normalises a non-positive maxMessageChars to the default ceiling (still protects)', async () => {
    const sink: { request?: LLMRequest } = {};
    const provider = captureRequestProvider(
      [
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
      sink,
    );
    // maxMessageChars = 0 would otherwise disable the whole FR-04 path
    // and silently accept unbounded inputs. The query engine
    // renormalises to 1_000_000.
    const huge = 'y'.repeat(1_200_000);
    const initialMessages: Message[] = [{ role: 'user', content: huge }];

    const rt = createRuntime(
      makeConfig({ provider, maxMessageChars: 0 }),
    );
    const events = await collectEvents(
      rt.query({ hostRunId: 'test-run', prompt: 'ignored', initialMessages }),
    );

    const notices = events.filter(
      (e) =>
        e.type === 'agent.stream.system_notice' &&
        (e.payload as Record<string, unknown>).notice_type === 'message_truncated',
    );
    expect(notices).toHaveLength(1);
    const payload = notices[0]!.payload as Record<string, unknown>;
    // Reports the *effective* ceiling (the default), not the invalid 0.
    expect(payload.max_chars).toBe(1_000_000);
    expect(payload.original_length).toBe(huge.length);
  });

  it('caps the final message length to maxMessageChars even when every block is similarly-sized', async () => {
    // Regression for the MAX_ROUNDS=32 edge case: many similarly-sized
    // compressible blocks caused each round to only shrink "the largest",
    // so total remained over the cap. The proportional-shrink fallback
    // guarantees we land below maxChars.
    const sink: { request?: LLMRequest } = {};
    const provider = captureRequestProvider(
      [
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
      sink,
    );
    const MAX = 5_000;
    const blockSize = 10_000;
    const blocks: ContentBlock[] = [];
    for (let i = 0; i < 40; i++) {
      blocks.push({ type: 'text', text: 'x'.repeat(blockSize) });
    }
    const initialMessages: Message[] = [{ role: 'user', content: blocks }];

    const rt = createRuntime(makeConfig({ provider, maxMessageChars: MAX }));
    const events = await collectEvents(
      rt.query({ hostRunId: 'test-run', prompt: 'ignored', initialMessages }),
    );

    const notices = events.filter(
      (e) =>
        e.type === 'agent.stream.system_notice' &&
        (e.payload as Record<string, unknown>).notice_type === 'message_truncated',
    );
    expect(notices).toHaveLength(1);
    const payload = notices[0]!.payload as Record<string, unknown>;
    expect(payload.new_length).toBeLessThanOrEqual(MAX);

    const seen = sink.request!.messages[0]!;
    // Double-check via direct measurement on the provider-side payload.
    expect(
      Array.isArray(seen.content)
        ? (seen.content as ContentBlock[]).reduce(
            (acc, b) => acc + (b.type === 'text' ? (b as { text: string }).text.length : 0),
            0,
          )
        : (seen.content as string).length,
    ).toBeLessThanOrEqual(MAX);
  });

  it('handles extreme-small budgets (maxMessageChars < 100) via head-only truncation', async () => {
    // When the configured ceiling is so small that there is no room for
    // the "[... truncated N chars ...]" marker, `truncateLongString`
    // falls back to a plain head slice. The result must still respect
    // the hard cap.
    const sink: { request?: LLMRequest } = {};
    const provider = captureRequestProvider(
      [
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
      sink,
    );
    const MAX = 80;
    const huge = 'w'.repeat(500);
    const initialMessages: Message[] = [{ role: 'user', content: huge }];

    const rt = createRuntime(makeConfig({ provider, maxMessageChars: MAX }));
    const events = await collectEvents(
      rt.query({ hostRunId: 'test-run', prompt: 'ignored', initialMessages }),
    );

    const notices = events.filter(
      (e) =>
        e.type === 'agent.stream.system_notice' &&
        (e.payload as Record<string, unknown>).notice_type === 'message_truncated',
    );
    expect(notices).toHaveLength(1);
    const seen = sink.request!.messages[0]!;
    const seenLen = messageCharLength(seen.content);
    expect(seenLen).toBeLessThanOrEqual(MAX);
    // Head-only slice — no marker text present
    expect(String(seen.content)).not.toContain('[... truncated');
  });

  it('emits user-friendly copy (no raw 0-based "Message #0")', async () => {
    const sink: { request?: LLMRequest } = {};
    const provider = captureRequestProvider(
      [
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
      sink,
    );
    const MAX = 500;
    const huge = 'z'.repeat(5_000);
    const initialMessages: Message[] = [{ role: 'user', content: huge }];

    const rt = createRuntime(makeConfig({ provider, maxMessageChars: MAX }));
    const events = await collectEvents(
      rt.query({ hostRunId: 'test-run', prompt: 'ignored', initialMessages }),
    );

    const notice = events.find(
      (e) =>
        e.type === 'agent.stream.system_notice' &&
        (e.payload as Record<string, unknown>).notice_type === 'message_truncated',
    )!;
    const content = String((notice.payload as Record<string, unknown>).content);
    expect(content).not.toMatch(/Message\s+#\d/);
    expect(content.toLowerCase()).toContain('conversation message');
  });
});

// ─── H1-E telemetry：message.truncated 事件 ─────────────────────────

describe('FR-04 + H1-E — message.truncated telemetry', () => {
  it('truncation 发生时 emit message.truncated，payload 不含消息内容', async () => {
    const { setTelemetrySink, resetTelemetrySink, TelemetryEvents } =
      await import('../src/telemetry/index.js');
    const records: Array<{ event_name: string; payload: Record<string, unknown>; session_id?: string }> = [];
    setTelemetrySink((r) => {
      records.push({
        event_name: r.event_name,
        payload: r.payload,
        ...(r.session_id ? { session_id: r.session_id } : {}),
      });
    });

    try {
      const provider = createMockProvider([
        [
          { type: 'text_delta', text: 'ok' },
          { type: 'stop', stopReason: 'end_turn' },
        ],
      ]);
      const MAX = 500;
      const secret = 'SECRET_CONTENT_' + 'x'.repeat(5_000);
      const initialMessages: Message[] = [{ role: 'user', content: secret }];

      const rt = createRuntime(makeConfig({ provider, maxMessageChars: MAX }));
      await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'ignored', initialMessages }));

      const matched = records.filter((r) => r.event_name === TelemetryEvents.MESSAGE_TRUNCATED);
      expect(matched).toHaveLength(1);
      const r = matched[0]!;

      // 必有字段
      expect(r.payload.message_index).toBe(0);
      expect(r.payload.original_length).toBe(secret.length);
      expect(r.payload.new_length).toBeLessThan(secret.length);
      expect(r.payload.max_chars).toBe(MAX);
      expect(typeof r.payload.iteration).toBe('number');
      // session_id 应被透传
      expect(r.session_id).toBeDefined();

      // **脱敏铁证**：原文中的 SECRET_CONTENT_ 绝不出现在 payload JSON
      expect(JSON.stringify(r)).not.toContain('SECRET_CONTENT_');
    } finally {
      resetTelemetrySink();
    }
  });
});

// ─── FR-04 Review 补强：oversized-incompressible 兜底告警 ────────────

describe('FR-04 — message_oversized_incompressible notice', () => {
  it('emits an oversized_incompressible notice when a tool_use-only message cannot shrink', async () => {
    const sink: { request?: LLMRequest } = {};
    const provider = captureRequestProvider(
      [
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
      sink,
    );
    const MAX = 500;
    const content: ContentBlock[] = [
      {
        type: 'tool_use',
        id: 'call-big',
        name: 'noop',
        input: { blob: 'q'.repeat(5_000) },
      },
    ];
    const initialMessages: Message[] = [{ role: 'user', content }];

    const rt = createRuntime(makeConfig({ provider, maxMessageChars: MAX }));
    const events = await collectEvents(
      rt.query({ hostRunId: 'test-run', prompt: 'ignored', initialMessages }),
    );

    // No misleading "truncated" notice — it would be a lie since nothing
    // was actually trimmed.
    expect(
      events.filter(
        (e) =>
          e.type === 'agent.stream.system_notice' &&
          (e.payload as Record<string, unknown>).notice_type === 'message_truncated',
      ),
    ).toHaveLength(0);

    // But the observer must know OOM backstop leaked through.
    const incompress = events.filter(
      (e) =>
        e.type === 'agent.stream.system_notice' &&
        (e.payload as Record<string, unknown>).notice_type ===
          'message_oversized_incompressible',
    );
    expect(incompress).toHaveLength(1);
    const payload = incompress[0]!.payload as Record<string, unknown>;
    expect(payload.message_index).toBe(0);
    expect(payload.max_chars).toBe(MAX);
    expect(payload.reason).toBe('tool_use');
    expect(typeof payload.original_length).toBe('number');
    expect(payload.original_length).toBeGreaterThan(MAX);
    expect(String(payload.content).toLowerCase()).toContain('cannot be safely truncated');
  });

  it('emits an oversized_incompressible notice for base64 image-only messages', async () => {
    const sink: { request?: LLMRequest } = {};
    const provider = captureRequestProvider(
      [
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
      sink,
    );
    const MAX = 10_000;
    const base64 = 'A'.repeat(50_000);
    const content: ContentBlock[] = [
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: base64 },
        detail: 'auto',
      },
    ];
    const initialMessages: Message[] = [{ role: 'user', content }];

    const rt = createRuntime(makeConfig({ provider, maxMessageChars: MAX }));
    const events = await collectEvents(
      rt.query({ hostRunId: 'test-run', prompt: 'ignored', initialMessages }),
    );

    const incompress = events.filter(
      (e) =>
        e.type === 'agent.stream.system_notice' &&
        (e.payload as Record<string, unknown>).notice_type ===
          'message_oversized_incompressible',
    );
    expect(incompress).toHaveLength(1);
    expect((incompress[0]!.payload as Record<string, unknown>).reason).toBe('image');

    // Image bytes untouched (structural fidelity preserved)
    const seen = sink.request!.messages[0]!;
    const first = (seen.content as ContentBlock[])[0]! as Extract<
      ContentBlock,
      { type: 'image' }
    >;
    expect((first.source as { data: string }).data).toBe(base64);
  });

  it('telemetry carries outcome=incompressible + reason for the dashboard', async () => {
    const { setTelemetrySink, resetTelemetrySink, TelemetryEvents } =
      await import('../src/telemetry/index.js');
    const records: Array<{ event_name: string; payload: Record<string, unknown> }> = [];
    setTelemetrySink((r) => {
      records.push({ event_name: r.event_name, payload: r.payload });
    });
    try {
      const provider = createMockProvider([
        [
          { type: 'text_delta', text: 'ok' },
          { type: 'stop', stopReason: 'end_turn' },
        ],
      ]);
      const MAX = 500;
      const content: ContentBlock[] = [
        {
          type: 'tool_use',
          id: 'call-big',
          name: 'noop',
          input: { blob: 'x'.repeat(5_000) },
        },
      ];
      const rt = createRuntime(makeConfig({ provider, maxMessageChars: MAX }));
      await collectEvents(
        rt.query({ hostRunId: 'test-run', prompt: 'ignored', initialMessages: [{ role: 'user', content }] }),
      );

      const msgRecords = records.filter(
        (r) => r.event_name === TelemetryEvents.MESSAGE_TRUNCATED,
      );
      expect(msgRecords).toHaveLength(1);
      expect(msgRecords[0]!.payload.outcome).toBe('incompressible');
      expect(msgRecords[0]!.payload.reason).toBe('tool_use');
    } finally {
      resetTelemetrySink();
    }
  });
});

// ─── FR-04 H1-B1 Review P0 fix：深度嵌套兜底 ──────────────────────────
//
// 早期实现中 `blockCharCount` 达到 `MESSAGE_MEASURE_MAX_DEPTH`（16）
// 时会静默返回 0，导致 `measureMessageChars` **低估**深嵌套消息的
// 真实字符数，`enforceMessageSizeBudget` 因此把实际超限的消息
// 放行到 LLM，OOM 兜底语义失效。修复后走 `oversizedIncompressible`
// 分支，reason = 'deeply_nested'。

describe('FR-04 — deeply-nested tool_result depth safety net', () => {
  it('classifies an over-depth nested tool_result as deeply_nested rather than silently passing it through', async () => {
    const sink: { request?: LLMRequest } = {};
    const provider = captureRequestProvider(
      [
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
      sink,
    );

    // Build a `tool_result.content: ContentBlock[]` tree deeper than
    // the recursion bound (16). Each level wraps one more
    // `tool_result` block — pathological but syntactically valid.
    type NestedBlock = ContentBlock;
    let deepest: NestedBlock = { type: 'text', text: 'ping' };
    for (let i = 0; i < 20; i++) {
      deepest = {
        type: 'tool_result',
        tool_use_id: `deep-${i}`,
        content: [deepest],
      } satisfies NestedBlock;
    }
    const initialMessages: Message[] = [
      { role: 'user', content: [deepest] },
    ];

    const MAX = 10_000;
    const rt = createRuntime(makeConfig({ provider, maxMessageChars: MAX }));
    const events = await collectEvents(
      rt.query({ hostRunId: 'test-run', prompt: 'ignored', initialMessages }),
    );

    // No misleading "truncated" notice — we cannot safely rewrite a
    // tree we could not fully measure.
    expect(
      events.filter(
        (e) =>
          e.type === 'agent.stream.system_notice' &&
          (e.payload as Record<string, unknown>).notice_type === 'message_truncated',
      ),
    ).toHaveLength(0);

    // Must surface as incompressible with the dedicated reason.
    const incompress = events.filter(
      (e) =>
        e.type === 'agent.stream.system_notice' &&
        (e.payload as Record<string, unknown>).notice_type ===
          'message_oversized_incompressible',
    );
    expect(incompress).toHaveLength(1);
    expect((incompress[0]!.payload as Record<string, unknown>).reason).toBe(
      'deeply_nested',
    );
  });

  it('emits message.truncated telemetry with reason=deeply_nested for dashboard filtering', async () => {
    const { setTelemetrySink, resetTelemetrySink, TelemetryEvents } =
      await import('../src/telemetry/index.js');
    const records: Array<{ event_name: string; payload: Record<string, unknown> }> = [];
    setTelemetrySink((r) => {
      records.push({ event_name: r.event_name, payload: r.payload });
    });
    try {
      const provider = createMockProvider([
        [
          { type: 'text_delta', text: 'ok' },
          { type: 'stop', stopReason: 'end_turn' },
        ],
      ]);

      let deepest: ContentBlock = { type: 'text', text: 'ping' };
      for (let i = 0; i < 20; i++) {
        deepest = {
          type: 'tool_result',
          tool_use_id: `deep-${i}`,
          content: [deepest],
        };
      }
      const initialMessages: Message[] = [
        { role: 'user', content: [deepest] },
      ];

      const rt = createRuntime(makeConfig({ provider, maxMessageChars: 10_000 }));
      await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'ignored', initialMessages }));

      const msgRecords = records.filter(
        (r) => r.event_name === TelemetryEvents.MESSAGE_TRUNCATED,
      );
      expect(msgRecords).toHaveLength(1);
      expect(msgRecords[0]!.payload.outcome).toBe('incompressible');
      expect(msgRecords[0]!.payload.reason).toBe('deeply_nested');
    } finally {
      resetTelemetrySink();
    }
  });
});
