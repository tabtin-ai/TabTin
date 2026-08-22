/**
 *  回归锁定：environment context 作为独立 immutable 历史块累积。
 *
 * 落库后的 environment context 块从历史重建时 marker 已丢失（types.ts 设计），
 * 需 `markHistoricalContextMessages` 按 content 补打 `HISTORICAL_CONTEXT` marker。
 * 补打后：
 *   1) normalizer 把它归 'context_injection' kind → 不与相邻真 user 合并；
 *   2) context-injector 的 fresh-block filter（只删 CONTEXT_INJECTION）不碰它 →
 *      历史 context immutable，连同历史前缀跨轮 byte-stable；
 *   3) 当前轮 fresh context 仍注入到当前 user 之前（ 语义保留）。
 */

import { describe, it, expect } from 'vitest';
import { buildUserContextWrapper } from '@tabtin/agent-prompt';
import { buildContextHook, type AppContext } from '../src/hooks/index.js';
import {
  markHistoricalContextMessages,
  INTERNAL_MESSAGE_MARKERS,
  hasInternalMarker,
  type Message,
  type EngineState,
} from '@tabtin/agent-runtime/engine';
import { mergeConsecutiveMessages, classifyUserMessageForMerge } from '@tabtin/agent-runtime/engine/message-normalizer';

function userMsg(text: string): Message {
  return { role: 'user', content: text };
}
function assistantMsg(text: string): Message {
  return { role: 'assistant', content: text };
}
/** 模拟从 DB 重建的、已落库的 environment context 块（无 in-memory marker）。 */
function persistedEnvCtx(body: string): Message {
  return { role: 'user', content: [{ type: 'text', text: buildUserContextWrapper('environment', body) }] };
}
function makeState(messages: Message[]): EngineState {
  return { messages } as unknown as EngineState;
}
function serialize(m: Message): string {
  return JSON.stringify({ role: m.role, content: m.content });
}
function ctxAt(tab: string): AppContext {
  return { appType: 'chat', openTabs: [{ type: 'tabdoc', title: tab, active: true }], userTimeZone: 'Asia/Shanghai' };
}

describe('#2099 environment context 历史累积', () => {
  it('markHistoricalContextMessages 给历史 environment 块补 HISTORICAL_CONTEXT marker，不碰真 user', () => {
    const msgs = [persistedEnvCtx('current_datetime: 2026-06-29 10:00'), userMsg('真用户问题'), assistantMsg('回答')];
    markHistoricalContextMessages(msgs);
    expect(hasInternalMarker(msgs[0]!, INTERNAL_MESSAGE_MARKERS.HISTORICAL_CONTEXT)).toBe(true);
    expect(hasInternalMarker(msgs[1]!, INTERNAL_MESSAGE_MARKERS.HISTORICAL_CONTEXT)).toBe(false);
  });

  it('真用户消息里恰好提到 wrapper 文本但不以其起头 → 不误标', () => {
    const msgs = [userMsg('帮我看看 <context type="environment"> 是什么意思')];
    markHistoricalContextMessages(msgs);
    expect(hasInternalMarker(msgs[0]!, INTERNAL_MESSAGE_MARKERS.HISTORICAL_CONTEXT)).toBe(false);
  });

  it('补标后归 context_injection kind → 不与相邻真 user 合并', () => {
    const msgs = [persistedEnvCtx('env'), userMsg('真问题')];
    markHistoricalContextMessages(msgs);
    expect(classifyUserMessageForMerge(msgs[0]!)).toBe('context_injection');
    const { messages, merged } = mergeConsecutiveMessages(msgs, 'user');
    expect(merged).toBe(0);
    expect(messages).toHaveLength(2);
  });

  it('context-injector 不删历史 context 块，只在当前 user 前插 fresh', async () => {
    const msgs = [
      persistedEnvCtx('historical-env'),
      userMsg('第一轮问题'),
      assistantMsg('第一轮回答'),
      userMsg('第二轮问题'),
    ];
    markHistoricalContextMessages(msgs);
    const state = makeState(msgs);
    await buildContextHook({ getAppContext: async () => ctxAt('文档A') }).beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    // 历史 context 块仍在 [0] 且 marker 保留（immutable）
    expect(hasInternalMarker(state.messages[0]!, INTERNAL_MESSAGE_MARKERS.HISTORICAL_CONTEXT)).toBe(true);
    expect((state.messages[0]!.content as { text: string }[])[0]!.text).toContain('historical-env');
    // fresh context 注入在当前 user 之前
    const lastIdx = state.messages.length - 1;
    expect(serialize(state.messages[lastIdx]!)).toBe(serialize(userMsg('第二轮问题')));
    expect(hasInternalMarker(state.messages[lastIdx - 1]!, INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION)).toBe(true);
  });

  // 环境部分用 workspaceMode 保证确定性（不受 tab 名渲染差异影响）。
  const DESKTOP_ENV = 'workspace_mode: desktop（工具打开的页面会显示在桌面工作台）';
  const CONV_ENV = 'workspace_mode: conversation（工具打开的页面会显示在当前对话的右侧画布）';
  function histCtx(envBody: string): Message {
    return {
      role: 'user',
      content: buildUserContextWrapper('environment', `current_datetime: 2026-01-01 00:00 (UTC+0)\n${envBody}`),
    };
  }

  it('环境未变：本轮只发时间 + 声明，不重复完整环境', async () => {
    const msgs: Message[] = [
      histCtx(DESKTOP_ENV),
      userMsg('历史问题'),
      assistantMsg('历史回答'),
      userMsg('当前问题'),
    ];
    markHistoricalContextMessages(msgs);
    const state = makeState(msgs);
    await buildContextHook({ getAppContext: async () => ({ workspaceMode: 'desktop' }) }).beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    // 仍注入 fresh（时间每轮变），但内容 = 时间 + 声明，不重复 DESKTOP_ENV。
    const lastIdx = state.messages.length - 1;
    expect(serialize(state.messages[lastIdx]!)).toBe(serialize(userMsg('当前问题')));
    const fresh = state.messages[lastIdx - 1]!;
    expect(hasInternalMarker(fresh, INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION)).toBe(true);
    const text = fresh.content as string;
    expect(text).toContain('current_datetime:');
    expect(text).toContain('环境未变');
    expect(text).not.toContain('workspace_mode: desktop');
  });

  it('环境变化：本轮发时间 + 完整环境', async () => {
    const msgs: Message[] = [
      histCtx(CONV_ENV),
      userMsg('历史问题'),
      assistantMsg('历史回答'),
      userMsg('当前问题'),
    ];
    markHistoricalContextMessages(msgs);
    const state = makeState(msgs);
    await buildContextHook({ getAppContext: async () => ({ workspaceMode: 'desktop' }) }).beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    const lastIdx = state.messages.length - 1;
    const fresh = state.messages[lastIdx - 1]!;
    expect(hasInternalMarker(fresh, INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION)).toBe(true);
    const text = fresh.content as string;
    expect(text).toContain('workspace_mode: desktop');
    expect(text).not.toContain('环境未变');
  });

  it('连续多轮未变：跳过声明块、与最近真实环境比对（不把声明误当基线）', async () => {
    const msgs: Message[] = [
      histCtx(DESKTOP_ENV), // 轮1 真实环境
      userMsg('u1'),
      assistantMsg('a1'),
      // 轮2 声明块（环境未变）
      { role: 'user', content: buildUserContextWrapper('environment', 'current_datetime: 2026-01-01 00:01 (UTC+0)\n\n(环境未变，同上一条 environment context)') },
      userMsg('u2'),
      assistantMsg('a2'),
      userMsg('当前问题'),
    ];
    markHistoricalContextMessages(msgs);
    const state = makeState(msgs);
    await buildContextHook({ getAppContext: async () => ({ workspaceMode: 'desktop' }) }).beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    // 当前环境仍是 desktop，应跳过轮2声明块、与轮1真实环境比对 → 判定未变 → 发声明。
    const fresh = state.messages[state.messages.length - 2]!;
    const text = fresh.content as string;
    expect(text).toContain('环境未变');
    expect(text).not.toContain('workspace_mode: desktop');
  });

  it('跨轮：历史 context 块（含上一轮 env）整段 byte-stable，仅当前轮 fresh + user 为新', async () => {
    // 第 N 轮已落库历史：[env@t1, u1, a1, env@t2, u2, a2]，当前轮 u3
    const baseHistory: Message[] = [
      persistedEnvCtx('env-turn1'),
      userMsg('u1'),
      assistantMsg('a1'),
      persistedEnvCtx('env-turn2'),
      userMsg('u2'),
      assistantMsg('a2'),
    ];

    const sN = makeState([...baseHistory.map((m) => ({ ...m })), userMsg('u3')]);
    markHistoricalContextMessages(sN.messages);
    await buildContextHook({ getAppContext: async () => ctxAt('文档A') }).beforeIteration!({ state: sN, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    const sN1 = makeState([...baseHistory.map((m) => ({ ...m })), userMsg('u3')]);
    markHistoricalContextMessages(sN1.messages);
    await buildContextHook({ getAppContext: async () => ctxAt('文档B') }).beforeIteration!({ state: sN1, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    // 前 6 条历史（含两轮已落库 env 块）逐字节一致 —— 累积的历史前缀稳定
    for (let i = 0; i < 6; i++) {
      expect(serialize(sN1.messages[i]!)).toBe(serialize(sN.messages[i]!));
    }
  });
});
