/**
 *  Wave2：主→子 mid-flight 插话单测。
 *
 * 覆盖：
 *   - SubagentManager.injectUserMessage / drainPendingUserMessages
 *   - buildParentMidflightInjectorHook beforeModel 注入 + UserEvent + 六件套
 */

import { describe, it, expect, vi } from 'vitest';
import { SubagentManager } from '../src/session/subagent-manager.js';
import {
  buildParentMidflightInjectorHook,
  wrapParentMidflightGuidance,
  PARENT_MIDFLIGHT_TRIGGERED_BY,
} from '../src/subagent/parent-midflight-injector.js';
import type { BeforeModelContext, EngineState } from '../src/engine/contracts/kernel.js';
import type { Message } from '../src/engine/contracts/conversation.js';
import type { StreamEvent } from '../src/engine/contracts/wire-protocol.js';

const CHILD_ID = 'child-abc-12345678';

describe('#9155 Wave2 · SubagentManager mid-flight 队列', () => {
  it('injectUserMessage：active 子 ok + drain 清空', () => {
    const mgr = new SubagentManager({ parentThreadId: 'parent-1' });
    const ctl = new AbortController();
    mgr.registerRun(CHILD_ID, ctl, { state: 'active' });

    expect(mgr.injectUserMessage(CHILD_ID, '  先停一下，改查 B 方案  ')).toEqual({ ok: true });
    expect(mgr.injectUserMessage(CHILD_ID, '第二条')).toEqual({ ok: true });

    expect(mgr.drainPendingUserMessages(CHILD_ID)).toEqual([
      '先停一下，改查 B 方案',
      '第二条',
    ]);
    expect(mgr.drainPendingUserMessages(CHILD_ID)).toEqual([]);
  });

  it('injectUserMessage：未登记 → not_found', () => {
    const mgr = new SubagentManager({ parentThreadId: 'parent-1' });
    expect(mgr.injectUserMessage('missing', 'hi')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('injectUserMessage：queued → not_running', () => {
    const mgr = new SubagentManager({ parentThreadId: 'parent-1' });
    mgr.registerRun(CHILD_ID, new AbortController(), { state: 'queued' });
    expect(mgr.injectUserMessage(CHILD_ID, 'hi')).toEqual({ ok: false, reason: 'not_running' });
  });

  it('injectUserMessage：已 abort → not_running', () => {
    const mgr = new SubagentManager({ parentThreadId: 'parent-1' });
    const ctl = new AbortController();
    mgr.registerRun(CHILD_ID, ctl, { state: 'active' });
    ctl.abort();
    expect(mgr.injectUserMessage(CHILD_ID, 'hi')).toEqual({ ok: false, reason: 'not_running' });
  });

  it('injectUserMessage：空文本 → empty', () => {
    const mgr = new SubagentManager({ parentThreadId: 'parent-1' });
    mgr.registerRun(CHILD_ID, new AbortController(), { state: 'active' });
    expect(mgr.injectUserMessage(CHILD_ID, '   ')).toEqual({ ok: false, reason: 'empty' });
  });

  it('cancel / unregister 丢弃未消费队列', () => {
    const mgr = new SubagentManager({ parentThreadId: 'parent-1' });
    const unregister = mgr.registerRun(CHILD_ID, new AbortController(), { state: 'active' });
    mgr.injectUserMessage(CHILD_ID, 'pending');
    unregister();
    expect(mgr.drainPendingUserMessages(CHILD_ID)).toEqual([]);
  });
});

describe('#9155 Wave2 · buildParentMidflightInjectorHook', () => {
  function makeBeforeModelCtx(messages: Message[] = []): BeforeModelContext & { _emitted: StreamEvent[] } {
    const emitted: StreamEvent[] = [];
    const state: EngineState = {
      messages,
      systemPrompt: '',
      turnCount: 0,
      totalUsage: { inputTokens: 0, outputTokens: 0 },
    };
    return {
      state,
      iteration: 1,
      appendSystemSection: vi.fn(),
      emitEvent: (event) => { emitted.push(event); },
      emitNotice: vi.fn(),
      requestTerminate: vi.fn(),
      requestForceFinal: vi.fn(),
      _emitted: emitted,
    } as BeforeModelContext & { _emitted: StreamEvent[] };
  }

  it('beforeModel：drain → 注入 + UserEvent + role=user 六件套', async () => {
    const onInjected = vi.fn();
    const hook = buildParentMidflightInjectorHook({
      drainMessages: () => ['改查竞品 B', '  '],
      onInjected,
      generateUUID: () => 'evt-1',
    });
    const ctx = makeBeforeModelCtx([{ role: 'user', content: 'original task' }]);

    await hook.beforeModel!(ctx);

    expect(ctx.state.messages).toHaveLength(2);
    const injected = ctx.state.messages[1]!;
    expect(injected.role).toBe('user');
    expect(injected.content).toEqual([{
      type: 'text',
      text: wrapParentMidflightGuidance('改查竞品 B'),
    }]);
    expect(onInjected).toHaveBeenCalledTimes(1);
    expect(onInjected.mock.calls[0]?.[0]).toBe(wrapParentMidflightGuidance('改查竞品 B'));
    expect(onInjected.mock.calls[0]?.[2]).toBe('evt-1');

    const emitted = ctx._emitted;
    expect(emitted[0]?.type).toBe('agent.stream.user');
    const userPayload = emitted[0]?.payload as Record<string, unknown>;
    expect(userPayload.triggered_by).toBe(PARENT_MIDFLIGHT_TRIGGERED_BY);
    expect(userPayload.content).toBe(wrapParentMidflightGuidance('改查竞品 B'));

    expect(emitted.map((e) => e.type)).toEqual([
      'agent.stream.user',
      'agent.stream.message_start',
      'agent.stream.content_block_start',
      'agent.stream.content_block_delta',
      'agent.stream.content_block_stop',
      'agent.stream.message_stop',
    ]);
    const startPayload = emitted[1]?.payload as Record<string, unknown>;
    expect(startPayload.role).toBe('user');
    expect(startPayload.message_id).toBe('evt-1');
    expect(startPayload.triggered_by).toBe(PARENT_MIDFLIGHT_TRIGGERED_BY);
    const deltaPayload = emitted[3]?.payload as { delta?: { text?: string } };
    expect(deltaPayload.delta?.text).toBe(wrapParentMidflightGuidance('改查竞品 B'));
  });

  it('drain 空数组时不注入、不 emit', async () => {
    const hook = buildParentMidflightInjectorHook({
      drainMessages: () => [],
    });
    const ctx = makeBeforeModelCtx();
    await hook.beforeModel!(ctx);
    expect(ctx.state.messages).toHaveLength(0);
    expect(ctx._emitted).toHaveLength(0);
  });
});
