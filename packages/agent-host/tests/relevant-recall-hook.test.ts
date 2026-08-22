/**
 * relevant-recall-injector 单测。
 *
 * 覆盖：
 *   1. 无召回内容 → 不注入，且清掉残留旧块
 *   2. 有召回内容 → 注入带 marker 的 user 消息，贴 context/memory/todo 之后、当前 user 前
 *   3. 每轮 filter 旧块再重插：召回变化时替换，不堆积
 *   4. 召回不变时重插同字节到同位置（幂等）
 */

import { describe, expect, it } from 'vitest';
import {
  INTERNAL_MESSAGE_MARKERS,
  hasInternalMarker,
  setInternalMarker,
  type Message,
  type EngineState,
} from '@tabtin/agent-runtime/engine';
import { makeIterationCtx } from './fixtures/iteration-ctx.js';
import { buildRelevantRecallHook } from '../src/hooks/index.js';

const REL_MARKER = INTERNAL_MESSAGE_MARKERS.RELEVANT_RECALL_INJECTION;
const CTX_MARKER = INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION;
const TODO_MARKER = INTERNAL_MESSAGE_MARKERS.TODO_STATE_INJECTION;

function messageText(m: Message): string {
  if (typeof m.content === 'string') return m.content;
  return m.content.map(b => (b.type === 'text' ? b.text : '')).join('');
}

function ctxMsg(): Message {
  return setInternalMarker({ role: 'user', content: '<context type="environment">env</context>' }, CTX_MARKER);
}

function todoMsg(): Message {
  return setInternalMarker(
    { role: 'user', content: [{ type: 'text', text: '<context type="active-todos">todos</context>' }] },
    TODO_MARKER,
  );
}

async function run(state: EngineState, blocks: Array<string | undefined>): Promise<void> {
  const hook = buildRelevantRecallHook({ getRelevantContextBlocks: () => blocks });
  await hook.beforeIteration!(makeIterationCtx(state));
}

describe('buildRelevantRecallHook', () => {
  it('无召回内容 → 不注入', async () => {
    const state = { messages: [{ role: 'user', content: '请求' }] } as EngineState;
    await run(state, [undefined, '']);
    expect(state.messages.some(m => hasInternalMarker(m, REL_MARKER))).toBe(false);
    expect(state.messages).toHaveLength(1);
  });

  it('有召回内容 → 注入带 marker 的 user 消息，贴 context/todo 之后、当前 user 前', async () => {
    const state = {
      messages: [ctxMsg(), todoMsg(), { role: 'user', content: '请求' }],
    } as EngineState;
    await run(state, ['<relevant_skills>\nA\n</relevant_skills>', '<relevant_cli>\nB\n</relevant_cli>']);

    const relIdx = state.messages.findIndex(m => hasInternalMarker(m, REL_MARKER));
    const userIdx = state.messages.findIndex(m => !hasInternalMarker(m, REL_MARKER) && !hasInternalMarker(m, CTX_MARKER) && !hasInternalMarker(m, TODO_MARKER) && m.role === 'user');
    const todoIdx = state.messages.findIndex(m => hasInternalMarker(m, TODO_MARKER));
    expect(relIdx).toBeGreaterThan(todoIdx); // 在 todo 之后
    expect(relIdx).toBeLessThan(userIdx); // 在真实 user 之前
    const text = messageText(state.messages[relIdx]!);
    expect(text).toContain('<relevant_skills>');
    expect(text).toContain('<relevant_cli>');
  });

  it('每轮 filter 旧块再重插：召回变化时替换不堆积', async () => {
    const state = { messages: [ctxMsg(), { role: 'user', content: '请求' }] } as EngineState;
    await run(state, ['<relevant_skills>\nOLD\n</relevant_skills>']);
    await run(state, ['<relevant_skills>\nNEW\n</relevant_skills>']);

    const relBlocks = state.messages.filter(m => hasInternalMarker(m, REL_MARKER));
    expect(relBlocks).toHaveLength(1);
    expect(messageText(relBlocks[0]!)).toContain('NEW');
    expect(messageText(relBlocks[0]!)).not.toContain('OLD');
  });

  it('召回从有到无 → 清掉旧块', async () => {
    const state = { messages: [ctxMsg(), { role: 'user', content: '请求' }] } as EngineState;
    await run(state, ['<relevant_skills>\nA\n</relevant_skills>']);
    expect(state.messages.some(m => hasInternalMarker(m, REL_MARKER))).toBe(true);
    await run(state, []);
    expect(state.messages.some(m => hasInternalMarker(m, REL_MARKER))).toBe(false);
  });

  it('无 context 块 → 回退到最后一条真实 user 之前', async () => {
    const state = { messages: [{ role: 'user', content: '请求' }] } as EngineState;
    await run(state, ['<relevant_skills>\nA\n</relevant_skills>']);
    const relIdx = state.messages.findIndex(m => hasInternalMarker(m, REL_MARKER));
    const userIdx = state.messages.findIndex(m => !hasInternalMarker(m, REL_MARKER) && m.role === 'user');
    expect(relIdx).toBeLessThan(userIdx);
  });
});
