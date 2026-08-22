/**
 * Rules Injector Hook —— 项目规则自动加载（AGENTS.md MVP）单测。
 *
 * 覆盖 PRD §6 hook 单测清单：
 *   - fetchProjectRules 返回 null / 空串 / 纯空白 → 不注入
 *   - 返回正常内容 → messages 最前出现 `<project_rules>` block
 *   - 连续两轮 → 只保留最新一条（marker filter 防堆积）
 *   - 超 charBudget → 尾截 + 截断标记
 *   - fetchProjectRules 抛错 → 静默跳过，不影响其他 messages
 *   - 注入回执 onInjected 带正确 chars / truncated（PRD §4.7）
 */

import { describe, it, expect, vi } from 'vitest';
import { buildRulesHook, buildContextHook } from '../src/hooks/index.js';
import {
  composeHooks,
  INTERNAL_MESSAGE_MARKERS,
  hasInternalMarker,
  type Message,
  type EngineState,
} from '@tabtin/agent-runtime/engine';

function userText(text: string): Message {
  return { role: 'user', content: text };
}

function makeState(messages: Message[]): EngineState {
  return { messages } as EngineState;
}

function extractText(m: Message): string {
  if (typeof m.content === 'string') return m.content;
  return m.content
    .map((b) => ((b as { type?: string }).type === 'text' ? (b as { text: string }).text : ''))
    .join('\n');
}

const RULES_MARKER = INTERNAL_MESSAGE_MARKERS.PROJECT_RULES_INJECTION;

describe('buildRulesHook', () => {
  it('fetchProjectRules 返回正常内容 → messages 最前出现 <project_rules> block', async () => {
    const hook = buildRulesHook({
      fetchProjectRules: async () => '本项目用 TypeScript，提交前跑 lint。',
    });
    const state = makeState([userText('帮我加个功能')]);
    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    expect(state.messages).toHaveLength(2);
    const injected = state.messages[0]!;
    expect(injected.role).toBe('system');
    expect(hasInternalMarker(injected, RULES_MARKER)).toBe(true);
    const text = extractText(injected);
    expect(text).toContain('<project_rules source="AGENTS.md">');
    expect(text).toContain('本项目用 TypeScript，提交前跑 lint。');
    // 真用户输入保持在后、原样不动。
    expect(state.messages[1]).toEqual(userText('帮我加个功能'));
  });

  it('返回 null → 不注入', async () => {
    const hook = buildRulesHook({ fetchProjectRules: async () => null });
    const state = makeState([userText('q')]);
    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });
    expect(state.messages).toHaveLength(1);
    expect(hasInternalMarker(state.messages[0]!, RULES_MARKER)).toBe(false);
  });

  it('返回空串 / 纯空白 → 不注入', async () => {
    for (const empty of ['', '   ', '\n\t  \n']) {
      const hook = buildRulesHook({ fetchProjectRules: async () => empty });
      const state = makeState([userText('q')]);
      await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });
      expect(state.messages).toHaveLength(1);
    }
  });

  it('连续两轮 → 只保留最新一条（marker filter 防堆积）', async () => {
    let version = 1;
    const hook = buildRulesHook({
      fetchProjectRules: async () => `规则版本 v${version}`,
    });
    const state = makeState([userText('q')]);

    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });
    version = 2;
    await hook.beforeIteration!({ state: state, iteration: 1, emitEvent: () => {}, emitNotice: () => {} });

    const markers = state.messages.filter((m) => hasInternalMarker(m, RULES_MARKER));
    expect(markers).toHaveLength(1);
    expect(extractText(markers[0]!)).toContain('规则版本 v2');
    expect(extractText(markers[0]!)).not.toContain('v1');
    // messages 仍是 [project_rules, 真用户]，不堆积。
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toBe(markers[0]);
  });

  it('第二轮文件被删/清空（fetch 返回 null）→ 撤销上一轮的 project_rules（同轮即时生效）', async () => {
    let present = true;
    const hook = buildRulesHook({
      fetchProjectRules: async () => (present ? '项目规约' : null),
    });
    const state = makeState([userText('q')]);

    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });
    expect(state.messages.filter((m) => hasInternalMarker(m, RULES_MARKER))).toHaveLength(1);

    present = false; // 文件被删
    await hook.beforeIteration!({ state: state, iteration: 1, emitEvent: () => {}, emitNotice: () => {} });
    // 旧的 project_rules 被撤掉，只剩真用户消息。
    expect(state.messages.filter((m) => hasInternalMarker(m, RULES_MARKER))).toHaveLength(0);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toEqual(userText('q'));
  });

  it('第二轮读盘抖动（fetch 抛错）→ 保留上一轮的 project_rules（last-good 不闪烁）', async () => {
    let mode: 'ok' | 'throw' = 'ok';
    const hook = buildRulesHook({
      fetchProjectRules: async () => {
        if (mode === 'throw') throw new Error('transient IO');
        return '项目规约';
      },
    });
    const state = makeState([userText('q')]);

    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });
    const injectedRef = state.messages[0]!;
    expect(hasInternalMarker(injectedRef, RULES_MARKER)).toBe(true);

    mode = 'throw'; // 瞬时抖动
    await hook.beforeIteration!({ state: state, iteration: 1, emitEvent: () => {}, emitNotice: () => {} });
    // 抖动不撤销：上一轮的 project_rules 仍在（引用不变）。
    expect(state.messages.filter((m) => hasInternalMarker(m, RULES_MARKER))).toHaveLength(1);
    expect(state.messages[0]).toBe(injectedRef);
  });

  it('无文件且无旧 marker → state.messages 引用不变（无副作用）', async () => {
    const hook = buildRulesHook({ fetchProjectRules: async () => null });
    const original = [userText('q1'), userText('q2')];
    const state = makeState(original);
    const before = state.messages;
    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });
    expect(state.messages).toBe(before); // 没移除任何东西 → 不重建数组
  });

  it('超 charBudget → 尾截 + 截断标记', async () => {
    const big = 'x'.repeat(500);
    const hook = buildRulesHook({
      fetchProjectRules: async () => big,
      charBudget: 100,
    });
    const state = makeState([userText('q')]);
    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    const text = extractText(state.messages[0]!);
    expect(text).toContain('[project_rules truncated due to budget]');
    // 截断后 body 是 100 个 x + 标记，不是全部 500。
    expect(text).not.toContain('x'.repeat(101));
  });

  it('fetchProjectRules 抛错 → 静默跳过，不影响其他 messages', async () => {
    const hook = buildRulesHook({
      fetchProjectRules: async () => {
        throw new Error('disk on fire');
      },
    });
    const original = [userText('q1'), userText('q2')];
    const state = makeState([...original]);
    await expect(hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} })).resolves.toBeUndefined();
    expect(state.messages).toEqual(original);
  });

  it('注入回执 onInjected：未截断时 truncated=false + chars 正确', async () => {
    const onInjected = vi.fn();
    const hook = buildRulesHook({
      fetchProjectRules: async () => 'short rule',
      onInjected,
    });
    await hook.beforeIteration!({ state: makeState([userText('q')]), iteration: 0, emitEvent: () => {}, emitNotice: () => {} });
    expect(onInjected).toHaveBeenCalledTimes(1);
    expect(onInjected).toHaveBeenCalledWith({ chars: 'short rule'.length, truncated: false });
  });

  it('注入回执 onInjected：截断时 truncated=true', async () => {
    const onInjected = vi.fn();
    const hook = buildRulesHook({
      fetchProjectRules: async () => 'y'.repeat(300),
      charBudget: 50,
      onInjected,
    });
    await hook.beforeIteration!({ state: makeState([userText('q')]), iteration: 0, emitEvent: () => {}, emitNotice: () => {} });
    expect(onInjected).toHaveBeenCalledTimes(1);
    // chars 上报"实际注入的规约字符数"= budget，不含截断标记长度。
    expect(onInjected).toHaveBeenCalledWith({ chars: 50, truncated: true });
  });

  it('跳过时不调 onInjected（无噪音）', async () => {
    const onInjected = vi.fn();
    const hook = buildRulesHook({
      fetchProjectRules: async () => null,
      onInjected,
    });
    await hook.beforeIteration!({ state: makeState([userText('q')]), iteration: 0, emitEvent: () => {}, emitNotice: () => {} });
    expect(onInjected).not.toHaveBeenCalled();
  });

  it('onInjected 抛错被吞，不阻塞注入', async () => {
    const hook = buildRulesHook({
      fetchProjectRules: async () => 'rule',
      onInjected: () => {
        throw new Error('logger exploded');
      },
    });
    const state = makeState([userText('q')]);
    await expect(hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} })).resolves.toBeUndefined();
    // 注入仍然成功。
    expect(hasInternalMarker(state.messages[0]!, RULES_MARKER)).toBe(true);
  });

  it('注入位置在 context / memory 注入之上（unshift 占 messages[0]）', async () => {
    // 模拟 context-injector 已经把 context 放 messages[0] 的局面：
    // rules-injector 作为末位执行者必须抢到 messages[0]，把 context 顶到 [1]。
    const ctx: Message = {
      role: 'user',
      content: [{ type: 'text', text: '<context type="environment">...</context>' }],
    };
    (ctx as unknown as Record<string, unknown>)[INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION] = true;

    const hook = buildRulesHook({ fetchProjectRules: async () => 'rule body' });
    const state = makeState([ctx, userText('真用户输入')]);
    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    expect(hasInternalMarker(state.messages[0]!, RULES_MARKER)).toBe(true);
    expect(hasInternalMarker(state.messages[1]!, INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION)).toBe(true);
    expect(state.messages[2]).toEqual(userText('真用户输入'));
  });

  // ── 收口（2026-05-29 review）：末位装配顺序守护 + 首次可见回执 ──

  it('集成·正例：composeHooks 末位装配 → rules 占 messages[0]、context 紧贴 user 在 [1]', async () => {
    // 复刻两端宿主装配：context 先、rules 末位。rules unshift 到头部稳定占 [0]；
    // context（ 后）注入到当前 user 之前——单条 user 时落在 [1]。
    const context = buildContextHook({
      getAppContext: async () => ({ appType: 'chat' }),
    });
    const rules = buildRulesHook({ fetchProjectRules: async () => 'rule body' });
    const composed = composeHooks(context, rules); // rules 末位（正确装配）
    const state = makeState([userText('真用户输入')]);
    await composed.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    expect(hasInternalMarker(state.messages[0]!, RULES_MARKER)).toBe(true);
    expect(hasInternalMarker(state.messages[1]!, INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION)).toBe(true);
    expect(state.messages[state.messages.length - 1]).toEqual(userText('真用户输入'));
  });

  it('#2072：即使 rules 不在末位，context 也不再夺走 messages[0]（context 注入当前 user 之前）', async () => {
    //  前：context-injector unshift 到头部，一旦排在 rules 之后就夺走
    // messages[0]，project_rules 的 cache 收益静默反转。#2072 后 context 改为
    // 注入「当前 user 消息之前」，不再竞争 [0]——无论 hook 顺序，rules 稳定占
    // [0]、context 紧贴 user，历史前缀不受易变 context 影响。
    const context = buildContextHook({
      getAppContext: async () => ({ appType: 'chat' }),
    });
    const rules = buildRulesHook({ fetchProjectRules: async () => 'rule body' });
    const composed = composeHooks(rules, context); // rules 在前（旧版会出问题）
    const state = makeState([userText('真用户输入')]);
    await composed.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    // 布局：[rules, context, user]——rules 仍占 [0]，context 在 user 之前。
    expect(hasInternalMarker(state.messages[0]!, RULES_MARKER)).toBe(true);
    expect(hasInternalMarker(state.messages[1]!, INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION)).toBe(true);
    expect(state.messages[state.messages.length - 1]).toEqual(userText('真用户输入'));
  });

  it('首次成功注入 → push 一条 project_rules_loaded SYSTEM_NOTICE；后续轮不重复（session 只发一次）', async () => {
    const hook = buildRulesHook({ fetchProjectRules: async () => 'rule body' });
    const state = makeState([userText('q')]);
    state.__pendingNotices = [];

    await hook.beforeIteration!({ state: state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });
    const round1 = (state.__pendingNotices ?? []).filter(
      (n) => (n.payload as { notice_type?: string }).notice_type === 'project_rules_loaded',
    );
    expect(round1).toHaveLength(1);
    expect((round1[0]!.payload as { content: string }).content).toContain('AGENTS.md');

    // 第二轮仍注入规约，但不再重复发可见回执。
    state.__pendingNotices = [];
    await hook.beforeIteration!({ state: state, iteration: 1, emitEvent: () => {}, emitNotice: () => {} });
    const round2 = (state.__pendingNotices ?? []).filter(
      (n) => (n.payload as { notice_type?: string }).notice_type === 'project_rules_loaded',
    );
    expect(round2).toHaveLength(0);
  });
});
