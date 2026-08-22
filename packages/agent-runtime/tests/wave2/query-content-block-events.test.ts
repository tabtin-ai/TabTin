/**
 * Wave 2 — query.ts ContentBlock envelope 集成测试
 *
 * 验证 query.ts 把 provider 抛出的 ContentBlockEnvelopeHint 完整补齐
 * 公共字段后 yield 出来 —— 这是 W2 出口契约（W3 Django 后端按这个吃）。
 *
 * 覆盖：
 *   1. 单 query 内 _seq 严格单调 +1
 *   2. message_start / message_stop 配对（每个 LLM 调用一对）
 *   3. content_block_start → delta → stop 三件套连续顺序
 *   4. 每个 message_start 携带新 message_id；同一个 message 内 _seq 单调
 *   5. trace_id / thread_id 在所有 envelope 上保持一致
 *   6. tool_use 完成后 query.ts 触发新一轮 LLM 调用 → 第二个 message_start
 *   7. 不再 emit 黑名单 StreamEvents（ASSISTANT/REASONING/TOOL/TOOL_CALL_ARGS_DELTA/CONTENT_RESET）
 */

import { describe, it, expect } from 'vitest';
import { createRuntime } from '../../src/runtime-assembly.js';
import {
  createMockPermissionHandler,
  createMockToolProvider,
} from '../test-utils.js';
import type {
  StreamEvent,
} from '../../src/engine/contracts/wire-protocol.js';
import type {
  LLMRequest,
  LLMResponseChunk,
} from '../../src/engine/contracts/model-llm.js';
import type {
  Tool,
} from '../../src/engine/contracts/tools.js';
import type {
  EngineConfig,
} from '../../src/engine/contracts/kernel.js';
import { ContentBlockEvents, StreamEvents } from '../../src/engine/contracts/stream-events.js';
import { buildUserContextWrapper } from '../../src/engine/context/user-context-wrapper.js';

async function collectEvents(
  gen: AsyncGenerator<StreamEvent>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

function makeReadFile(): Tool {
  return {
    name: 'read_file',
    description: 'Read file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    isReadOnly: true,
    execute: async () => ({ content: 'file content' }),
  };
}

function makeOneShotConfig(sessionId: string): EngineConfig {
  return {
    provider: {
      async *createStream(): AsyncIterable<LLMResponseChunk> {
        yield { type: 'stop', stopReason: 'end_turn' };
      },
    },
    tools: createMockToolProvider([]),
    permissionHandler: createMockPermissionHandler('allow'),
    sessionConfig: { sessionDir: `/tmp/${sessionId}`, threadId: sessionId },
    model: 'test',
  };
}

function userEvents(events: StreamEvent[]): StreamEvent[] {
  return events.filter((event) => event.type === StreamEvents.USER);
}

describe('query.ts — USER event user blocks normalization', () => {
  it('把用户可见正文补进已有 file/context blocks 前面', async () => {
    const events = await collectEvents(createRuntime(makeOneShotConfig('user-blocks-file')).query({
      hostRunId: 'test-run',
      prompt: '请总结这个文件',
      clientMessageId: '11111111-1111-4111-8111-111111111111',
      userMessageBlocks: [
        { type: 'file', file_id: 'file-1', filename: 'brief.pdf' },
      ],
    }));

    const [userEvent] = userEvents(events);
    const blocks = userEvent?.payload?.blocks_json as Array<Record<string, unknown>>;
    expect(blocks).toEqual([
      { type: 'text', text: '请总结这个文件' },
      { type: 'file', file_id: 'file-1', filename: 'brief.pdf' },
    ]);
  });

  it('已有等价 text block 时不重复插入正文', async () => {
    const events = await collectEvents(createRuntime(makeOneShotConfig('user-blocks-existing-text')).query({
      hostRunId: 'test-run',
      prompt: 'internal prompt',
      displayMessage: '用户看到的文本',
      clientMessageId: '22222222-2222-4222-8222-222222222222',
      userMessageBlocks: [
        { type: 'text', text: '用户看到的文本' },
        { type: 'webpage', url: 'https://example.com' },
      ],
    }));

    const [userEvent] = userEvents(events);
    const blocks = userEvent?.payload?.blocks_json as Array<Record<string, unknown>>;
    expect(blocks).toEqual([
      { type: 'text', text: '用户看到的文本' },
      { type: 'webpage', url: 'https://example.com' },
    ]);
  });

  it('已有多个 text blocks 可拼出正文时不重复插入', async () => {
    const events = await collectEvents(createRuntime(makeOneShotConfig('user-blocks-split-text')).query({
      hostRunId: 'test-run',
      prompt: '第一段\n第二段',
      clientMessageId: '66666666-6666-4666-8666-666666666666',
      userMessageBlocks: [
        { type: 'text', text: '第一段' },
        { type: 'text', text: '第二段' },
        { type: 'file', file_id: 'file-2', filename: 'split.pdf' },
      ],
    }));

    const [userEvent] = userEvents(events);
    const blocks = userEvent?.payload?.blocks_json as Array<Record<string, unknown>>;
    expect(blocks).toEqual([
      { type: 'text', text: '第一段' },
      { type: 'text', text: '第二段' },
      { type: 'file', file_id: 'file-2', filename: 'split.pdf' },
    ]);
  });

  it('只规范化 USER event，不改变发给 LLM 的执行 prompt', async () => {
    const capturedRequests: LLMRequest[] = [];
    const config: EngineConfig = {
      provider: {
        async *createStream(req: LLMRequest): AsyncIterable<LLMResponseChunk> {
          capturedRequests.push(req);
          yield { type: 'stop', stopReason: 'end_turn' };
        },
      },
      tools: createMockToolProvider([]),
      permissionHandler: createMockPermissionHandler('allow'),
      sessionConfig: { sessionDir: '/tmp/user-blocks-llm-input', threadId: 'user-blocks-llm-input' },
      model: 'test',
    };

    const events = await collectEvents(createRuntime(config).query({
      hostRunId: 'test-run',
      prompt: '<internal>请按附件生成报告</internal>',
      displayMessage: '请按附件生成报告',
      clientMessageId: '55555555-5555-4555-8555-555555555555',
      userMessageBlocks: [
        { type: 'file', file_id: 'file-1', filename: 'report.pdf' },
      ],
    }));

    const [userEvent] = userEvents(events);
    expect(userEvent?.payload?.content).toBe('请按附件生成报告');
    expect(userEvent?.payload?.blocks_json).toEqual([
      { type: 'text', text: '请按附件生成报告' },
      { type: 'file', file_id: 'file-1', filename: 'report.pdf' },
    ]);
    const requestUserMessages = capturedRequests[0]?.messages.filter(message => message.role === 'user') ?? [];
    expect(requestUserMessages.at(-1)).toMatchObject({
      role: 'user',
      content: '<internal>请按附件生成报告</internal>',
    });
  });

  it('空文本仅附件时不制造空 text block', async () => {
    const events = await collectEvents(createRuntime(makeOneShotConfig('user-blocks-empty-text')).query({
      hostRunId: 'test-run',
      prompt: '',
      clientMessageId: '33333333-3333-4333-8333-333333333333',
      userMessageBlocks: [
        { type: 'file', file_id: 'file-only', filename: 'only.pdf' },
      ],
    }));

    const [userEvent] = userEvents(events);
    const blocks = userEvent?.payload?.blocks_json as Array<Record<string, unknown>>;
    expect(blocks).toEqual([
      { type: 'file', file_id: 'file-only', filename: 'only.pdf' },
    ]);
  });

  it('clientMessageId 加 initialMessages 的设备端路径仍 yield 规范化 USER event', async () => {
    const events = await collectEvents(createRuntime(makeOneShotConfig('user-blocks-initial-messages')).query({
      hostRunId: 'test-run',
      prompt: '继续处理附件',
      clientMessageId: '44444444-4444-4444-8444-444444444444',
      initialMessages: [{ role: 'user', content: '上一轮' }],
      userMessageBlocks: [
        { type: 'file', file_id: 'device-file', filename: 'device.pdf' },
      ],
    }));

    const users = userEvents(events);
    expect(users).toHaveLength(1);
    expect(users[0]?.payload?.blocks_json).toEqual([
      { type: 'text', text: '继续处理附件' },
      { type: 'file', file_id: 'device-file', filename: 'device.pdf' },
    ]);
  });

  it('无 clientMessageId 且已有 initialMessages 时不扩大 USER event 发射范围', async () => {
    const events = await collectEvents(createRuntime(makeOneShotConfig('user-blocks-no-client-id')).query({
      hostRunId: 'test-run',
      prompt: '内部子任务',
      initialMessages: [{ role: 'user', content: '父任务上下文' }],
      userMessageBlocks: [
        { type: 'file', file_id: 'sub-file', filename: 'sub.pdf' },
      ],
    }));

    expect(userEvents(events)).toHaveLength(0);
  });

  it('#2542 未透传 displayMessage 时，从 prompt 剥掉附件 <context> 注入再落库', async () => {
    // 复刻 daemon / 旧客户端路径：host 把附件包成 <context type="attached"> 拼进
    // 执行 prompt，但没有单独透传干净的 displayMessage。runtime 必须剥壳，
    // 不能把注入正文当用户可见正文落库。
    const attachedWrapper = buildUserContextWrapper('attached', '[文档: brief.pdf — 文档读取失败]', {
      filename: 'brief.pdf',
      stale_after_turn: '77777777-7777-4777-8777-777777777777',
    });
    const events = await collectEvents(createRuntime(makeOneShotConfig('user-blocks-strip-attached')).query({
      hostRunId: 'test-run',
      prompt: `请总结这个文件\n\n${attachedWrapper}`,
      clientMessageId: '77777777-7777-4777-8777-777777777777',
      userMessageBlocks: [
        { type: 'file', file_id: 'file-1', filename: 'brief.pdf' },
      ],
    }));

    const [userEvent] = userEvents(events);
    expect(userEvent?.payload?.content).toBe('请总结这个文件');
    expect(userEvent?.payload?.blocks_json).toEqual([
      { type: 'text', text: '请总结这个文件' },
      { type: 'file', file_id: 'file-1', filename: 'brief.pdf' },
    ]);
  });

  it('#2542 仅附件、无正文且未透传 displayMessage 时不制造含 <context> 的 text block', async () => {
    const attachedWrapper = buildUserContextWrapper('attached', '[文档: empty10m.txt — 文档读取失败]', {
      filename: 'empty10m.txt',
      stale_after_turn: '88888888-8888-4888-8888-888888888888',
    });
    const events = await collectEvents(createRuntime(makeOneShotConfig('user-blocks-strip-attached-only')).query({
      hostRunId: 'test-run',
      prompt: `\n\n${attachedWrapper}`,
      clientMessageId: '88888888-8888-4888-8888-888888888888',
      userMessageBlocks: [
        { type: 'file', file_id: 'file-empty', filename: 'empty10m.txt' },
      ],
    }));

    const [userEvent] = userEvents(events);
    expect(userEvent?.payload?.content).toBe('');
    expect(userEvent?.payload?.blocks_json).toEqual([
      { type: 'file', file_id: 'file-empty', filename: 'empty10m.txt' },
    ]);
  });
});

describe('query.ts — Wave 2 ContentBlock envelope output', () => {
  it('单轮 LLM 调用 → message_start / cb_start / cb_delta / cb_stop / message_delta / message_stop', async () => {
    const mockProvider = {
      async *createStream(req: LLMRequest): AsyncIterable<LLMResponseChunk> {
        // 模拟 proxy-provider 反推 hint 的回调
        if (req.onContentBlockEvent) {
          req.onContentBlockEvent({
            kind: ContentBlockEvents.MESSAGE_START,
            upstream_message_id: 'msg_upstream_1',
          });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.CONTENT_BLOCK_START,
            index: 0,
            block_id: 'b0',
            block: { type: 'text', text: '' },
          });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.CONTENT_BLOCK_DELTA,
            index: 0,
            delta: { type: 'text_delta', text: 'hello world' },
          });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.CONTENT_BLOCK_STOP,
            index: 0,
          });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.MESSAGE_DELTA,
            delta: { stop_reason: 'end_turn' },
            usage: { input_tokens: 10, output_tokens: 5 },
          });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.MESSAGE_STOP,
          });
        }

        yield { type: 'text_delta', text: 'hello world' };
        yield { type: 'stop', stopReason: 'end_turn' };
      },
    };

    const config: EngineConfig = {
      provider: mockProvider,
      tools: createMockToolProvider([]),
      permissionHandler: createMockPermissionHandler('allow'),
      sessionConfig: { sessionDir: '/tmp/test-w2-1', threadId: 'sess-w2-1' },
      model: 'test',
    };

    const rt = createRuntime(config);
    const events = await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'hi' }));

    // 抓 envelope 类事件
    const cbEvents = events.filter((e) => {
      const t = (e as { type: string }).type;
      return (
        t === ContentBlockEvents.MESSAGE_START
        || t === ContentBlockEvents.MESSAGE_DELTA
        || t === ContentBlockEvents.MESSAGE_STOP
        || t === ContentBlockEvents.CONTENT_BLOCK_START
        || t === ContentBlockEvents.CONTENT_BLOCK_DELTA
        || t === ContentBlockEvents.CONTENT_BLOCK_STOP
      );
    });

    // 至少 6 件套各 1
    const types = cbEvents.map((e) => (e as { type: string }).type);
    expect(types).toContain(ContentBlockEvents.MESSAGE_START);
    expect(types).toContain(ContentBlockEvents.MESSAGE_STOP);
    expect(types).toContain(ContentBlockEvents.CONTENT_BLOCK_START);
    expect(types).toContain(ContentBlockEvents.CONTENT_BLOCK_DELTA);
    expect(types).toContain(ContentBlockEvents.CONTENT_BLOCK_STOP);

    // 顺序：message_start → cb_start → cb_delta → cb_stop → message_stop
    const startIdx = types.indexOf(ContentBlockEvents.MESSAGE_START);
    const cbStartIdx = types.indexOf(ContentBlockEvents.CONTENT_BLOCK_START);
    const cbDeltaIdx = types.indexOf(ContentBlockEvents.CONTENT_BLOCK_DELTA);
    const cbStopIdx = types.indexOf(ContentBlockEvents.CONTENT_BLOCK_STOP);
    const stopIdx = types.indexOf(ContentBlockEvents.MESSAGE_STOP);
    expect(startIdx).toBeLessThan(cbStartIdx);
    expect(cbStartIdx).toBeLessThan(cbDeltaIdx);
    expect(cbDeltaIdx).toBeLessThan(cbStopIdx);
    expect(cbStopIdx).toBeLessThan(stopIdx);
  });

  it('_seq 在单 query 内严格单调递增（同一 message 内 +1）', async () => {
    const mockProvider = {
      async *createStream(req: LLMRequest): AsyncIterable<LLMResponseChunk> {
        if (req.onContentBlockEvent) {
          req.onContentBlockEvent({
            kind: ContentBlockEvents.MESSAGE_START,
            upstream_message_id: 'msg_x',
          });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.CONTENT_BLOCK_START,
            index: 0,
            block_id: 'b0',
            block: { type: 'text', text: '' },
          });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.CONTENT_BLOCK_DELTA,
            index: 0,
            delta: { type: 'text_delta', text: 'a' },
          });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.CONTENT_BLOCK_DELTA,
            index: 0,
            delta: { type: 'text_delta', text: 'b' },
          });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.CONTENT_BLOCK_STOP,
            index: 0,
          });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.MESSAGE_STOP,
          });
        }
        yield { type: 'text_delta', text: 'ab' };
        yield { type: 'stop', stopReason: 'end_turn' };
      },
    };

    const config: EngineConfig = {
      provider: mockProvider,
      tools: createMockToolProvider([]),
      permissionHandler: createMockPermissionHandler('allow'),
      sessionConfig: { sessionDir: '/tmp/test-w2-2', threadId: 'sess-w2-2' },
      model: 'test',
    };

    const events = await collectEvents(createRuntime(config).query({ hostRunId: 'test-run', prompt: 'hi' }));

    // 抓所有带 _seq 的 envelope 事件 —— 6 件套都应该有 _seq
    const cbTypes = new Set([
      ContentBlockEvents.MESSAGE_START,
      ContentBlockEvents.MESSAGE_DELTA,
      ContentBlockEvents.MESSAGE_STOP,
      ContentBlockEvents.CONTENT_BLOCK_START,
      ContentBlockEvents.CONTENT_BLOCK_DELTA,
      ContentBlockEvents.CONTENT_BLOCK_STOP,
    ]);
    const seqs = events
      .filter((e) => cbTypes.has((e as { type: string }).type as typeof ContentBlockEvents.MESSAGE_START))
      .map((e) => (e as unknown as { payload: { _seq?: number } }).payload._seq)
      .filter((s): s is number => typeof s === 'number');

    expect(seqs.length).toBeGreaterThan(0);
    // 严格单调 +1（W2 EnvelopeEmitter 内部维护单调计数器）
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe(seqs[i - 1] + 1);
    }
  });

  it('trace_id / thread_id 在所有 envelope 上保持一致', async () => {
    const mockProvider = {
      async *createStream(req: LLMRequest): AsyncIterable<LLMResponseChunk> {
        if (req.onContentBlockEvent) {
          req.onContentBlockEvent({
            kind: ContentBlockEvents.MESSAGE_START,
            upstream_message_id: 'msg',
          });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.CONTENT_BLOCK_START,
            index: 0,
            block_id: 'b0',
            block: { type: 'text', text: '' },
          });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.CONTENT_BLOCK_DELTA,
            index: 0,
            delta: { type: 'text_delta', text: 'x' },
          });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.CONTENT_BLOCK_STOP,
            index: 0,
          });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.MESSAGE_STOP,
          });
        }
        yield { type: 'text_delta', text: 'x' };
        yield { type: 'stop', stopReason: 'end_turn' };
      },
    };

    const config: EngineConfig = {
      provider: mockProvider,
      tools: createMockToolProvider([]),
      permissionHandler: createMockPermissionHandler('allow'),
      sessionConfig: { sessionDir: '/tmp/test-w2-3', threadId: 'sess-w2-3' },
      model: 'test',
    };

    const events = await collectEvents(createRuntime(config).query({ hostRunId: 'test-run', prompt: 'hi' }));

    const cbTypes = new Set([
      ContentBlockEvents.MESSAGE_START,
      ContentBlockEvents.MESSAGE_STOP,
      ContentBlockEvents.CONTENT_BLOCK_START,
      ContentBlockEvents.CONTENT_BLOCK_DELTA,
      ContentBlockEvents.CONTENT_BLOCK_STOP,
    ]);
    const cbEvents = events.filter((e) =>
      cbTypes.has((e as { type: string }).type as typeof ContentBlockEvents.MESSAGE_START),
    );

    expect(cbEvents.length).toBeGreaterThan(0);
    const traceIds = new Set(
      cbEvents.map((e) => (e as unknown as { payload: { trace_id?: string } }).payload.trace_id),
    );
    const threadIds = new Set(
      cbEvents.map((e) => (e as unknown as { payload: { thread_id?: string } }).payload.thread_id),
    );

    expect(traceIds.size).toBe(1);
    expect(threadIds.size).toBe(1);
  });

  it('tool_use 触发的第二轮 LLM 调用 → 新 message_start（message_id 不同）', async () => {
    let callIndex = 0;
    const mockProvider = {
      async *createStream(req: LLMRequest): AsyncIterable<LLMResponseChunk> {
        if (callIndex === 0) {
          callIndex++;
          if (req.onContentBlockEvent) {
            req.onContentBlockEvent({
              kind: ContentBlockEvents.MESSAGE_START,
              upstream_message_id: 'msg_round1',
            });
            req.onContentBlockEvent({
              kind: ContentBlockEvents.CONTENT_BLOCK_START,
              index: 0,
              block_id: 'b0',
              block: { type: 'tool_use', id: 'tc1', name: 'read_file', input: {} },
            });
            req.onContentBlockEvent({
              kind: ContentBlockEvents.CONTENT_BLOCK_DELTA,
              index: 0,
              delta: { type: 'input_json_delta', partial_json: '{"path":"f"}' },
            });
            req.onContentBlockEvent({
              kind: ContentBlockEvents.CONTENT_BLOCK_STOP,
              index: 0,
            });
            req.onContentBlockEvent({
              kind: ContentBlockEvents.MESSAGE_STOP,
            });
          }
          yield {
            type: 'tool_use',
            toolUse: { id: 'tc1', name: 'read_file', input: { path: 'f' } },
          };
          yield { type: 'stop', stopReason: 'tool_use' };
          return;
        }
        // 第二轮
        if (req.onContentBlockEvent) {
          req.onContentBlockEvent({
            kind: ContentBlockEvents.MESSAGE_START,
            upstream_message_id: 'msg_round2',
          });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.CONTENT_BLOCK_START,
            index: 0,
            block_id: 'b1',
            block: { type: 'text', text: '' },
          });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.CONTENT_BLOCK_DELTA,
            index: 0,
            delta: { type: 'text_delta', text: 'final' },
          });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.CONTENT_BLOCK_STOP,
            index: 0,
          });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.MESSAGE_STOP,
          });
        }
        yield { type: 'text_delta', text: 'final' };
        yield { type: 'stop', stopReason: 'end_turn' };
      },
    };

    const config: EngineConfig = {
      provider: mockProvider,
      tools: createMockToolProvider([makeReadFile()]),
      permissionHandler: createMockPermissionHandler('allow'),
      sessionConfig: { sessionDir: '/tmp/test-w2-4', threadId: 'sess-w2-4' },
      model: 'test',
    };

    const events = await collectEvents(createRuntime(config).query({ hostRunId: 'test-run', prompt: 'hi' }));

    // **更新（wire tool_result envelope 主成功路径恢复后）**：
    // 第一轮 LLM 完成 + 工具执行结束后，runtime 会 emit 一条 role='user' /
    // message_kind='llm' 的 tool_result mini-message envelope（让 Django
    // reassembler 把 tool_result 合并进 assistant content_blocks_json）。
    // 所以 message_start 数从原 2 个（两轮 LLM）变成 3 个（两轮 LLM +
    // 一条中间 user tool_result mini-message）。详见 query.ts 「wire
    // `tool_result envelope` 主成功路径 emit」段落。
    const messageStarts = events.filter(
      (e) => (e as { type: string }).type === ContentBlockEvents.MESSAGE_START,
    );
    expect(messageStarts.length).toBe(3);

    // 三个 message_id 互不相同
    const messageIds = messageStarts.map(
      (e) => (e as unknown as { payload: { message_id?: string } }).payload.message_id,
    );
    expect(new Set(messageIds).size).toBe(3);

    // 中间那条是 user role + message_kind='llm'（tool_result mini-message
    // 协议特征），首尾两条是 assistant role + LLM 真实输出。
    const roles = messageStarts.map(
      (e) => (e as unknown as { payload: { role?: string } }).payload.role,
    );
    expect(roles).toEqual(['assistant', 'user', 'assistant']);
    const kinds = messageStarts.map(
      (e) => (e as unknown as { payload: { message_kind?: string } }).payload.message_kind,
    );
    expect(kinds).toEqual(['llm', 'llm', 'llm']);

    // _seq 跨多轮全 query 严格单调（W2 EnvelopeEmitter 跨多轮共享 seq）
    const cbTypes = new Set([
      ContentBlockEvents.MESSAGE_START,
      ContentBlockEvents.MESSAGE_DELTA,
      ContentBlockEvents.MESSAGE_STOP,
      ContentBlockEvents.CONTENT_BLOCK_START,
      ContentBlockEvents.CONTENT_BLOCK_DELTA,
      ContentBlockEvents.CONTENT_BLOCK_STOP,
    ]);
    const seqs = events
      .filter((e) => cbTypes.has((e as { type: string }).type as typeof ContentBlockEvents.MESSAGE_START))
      .map((e) => (e as unknown as { payload: { _seq?: number } }).payload._seq)
      .filter((s): s is number => typeof s === 'number');
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe(seqs[i - 1] + 1);
    }
  });

  it('黑名单 LLM 内容流 StreamEvents 不再 yield：ASSISTANT / REASONING / TOOL_CALL_ARGS_DELTA / CONTENT_RESET', async () => {
    let callIndex = 0;
    const mockProvider = {
      async *createStream(req: LLMRequest): AsyncIterable<LLMResponseChunk> {
        if (callIndex === 0) {
          callIndex++;
          if (req.onContentBlockEvent) {
            req.onContentBlockEvent({ kind: ContentBlockEvents.MESSAGE_START, upstream_message_id: 'm1' });
            req.onContentBlockEvent({
              kind: ContentBlockEvents.CONTENT_BLOCK_START,
              index: 0,
              block_id: 'b0',
              block: { type: 'thinking', thinking: '' },
            });
            req.onContentBlockEvent({
              kind: ContentBlockEvents.CONTENT_BLOCK_DELTA,
              index: 0,
              delta: { type: 'thinking_delta', thinking: 'thinking...' },
            });
            req.onContentBlockEvent({
              kind: ContentBlockEvents.CONTENT_BLOCK_STOP,
              index: 0,
            });
            req.onContentBlockEvent({
              kind: ContentBlockEvents.CONTENT_BLOCK_START,
              index: 1,
              block_id: 'b1',
              block: { type: 'text', text: '' },
            });
            req.onContentBlockEvent({
              kind: ContentBlockEvents.CONTENT_BLOCK_DELTA,
              index: 1,
              delta: { type: 'text_delta', text: 'answer' },
            });
            req.onContentBlockEvent({
              kind: ContentBlockEvents.CONTENT_BLOCK_STOP,
              index: 1,
            });
            req.onContentBlockEvent({
              kind: ContentBlockEvents.CONTENT_BLOCK_START,
              index: 2,
              block_id: 'b2',
              block: { type: 'tool_use', id: 'tc1', name: 'read_file', input: {} },
            });
            req.onContentBlockEvent({
              kind: ContentBlockEvents.CONTENT_BLOCK_DELTA,
              index: 2,
              delta: { type: 'input_json_delta', partial_json: '{"path":"x"}' },
            });
            req.onContentBlockEvent({
              kind: ContentBlockEvents.CONTENT_BLOCK_STOP,
              index: 2,
            });
            req.onContentBlockEvent({ kind: ContentBlockEvents.MESSAGE_STOP });
          }
          yield { type: 'thinking', text: 'thinking...' };
          yield { type: 'text_delta', text: 'answer' };
          yield {
            type: 'tool_use',
            toolUse: { id: 'tc1', name: 'read_file', input: { path: 'x' } },
          };
          yield { type: 'stop', stopReason: 'tool_use' };
          return;
        }
        if (req.onContentBlockEvent) {
          req.onContentBlockEvent({ kind: ContentBlockEvents.MESSAGE_START, upstream_message_id: 'm2' });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.CONTENT_BLOCK_START,
            index: 0,
            block_id: 'b3',
            block: { type: 'text', text: '' },
          });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.CONTENT_BLOCK_DELTA,
            index: 0,
            delta: { type: 'text_delta', text: 'final' },
          });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.CONTENT_BLOCK_STOP,
            index: 0,
          });
          req.onContentBlockEvent({ kind: ContentBlockEvents.MESSAGE_STOP });
        }
        yield { type: 'text_delta', text: 'final' };
        yield { type: 'stop', stopReason: 'end_turn' };
      },
    };

    const config: EngineConfig = {
      provider: mockProvider,
      tools: createMockToolProvider([makeReadFile()]),
      permissionHandler: createMockPermissionHandler('allow'),
      sessionConfig: { sessionDir: '/tmp/test-w2-5', threadId: 'sess-w2-5' },
      model: 'test',
    };

    const events = await collectEvents(createRuntime(config).query({ hostRunId: 'test-run', prompt: 'hi' }));

    // 黑名单事件类型 —— W2 范围内的"LLM 内容流"
    // 注意：`agent.stream.tool` 是工具执行生命周期信号，由 tool-orchestration.ts
    // 在 runTools 内部 emit。W2 总控明确该信号由 W3-W7 工具管线 envelope 化收敛，
    // 本 Wave 不在内容流黑名单里。
    // W4.5 第三波 C1（2026-05-13）：以下字面量对应的 wire `StreamEvents.*`
    // 常量已物理删除，黑名单改用字面量直接表示——daemon 0 处真 emit 是本测试的
    // 反向断言；任何未来 PR 误重新引入这几个事件 emit，本测试都会立刻 fail。
    const blacklist = new Set<string>([
      'agent.stream.assistant',
      'agent.stream.reasoning',
      'agent.stream.tool_call_args_delta',
      'agent.stream.content_reset',
    ]);
    // W4a 四轮 R4-1：lite-blocks-collector 临时桥 inject 一条 `agent.stream.assistant
    // (phase='final')` 让 Django 落库 ChatMessage with blocks_json（@cleanup-after
    // W4c-Django-reconstructor）。这条 inject 事件带 `_lite_collector_synthetic: true`
    // 标记——本测试排除这条 synthetic 事件后保留黑名单契约。
    const blackHits = events.filter((e) => {
      if (!blacklist.has((e as { type: string }).type)) return false
      const payload = (e as { payload?: { _lite_collector_synthetic?: boolean; metadata?: { _lite_collector_synthetic?: boolean } } }).payload
      // synthetic inject 不算违反 W2 黑名单契约（它属 W4a 临时桥范围）
      // W3 W4a-L40 修复后 synthetic 标记塞在 payload.metadata._lite_collector_synthetic；
      // 兼容老位置（payload._lite_collector_synthetic）保持向后兼容性
      return !payload?._lite_collector_synthetic && !payload?.metadata?._lite_collector_synthetic
    });
    if (blackHits.length > 0) {
      // eslint-disable-next-line no-console
      console.error('UNEXPECTED BLACKLIST EVENTS:', JSON.stringify(blackHits, null, 2));
    }
    expect(blackHits).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════
// message_kind 协议字段 — query.ts 4 个 caller 集成断言
// ────────────────────────────────────────────────────────────────────
// PRD §6.1 W0.5 单测清单要求覆盖：
//   - 主循环 emit 'llm'
//   - stall retry 续轮 emit 'llm'
//   - emitAssistantErrorMessageEnvelope emit 'error_envelope'
//   - emitToolErrorEnvelope emit 'llm' + role='user' + 含 tool_result block
//
// 本 describe 块用 mock provider 覆盖"主循环 emit 'llm'"+"stall retry"
// 两条主路径并强校验经 wire schema parse 通过；error_envelope /
// emitToolErrorEnvelope 的 helper 出口行为由 envelope-emitter.test.ts 单测
// 锁定（envelope-emitter 是这两个 helper 的唯一 emit 通道），query.ts 内的
// caller 调用方式由代码 review + harness W5 端到端 dogfood 验证完整路径。
// ════════════════════════════════════════════════════════════════════

describe('query.ts — Wave message_kind 协议字段', () => {
  it('主循环 emit 的 message_start 都含 message_kind=llm（经 wire MessageStartSchema parse 通过）', async () => {
    const mockProvider = {
      async *createStream(req: LLMRequest): AsyncIterable<LLMResponseChunk> {
        if (req.onContentBlockEvent) {
          req.onContentBlockEvent({
            kind: ContentBlockEvents.MESSAGE_START,
            upstream_message_id: 'msg_upstream',
          });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.CONTENT_BLOCK_START,
            index: 0,
            block_id: 'b0',
            block: { type: 'text', text: '' },
          });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.CONTENT_BLOCK_DELTA,
            index: 0,
            delta: { type: 'text_delta', text: 'hi' },
          });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.CONTENT_BLOCK_STOP,
            index: 0,
          });
          req.onContentBlockEvent({ kind: ContentBlockEvents.MESSAGE_STOP });
        }
        yield { type: 'text_delta', text: 'hi' };
        yield { type: 'stop', stopReason: 'end_turn' };
      },
    };

    const config: EngineConfig = {
      provider: mockProvider,
      tools: createMockToolProvider([]),
      permissionHandler: createMockPermissionHandler('allow'),
      sessionConfig: { sessionDir: '/tmp/test-w2-mkind-main', threadId: 'sess-mkind-main' },
      model: 'test',
    };

    const events = await collectEvents(createRuntime(config).query({ hostRunId: 'test-run', prompt: 'hi' }));
    const messageStartEvents = events.filter(
      (e) => (e as { type: string }).type === ContentBlockEvents.MESSAGE_START,
    );

    expect(messageStartEvents.length).toBeGreaterThan(0);

    const { MessageStartSchema } = await import('@tabtin/agent-wire');
    for (const ev of messageStartEvents) {
      // 协议契约：每条 message_start 都必须经 wire schema parse 通过——
      // 缺 message_kind / role × kind 非法都会让 parse fail，本 e2e 验证
      // daemon 真实路径不会 emit 出协议违法的 message_start。
      const parsed = MessageStartSchema.parse((ev as { payload: unknown }).payload);
      // 主循环路径必须标 'llm'（详见 query.ts:3084 + :3136）
      expect(parsed.message_kind).toBe('llm');
      // 主循环路径必须 role=assistant
      expect(parsed.role).toBe('assistant');
      // 已废弃字段：synthetic 不应再出现
      expect((parsed as unknown as { synthetic?: boolean }).synthetic).toBeUndefined();
    }
  });

  it('#9002 stall retry：先 close thinking 再切 message，message_stop 不挂 message_stop_fallback', async () => {
    // mock：先推 thinking 块（不 stop）→ 标 stall retry → 再吐 text。
    // 期望：旧 message 在 end 前收到 content_block_stop；end 不带 error_info；
    // 新 message 承接 text（避免 UI「…内容被截断」）。
    const mockProvider = {
      async *createStream(req: LLMRequest): AsyncIterable<LLMResponseChunk> {
        req.onContentBlockEvent?.({
          kind: ContentBlockEvents.CONTENT_BLOCK_START,
          index: 0,
          block_id: 'b_thinking',
          block: { type: 'thinking', thinking: '', signature: '' },
        });
        req.onContentBlockEvent?.({
          kind: ContentBlockEvents.CONTENT_BLOCK_DELTA,
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'It is my plan to reply "ok".' },
        });
        yield { type: 'thinking', text: 'It is my plan to reply "ok".' };

        req.onRetryAttempt?.({
          attempt: 2,
          maxRetries: 3,
          delayMs: 0,
          isStallRetry: true,
          errorMessage: 'LLM stream stalled (no data for 30s)',
        });

        yield { type: 'text_delta', text: 'ok' };
        req.onContentBlockEvent?.({
          kind: ContentBlockEvents.CONTENT_BLOCK_START,
          index: 0,
          block_id: 'b_text',
          block: { type: 'text', text: '' },
        });
        req.onContentBlockEvent?.({
          kind: ContentBlockEvents.CONTENT_BLOCK_DELTA,
          index: 0,
          delta: { type: 'text_delta', text: 'ok' },
        });
        req.onContentBlockEvent?.({
          kind: ContentBlockEvents.CONTENT_BLOCK_STOP,
          index: 0,
        });
        yield { type: 'stop', stopReason: 'end_turn' };
      },
    };

    const config: EngineConfig = {
      provider: mockProvider,
      tools: createMockToolProvider([]),
      permissionHandler: createMockPermissionHandler('allow'),
      sessionConfig: { sessionDir: '/tmp/test-w2-mkind-stall', threadId: 'sess-mkind-stall' },
      model: 'test',
    };

    const events = await collectEvents(createRuntime(config).query({ hostRunId: 'test-run', prompt: 'recover' }));
    const messageStarts = events.filter((e) => e.type === ContentBlockEvents.MESSAGE_START);
    const messageStops = events.filter((e) => e.type === ContentBlockEvents.MESSAGE_STOP);
    expect(messageStarts.length).toBeGreaterThanOrEqual(2);
    expect(messageStops.length).toBeGreaterThanOrEqual(2);

    const firstStop = messageStops[0]!;
    const firstStopPayload = firstStop.payload as {
      message_id: string;
      error_info?: { partial_reason?: string };
    };
    expect(firstStopPayload.error_info?.partial_reason).toBeUndefined();

    const firstMsgId = firstStopPayload.message_id;
    const firstMsgEvents = events.filter((e) => {
      const p = e.payload as { message_id?: string };
      return p.message_id === firstMsgId;
    });
    const types = firstMsgEvents.map((e) => e.type);
    const stopIdx = types.lastIndexOf(ContentBlockEvents.MESSAGE_STOP);
    const thinkingStopIdx = types.lastIndexOf(ContentBlockEvents.CONTENT_BLOCK_STOP);
    expect(thinkingStopIdx).toBeGreaterThanOrEqual(0);
    expect(thinkingStopIdx).toBeLessThan(stopIdx);

    // 保留原「间接守门」：所有 message_start 过 wire schema
    const { MessageStartSchema } = await import('@tabtin/agent-wire');
    for (const ev of messageStarts) {
      const parsed = MessageStartSchema.parse((ev as { payload: unknown }).payload);
      expect(parsed.message_kind).toBe('llm');
    }
  });

  it('普通流程 emit 的 message_start 都经 wire schema parse 通过（stall retry 真路径见上一用例）', async () => {
    const mockProvider = {
      async *createStream(req: LLMRequest): AsyncIterable<LLMResponseChunk> {
        if (req.onContentBlockEvent) {
          req.onContentBlockEvent({
            kind: ContentBlockEvents.MESSAGE_START,
            upstream_message_id: 'msg_stalled',
          });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.CONTENT_BLOCK_START,
            index: 0,
            block_id: 'b0',
            block: { type: 'text', text: '' },
          });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.CONTENT_BLOCK_DELTA,
            index: 0,
            delta: { type: 'text_delta', text: 'recovered' },
          });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.CONTENT_BLOCK_STOP,
            index: 0,
          });
          req.onContentBlockEvent({ kind: ContentBlockEvents.MESSAGE_STOP });
        }
        yield { type: 'text_delta', text: 'recovered' };
        yield { type: 'stop', stopReason: 'end_turn' };
      },
    };

    const config: EngineConfig = {
      provider: mockProvider,
      tools: createMockToolProvider([]),
      permissionHandler: createMockPermissionHandler('allow'),
      sessionConfig: { sessionDir: '/tmp/test-w2-mkind-stall-schema', threadId: 'sess-mkind-stall-schema' },
      model: 'test',
    };

    const events = await collectEvents(createRuntime(config).query({ hostRunId: 'test-run', prompt: 'recover' }));
    const messageStartEvents = events.filter(
      (e) => (e as { type: string }).type === ContentBlockEvents.MESSAGE_START,
    );

    expect(messageStartEvents.length).toBeGreaterThan(0);

    const { MessageStartSchema } = await import('@tabtin/agent-wire');
    for (const ev of messageStartEvents) {
      const parsed = MessageStartSchema.parse((ev as { payload: unknown }).payload);
      expect(parsed.message_kind).toBe('llm');
    }
  });

  it('多轮 tool_use 后第二轮 LLM 调用的 message_start 也标 message_kind=llm', async () => {
    // query.ts:3084 主循环在每一轮 iteration 开头都 beginMessage(messageKind:'llm')，
    // tool_use 触发新一轮 LLM 调用时不应该漏标。
    let callIndex = 0;
    const mockProvider = {
      async *createStream(req: LLMRequest): AsyncIterable<LLMResponseChunk> {
        if (callIndex === 0) {
          callIndex++;
          if (req.onContentBlockEvent) {
            req.onContentBlockEvent({
              kind: ContentBlockEvents.MESSAGE_START,
              upstream_message_id: 'msg_round1',
            });
            req.onContentBlockEvent({
              kind: ContentBlockEvents.CONTENT_BLOCK_START,
              index: 0,
              block_id: 'b0',
              block: { type: 'tool_use', id: 'tc_mkind', name: 'read_file', input: {} },
            });
            req.onContentBlockEvent({
              kind: ContentBlockEvents.CONTENT_BLOCK_DELTA,
              index: 0,
              delta: { type: 'input_json_delta', partial_json: '{"path":"/f"}' },
            });
            req.onContentBlockEvent({
              kind: ContentBlockEvents.CONTENT_BLOCK_STOP,
              index: 0,
            });
            req.onContentBlockEvent({ kind: ContentBlockEvents.MESSAGE_STOP });
          }
          yield {
            type: 'tool_use',
            toolUse: { id: 'tc_mkind', name: 'read_file', input: { path: '/f' } },
          };
          yield { type: 'stop', stopReason: 'tool_use' };
          return;
        }
        // 第二轮
        if (req.onContentBlockEvent) {
          req.onContentBlockEvent({
            kind: ContentBlockEvents.MESSAGE_START,
            upstream_message_id: 'msg_round2',
          });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.CONTENT_BLOCK_START,
            index: 0,
            block_id: 'b1',
            block: { type: 'text', text: '' },
          });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.CONTENT_BLOCK_DELTA,
            index: 0,
            delta: { type: 'text_delta', text: 'done' },
          });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.CONTENT_BLOCK_STOP,
            index: 0,
          });
          req.onContentBlockEvent({ kind: ContentBlockEvents.MESSAGE_STOP });
        }
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'stop', stopReason: 'end_turn' };
      },
    };

    const config: EngineConfig = {
      provider: mockProvider,
      tools: createMockToolProvider([makeReadFile()]),
      permissionHandler: createMockPermissionHandler('allow'),
      sessionConfig: { sessionDir: '/tmp/test-w2-mkind-tool', threadId: 'sess-mkind-tool' },
      model: 'test',
    };

    const events = await collectEvents(createRuntime(config).query({ hostRunId: 'test-run', prompt: 'tool' }));
    const messageStartEvents = events.filter(
      (e) => (e as { type: string }).type === ContentBlockEvents.MESSAGE_START,
    );

    // 至少 2 个 message_start（两轮 LLM 调用）
    expect(messageStartEvents.length).toBeGreaterThanOrEqual(2);

    const { MessageStartSchema } = await import('@tabtin/agent-wire');
    const parsedKinds = messageStartEvents.map(
      (ev) => MessageStartSchema.parse((ev as { payload: unknown }).payload).message_kind,
    );
    // 全部都是 'llm'（多轮 LLM 调用都是主循环 path）
    expect(parsedKinds.every((k) => k === 'llm')).toBe(true);
    // 两轮 message_id 不同
    const messageIds = messageStartEvents.map(
      (ev) => (ev as { payload: { message_id: string } }).payload.message_id,
    );
    expect(new Set(messageIds).size).toBe(messageIds.length);
  });

  it('stall retry 在尚未累积 text/reasoning 时也补发 message_start（GH-#1 回归）', async () => {
    // 根因回归：stall 发生在消息开头（尚无任何 text/reasoning）时，provider 的
    // message_start hint 被 envelope-emitter drop；修复前 query.ts 的 close+begin
    // 被 `if (fullText>0||fullReasoning>0)` 门槛跳过 → retry 后的 content block
    // 没有 message_start 前导 → 客户端 after-finalize drop、Django reassembler
    // 「content_block_start 但无 message_start」拒收不落库 → turn 假性中断 + 丢消息。
    // 修复后：stall retry 无条件切到全新 message 边界，恢复「每条 content_block_*
    // 必有同 message_id 的 message_start 前导」不变量。
    const mockProvider = {
      async *createStream(req: LLMRequest): AsyncIterable<LLMResponseChunk> {
        // provider 在消息最开头即 stall 并内部 retry（此刻 runtime 未累积任何内容）
        req.onRetryAttempt?.({
          attempt: 1,
          maxRetries: 3,
          delayMs: 0,
          errorMessage: 'stream stalled',
          isStallRetry: true,
        });
        // retry 后重构 envelopeState 重发 message_start hint（会被 envelope-emitter drop）
        if (req.onContentBlockEvent) {
          req.onContentBlockEvent({
            kind: ContentBlockEvents.MESSAGE_START,
            upstream_message_id: 'msg_after_stall',
          });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.CONTENT_BLOCK_START,
            index: 0,
            block_id: 'b0',
            block: { type: 'text', text: '' },
          });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.CONTENT_BLOCK_DELTA,
            index: 0,
            delta: { type: 'text_delta', text: 'recovered' },
          });
          req.onContentBlockEvent({
            kind: ContentBlockEvents.CONTENT_BLOCK_STOP,
            index: 0,
          });
          req.onContentBlockEvent({ kind: ContentBlockEvents.MESSAGE_STOP });
        }
        // 首个 fresh chunk 触发 stall 分支（text_delta，验证「无累积内容」路径）
        yield { type: 'text_delta', text: 'recovered' };
        yield { type: 'stop', stopReason: 'end_turn' };
      },
    };

    const config: EngineConfig = {
      provider: mockProvider,
      tools: createMockToolProvider([]),
      permissionHandler: createMockPermissionHandler('allow'),
      sessionConfig: { sessionDir: '/tmp/test-w2-stall-empty', threadId: 'sess-stall-empty' },
      model: 'test',
    };

    const events = await collectEvents(createRuntime(config).query({ hostRunId: 'test-run', prompt: 'recover' }));

    type Ev = { type: string; payload?: { message_id?: string } }
    const startedMessageIds = new Set<string>()
    for (const raw of events) {
      const ev = raw as Ev
      if (ev.type === ContentBlockEvents.MESSAGE_START && ev.payload?.message_id) {
        startedMessageIds.add(ev.payload.message_id)
      }
      // 核心不变量：任何 content_block_start 都必须有同 message_id 的前导 message_start
      if (ev.type === ContentBlockEvents.CONTENT_BLOCK_START) {
        expect(ev.payload?.message_id).toBeDefined()
        expect(startedMessageIds.has(ev.payload!.message_id!)).toBe(true)
      }
    }

    // stall retry 路径确实跑了：除了本轮 iteration 的 message_start，还应有一条
    // 由 stall 分支补发的新 message_start（修复前空内容场景下不会出现）。
    expect(startedMessageIds.size).toBeGreaterThanOrEqual(2)
  });
});

