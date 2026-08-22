/**
 * todo-state-injector hook 单测
 */

import { describe, expect, it } from 'vitest';
import { buildTodoStateHook } from '../src/hooks/index.js';
import {
  INTERNAL_MESSAGE_MARKERS,
  hasInternalMarker,
  setInternalMarker,
  type Message,
  type EngineState,
  type ToolContext,
} from '@tabtin/agent-runtime/engine';
import type { TodoSessionAnchor } from '@tabtin/agent-runtime';
import { createCoreTools } from '@tabtin/agent-runtime/tools';

const TODO_MARKER = INTERNAL_MESSAGE_MARKERS.TODO_STATE_INJECTION;

function makeState(messages: Message[] = []): EngineState {
  return {
    messages,
    iteration: 0,
    pendingThinking: [],
    pendingToolUses: [],
  } as unknown as EngineState;
}

function userMsg(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function assistantTodoWrite(
  todos: Array<{ id: string; content: string; status: string }>,
  toolUseId = 'tu-1',
): Message {
  return {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: toolUseId,
        name: 'todo',
        input: { action: 'open', items: todos },
      },
    ],
  };
}

function todoWriteResult(toolUseId = 'tu-1'): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }],
  };
}

describe('buildTodoStateHook', () => {
  it('agent mode + unsettled → 注入 active-todos wrapper', async () => {
    const hook = buildTodoStateHook({ getAgentMode: () => 'agent' });
    const state = makeState([
      userMsg('帮我做三步任务'),
      assistantTodoWrite([
        { id: '1', content: '步骤一', status: 'completed' },
        { id: '2', content: '步骤二', status: 'in_progress' },
      ]),
    ]);

    await hook.beforeIteration!({
      state,
      iteration: 1,
      emitEvent: () => {},
      emitNotice: () => {},
    });

    const injected = state.messages.find(m => hasInternalMarker(m, TODO_MARKER));
    expect(injected).toBeDefined();
    const text = (injected!.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain('<context type="active-todos">');
    expect(text).toContain('当前待办进度：1/2');
    expect(text).toContain('[进行中] 步骤二');
  });

  it('ask mode → 跳过且不保留旧 marker', async () => {
    const hook = buildTodoStateHook({ getAgentMode: () => 'ask' });
    const stale = setInternalMarker(userMsg('stale'), TODO_MARKER);
    const state = makeState([
      stale,
      assistantTodoWrite([{ id: '1', content: 'X', status: 'pending' }]),
    ]);

    await hook.beforeIteration!({ state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    expect(state.messages.some(m => hasInternalMarker(m, TODO_MARKER))).toBe(false);
  });

  it('settled 批 → 不注入', async () => {
    const hook = buildTodoStateHook({ getAgentMode: () => 'agent' });
    const state = makeState([
      assistantTodoWrite([{ id: '1', content: '完成', status: 'completed' }]),
    ]);

    await hook.beforeIteration!({ state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    expect(state.messages.some(m => hasInternalMarker(m, TODO_MARKER))).toBe(false);
  });

  it('每轮 filter+重插单块：待办未变更时仍只有一块、位置稳定', async () => {
    const hook = buildTodoStateHook({ getAgentMode: () => 'agent' });
    const state = makeState([
      assistantTodoWrite([{ id: '1', content: 'A', status: 'in_progress' }]),
      todoWriteResult(),
    ]);

    await hook.beforeIteration!({ state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });
    const firstIdx = state.messages.findIndex(m => hasInternalMarker(m, TODO_MARKER));
    await hook.beforeIteration!({ state, iteration: 1, emitEvent: () => {}, emitNotice: () => {} });

    expect(state.messages.filter(m => hasInternalMarker(m, TODO_MARKER))).toHaveLength(1);
    expect(state.messages.findIndex(m => hasInternalMarker(m, TODO_MARKER))).toBe(firstIdx);
  });

  it('按时序注入：快照插在最后一次 todo 的 tool_result 之后', async () => {
    const hook = buildTodoStateHook({ getAgentMode: () => 'agent' });
    const state = makeState([
      userMsg('帮我做任务'),
      assistantTodoWrite([{ id: '1', content: '步骤一', status: 'in_progress' }]),
      todoWriteResult(),
      { role: 'assistant', content: [{ type: 'text', text: '继续干活' }] },
    ]);

    await hook.beforeIteration!({ state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    const todoIdx = state.messages.findIndex(m => hasInternalMarker(m, TODO_MARKER));
    const resultIdx = state.messages.findIndex(
      m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result'),
    );
    // 紧贴 tool_result 之后，而非历史顶部的真实用户消息之前。
    expect(todoIdx).toBe(resultIdx + 1);
  });

  it('新 todo 出现时单块随锚点前移，仍只有一块且反映最新合并态', async () => {
    const hook = buildTodoStateHook({ getAgentMode: () => 'agent' });
    const state = makeState([
      userMsg('多步任务'),
      assistantTodoWrite([{ id: '1', content: 'A', status: 'in_progress' }], 'tu-1'),
      todoWriteResult('tu-1'),
    ]);

    await hook.beforeIteration!({ state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });
    expect(state.messages.filter(m => hasInternalMarker(m, TODO_MARKER))).toHaveLength(1);

    // 模拟后续工作：先 add B，再把 A 标完成（避免 A 单独 completed 触发自动 close）。
    state.messages.push({ role: 'assistant', content: [{ type: 'text', text: '做完 A' }] });
    state.messages.push({
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'tu-2a',
          name: 'todo',
          input: { action: 'add', item: { id: '2', content: 'B', status: 'pending' } },
        },
        {
          type: 'tool_use',
          id: 'tu-2b',
          name: 'todo',
          input: { action: 'update', id: '1', status: 'completed' },
        },
        {
          type: 'tool_use',
          id: 'tu-2c',
          name: 'todo',
          input: { action: 'update', id: '2', status: 'in_progress' },
        },
      ],
    });
    state.messages.push({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu-2a', content: 'ok' },
        { type: 'tool_result', tool_use_id: 'tu-2b', content: 'ok' },
        { type: 'tool_result', tool_use_id: 'tu-2c', content: 'ok' },
      ],
    });

    await hook.beforeIteration!({ state, iteration: 1, emitEvent: () => {}, emitNotice: () => {} });

    const markerIdxs = state.messages
      .map((m, idx) => (hasInternalMarker(m, TODO_MARKER) ? idx : -1))
      .filter(idx => idx >= 0);
    // 单块不累积。
    expect(markerIdxs).toHaveLength(1);
    // 块随第二次 todo 前移到其 tool_result 之后。
    const secondResultIdx = state.messages.findIndex(
      m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result' && b.tool_use_id === 'tu-2c'),
    );
    expect(markerIdxs[0]).toBe(secondResultIdx + 1);
    // 内容反映合并后的全量态。
    const block = state.messages[markerIdxs[0]!]!;
    const text = (block.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain('[进行中] B');
  });

  it('会话级锚：todo 被上下文截断挤掉后仍注入待办', async () => {
    const hook = buildTodoStateHook({ getAgentMode: () => 'agent' });

    // 第 1 轮：窗口里有创建 todo 的 todo。
    const round1 = makeState([
      userMsg('帮我做两步任务'),
      assistantTodoWrite([
        { id: '1', content: '步骤一', status: 'in_progress' },
        { id: '2', content: '步骤二', status: 'pending' },
      ]),
    ]);
    await hook.beforeIteration!({ state: round1, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });
    expect(round1.messages.some(m => hasInternalMarker(m, TODO_MARKER))).toBe(true);

    // 第 2 轮：模拟上下文截断——窗口里已经没有 todo，只剩后续工具往返。
    const round2 = makeState([
      userMsg('[对话历史因长度限制已被截断]'),
      { role: 'assistant', content: [{ type: 'text', text: '继续搜索' }] },
    ]);
    await hook.beforeIteration!({ state: round2, iteration: 1, emitEvent: () => {}, emitNotice: () => {} });

    const injected = round2.messages.find(m => hasInternalMarker(m, TODO_MARKER));
    expect(injected).toBeDefined();
    const text = (injected!.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain('<context type="active-todos">');
    expect(text).toContain('[进行中] 步骤一');
    expect(text).toContain('步骤二');
  });

  it('会话级锚：截断后收到 merge=true 完成态 → 全批 settled 则不再注入', async () => {
    const hook = buildTodoStateHook({ getAgentMode: () => 'agent' });

    const round1 = makeState([
      assistantTodoWrite([
        { id: '1', content: '步骤一', status: 'in_progress' },
        { id: '2', content: '步骤二', status: 'pending' },
      ]),
    ]);
    await hook.beforeIteration!({ state: round1, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    // 截断后窗口里只有把两步都收尾的 merge=true（种子补齐另一条）。
    const round2 = makeState([
      assistantTodoWrite([
        { id: '1', content: '步骤一', status: 'completed' },
        { id: '2', content: '步骤二', status: 'completed' },
      ]),
    ]);
    await hook.beforeIteration!({ state: round2, iteration: 1, emitEvent: () => {}, emitNotice: () => {} });

    expect(round2.messages.some(m => hasInternalMarker(m, TODO_MARKER))).toBe(false);
  });

  it('共享锚：hook 写入后截断窗口 execute update 仍成功', async () => {
    const sessionAnchor: TodoSessionAnchor = { current: null };
    const hook = buildTodoStateHook({
      getAgentMode: () => 'agent',
      sessionAnchor,
    });
    const round1 = makeState([
      assistantTodoWrite([
        { id: '1', content: '步骤一', status: 'in_progress' },
        { id: '2', content: '步骤二', status: 'pending' },
      ]),
    ]);
    await hook.beforeIteration!({
      state: round1,
      iteration: 0,
      emitEvent: () => {},
      emitNotice: () => {},
    });
    expect(sessionAnchor.current?.map((t) => t.id)).toEqual(['1', '2']);

    const todo = createCoreTools({ todoSessionAnchor: sessionAnchor }).find(
      (t) => t.name === 'todo',
    );
    if (!todo) throw new Error('todo tool missing');

    const truncated: Message[] = [
      userMsg('[截断]'),
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu-upd',
            name: 'todo',
            input: { action: 'update', id: '1', status: 'completed' },
          },
        ],
      },
    ];
    const ctx: ToolContext = {
      threadId: 't',
      runtimeId: 'rt',
      agentRunId: 'ar',
      toolUseId: 'tu-upd',
      abortSignal: new AbortController().signal,
      messages: truncated,
    };
    const result = await todo.execute(
      { action: 'update', id: '1', status: 'completed' },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(sessionAnchor.current?.find((t) => t.id === '1')?.status).toBe('completed');
  });

  it('时序注入不再绑定 context/memory 注入位，而是贴最近 todo', async () => {
    const hook = buildTodoStateHook({ getAgentMode: () => 'agent' });
    // 真实用户消息 + 其后的一次 todo 往返。时序位应落在 todo 附近，
    // 而非真实用户消息（历史顶部）之前。
    const state = makeState([
      userMsg('real user'),
      assistantTodoWrite([{ id: '1', content: '待办', status: 'in_progress' }]),
      todoWriteResult(),
    ]);

    await hook.beforeIteration!({ state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    const userIdx = state.messages.findIndex(
      m => Array.isArray(m.content) && m.content.some(b => b.type === 'text' && b.text === 'real user'),
    );
    const todoIdx = state.messages.findIndex(m => hasInternalMarker(m, TODO_MARKER));
    // 注入在真实用户消息之后（时序尾部），不再是其之前。
    expect(todoIdx).toBeGreaterThan(userIdx);
  });
});
