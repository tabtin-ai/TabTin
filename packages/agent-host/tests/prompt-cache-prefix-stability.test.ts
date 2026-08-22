/**
 *  回归锁定：易变上下文注入（context / memory）移到「紧贴当前 user 消息
 * 之前」后，对话历史前缀跨轮保持 byte-stable，prompt cache 历史可复用。
 *
 * baseline（改前）：context-injector prepend 到 messages 头部 → 每轮变化的
 * datetime/focused/open_tabs 改写整条历史前缀字节 → cross-turn 公共前缀归零。
 * 详见 docs/agent/prompt-cache-prefix-acceptance-harness.md。
 */

import { describe, it, expect } from 'vitest';
import {
  buildContextHook,
  buildMemoryHook,
  buildRulesHook,
  type AppContext,
} from '../src/hooks/index.js';
import {
  composeHooks,
  INTERNAL_MESSAGE_MARKERS,
  hasInternalMarker,
  type Message,
  type EngineState,
} from '@tabtin/agent-runtime/engine';

function userMsg(text: string): Message {
  return { role: 'user', content: text };
}
function assistantMsg(text: string): Message {
  return { role: 'assistant', content: text };
}
function makeState(messages: Message[]): EngineState {
  return { messages } as unknown as EngineState;
}
function serialize(m: Message): string {
  return JSON.stringify({ role: m.role, content: m.content });
}

function ctxAt(tab: string, dt: string): AppContext {
  return { appType: 'chat', openTabs: [{ type: 'tabdoc', title: tab, active: true }], userTimeZone: dt };
}

describe('#2072 prompt cache 前缀稳定性', () => {
  it('context-injector 注入到当前 user 之前，历史前缀不变', async () => {
    const history = [userMsg('第一轮问题'), assistantMsg('第一轮回答')];
    const state = makeState([...history, userMsg('第二轮问题')]);
    const hook = buildContextHook({ getAppContext: async () => ctxAt('文档A', 'Asia/Shanghai') });

    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    // 布局：[history0, history1, context, currentUser]
    expect(serialize(state.messages[0]!)).toBe(serialize(history[0]!));
    expect(serialize(state.messages[1]!)).toBe(serialize(history[1]!));
    expect(hasInternalMarker(state.messages[2]!, INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION)).toBe(true);
    expect(serialize(state.messages[3]!)).toBe(serialize(userMsg('第二轮问题')));
  });

  it('跨轮：context 内容变化（不同 tab）只影响注入块，历史前缀 byte-identical', async () => {
    const history = [userMsg('第一轮问题'), assistantMsg('第一轮回答')];

    // 第二轮（聚焦文档A）
    const s1 = makeState([...history, userMsg('第二轮问题')]);
    await buildContextHook({ getAppContext: async () => ctxAt('文档A', 'Asia/Shanghai') }).beforeIteration!({ state: s1, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    // 第三轮（聚焦文档B，context 变了），历史前缀应与第二轮逐字节一致
    const s2 = makeState([...history, userMsg('第二轮问题')]);
    await buildContextHook({ getAppContext: async () => ctxAt('文档B', 'Asia/Shanghai') }).beforeIteration!({ state: s2, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    // 历史两条逐字节相同（前缀稳定）
    expect(serialize(s2.messages[0]!)).toBe(serialize(s1.messages[0]!));
    expect(serialize(s2.messages[1]!)).toBe(serialize(s1.messages[1]!));
    // 注入的 context 块内容不同（确实反映了焦点变化）
    expect(serialize(s2.messages[2]!)).not.toBe(serialize(s1.messages[2]!));
  });

  it('memory-injector 无 context 时也插到当前 user 之前，不 prepend 头部', async () => {
    const history = [userMsg('历史问题'), assistantMsg('历史回答')];
    const state = makeState([...history, userMsg('当前问题')]);
    const hook = buildMemoryHook({
      fetchAgentConfig: () => ({ enabled: true, injection: { auto_inject: true } }),
      fetchMemories: async () => [{ id: 'm1', content: '一条记忆', score: 0.9 } as never],
    });

    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    expect(serialize(state.messages[0]!)).toBe(serialize(history[0]!));
    expect(serialize(state.messages[1]!)).toBe(serialize(history[1]!));
    expect(hasInternalMarker(state.messages[2]!, INTERNAL_MESSAGE_MARKERS.MEMORY_INJECTION)).toBe(true);
    expect(serialize(state.messages[3]!)).toBe(serialize(userMsg('当前问题')));
  });

  it('rules + context + memory 组合：[rules, ...history, context, memory, currentUser]', async () => {
    const history = [userMsg('历史问题'), assistantMsg('历史回答')];
    const composed = composeHooks(
      buildContextHook({ getAppContext: async () => ctxAt('文档A', 'Asia/Shanghai') }),
      buildMemoryHook({
        fetchAgentConfig: () => ({ enabled: true, injection: { auto_inject: true } }),
        fetchMemories: async () => [{ id: 'm1', content: '一条记忆', score: 0.9 } as never],
      }),
      buildRulesHook({ fetchProjectRules: async () => '项目规约' }),
    );
    const state = makeState([...history, userMsg('当前问题')]);

    await composed.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    expect(hasInternalMarker(state.messages[0]!, INTERNAL_MESSAGE_MARKERS.PROJECT_RULES_INJECTION)).toBe(true);
    expect(serialize(state.messages[1]!)).toBe(serialize(history[0]!));
    expect(serialize(state.messages[2]!)).toBe(serialize(history[1]!));
    expect(hasInternalMarker(state.messages[3]!, INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION)).toBe(true);
    expect(hasInternalMarker(state.messages[4]!, INTERNAL_MESSAGE_MARKERS.MEMORY_INJECTION)).toBe(true);
    expect(serialize(state.messages[5]!)).toBe(serialize(userMsg('当前问题')));
  });
});
