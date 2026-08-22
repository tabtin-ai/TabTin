/**
 * Mode reminder injector hook — Phase 2 per-turn sparse reminder。
 */

import { describe, it, expect } from 'vitest';
import {
  buildModeReminderHook,
  shouldInjectModeReminderThisTurn,
} from '../src/hooks/index.js';
import {
  mergeConsecutiveMessages,
  INTERNAL_MESSAGE_MARKERS,
  hasInternalMarker,
  setInternalMarker,
  type Message,
  type EngineState,
} from '@tabtin/agent-runtime/engine';

function userText(text: string): Message {
  return { role: 'user', content: text };
}

function makeState(messages: Message[]): EngineState {
  return { messages } as EngineState;
}

function getMessageText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((block) => (typeof block === 'object' && block && 'text' in block ? String(block.text) : ''))
    .join('\n');
}

describe('buildModeReminderHook', () => {
  it('iteration 0 injects reminder after last real user in plan mode', async () => {
    const hook = buildModeReminderHook({ getAgentMode: () => 'plan' });
    const state = makeState([
      userText('第一轮问题'),
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      userText('第二轮问题'),
    ]);
    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });
    expect(state.messages).toHaveLength(4);
    const reminder = state.messages[3]!;
    expect(reminder.role).toBe('system');
    expect(hasInternalMarker(reminder, INTERNAL_MESSAGE_MARKERS.MODE_REMINDER_INJECTION)).toBe(true);
    const text = getMessageText(reminder);
    expect(text).toContain('type="mode-reminder"');
    expect(text).toContain('<system-reminder>');
    expect(state.messages[0]).toEqual(userText('第一轮问题'));
    expect(state.messages[2]).toEqual(userText('第二轮问题'));
  });

  it('skips injection when iteration !== 0', async () => {
    const hook = buildModeReminderHook({ getAgentMode: () => 'ask' });
    const state = makeState([userText('q')]);
    await hook.beforeIteration!({ state: state, iteration: 1, emitEvent: () => {}, emitNotice: () => {} });
    expect(state.messages).toHaveLength(1);
  });

  it('clears old marker before injecting new one', async () => {
    const hook = buildModeReminderHook({ getAgentMode: () => 'ask' });
    const old = setInternalMarker(userText('stale'), INTERNAL_MESSAGE_MARKERS.MODE_REMINDER_INJECTION);
    const state = makeState([userText('real'), old]);
    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });
    const markers = state.messages.filter((m) =>
      hasInternalMarker(m, INTERNAL_MESSAGE_MARKERS.MODE_REMINDER_INJECTION),
    );
    expect(markers).toHaveLength(1);
  });

  it('mode switch to agent removes reminder', async () => {
    const hook = buildModeReminderHook({ getAgentMode: () => 'agent' });
    const old = setInternalMarker(userText('old'), INTERNAL_MESSAGE_MARKERS.MODE_REMINDER_INJECTION);
    const state = makeState([userText('real'), old]);
    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });
    expect(
      state.messages.some((m) =>
        hasInternalMarker(m, INTERNAL_MESSAGE_MARKERS.MODE_REMINDER_INJECTION),
      ),
    ).toBe(false);
  });

  it('turnsBetween throttles injection', () => {
    const msgs: Message[] = [
      userText('t1'),
      setInternalMarker(userText('r1'), INTERNAL_MESSAGE_MARKERS.MODE_REMINDER_INJECTION),
      userText('t2'),
    ];
    expect(shouldInjectModeReminderThisTurn(msgs, 5)).toBe(false);
    expect(shouldInjectModeReminderThisTurn([userText('only')], 5)).toBe(true);
  });

  it('W4: mode_reminder does not merge with adjacent real user', () => {
    const hook = buildModeReminderHook({ getAgentMode: () => 'plan' });
    const state = makeState([userText('用户真实输入')]);
    void hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });
    const { messages, merged } = mergeConsecutiveMessages(state.messages, 'user');
    expect(merged).toBe(0);
    expect(messages.length).toBe(2);
  });

  it('iteration 0 injects reminder in study mode', async () => {
    const hook = buildModeReminderHook({ getAgentMode: () => 'study' });
    const state = makeState([userText('学习问题')]);
    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });
    expect(state.messages).toHaveLength(2);
    const reminder = state.messages[1]!;
    expect(hasInternalMarker(reminder, INTERNAL_MESSAGE_MARKERS.MODE_REMINDER_INJECTION)).toBe(true);
    const text = getMessageText(reminder);
    expect(text).toContain('Study');
  });

  it('plan reminder does not leak path placeholder when active plan path is provided', async () => {
    const hook = buildModeReminderHook({
      getAgentMode: () => 'plan',
      getActivePlanFilePath: () => 'plans/active-plan.md',
    });
    const state = makeState([userText('规划问题')]);
    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });
    const reminder = state.messages[1]!;
    const text = getMessageText(reminder);
    expect(text).not.toContain('{{planFilePath}}');
    expect(text).toContain('Plan 模式');
  });

  it('plan reminder omits path placeholder when no active plan path', async () => {
    const hook = buildModeReminderHook({ getAgentMode: () => 'plan' });
    const state = makeState([userText('规划问题')]);
    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });
    const reminder = state.messages[1]!;
    const text = getMessageText(reminder);
    expect(text).not.toContain('{{planFilePath}}');
  });
});

describe('mode transition reminder', () => {
  it('injects once for pending mode transition, then clears', async () => {
    let pending: { fromMode: 'ask'; toMode: 'agent' } | undefined = { fromMode: 'ask', toMode: 'agent' };
    const hook = buildModeReminderHook({
      getAgentMode: () => 'agent',
      getPendingModeTransition: () => pending,
      clearPendingModeTransition: () => {
        pending = undefined;
      },
    });
    const state = makeState([userText('继续执行')]);
    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });
    expect(pending).toBeUndefined();
    expect(state.messages).toHaveLength(2);
    const transitionReminder = state.messages[1]!;
    expect(
      hasInternalMarker(transitionReminder, INTERNAL_MESSAGE_MARKERS.MODE_TRANSITION_REMINDER),
    ).toBe(true);
    const text =
      typeof transitionReminder.content === 'string'
        ? transitionReminder.content
        : (transitionReminder.content[0] as { text: string }).text;
    expect(text).toContain('type="mode-transition-reminder"');
    expect(text).toContain('ask');
    expect(text).toContain('agent');
    expect(text).toContain('不要再要求用户重复切换模式');

    const state2 = makeState([userText('第二轮')]);
    await hook.beforeIteration!({ state: state2, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });
    expect(
      state2.messages.some((m) =>
        hasInternalMarker(m, INTERNAL_MESSAGE_MARKERS.MODE_TRANSITION_REMINDER),
      ),
    ).toBe(false);
  });});

describe('engine-message-normalizer mode_reminder kind', () => {
  it('mode_reminder and real user are not merged', () => {
    const reminder = setInternalMarker(
      userText('<context type="mode-reminder">x</context>'),
      INTERNAL_MESSAGE_MARKERS.MODE_REMINDER_INJECTION,
    );
    const { messages, merged } = mergeConsecutiveMessages([
      userText('真实用户'),
      reminder,
      userText('下一条真实'),
    ], 'user');
    expect(merged).toBe(0);
    expect(messages.length).toBe(3);
  });
});
