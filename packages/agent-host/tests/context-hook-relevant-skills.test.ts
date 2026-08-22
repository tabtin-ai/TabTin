/**
 * context-injector 环境快照注入行为（原  / ）。
 *
 *  起：相关能力召回块（`<relevant_skills>` / `<relevant_mcp>` / `<relevant_cli>`）
 * 已从 context-injector 迁出到 relevant-recall-injector（见
 * `src/capability/injectors/__tests__/relevant-recall-injector.test.ts`）——因为召回块
 * 要随 in_progress todo 推进每轮刷新，与本 hook「按 run 冻结 `<context>` 保 prompt
 * cache」的  幂等闸门诉求相反。本 hook 现只注入环境快照，本文件覆盖其幂等 /
 * compact 自愈 / getFocusedAppKey。
 */

import { describe, it, expect } from 'vitest';
import {
  buildContextHook,
  getFocusedAppKey,
  type AppContext,
} from '../src/hooks/index.js';
import {
  INTERNAL_MESSAGE_MARKERS,
  hasInternalMarker,
  type Message,
  type EngineState,
} from '@tabtin/agent-runtime/engine';

const CONTEXT_MARKER = INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION;

function stateWithUser(): EngineState {
  const messages: Message[] = [{ role: 'user', content: '当前问题' }];
  return { messages } as unknown as EngineState;
}

describe('context-injector 环境快照', () => {
  it('有 app context → 注入 <context type="environment"> 消息', async () => {
    const hook = buildContextHook({
      getAppContext: async (): Promise<AppContext> => ({ appType: 'chat' }),
    });
    const state = stateWithUser();
    await hook.beforeIteration!({ state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });

    const ctxMsg = state.messages.find((m) => hasInternalMarker(m, CONTEXT_MARKER));
    expect(ctxMsg).toBeTruthy();
    expect(ctxMsg!.content as string).toContain('<context');
  });

  it('无 app context → 不注入（召回块已迁出，本 hook 只管环境）', async () => {
    const hook = buildContextHook({
      getAppContext: async () => null,
    });
    const state = stateWithUser();
    await hook.beforeIteration!({ state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });
    expect(state.messages.some((m) => hasInternalMarker(m, CONTEXT_MARKER))).toBe(false);
  });

  it('run 内幂等：第二轮跳过，不累积、不改写已注入的 CONTEXT 消息', async () => {
    let calls = 0;
    const hook = buildContextHook({
      getAppContext: async (): Promise<AppContext> => {
        calls += 1;
        return { appType: 'chat' };
      },
    });
    const state = stateWithUser();
    await hook.beforeIteration!({ state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });
    const firstMsg = state.messages.find((m) => hasInternalMarker(m, CONTEXT_MARKER))!;
    await hook.beforeIteration!({ state, iteration: 1, emitEvent: () => {}, emitNotice: () => {} });

    const markers = state.messages.filter((m) => hasInternalMarker(m, CONTEXT_MARKER));
    expect(markers).toHaveLength(1);
    expect(calls).toBe(1);
    expect(markers[0]).toBe(firstMsg);
  });

  it('compact 自愈：CONTEXT marker 被 compact 吃掉后重新注入', async () => {
    let calls = 0;
    const hook = buildContextHook({
      getAppContext: async (): Promise<AppContext> => {
        calls += 1;
        return { appType: 'chat' };
      },
    });
    const state = stateWithUser();

    await hook.beforeIteration!({ state, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });
    expect(calls).toBe(1);
    expect(state.messages.filter((m) => hasInternalMarker(m, CONTEXT_MARKER))).toHaveLength(1);

    state.messages = state.messages.filter((m) => !hasInternalMarker(m, CONTEXT_MARKER));

    await hook.beforeIteration!({ state, iteration: 1, emitEvent: () => {}, emitNotice: () => {} });
    expect(calls).toBe(2);
    expect(state.messages.filter((m) => hasInternalMarker(m, CONTEXT_MARKER))).toHaveLength(1);
  });
});

describe('getFocusedAppKey', () => {
  it('优先 active tab 的 app_key（apphome 场景）', () => {
    expect(
      getFocusedAppKey({
        appType: 'apphome',
        openTabs: [
          { type: 'apphome', app_key: 'tabdoc', display_name: '文档', active: true },
        ],
      }),
    ).toBe('tabdoc');
  });

  it('无 active tab 时回退 appType；chat/apphome 返回 null', () => {
    expect(getFocusedAppKey({ appType: 'tabdata' })).toBe('tabdata');
    expect(getFocusedAppKey({ appType: 'chat' })).toBeNull();
    expect(getFocusedAppKey({ appType: 'apphome' })).toBeNull();
  });

});
