/**
 * switch_mode tool — Phase 3 unit tests（含 F4 fail-closed + F5/F7 dedup）
 */

import { describe, it, expect, vi } from 'vitest';
import { StreamEvents } from '../src/engine/contracts/stream-events.js';
import {
  createSwitchModeTool,
  REQUIRES_CLIENT_APPROVAL,
  ALREADY_PENDING,
  type SwitchModeProposalRegistry,
} from '../src/tools/mode-tools.js';
import {
  isToolAllowedByPolicy,
  getAgentModeConfig,
  listFilteredToolNames,
} from '@tabtin/agent-modes';
import type {
  Tool,
  ToolContext,
} from '../src/engine/contracts/tools.js';

function makeTool(name: string, isReadOnly: boolean): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    isReadOnly,
    execute: async () => ({ content: 'ok' }),
  };
}

const baseContext: ToolContext = {
  threadId: 'thread-1',
  runtimeId: 'rt-1',
  abortSignal: new AbortController().signal,
  messages: [],
};

describe('createSwitchModeTool', () => {
  // ：switch_mode 自带专用审批面（ModeSwitchProposalCard）。必须标
  // riskLevel='safe' + isReadOnly，否则 judge 会把它当默认 object 写工具再弹一张
  // 通用权限卡（"对象写操作需要确认"），与专用切换卡重复门禁。
  it('声明为 safe + readonly，避免 judge 叠加通用权限审批卡', () => {
    const tool = createSwitchModeTool({ allowedTargets: ['agent', 'plan', 'group'] });
    expect(tool.riskLevel).toBe('safe');
    expect(tool.isReadOnly).toBe(true);
  });

  // ：switch_mode 现为**阻塞式 HITL 工具** —— emit 卡片后 await
  // waitForUserInput，approve 回流后返回 contextModifier.modeOverride 让引擎轮内热切换。
  it('emits mode_switch_proposal, blocks on approval, returns modeOverride on approve', async () => {
    const events: Array<{ type: string; payload: unknown }> = [];
    const tool = createSwitchModeTool();
    const result = await tool.execute(
      { target_mode_id: 'agent', reason: '需要改代码了' },
      {
        ...baseContext,
        emitStreamEvent: (e) => events.push(e),
        // host resolve：approve + 目标模式
        waitForUserInput: async () => ({ outcome: 'approved', to_mode: 'agent' }),
      },
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content as string) as {
      status: string;
      mode?: string;
      hint?: string;
    };
    expect(body.status).toBe('approved');
    expect(body.mode).toBe('agent');
    // 关键：返回 contextModifier.modeOverride，引擎据此回读 config 轮内热切换。
    expect(result.contextModifier?.modeOverride).toBe('agent');
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe(StreamEvents.MODE_SWITCH_PROPOSAL);
    const payload = events[0]!.payload as Record<string, unknown>;
    expect(payload.target_mode_id).toBe('agent');
    expect(payload.reason).toBe('需要改代码了');
  });

  it('returns declined (no modeOverride) when user cancels', async () => {
    const tool = createSwitchModeTool();
    const result = await tool.execute(
      { target_mode_id: 'agent', reason: 'x' },
      {
        ...baseContext,
        emitStreamEvent: () => {},
        waitForUserInput: async () => ({ outcome: 'cancelled' }),
      },
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content as string) as { status: string };
    expect(body.status).toBe('declined');
    expect(result.contextModifier?.modeOverride).toBeUndefined();
  });

  it('fail-closed when waitForUserInput is missing', async () => {
    const tool = createSwitchModeTool();
    const result = await tool.execute(
      { target_mode_id: 'agent', reason: 'x' },
      { ...baseContext, emitStreamEvent: () => {} }, // 有 emit 但无 waiter
    );
    expect(result.isError).toBe(true);
    const meta = JSON.parse(result.content as string) as { error_kind?: string };
    expect(meta.error_kind).toBe(REQUIRES_CLIENT_APPROVAL);
  });

  it('rejects non-agent target_mode_id', async () => {
    const tool = createSwitchModeTool();
    const result = await tool.execute(
      { target_mode_id: 'plan', reason: 'x' },
      baseContext,
    );
    expect(result.isError).toBe(true);
    const meta = JSON.parse(result.content as string) as { error_kind?: string };
    expect(meta.error_kind).toBe('invalid_param_format');
  });

  it('daemon / headless returns requires_client_approval', async () => {
    const tool = createSwitchModeTool({ isHeadlessHost: true });
    const result = await tool.execute(
      { target_mode_id: 'agent', reason: 'x' },
      baseContext,
    );
    expect(result.isError).toBe(true);
    const meta = JSON.parse(result.content as string) as { error_kind?: string };
    expect(meta.error_kind).toBe(REQUIRES_CLIENT_APPROVAL);
  });

  // F4: 没有 emitStreamEvent 注入 → fail-closed
  // P2 修复（复检后）：emit throw 时 registry 必须回滚，否则后续调被 already_pending 误挡。
  it('P2: emitStreamEvent throw → registry.unregister rolled back, next call can re-issue', async () => {
    const pendingMap = new Map<string, string>();
    const unregisterCalls: Array<{ sid: string; pid: string }> = [];
    const registry: SwitchModeProposalRegistry = {
      registerPending: (sid, pid) => {
        const existing = pendingMap.get(sid);
        if (existing) return { ok: false, existingProposalId: existing };
        pendingMap.set(sid, pid);
        return { ok: true };
      },
      unregister: (sid, pid) => {
        unregisterCalls.push({ sid, pid });
        if (pendingMap.get(sid) === pid) pendingMap.delete(sid);
      },
    };

    const tool = createSwitchModeTool({ proposalRegistry: registry });
    const firstAttempt = await tool.execute(
      { target_mode_id: 'agent', reason: 'emit will throw' },
      {
        ...baseContext,
        emitStreamEvent: () => {
          throw new Error('renderer disconnected');
        },
        // 有 waiter 才能过 fail-closed 门；emit 在 await 之前 throw，waiter 不会被调。
        waitForUserInput: async () => ({ outcome: 'approved', to_mode: 'agent' }),
      },
    );
    expect(firstAttempt.isError).toBe(true);
    const meta = JSON.parse(firstAttempt.content as string) as { error_kind?: string };
    expect(meta.error_kind).toBe('execute_error');
    expect(unregisterCalls.length).toBeGreaterThanOrEqual(1);
    expect(pendingMap.size).toBe(0);

    // 后续调可重新发起（不被 already_pending 误挡）
    const secondAttempt = await tool.execute(
      { target_mode_id: 'agent', reason: 'retry' },
      {
        ...baseContext,
        emitStreamEvent: () => {},
        waitForUserInput: async () => ({ outcome: 'approved', to_mode: 'agent' }),
      },
    );
    expect(secondAttempt.isError).toBeFalsy();
  });

  it('F4: returns requires_client_approval when no emitStreamEvent is provided (fail-closed)', async () => {
    const tool = createSwitchModeTool();
    const result = await tool.execute(
      { target_mode_id: 'agent', reason: '需要写代码' },
      baseContext, // 没有 emitStreamEvent
    );
    expect(result.isError).toBe(true);
    const meta = JSON.parse(result.content as string) as {
      error_kind?: string;
      hint?: string;
    };
    expect(meta.error_kind).toBe(REQUIRES_CLIENT_APPROVAL);
    expect(meta.hint).toMatch(/manually|stream/i);
  });

  // F5+F7: 同 session 内重复调 switch_mode 返回 already_pending
  it('F5+F7: second call in same session returns already_pending with existing proposal_id', async () => {
    const pendingMap = new Map<string, string>();
    const registry: SwitchModeProposalRegistry = {
      registerPending: (sessionId, proposalId) => {
        const existing = pendingMap.get(sessionId);
        if (existing) {
          return { ok: false, existingProposalId: existing };
        }
        pendingMap.set(sessionId, proposalId);
        return { ok: true };
      },
      unregister: (sessionId, proposalId) => {
        if (pendingMap.get(sessionId) === proposalId) pendingMap.delete(sessionId);
      },
    };

    const events: Array<{ type: string; payload: unknown }> = [];
    // 第一次调用挂起（deferred waiter 不立即 resolve），模拟"卡片仍在等审批"。
    let resolveFirst: (v: unknown) => void = () => {};
    const ctx: ToolContext = {
      ...baseContext,
      emitStreamEvent: (e) => events.push(e),
      waitForUserInput: () =>
        new Promise((res) => {
          resolveFirst = res;
        }),
    };
    const tool = createSwitchModeTool({ proposalRegistry: registry });

    // 不 await：execute 同步跑完 registerPending + emit 后停在 await waiter。
    const firstPromise = tool.execute(
      { target_mode_id: 'agent', reason: 'attempt 1' },
      ctx,
    );
    const firstProposalId = (events[0]!.payload as Record<string, unknown>)
      .proposal_id as string;

    const second = await tool.execute(
      { target_mode_id: 'agent', reason: 'attempt 2' },
      ctx,
    );
    expect(second.isError).toBe(true);
    const secondBody = JSON.parse(second.content as string) as {
      error_kind?: string;
      existing_proposal_id?: string;
      hint?: string;
    };
    expect(secondBody.error_kind).toBe(ALREADY_PENDING);
    expect(secondBody.existing_proposal_id).toBe(firstProposalId);
    expect(secondBody.hint).toMatch(/wait.*user|continue.*plan/i);
    // 重复调不应再 emit 第二张卡
    expect(events).toHaveLength(1);

    // 收尾：resolve 第一次的 waiter，让 firstPromise 完成（清 timeout timer）。
    resolveFirst({ outcome: 'approved', to_mode: 'agent' });
    await firstPromise;
  });

  function makeInMemoryRegistry(): {
    registry: SwitchModeProposalRegistry;
    pendingMap: Map<string, string>;
  } {
    const pendingMap = new Map<string, string>();
    return {
      pendingMap,
      registry: {
        registerPending: (sessionId, proposalId) => {
          const existing = pendingMap.get(sessionId);
          if (existing) return { ok: false, existingProposalId: existing };
          pendingMap.set(sessionId, proposalId);
          return { ok: true };
        },
        unregister: (sessionId, proposalId) => {
          if (pendingMap.get(sessionId) === proposalId) pendingMap.delete(sessionId);
        },
      },
    };
  }

  // 中断 / 拒绝后不得把 F7 pending 留在注册表，否则后续 switch_mode 会被
  // already_pending 永久误挡（Stop、新消息插队、HITL cancel 都走这条）。
  it('interrupted / declined waiter releases registry so the next switch_mode can re-issue', async () => {
    const { registry, pendingMap } = makeInMemoryRegistry();
    const tool = createSwitchModeTool({ proposalRegistry: registry });
    const abortShapedResolution = {
      batch_id: 'mode-switch-1',
      decisions: [{ outcome: 'cancelled' as const, request_id: '__mode_switch_cancel__' }],
    };

    const first = await tool.execute(
      { target_mode_id: 'agent', reason: 'first was interrupted' },
      {
        ...baseContext,
        emitStreamEvent: () => {},
        waitForUserInput: async () => abortShapedResolution,
      },
    );
    expect(first.isError).toBeFalsy();
    const firstBody = JSON.parse(first.content as string) as { status: string };
    expect(firstBody.status).toBe('declined');
    expect(pendingMap.size).toBe(0);

    const events: Array<{ type: string; payload: unknown }> = [];
    const second = await tool.execute(
      { target_mode_id: 'agent', reason: 'retry after interrupt' },
      {
        ...baseContext,
        emitStreamEvent: (e) => events.push(e),
        waitForUserInput: async () => ({ outcome: 'approved', to_mode: 'agent' }),
      },
    );
    expect(second.isError).toBeFalsy();
    expect(JSON.parse(second.content as string)).toMatchObject({ status: 'approved' });
    expect(events).toHaveLength(1);
    expect(pendingMap.size).toBe(0);
  });

  it('explicit cancel also releases registry for a later switch_mode', async () => {
    const { registry, pendingMap } = makeInMemoryRegistry();
    const tool = createSwitchModeTool({ proposalRegistry: registry });
    await tool.execute(
      { target_mode_id: 'agent', reason: 'user cancelled' },
      {
        ...baseContext,
        emitStreamEvent: () => {},
        waitForUserInput: async () => ({ outcome: 'cancelled' }),
      },
    );
    expect(pendingMap.size).toBe(0);

    const retry = await tool.execute(
      { target_mode_id: 'agent', reason: 'retry after cancel' },
      {
        ...baseContext,
        emitStreamEvent: () => {},
        waitForUserInput: async () => ({ outcome: 'approved', to_mode: 'agent' }),
      },
    );
    expect(retry.isError).toBeFalsy();
    expect(pendingMap.size).toBe(0);
  });

  // F7 隔离：不同 session 各自独立 pending
  it('F7: different sessions do not interfere — both succeed', async () => {
    const pendingMap = new Map<string, string>();
    const registry: SwitchModeProposalRegistry = {
      registerPending: (sessionId, proposalId) => {
        const existing = pendingMap.get(sessionId);
        if (existing) return { ok: false, existingProposalId: existing };
        pendingMap.set(sessionId, proposalId);
        return { ok: true };
      },
      unregister: (sessionId, proposalId) => {
        if (pendingMap.get(sessionId) === proposalId) pendingMap.delete(sessionId);
      },
    };

    const tool = createSwitchModeTool({ proposalRegistry: registry });
    const events: Array<{ type: string; payload: unknown }> = [];
    const emit = (e: { type: string; payload: unknown }) => events.push(e);
    const approve = async () => ({ outcome: 'approved' as const, to_mode: 'agent' });

    const rA = await tool.execute(
      { target_mode_id: 'agent', reason: 'A' },
      { ...baseContext, threadId: 'sess-A', emitStreamEvent: emit, waitForUserInput: approve },
    );
    const rB = await tool.execute(
      { target_mode_id: 'agent', reason: 'B' },
      { ...baseContext, threadId: 'sess-B', emitStreamEvent: emit, waitForUserInput: approve },
    );
    expect(rA.isError).toBeFalsy();
    expect(rB.isError).toBeFalsy();
    expect(events).toHaveLength(2);
  });
});

describe('switch_mode contract visibility', () => {
  const tools = [
    makeTool('switch_mode', false),
    makeTool('plan_create', false),
    makeTool('write_file', false),
  ];
  const planPolicy = getAgentModeConfig('plan')!.toolPolicy;
  const askPolicy = getAgentModeConfig('ask')!.toolPolicy;
  const studyPolicy = getAgentModeConfig('study')!.toolPolicy;

  it('plan mode allows switch_mode in policy', () => {
    const sw = tools.find((t) => t.name === 'switch_mode')!;
    expect(isToolAllowedByPolicy(sw, planPolicy)).toBe(true);
    expect(listFilteredToolNames(tools, 'plan').allowed).toContain('switch_mode');
  });

  // ：ask / study 现在可提议切到 plan → switch_mode 在 policy allow。
  it('ask / study allow switch_mode via policy (→ plan proposal)', () => {
    const sw = tools.find((t) => t.name === 'switch_mode')!;
    expect(isToolAllowedByPolicy(sw, askPolicy)).toBe(true);
    expect(isToolAllowedByPolicy(sw, studyPolicy)).toBe(true);
    expect(listFilteredToolNames(tools, 'ask').allowed).toContain('switch_mode');
    expect(listFilteredToolNames(tools, 'study').allowed).toContain('switch_mode');
  });
});
