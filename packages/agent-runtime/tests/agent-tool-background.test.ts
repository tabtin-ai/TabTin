/**
 * agent-tool 后台 detach + 完成回调链 e2e（W4a PR2 S4+S5，2026-05-30）。
 *
 * 北极星（必须 e2e 测通）：
 *   主 Agent background:true spawn 调工具子 → 父 turn 结束（context.abortSignal abort）
 *   → 子仍在后台 running（不被误杀）→ 子完成 → 主 Agent 无用户输入也收到一个
 *   push（synthetic message 含 childId + summary）→ 子终态 completed 而非 cancelled。
 *
 * 另测：
 *   - 后台子不被 context.abortSignal 误杀（父 turn 结束不取消后台子）；
 *   - 后台子终态 completed 而非 cancelled（catch 按子 controller 判，不读 context.abortSignal）；
 *   - rebindLiveDeps（模拟 runtime 重建）不误杀后台子；
 *   - 多后台子同时完成 → 合并通知；
 *   - release 时机：秒回不过早 release（并发槽仍占用）；
 *   - 后台子 HITL 走 rebind 的活体 waitForUserInput（不 fail-closed deny）；
 *   - resume / background 撞 disposed Manager → 显式报错。
 *
 * 走真实 NotificationQueue + buildSubagentCompletionEnvelope + composeNotificationPrompt
 *（不 mock 队列接口），证完整 producer→queue→consumer 链。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createAgentTool } from '../src/subagent/agent-tool.js';
import { forkQuery } from '../src/subagent/fork-query.js';
import { SubagentManager, type SubagentCompletionInfo } from '../src/session/subagent-manager.js';
import { BudgetTracker } from '../src/engine/guards/budget-tracker.js';
import {
  NotificationQueue,
  buildSubagentCompletionEnvelope,
  composeNotificationPrompt,
  type NotificationEnvelope,
  type SubagentCompletedPayload,
} from '@tabtin/terminal-core';
import {
  normalize as normalizePolicyPath,
  type EffectivePolicy,
  type MemoStore,
} from '@tabtin/security-policy';
import { ContentBlockEvents, StreamEvents } from '../src/engine/contracts/stream-events.js';
import { createMockProvider, createMockPermissionHandler, createMockToolProvider } from './test-utils.js';
import type {
  StreamEvent,
} from '../src/engine/contracts/wire-protocol.js';
import type {
  Message,
} from '../src/engine/contracts/conversation.js';
import type {
  LLMResponseChunk,
} from '../src/engine/contracts/model-llm.js';
import type {
  Tool,
} from '../src/engine/contracts/tools.js';
import { createTestToolRiskPolicyPort } from './helpers/tool-risk-policy-port.js';

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    threadId: 'thread-1',
    runtimeId: 'rt-1',
    toolUseId: 'toolu_parent',
    abortSignal: new AbortController().signal,
    messages: [] as Message[],
    ...overrides,
  };
}

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

/**
 * 受控 provider：createStream 挂起到 release() 才 yield 完成（模拟「在跑」）。
 * hang promise **提前创建**（resolveHang 同步可用），避免「release 早于 createStream
 * 被调」的测试竞态——子 forkQuery 在首个 await（recordStart 文件 I/O）后才到
 * createStream，release 可能先到。
 */
function makeHangingProvider() {
  let resolveHang!: () => void;
  const hang = new Promise<void>((resolve) => { resolveHang = resolve; });
  const provider = {
    async *createStream(): AsyncIterable<LLMResponseChunk> {
      await hang;
      yield { type: 'text_delta' as const, text: '后台调研完成：推荐方案 B' };
      yield { type: 'stop' as const, stopReason: 'end_turn' as const };
    },
  };
  return { provider, release: () => resolveHang() };
}

/** 把 host 的「完成句柄 + 真实 NotificationQueue」组装出来（mimic createRuntimeForSession）。 */
function makeWiredManager(opts: { spaceId?: string; threadId?: string } = {}) {
  const spaceId = opts.spaceId ?? 'space-1';
  const threadId = opts.threadId ?? 'thread-1';
  const queue = new NotificationQueue({
    clock: () => 1_700_000_000_000,
    setInterval: () => 'h',
    clearInterval: () => {},
    log: () => {},
  });
  const budgetTracker = new BudgetTracker();
  const manager = new SubagentManager({
    parentThreadId: threadId,
    spaceId,
    budgetTracker,
    enqueueNotification: (info) =>
      queue.enqueue(buildSubagentCompletionEnvelope(info, { spaceId, threadId })),
  });
  manager.rebindLiveDeps({ budgetTracker });
  return { queue, budgetTracker, manager, spaceId, threadId };
}

function extractChildId(content: string): string {
  const m = content.match(/\[子 Agent ID: ([^\]]+)\]/);
  if (!m) throw new Error(`no child id in: ${content}`);
  return m[1];
}

function makeWorkspacePolicy(
  workspaceRoot: string,
  approvalMode: EffectivePolicy['approvalMode'] = 'auto',
): EffectivePolicy {
  return {
    approvalMode,
    workspace: {
      sources: {
        sandbox: workspaceRoot,
        workingDir: workspaceRoot,
        sessionApprovedPaths: [],
        attachedFiles: [],
      },
      allowedPaths: [workspaceRoot],
      allowedFiles: [],
      spaceSessionId: 'session-worktree-root',
    },
    memo: { generation: 0, entries: {} },
    executionLimits: {},
    planModeGuardActive: false,
  };
}

function makeWorkspacePolicyPort(
  workspaceRoot: string,
  approvalMode: EffectivePolicy['approvalMode'] = 'auto',
) {
  const memoStore: MemoStore = {
    lookup: () => null,
    putAlways: async () => undefined,
    putThread: () => undefined,
  };
  return createTestToolRiskPolicyPort({
    buildEffectivePolicy: () => makeWorkspacePolicy(workspaceRoot, approvalMode),
    memoStore,
  });
}

// ─── 北极星 ───────────────────────────────────────────────────────────

describe('agent-tool 后台 detach 北极星', () => {
  it('后台 spawn → 父 turn 结束不误杀 → 完成 push 通知 → 终态 completed 非 cancelled', async () => {
    const { queue, budgetTracker, manager, threadId } = makeWiredManager();
    const events: StreamEvent[] = [];
    const { provider, release } = makeHangingProvider();

    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/bg-polaris', threadId },
      model: 'claude-sonnet-4-20250514',
      budgetTracker,
      subagentManager: manager,
    });

    const parentAbort = new AbortController();
    const result = await tool.execute(
      { prompt: '长后台任务', description: '后台调研', background: true },
      makeContext({ emitStreamEvent: (e: StreamEvent) => events.push(e), abortSignal: parentAbort.signal }),
    );

    // 秒回：不等子完成，立刻返回「已在后台启动」+ childId
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('已在后台启动');
    const childId = extractChildId(result.content);

    // 后台子仍在 manager 登记（running、标 background）
    expect(manager.has(childId)).toBe(true);
    expect(manager.getStatus(childId)?.background).toBe(true);

    // 模拟父 turn 结束：abort 父 context signal —— 后台子**不应被误杀**
    parentAbort.abort();
    await tick(30);
    expect(manager.has(childId)).toBe(true);
    expect(manager.getStatus(childId)?.cancelled).toBe(false);
    // 队列此刻还没有完成通知（子还在跑）
    expect(queue.peekByThreadId(threadId)).toBe(0);

    // 子完成
    release();
    await tick();

    // 完成后注销 + 入队完成通知（subagent-completed）
    expect(manager.has(childId)).toBe(false);
    const items = queue.drainByThreadId(threadId) as NotificationEnvelope<SubagentCompletedPayload>[];
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('subagent-completed');
    expect(items[0].payload.subagent_run_id).toBe(childId);
    // **终态 completed 而非 cancelled**（父 turn 已 abort 也不误判）
    expect(items[0].payload.status).toBe('completed');

    // consumer：合成 synthetic user message（含 childId + summary）跨 turn 唤醒
    const prompt = composeNotificationPrompt(items);
    expect(prompt).toContain('A background sub-agent finished');
    expect(prompt).toContain(`<subagent-run-id>${childId}</subagent-run-id>`);
    expect(prompt).toContain('<status>completed</status>');
    expect(prompt).toContain('后台调研完成：推荐方案 B');

    // live 事件：发了 SUBAGENT_COMPLETED，没发 SUBAGENT_FAILED
    expect(events.some((e) => e.type === StreamEvents.SUBAGENT_COMPLETED)).toBe(true);
    expect(events.some((e) => e.type === StreamEvents.SUBAGENT_FAILED)).toBe(false);
    const terminalFactBlock = events.find((e) =>
      e.type === ContentBlockEvents.CONTENT_BLOCK_START
      && (e.payload as {
        block?: {
          type?: string;
          tool_use_id?: string;
          content?: string;
          presentation?: { kind?: string; data?: { subagent_run_id?: string; status?: string } };
        };
      }).block?.type === 'tool_result'
      && (e.payload as { block?: { tool_use_id?: string } }).block?.tool_use_id === 'toolu_parent'
      && (e.payload as { block?: { presentation?: { kind?: string } } }).block?.presentation?.kind === 'subagent_result'
    );
    expect(terminalFactBlock, '后台子 Agent 终态必须落为 parent message block 事实').toBeTruthy();
    const terminalFactMessageId = (terminalFactBlock!.payload as { message_id: string }).message_id;
    const terminalFactStart = events.find((e) =>
      e.type === ContentBlockEvents.MESSAGE_START
      && (e.payload as { message_id?: string }).message_id === terminalFactMessageId
    );
    expect(
      (terminalFactStart!.payload as { message_kind?: string }).message_kind,
      '后台子 Agent 终态必须走统一 tool_artifact message fact 管道',
    ).toBe('tool_artifact');
    expect((terminalFactBlock!.payload as {
      block: {
        content: string;
        presentation: { data: { subagent_run_id: string; status: string } };
      };
    }).block).toMatchObject({
      presentation: {
        data: {
          subagent_run_id: childId,
          status: 'completed',
        },
      },
    });
    expect((terminalFactBlock!.payload as { block: { content: string } }).block.content)
      .toContain('[子 Agent ID: ');
    const terminalPersist = events.find((e) =>
      e.type === StreamEvents.PERSIST_MESSAGE
      && (e.payload as {
        message_kind?: string;
        blocks_json?: Array<{
          type?: string;
          tool_use_id?: string;
          content?: string;
          presentation?: { kind?: string; data?: { subagent_run_id?: string; status?: string } };
        }>;
      }).message_kind === 'tool_artifact'
      && (e.payload as { message_id?: string }).message_id === terminalFactMessageId
      && (e.payload as { blocks_json?: Array<{ tool_use_id?: string }> }).blocks_json?.[0]?.tool_use_id === 'toolu_parent'
    );
    expect(terminalPersist, '后台子 Agent 终态必须通过 persist_message 落历史 message blocks').toBeTruthy();
    expect((terminalPersist!.payload as {
      blocks_json: Array<{
        content: string;
        presentation: { data: { subagent_run_id: string; status: string } };
      }>;
    }).blocks_json[0]).toMatchObject({
      presentation: {
        data: {
          subagent_run_id: childId,
          status: 'completed',
        },
      },
    });
    // STARTED 标了 background
    const started = events.find((e) => e.type === StreamEvents.SUBAGENT_STARTED);
    expect((started!.payload as { background?: boolean }).background).toBe(true);
  });
});

// ─── 后台不误杀 / 不误判 cancelled ────────────────────────────────────

describe('agent-tool 后台子生命周期', () => {
  it('子 Agent 内部后台孙代理完成时路由到发起者 run 队列而非主会话', async () => {
    const spaceId = 'space-1';
    const threadId = 'thread-1';
    const queue = new NotificationQueue({
      clock: () => 1_700_000_000_000,
      setInterval: () => 'h',
      clearInterval: () => {},
      log: () => {},
    });
    const budgetTracker = new BudgetTracker();
    const enqueueNotification = vi.fn((info: SubagentCompletionInfo) =>
      queue.enqueue(buildSubagentCompletionEnvelope(info, {
        spaceId,
        threadId: info.run_id ?? threadId,
      })),
    );
    const manager = new SubagentManager({
      parentThreadId: threadId,
      spaceId,
      budgetTracker,
      enqueueNotification,
    });
    manager.rebindLiveDeps({ budgetTracker });
    const { provider, release } = makeHangingProvider();
    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/bg-nested-no-main-notify', threadId },
      model: 'claude-sonnet-4-20250514',
      budgetTracker,
      subagentManager: manager,
    });

    const result = await tool.execute(
      { prompt: '孙代理后台任务', description: '孙代理', background: true },
      makeContext({
        emitStreamEvent: () => {},
        subagentDepth: 1,
        assistantSubagentRunId: 'child-dispatcher',
        toolUseId: 'toolu-grandchild',
      }),
    );
    const grandchildId = extractChildId(result.content);

    release();
    await tick();

    expect(enqueueNotification).toHaveBeenCalledTimes(1);
    expect(enqueueNotification.mock.calls[0]?.[0]).toMatchObject({
      subagent_run_id: grandchildId,
      run_id: 'child-dispatcher',
      tool_call_id: 'toolu-grandchild',
      parent_tool_call_id: 'toolu-grandchild',
    });
    expect(queue.peekByThreadId(threadId)).toBe(0);
    expect(queue.peekByThreadId('child-dispatcher')).toBe(1);
    const prompt = composeNotificationPrompt(queue.drainByThreadId('child-dispatcher'));
    expect(prompt).toContain(`<subagent-run-id>${grandchildId}</subagent-run-id>`);
    expect(prompt).toContain('<run-id>child-dispatcher</run-id>');
    expect(prompt).toContain('<tool-call-id>toolu-grandchild</tool-call-id>');
  });

  it('rebindLiveDeps（模拟 runtime 重建）不误杀后台子', async () => {
    const { budgetTracker, manager, threadId } = makeWiredManager();
    const { provider, release } = makeHangingProvider();
    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/bg-rebuild', threadId },
      model: 'claude-sonnet-4-20250514',
      budgetTracker,
      subagentManager: manager,
    });

    const result = await tool.execute(
      { prompt: 'bg', background: true },
      makeContext({ emitStreamEvent: () => {} }),
    );
    const childId = extractChildId(result.content);
    expect(manager.has(childId)).toBe(true);

    // 模拟 runtime 重建：host carry-forward 同一 Manager + rebind 新依赖（不 dispose）
    const newTracker = new BudgetTracker();
    manager.rebindLiveDeps({ budgetTracker: newTracker });

    // 后台子未被 abort、仍登记
    expect(manager.has(childId)).toBe(true);
    expect(manager.getStatus(childId)?.cancelled).toBe(false);

    release();
    await tick();
    expect(manager.has(childId)).toBe(false);
  });

  it('release 时机：秒回不过早 release 并发槽（slot 仍占用到子完成）', async () => {
    const budgetTracker = new BudgetTracker({ maxConcurrentChildren: 2, maxQueueSize: 10 });
    const queue = new NotificationQueue({ clock: () => 1, setInterval: () => 'h', clearInterval: () => {}, log: () => {} });
    const manager = new SubagentManager({
      parentThreadId: 'thread-1',
      spaceId: 'space-1',
      budgetTracker,
      enqueueNotification: (info) => queue.enqueue(buildSubagentCompletionEnvelope(info, { spaceId: 'space-1', threadId: 'thread-1' })),
    });
    manager.rebindLiveDeps({ budgetTracker });

    const { provider, release } = makeHangingProvider();
    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/bg-slot', threadId: 'thread-1' },
      model: 'claude-sonnet-4-20250514',
      budgetTracker,
      subagentManager: manager,
    });

    await tool.execute({ prompt: 'bg', background: true }, makeContext({ emitStreamEvent: () => {} }));
    await tick(20);
    // 秒回后并发槽仍被占（active=1）——没在秒回时过早 release 穿透并发上限
    expect(budgetTracker.getSchedulerStats().activeCount).toBe(1);

    release();
    await tick();
    // 子完成后槽释放
    expect(budgetTracker.getSchedulerStats().activeCount).toBe(0);
  });
});

// ─── 多后台子合并通知 ─────────────────────────────────────────────────

describe('agent-tool 多后台子完成合并', () => {
  it('两个后台子完成 → 合并成一段（复数前缀 + 各自块）', async () => {
    const { queue, budgetTracker, manager, threadId } = makeWiredManager();
    const p1 = makeHangingProvider();
    const p2 = makeHangingProvider();

    const mk = (p: { provider: { createStream: () => AsyncIterable<LLMResponseChunk> } }) =>
      createAgentTool({
        provider: p.provider as Parameters<typeof createAgentTool>[0]['provider'],
        tools: createMockToolProvider(),
        permissionHandler: createMockPermissionHandler(),
        sessionConfig: { sessionDir: '/tmp/bg-multi', threadId },
        model: 'claude-sonnet-4-20250514',
        budgetTracker,
        subagentManager: manager,
      });

    const r1 = await mk(p1).execute({ prompt: 'a', description: '任务A', background: true }, makeContext({ emitStreamEvent: () => {} }));
    const r2 = await mk(p2).execute({ prompt: 'b', description: '任务B', background: true }, makeContext({ emitStreamEvent: () => {} }));
    const c1 = extractChildId(r1.content);
    const c2 = extractChildId(r2.content);

    p1.release();
    p2.release();
    await tick(150);

    const items = queue.drainByThreadId(threadId);
    expect(items).toHaveLength(2);
    const prompt = composeNotificationPrompt(items);
    expect(prompt).toContain('2 background sub-agents finished');
    expect(prompt).toContain(`<subagent-run-id>${c1}</subagent-run-id>`);
    expect(prompt).toContain(`<subagent-run-id>${c2}</subagent-run-id>`);
  });

  it('wait_agent_ids 挂起父 run，全部终态前不释放完成通知', async () => {
    const { queue, budgetTracker, manager, threadId } = makeWiredManager();
    const p1 = makeHangingProvider();
    const p2 = makeHangingProvider();
    const mk = (p: { provider: { createStream: () => AsyncIterable<LLMResponseChunk> } }) =>
      createAgentTool({
        provider: p.provider as Parameters<typeof createAgentTool>[0]['provider'],
        tools: createMockToolProvider(),
        permissionHandler: createMockPermissionHandler(),
        sessionConfig: { sessionDir: '/tmp/bg-wait-barrier', threadId },
        model: 'claude-sonnet-4-20250514',
        budgetTracker,
        subagentManager: manager,
      });

    const r1 = await mk(p1).execute(
      { prompt: 'a', description: '任务A', background: true },
      makeContext({ emitStreamEvent: () => {} }),
    );
    const r2 = await mk(p2).execute(
      { prompt: 'b', description: '任务B', background: true },
      makeContext({ emitStreamEvent: () => {} }),
    );
    const childIds = [extractChildId(r1.content), extractChildId(r2.content)];
    const normalizedChildIds = [...childIds].sort();
    const waitResult = await mk(p1).execute(
      { wait_agent_ids: childIds },
      makeContext({ emitStreamEvent: () => {} }),
    );

    expect(waitResult.isError).toBe(false);
    expect(waitResult.signals?.suspendRun).toEqual({
      reason: 'awaiting_subagents',
      pendingSubagentIds: normalizedChildIds,
      onDiscard: expect.any(Function),
    });

    p1.release();
    await tick(100);
    expect(queue.peekByThreadId(threadId)).toBe(0);

    p2.release();
    await tick(150);
    const items = queue.drainByThreadId(threadId);
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.payload.subagent_run_id)).toEqual(normalizedChildIds);
  });

  it('wait_agent_ids 允许同一父会话按不同 tool_use 并行等待不同子任务组', async () => {
    const { queue, budgetTracker, manager, threadId } = makeWiredManager();
    const providers = [
      makeHangingProvider(),
      makeHangingProvider(),
      makeHangingProvider(),
      makeHangingProvider(),
    ];
    const mk = (p: { provider: { createStream: () => AsyncIterable<LLMResponseChunk> } }) =>
      createAgentTool({
        provider: p.provider as Parameters<typeof createAgentTool>[0]['provider'],
        tools: createMockToolProvider(),
        permissionHandler: createMockPermissionHandler(),
        sessionConfig: { sessionDir: '/tmp/bg-wait-multi-barrier', threadId },
        model: 'claude-sonnet-4-20250514',
        budgetTracker,
        subagentManager: manager,
      });

    const started = await Promise.all(providers.map((p, index) =>
      mk(p).execute(
        { prompt: `task-${index}`, description: `任务${index}`, background: true },
        makeContext({ emitStreamEvent: () => {}, toolUseId: `spawn-${index}` }),
      ),
    ));
    const childIds = started.map((result) => extractChildId(result.content));
    const firstGroup = childIds.slice(0, 2);
    const secondGroup = childIds.slice(2, 4);

    const firstWait = await mk(providers[0]).execute(
      { wait_agent_ids: firstGroup },
      makeContext({ emitStreamEvent: () => {}, toolUseId: 'wait-first' }),
    );
    const secondWait = await mk(providers[2]).execute(
      { wait_agent_ids: secondGroup },
      makeContext({ emitStreamEvent: () => {}, toolUseId: 'wait-second' }),
    );

    expect(firstWait.isError).toBe(false);
    expect(firstWait.presentation).toEqual({
      kind: 'subagent_wait',
      data: expect.objectContaining({
        waitToolCallId: 'wait-first',
        status: 'waiting',
        childIds: [...firstGroup].sort(),
      }),
    });
    expect(secondWait.isError).toBe(false);
    expect(secondWait.presentation).toEqual({
      kind: 'subagent_wait',
      data: expect.objectContaining({
        waitToolCallId: 'wait-second',
        status: 'waiting',
        childIds: [...secondGroup].sort(),
      }),
    });

    providers[2].release();
    await tick(150);
    expect(queue.peekByThreadId(threadId)).toBe(0);

    providers[0].release();
    providers[1].release();
    await tick(150);
    expect(queue.peekByThreadId(threadId)).toBe(2);

    providers[3].release();
    await tick(150);
    const items = queue.drainByThreadId(threadId);
    expect(items.map((item) => item.payload.subagent_run_id).sort()).toEqual([...childIds].sort());
  });

  it('wait_agent_ids 遇到部分终态时只挂起仍运行的子 Agent', async () => {
    const { budgetTracker, manager, threadId } = makeWiredManager();
    const p1 = makeHangingProvider();
    const p2 = makeHangingProvider();
    const mk = (p: { provider: { createStream: () => AsyncIterable<LLMResponseChunk> } }) =>
      createAgentTool({
        provider: p.provider as Parameters<typeof createAgentTool>[0]['provider'],
        tools: createMockToolProvider(),
        permissionHandler: createMockPermissionHandler(),
        sessionConfig: { sessionDir: '/tmp/bg-wait-partial-terminal', threadId },
        model: 'claude-sonnet-4-20250514',
        budgetTracker,
        subagentManager: manager,
      });

    const r1 = await mk(p1).execute(
      { prompt: 'a', description: '任务A', background: true },
      makeContext({ emitStreamEvent: () => {} }),
    );
    const r2 = await mk(p2).execute(
      { prompt: 'b', description: '任务B', background: true },
      makeContext({ emitStreamEvent: () => {} }),
    );
    const c1 = extractChildId(r1.content);
    const c2 = extractChildId(r2.content);

    p1.release();
    await tick(100);
    const waitResult = await mk(p2).execute(
      { wait_agent_ids: [c2, c1] },
      makeContext({ emitStreamEvent: () => {} }),
    );

    expect(waitResult.isError).toBe(false);
    expect(waitResult.signals?.suspendRun).toMatchObject({
      reason: 'awaiting_subagents',
      pendingSubagentIds: [c2],
    });
    expect(waitResult.presentation).toEqual({
      kind: 'subagent_wait',
      data: expect.objectContaining({
        status: 'waiting',
        completedChildIds: [c1],
        pendingCount: 1,
      }),
    });

    p2.release();
    await tick(100);
  });

  it('wait_agent_ids 遇到全部终态时直接返回摘要且不挂起', async () => {
    const { budgetTracker, manager, threadId } = makeWiredManager();
    const p1 = makeHangingProvider();
    const p2 = makeHangingProvider();
    const mk = (p: { provider: { createStream: () => AsyncIterable<LLMResponseChunk> } }) =>
      createAgentTool({
        provider: p.provider as Parameters<typeof createAgentTool>[0]['provider'],
        tools: createMockToolProvider(),
        permissionHandler: createMockPermissionHandler(),
        sessionConfig: { sessionDir: '/tmp/bg-wait-all-terminal', threadId },
        model: 'claude-sonnet-4-20250514',
        budgetTracker,
        subagentManager: manager,
      });

    const r1 = await mk(p1).execute(
      { prompt: 'a', description: '任务A', background: true },
      makeContext({ emitStreamEvent: () => {} }),
    );
    const r2 = await mk(p2).execute(
      { prompt: 'b', description: '任务B', background: true },
      makeContext({ emitStreamEvent: () => {} }),
    );
    const childIds = [extractChildId(r1.content), extractChildId(r2.content)].sort();

    p1.release();
    p2.release();
    await tick(150);
    const waitResult = await mk(p1).execute(
      { wait_agent_ids: [...childIds].reverse() },
      makeContext({ emitStreamEvent: () => {} }),
    );

    expect(waitResult.isError).toBe(false);
    expect(waitResult.signals?.suspendRun).toBeUndefined();
    expect(String(waitResult.content)).toContain('均已结束，无需继续挂起');
    expect(waitResult.presentation).toEqual({
      kind: 'subagent_wait',
      data: expect.objectContaining({
        childIds,
        status: 'completed',
        completedCount: 2,
      }),
    });
  });
});

// ─── 空 wait_agent_ids 视为未传（ Codex/OpenAI 填满 schema）──────

describe('agent-tool 空 wait_agent_ids 容错', () => {
  function makeBgTool(
    provider: { createStream: () => AsyncIterable<LLMResponseChunk> },
    manager: SubagentManager,
    budgetTracker: BudgetTracker,
    threadId: string,
  ) {
    return createAgentTool({
      provider: provider as Parameters<typeof createAgentTool>[0]['provider'],
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/bg-empty-wait', threadId },
      model: 'claude-sonnet-4-20250514',
      budgetTracker,
      subagentManager: manager,
    });
  }

  it('wait_agent_ids: [] + prompt → 走 spawn，不报等待错误', async () => {
    const { budgetTracker, manager, threadId } = makeWiredManager({
      threadId: 'thread-empty-wait-array',
    });
    const { provider, release } = makeHangingProvider();
    const tool = makeBgTool(provider, manager, budgetTracker, threadId);

    const result = await tool.execute(
      {
        prompt: '只读勘察',
        description: '勘察',
        background: true,
        wait_agent_ids: [],
        check_agent_id: '',
        resume_agent_id: '',
      },
      makeContext({ emitStreamEvent: () => {} }),
    );

    expect(result.isError).toBeFalsy();
    expect(String(result.content)).not.toContain('wait_agent_ids 至少需要');
    expect(String(result.content)).toContain('已在后台启动');
    expect(result.presentation?.kind).not.toBe('subagent_wait');

    release();
    await tick(150);
  });

  it('wait_agent_ids: [""] + prompt → 走 spawn，不报等待错误', async () => {
    const { budgetTracker, manager, threadId } = makeWiredManager({
      threadId: 'thread-empty-wait-blank',
    });
    const { provider, release } = makeHangingProvider();
    const tool = makeBgTool(provider, manager, budgetTracker, threadId);

    const result = await tool.execute(
      {
        prompt: '只读勘察',
        description: '勘察',
        background: true,
        wait_agent_ids: [''],
      },
      makeContext({ emitStreamEvent: () => {} }),
    );

    expect(result.isError).toBeFalsy();
    expect(String(result.content)).not.toContain('wait_agent_ids 至少需要');
    expect(String(result.content)).toContain('已在后台启动');

    release();
    await tick(150);
  });

  it('resolvePresentation：空 wait_agent_ids 不预渲染等待行', () => {
    const { budgetTracker, manager, threadId } = makeWiredManager({
      threadId: 'thread-empty-wait-presentation',
    });
    const tool = makeBgTool(createMockProvider(), manager, budgetTracker, threadId);

    expect(tool.resolvePresentation?.({ wait_agent_ids: [] })).toBeUndefined();
    expect(tool.resolvePresentation?.({ wait_agent_ids: [''] })).toBeUndefined();
    expect(tool.resolvePresentation?.({ wait_agent_ids: ['child-1'] })).toEqual({
      kind: 'subagent_wait',
      data: {
        childIds: ['child-1'],
        status: 'waiting',
      },
    });
  });
});

// ─── 后台子 HITL 走活体依赖（不 fail-closed deny）────────────────────

describe('agent-tool 后台子 HITL', () => {
  it('config 无 waitForUserInput、Manager rebind 有 → 后台子 HITL 用活体依赖（不 deny）', async () => {
    const waitForUserInput = vi.fn(async () => ({ approved: true, answer: 'yes' }));
    const budgetTracker = new BudgetTracker();
    const queue = new NotificationQueue({ clock: () => 1, setInterval: () => 'h', clearInterval: () => {}, log: () => {} });
    const manager = new SubagentManager({
      parentThreadId: 'thread-1',
      spaceId: 'space-1',
      budgetTracker,
      enqueueNotification: (info) => queue.enqueue(buildSubagentCompletionEnvelope(info, { spaceId: 'space-1', threadId: 'thread-1' })),
    });
    // rebind 注入活体 waitForUserInput（host createRuntimeForSession 同款）
    manager.rebindLiveDeps({ budgetTracker, waitForUserInput });

    const hitlTool: Tool = {
      name: 'ask_thing',
      description: 'ask user',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: true,
      async execute(_input, ctx) {
        const ans = await ctx.waitForUserInput?.('req-1');
        return { content: `got:${JSON.stringify(ans)}` };
      },
    };

    const provider = createMockProvider([
      [
        { type: 'tool_use', toolUse: { id: 'tu-1', name: 'ask_thing', input: {} } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'done after ask' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);

    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider([hitlTool]),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/bg-hitl', threadId: 'thread-1' },
      model: 'claude-sonnet-4-20250514',
      budgetTracker,
      subagentManager: manager,
      toolRiskPolicy: createTestToolRiskPolicyPort({
        buildEffectivePolicy: () => undefined,
        memoStore: { lookup: async () => undefined } as never,
      }),
      // 注意：config.waitForUserInput 故意不传（模拟 spawn 快照缺 / 失效）
    });

    const result = await tool.execute(
      { prompt: 'ask then finish', background: true },
      makeContext({ emitStreamEvent: () => {} }),
    );
    const childId = extractChildId(result.content);

    await tick();

    // 活体 waitForUserInput 被调用 = 后台子 HITL 没落 fail-closed deny stub
    expect(waitForUserInput).toHaveBeenCalledWith('req-1');
    // 子正常完成（completed）
    const items = queue.drainByThreadId('thread-1') as NotificationEnvelope<SubagentCompletedPayload>[];
    expect(items.some((e) => e.payload.subagent_run_id === childId && e.payload.status === 'completed')).toBe(true);
  });
});

describe('agent-tool 后台子 worktree 根重绑', () => {
  it('runtime 重建并切换 worktree 后，子 Agent 的路径解析根与授权快照同源', async () => {
    const staleWorkspaceRoot = '/tmp/worktree-before';
    const boundWorkspaceRoot = '/tmp/worktree-after';
    const budgetTracker = new BudgetTracker();
    const manager = new SubagentManager({
      parentThreadId: 'thread-1',
      budgetTracker,
    });
    manager.rebindLiveDeps({
      budgetTracker,
      workspaceRoot: boundWorkspaceRoot,
      toolRiskPolicy: makeWorkspacePolicyPort(boundWorkspaceRoot),
    });

    let observedWorkspaceRoot: string | undefined;
    let observedAllowedPaths: readonly string[] | undefined;
    const inspectWorkspace: Tool = {
      name: 'inspect_workspace',
      description: 'inspect current workspace',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: true,
      async execute(_input, ctx) {
        observedWorkspaceRoot = ctx.workspaceRoot;
        observedAllowedPaths = ctx.workspaceSnapshot?.allowedPaths;
        return { content: 'ok' };
      },
    };
    const provider = createMockProvider([
      [
        { type: 'tool_use', toolUse: { id: 'tu-1', name: 'inspect_workspace', input: {} } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'done' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);
    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider([inspectWorkspace]),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/bg-worktree-root', threadId: 'thread-1' },
      model: 'claude-sonnet-4-20250514',
      budgetTracker,
      subagentManager: manager,
      workspaceRoot: staleWorkspaceRoot,
      toolRiskPolicy: makeWorkspacePolicyPort(staleWorkspaceRoot),
    });

    const result = await tool.execute(
      { prompt: 'inspect', background: true },
      makeContext({ emitStreamEvent: () => {}, workspaceRoot: staleWorkspaceRoot }),
    );
    expect(result.isError).toBeFalsy();
    await tick();

    expect(observedWorkspaceRoot).toBe(boundWorkspaceRoot);
    expect(observedAllowedPaths).toContain(normalizePolicyPath(boundWorkspaceRoot).path);
  });

  it('执行根已切到 worktree 时，即使授权端口来自旧 runtime，根内写入也不再弹审批', async () => {
    const staleWorkspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-stale-root-'));
    const boundWorkspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-bound-root-'));
    const budgetTracker = new BudgetTracker();
    const requestApprovalsBatch = vi.fn(async (params: {
      batchId: string;
      actionRequests: Array<{ requestId: string; toolCallId: string }>;
    }) => ({
      batchId: params.batchId,
      decisions: params.actionRequests.map((request) => ({
        requestId: request.requestId,
        toolCallId: request.toolCallId,
        outcome: 'allow' as const,
        scope: 'once' as const,
      })),
    }));
    const manager = new SubagentManager({
      parentThreadId: 'thread-1',
      budgetTracker,
    });
    manager.rebindLiveDeps({
      budgetTracker,
      workspaceRoot: boundWorkspaceRoot,
      // 模拟 worktree 切换后 Manager 仍拿到旧 runtime 的授权闭包。
      toolRiskPolicy: makeWorkspacePolicyPort(staleWorkspaceRoot, 'always_ask'),
      userInteractiveChannel: { requestApprovalsBatch },
    });

    let observedWorkspaceRoot: string | undefined;
    let observedAllowedPaths: readonly string[] | undefined;
    const writeProbe: Tool = {
      name: 'write_file',
      description: 'write a probe file',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, contents: { type: 'string' } },
        required: ['path', 'contents'],
      },
      isReadOnly: false,
      riskLevel: 'review',
      policyActionKind: 'file',
      async execute(input, ctx) {
        observedWorkspaceRoot = ctx.workspaceRoot;
        observedAllowedPaths = ctx.workspaceSnapshot?.allowedPaths;
        const args = input as { path: string; contents: string };
        fs.writeFileSync(path.join(ctx.workspaceRoot!, args.path), args.contents, 'utf8');
        return { content: 'ok' };
      },
    };
    const provider = createMockProvider([
      [
        {
          type: 'tool_use',
          toolUse: {
            id: 'tu-write',
            name: 'write_file',
            input: { path: 'test.txt', contents: '测试' },
          },
        },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'done' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);
    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider([writeProbe]),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/bg-worktree-write', threadId: 'thread-1' },
      model: 'claude-sonnet-4-20250514',
      budgetTracker,
      subagentManager: manager,
      workspaceRoot: staleWorkspaceRoot,
      toolRiskPolicy: makeWorkspacePolicyPort(staleWorkspaceRoot, 'always_ask'),
    });

    try {
      const result = await tool.execute(
        { prompt: 'write', background: true },
        makeContext({ emitStreamEvent: () => {}, workspaceRoot: staleWorkspaceRoot }),
      );
      expect(result.isError).toBeFalsy();
      await tick();

      expect(requestApprovalsBatch).not.toHaveBeenCalled();
      expect(observedWorkspaceRoot).toBe(boundWorkspaceRoot);
      expect(observedAllowedPaths).toContain(normalizePolicyPath(boundWorkspaceRoot).path);
      expect(fs.readFileSync(path.join(boundWorkspaceRoot, 'test.txt'), 'utf8')).toBe('测试');
    } finally {
      fs.rmSync(staleWorkspaceRoot, { recursive: true, force: true });
      fs.rmSync(boundWorkspaceRoot, { recursive: true, force: true });
    }
  });
});

// ─── disposed Manager → 显式报错 ──────────────────────────────────────

describe('agent-tool live 重绑失败语义', () => {
  it('Manager 已 dispose → 后台 spawn 显式报错（不静默 fail-closed deny）', async () => {
    const { budgetTracker, manager } = makeWiredManager();
    manager.dispose();

    const tool = createAgentTool({
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/bg-disposed', threadId: 'thread-1' },
      model: 'claude-sonnet-4-20250514',
      budgetTracker,
      subagentManager: manager,
    });

    const result = await tool.execute(
      { prompt: 'x', background: true },
      makeContext({ emitStreamEvent: () => {} }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('会话环境已失效');
  });
});

// ─── ：缺 SubagentManager → background 降级前台但不静默 ──────────────

describe('agent-tool 缺 Manager 时 background 降级不静默', () => {
  it('background:true 但未接 SubagentManager → 前台同步执行 + 发 SYSTEM_NOTICE + tool_result 前缀', async () => {
    const events: StreamEvent[] = [];
    const budgetTracker = new BudgetTracker();

    // 故意不传 subagentManager（模拟旧 host / 未接 Manager 的运行时）
    const tool = createAgentTool({
      provider: createMockProvider([
        [{ type: 'text_delta', text: '前台跑完的结果' }, { type: 'stop', stopReason: 'end_turn' }],
      ]),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/bg-no-manager', threadId: 'thread-1' },
      model: 'claude-sonnet-4-20250514',
      budgetTracker,
      // subagentManager: 故意缺省
    });

    const result = await tool.execute(
      { prompt: '本该后台的任务', description: '降级验证', background: true },
      makeContext({ emitStreamEvent: (e: StreamEvent) => events.push(e) }),
    );

    // 1) 前台同步执行成功（安全兜底行为不变，不是 error）
    expect(result.isError).toBeFalsy();
    // 2) tool_result 内容带降级前缀（主 Agent 能读到，不会误以为已后台化）
    expect(typeof result.content === 'string' && result.content).toContain('后台模式当前不可用');
    // 3) 拿到的是前台跑完的真实结果，不是「已在后台启动」
    expect(result.content).not.toContain('已在后台启动');
    expect(result.content).toContain('前台跑完的结果');
    // 4) 发了 SYSTEM_NOTICE 让 host/UI 可观测（不再静默降级）
    const notice = events.find(
      (e) =>
        e.type === StreamEvents.SYSTEM_NOTICE &&
        (e.payload as { notice_type?: string })?.notice_type === 'subagent_background_unavailable',
    );
    expect(notice).toBeTruthy();
  });
});

// ─── resume 撞 disposed Manager → 显式报错（rebind 失败语义，session 存在于盘）──

describe('agent-tool resume live 重绑失败语义', () => {
  let tmpDir: string;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('子 session 存在于盘 + Manager 已 dispose → resume 越过盘存在性检查后 rebind 显式报错', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-resume-rebind-'));
    const threadId = 'parent-resume-rebind';
    const childId = 'resume-rebind-0001';

    // 1) 真实 spawn 一个子，落盘 messages.jsonl（让 subagentSessionExists 早检通过）
    const spawnGen = forkQuery({
      childId,
      parentMessages: [],
      taskPrompt: 'SPAWN',
      systemPrompt: '',
      provider: createMockProvider([
        [{ type: 'text_delta', text: 'spawn done' }, { type: 'stop', stopReason: 'end_turn' }],
      ]),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      model: 'sonnet',
      sessionConfig: { sessionDir: tmpDir, threadId },
    });
    let n = await spawnGen.next();
    while (!n.done) n = await spawnGen.next();

    // 2) dispose 的 Manager（模拟 session 环境已失效）
    const budgetTracker = new BudgetTracker();
    const manager = new SubagentManager({ parentThreadId: threadId, spaceId: 'space-1', budgetTracker });
    manager.rebindLiveDeps({ budgetTracker });
    manager.dispose();

    const tool = createAgentTool({
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: tmpDir, threadId },
      model: 'sonnet',
      budgetTracker,
      subagentManager: manager,
    });

    // 3) resume：盘上 session 存在（早检过）→ rebind 撞 disposed → 显式报错
    const result = await tool.execute(
      { prompt: '续跑', resume_agent_id: childId },
      makeContext({ threadId, emitStreamEvent: () => {} }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('会话环境已失效');
  });
});
