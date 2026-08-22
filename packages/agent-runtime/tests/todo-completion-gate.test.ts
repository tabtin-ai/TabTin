/**
 * end_turn todo 完成度 gate
 */

import { describe, expect, it } from 'vitest';
import { StreamEvents } from '../src/engine/contracts/stream-events.js';
import type { Message } from '../src/engine/contracts/conversation.js';
import {
  INTERNAL_MESSAGE_MARKERS,
  hasInternalMarker,
} from '../src/engine/contracts/conversation.js';
import type { EngineState } from '../src/engine/contracts/kernel.js';
import type { RunContext } from '../src/engine/core/run-context.js';
import { RunTerminator } from '../src/engine/core/completion.js';
import { EnvelopeEmitter } from '../src/engine/wire/envelope-emitter.js';
import { extractLatestUnfinishedTodos } from '../src/todo/todo-replay.js';

function makeState(messages: Message[] = []): EngineState {
  return {
    messages,
    iteration: 0,
    pendingThinking: [],
    pendingToolUses: [],
    totalInputTokens: 0,
    totalOutputTokens: 0,
  } as unknown as EngineState;
}

function assistantTodoWrite(
  todos: Array<{ id: string; content: string; status: string }>,
): Message {
  return assistantTodoAction({ action: 'open', items: todos }, 'tu-1');
}

function assistantTodoAction(input: Record<string, unknown>, id: string): Message {
  return {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id,
        name: 'todo',
        input,
      },
    ],
  };
}

function makeRunContext(state: EngineState, agentMode: 'agent' | 'ask' = 'agent'): RunContext {
  const envelopeEmitter = new EnvelopeEmitter({
    traceId: 'trace-test',
    threadId: 'thread-test',
    runId: 'run-test',
  });
  envelopeEmitter.beginMessage({
    messageId: 'msg-1',
    modelId: 'test-model',
    modelName: 'Test Model',
    messageKind: 'llm',
  });
  return {
    state,
    config: {
      agentMode,
      todoCompletionNudgeProvider: {
        buildNudgeBody: (items) =>
          `nudge:${items.map((item) => item.id).join(',')}`,
        // 与宿主 createTodoCompletionNudgeProvider 同语义（ Stage 4）
        isEnabledForMode: (mode) => mode === undefined || mode === 'agent',
      },
    },
    traceId: 'trace-test',
    envelopeEmitter,
    deps: { observe: () => {} },
    getAssistantClientEventId: () => 'client-event-1',
    clearInflightAssistantText: () => {},
    getBudgetSnapshot: () => null,
  } as unknown as RunContext;
}

function collectSync<T>(gen: Generator<unknown, T, undefined>): { events: unknown[]; result: T } {
  const events: unknown[] = [];
  let next = gen.next();
  while (!next.done) {
    events.push(next.value);
    next = gen.next();
  }
  return { events, result: next.value };
}

describe('RunTerminator.noToolUseCompletion — todo gate', () => {
  const baseArgs = {
    toolUseBlocks: [],
    stopReason: 'end_turn' as const,
    continuationCount: 0,
    assistantMessage: { role: 'assistant' as const, content: '完成了' },
    currentLLMMessageId: 'msg-1',
    fullText: '完成了',
  };

  it('unsettled todo → continue_todo + nudge message', () => {
    const state = makeState([
      assistantTodoWrite([{ id: '1', content: '收尾', status: 'in_progress' }]),
    ]);
    const terminator = new RunTerminator(makeRunContext(state));
    const { events, result } = collectSync(
      terminator.noToolUseCompletion({
        ...baseArgs,
        todoCompletionNudgeCount: 0,
      }),
    );

    expect(result).toBe('continue_todo');
    const persistEvent = events.find(e => (e as { type: string }).type === StreamEvents.PERSIST_MESSAGE) as
      | { payload?: { message_id?: string; blocks_json?: Array<{ type: string; text?: string }> } }
      | undefined;
    expect(persistEvent?.payload?.message_id).toBe('msg-1');
    expect(persistEvent?.payload?.blocks_json?.[0]).toMatchObject({ type: 'text', text: '完成了' });
    expect(events.some(
      e => (e as { type: string; payload?: { notice_type?: string } }).payload?.notice_type
        === 'todo_completion_nudge',
    )).toBe(false);
    expect(
      state.messages.some(m => hasInternalMarker(m, INTERNAL_MESSAGE_MARKERS.TODO_COMPLETION_NUDGE)),
    ).toBe(true);
  });

  it('settled todo → break + DONE', () => {
    const state = makeState([
      assistantTodoWrite([{ id: '1', content: '收尾', status: 'completed' }]),
    ]);
    const terminator = new RunTerminator(makeRunContext(state));
    const { events, result } = collectSync(
      terminator.noToolUseCompletion({
        ...baseArgs,
        todoCompletionNudgeCount: 0,
      }),
    );
    expect(result).toBe('break');
    expect(events.some(e => (e as { type: string }).type === StreamEvents.DONE)).toBe(true);
  });

  it('paused 当前项 + pending 后续项 → break + DONE，不越过阻塞项', () => {
    const state = makeState([
      assistantTodoWrite([
        { id: '1', content: '检查 OAuth 授权', status: 'in_progress' },
        { id: '2', content: '读取授权后的数据', status: 'pending' },
      ]),
      assistantTodoAction({
        action: 'update',
        id: '1',
        status: 'paused',
        content: '等待用户完成 OAuth 授权',
      }, 'tu-2'),
    ]);
    const terminator = new RunTerminator(makeRunContext(state));
    const { events, result } = collectSync(
      terminator.noToolUseCompletion({
        ...baseArgs,
        todoCompletionNudgeCount: 0,
      }),
    );

    expect(extractLatestUnfinishedTodos(state.messages).map((t) => `${t.id}:${t.status}`)).toEqual([
      '1:paused',
      '2:pending',
    ]);
    expect(result).toBe('break');
    expect(events.some(e => (e as { type: string }).type === StreamEvents.DONE)).toBe(true);
    expect(
      state.messages.some(m => hasInternalMarker(m, INTERNAL_MESSAGE_MARKERS.TODO_COMPLETION_NUDGE)),
    ).toBe(false);
  });

  it('paused 后尝试启动另一项会被状态机忽略，gate 不会在真实 in_progress 下 DONE', () => {
    const state = makeState([
      assistantTodoWrite([
        { id: '1', content: '检查 OAuth 授权', status: 'in_progress' },
        { id: '2', content: '读取授权后的数据', status: 'pending' },
      ]),
      assistantTodoAction({
        action: 'update',
        id: '1',
        status: 'paused',
        content: '等待用户完成 OAuth 授权',
      }, 'tu-2'),
      assistantTodoAction({
        action: 'update',
        id: '2',
        status: 'in_progress',
      }, 'tu-3'),
    ]);
    const terminator = new RunTerminator(makeRunContext(state));
    const { events, result } = collectSync(
      terminator.noToolUseCompletion({
        ...baseArgs,
        todoCompletionNudgeCount: 0,
      }),
    );

    expect(result).toBe('break');
    expect(events.some(e => (e as { type: string }).type === StreamEvents.DONE)).toBe(true);
    expect(
      state.messages.some(m => hasInternalMarker(m, INTERNAL_MESSAGE_MARKERS.TODO_COMPLETION_NUDGE)),
    ).toBe(false);
  });

  it('多个 paused 后恢复其中一个时 gate 看到真实 in_progress 并继续收尾', () => {
    const state = makeState([
      assistantTodoWrite([
        { id: '1', content: '检查 OAuth 授权', status: 'in_progress' },
        { id: '2', content: '等待第二个外部条件', status: 'pending' },
      ]),
      assistantTodoAction({
        action: 'update',
        id: '1',
        status: 'paused',
        content: '等待 OAuth 授权',
      }, 'tu-2'),
      assistantTodoAction({
        action: 'update',
        id: '2',
        status: 'paused',
        content: '等待第二个外部条件',
      }, 'tu-3'),
      assistantTodoAction({
        action: 'update',
        id: '1',
        status: 'in_progress',
        content: 'OAuth 已授权，继续处理',
      }, 'tu-4'),
    ]);
    const terminator = new RunTerminator(makeRunContext(state));
    const { events, result } = collectSync(
      terminator.noToolUseCompletion({
        ...baseArgs,
        todoCompletionNudgeCount: 0,
      }),
    );

    expect(extractLatestUnfinishedTodos(state.messages).map((t) => `${t.id}:${t.status}`)).toEqual([
      '1:in_progress',
      '2:pending',
    ]);
    expect(result).toBe('continue_todo');
    expect(events.some(e => (e as { type: string }).type === StreamEvents.DONE)).toBe(false);
    expect(
      state.messages.some(m => hasInternalMarker(m, INTERNAL_MESSAGE_MARKERS.TODO_COMPLETION_NUDGE)),
    ).toBe(true);
  });

  it('nudge 达上限 → exhausted notice 后仍 DONE', () => {
    const state = makeState([
      assistantTodoWrite([{ id: '1', content: '收尾', status: 'pending' }]),
    ]);
    const terminator = new RunTerminator(makeRunContext(state));
    const { events, result } = collectSync(
      terminator.noToolUseCompletion({
        ...baseArgs,
        todoCompletionNudgeCount: 2,
      }),
    );

    expect(result).toBe('break');
    expect(events.some(
      e => (e as { payload?: { notice_type?: string } }).payload?.notice_type
        === 'todo_completion_exhausted',
    )).toBe(false);
    expect(events.some(e => (e as { type: string }).type === StreamEvents.DONE)).toBe(true);
  });

  it('ask mode 不 gate', () => {
    const state = makeState([
      assistantTodoWrite([{ id: '1', content: '收尾', status: 'pending' }]),
    ]);
    const terminator = new RunTerminator(makeRunContext(state, 'ask'));
    const { result } = collectSync(
      terminator.noToolUseCompletion({
        ...baseArgs,
        todoCompletionNudgeCount: 0,
      }),
    );

    expect(result).toBe('break');
  });
});
