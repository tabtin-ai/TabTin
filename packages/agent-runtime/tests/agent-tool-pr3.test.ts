/**
 * W4a PR3 e2e（P1 排队子登记 + S6 check_agent_id + S7 interrupt，2026-05-30）。
 *
 * 北极星（必须 e2e 测通）：
 *   ① check_agent_id：running 后台子查到 running+步数；终态子查到 completed；不存在
 *      报错；**排队中的后台子也查得到**（state='queued'）。
 *   ② interrupt：spawn 后台子运行中 → interrupt + 新 prompt → 旧 run 标 cancelled +
 *      等 settle + 新 run 用新 prompt 续跑（restoreMessages 读回旧历史）→
 *      messages.jsonl 无并发交错（同 childId 串行 runSeq 递增）。
 *   ③ P1：排队中的后台子能被 dispose/cancel 取消、有超时兜底。
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  CHECK_AGENT_STATUS_COOLDOWN_MS,
  createAgentStatusCheckGuard,
  createAgentTool,
} from '../src/subagent/agent-tool.js';
import { SubagentManager } from '../src/session/subagent-manager.js';
import type { SubagentCompletionInfo } from '../src/session/subagent-manager.js';
import { BudgetTracker } from '../src/engine/guards/budget-tracker.js';
import { StreamEvents } from '../src/engine/contracts/stream-events.js';
import {
  createMockProvider,
  createMockPermissionHandler,
  createMockToolProvider,
} from './test-utils.js';
import type {
  StreamEvent,
} from '../src/engine/contracts/wire-protocol.js';
import type {
  Message,
} from '../src/engine/contracts/conversation.js';
import type {
  LLMProvider,
  LLMResponseChunk,
} from '../src/engine/contracts/model-llm.js';
import type {
  Tool,
  ToolContext,
} from '../src/engine/contracts/tools.js';

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    threadId: 'pr3-thread',
    runtimeId: 'pr3-rt',
    toolUseId: 'toolu_pr3',
    abortSignal: new AbortController().signal,
    messages: [] as Message[],
    ...overrides,
  } as ToolContext;
}

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function extractChildId(content: string): string {
  const m = content.match(/\[子 Agent ID: ([^\]]+)\]/);
  if (!m) throw new Error(`no child id in: ${content}`);
  return m[1];
}

/** 受控挂起 provider（流式秒回到 release() 才完成）。 */
function makeHangingProvider() {
  let resolveHang!: () => void;
  const hang = new Promise<void>((resolve) => { resolveHang = resolve; });
  const provider: LLMProvider = {
    async *createStream(): AsyncIterable<LLMResponseChunk> {
      await hang;
      yield { type: 'text_delta' as const, text: 'done' };
      yield { type: 'stop' as const, stopReason: 'end_turn' as const };
    },
  };
  return { provider, release: () => resolveHang() };
}

/** 第一轮调工具（落一轮历史），第二轮挂起到 release() 的 provider。 */
function makeToolThenHangProvider() {
  let resolveHang!: () => void;
  const hang = new Promise<void>((resolve) => { resolveHang = resolve; });
  let turn = 0;
  const provider: LLMProvider = {
    async *createStream(): AsyncIterable<LLMResponseChunk> {
      turn += 1;
      if (turn === 1) {
        yield { type: 'tool_use' as const, toolUse: { id: 'tu-1', name: 'probe', input: {} } };
        yield { type: 'stop' as const, stopReason: 'tool_use' as const };
        return;
      }
      await hang;
      yield { type: 'text_delta' as const, text: 'done' };
      yield { type: 'stop' as const, stopReason: 'end_turn' as const };
    },
  };
  return { provider, release: () => resolveHang() };
}

// isReadOnly:false 让工具走正常 runTools 路径（emit tool_completed），从而触发
// agent-tool while 循环的 stepCount++ / reportProgress。只读工具会被 query.ts 的
// pre-start 快路径吞掉（只发 tool_pre_started_exec_*，不发 tool_completed）——那是
// 与 UI 进度卡共享的既有行为，stepCount 对只读工具同样不计（PR3 范围外）。
const probeTool: Tool = {
  name: 'probe',
  description: 'probe tool',
  inputSchema: { type: 'object', properties: {} },
  isReadOnly: false,
  async execute() { return { content: 'PROBE_RESULT' }; },
};

function makeManager(threadId: string, budgetTracker: BudgetTracker) {
  const manager = new SubagentManager({ parentThreadId: threadId, spaceId: 'space-1', budgetTracker });
  manager.rebindLiveDeps({ budgetTracker });
  return manager;
}

// ─────────────────────────────────────────────────────────────────────
// P1：排队中的后台子登记进 Manager + dispose/cancel/超时网
// ─────────────────────────────────────────────────────────────────────

describe('PR3 P1：排队中的后台子登记进 Manager', () => {
  it('排队后台子在 Manager 可见（state=queued, background）+ hasBackgroundRuns + dispose 取消', async () => {
    const threadId = 'p1-dispose';
    const bt = new BudgetTracker({ maxConcurrentChildren: 1, maxQueueSize: 5 });
    bt.trySubmit({ speakerId: 'pre-occupied' }); // 占满唯一 active 槽 → 后台子进队列
    const manager = makeManager(threadId, bt);
    const events: StreamEvent[] = [];
    const { provider } = makeHangingProvider();

    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/pr3-p1-dispose', threadId },
      model: 'claude-sonnet-4-20250514',
      budgetTracker: bt,
      subagentManager: manager,
    });

    const r = await tool.execute(
      { prompt: '排队的后台任务', description: '排队后台子', background: true },
      makeContext({ threadId, emitStreamEvent: (e: StreamEvent) => events.push(e) }),
    );
    const childId = extractChildId(r.content);
    await tick();

    // 排队中的后台子：在 Manager 可见 + 标 queued + background；hasBackgroundRuns 看得到
    expect(manager.has(childId)).toBe(true);
    expect(manager.getStatus(childId)?.state).toBe('queued');
    expect(manager.getStatus(childId)?.background).toBe(true);
    expect(manager.hasBackgroundRuns()).toBe(true);
    // 还在排队，没真启动
    expect(events.some((e) => e.type === StreamEvents.SUBAGENT_QUEUED)).toBe(true);
    expect(events.some((e) => e.type === StreamEvents.SUBAGENT_STARTED)).toBe(false);

    // dispose → 取消排队中的后台子（abort + onCancel=cancelQueued 中断排队 await）
    manager.dispose();
    await tick();

    expect(manager.has(childId)).toBe(false);
    expect(manager.isDisposed).toBe(true);
    const failed = events.find((e) => e.type === StreamEvents.SUBAGENT_FAILED);
    expect(failed, 'dispose 应让排队后台子终态 FAILED(cancelled)').toBeTruthy();
    expect((failed!.payload as { cancelled?: boolean }).cancelled).toBe(true);
    // 始终没真启动
    expect(events.some((e) => e.type === StreamEvents.SUBAGENT_STARTED)).toBe(false);
  });

  it('manager.cancel(childId) 取消排队中的后台子', async () => {
    const threadId = 'p1-cancel';
    const bt = new BudgetTracker({ maxConcurrentChildren: 1, maxQueueSize: 5 });
    bt.trySubmit({ speakerId: 'pre-occupied' });
    const manager = makeManager(threadId, bt);
    const events: StreamEvent[] = [];
    const { provider } = makeHangingProvider();

    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/pr3-p1-cancel', threadId },
      model: 'claude-sonnet-4-20250514',
      budgetTracker: bt,
      subagentManager: manager,
    });

    const r = await tool.execute(
      { prompt: '排队后台子', background: true },
      makeContext({ threadId, emitStreamEvent: (e: StreamEvent) => events.push(e) }),
    );
    const childId = extractChildId(r.content);
    await tick();
    expect(manager.has(childId)).toBe(true);

    expect(manager.cancel(childId)).toBe(true);
    await tick();

    expect(manager.has(childId)).toBe(false);
    const failed = events.find((e) => e.type === StreamEvents.SUBAGENT_FAILED);
    expect(failed).toBeTruthy();
    expect((failed!.payload as { cancelled?: boolean }).cancelled).toBe(true);
    expect(events.some((e) => e.type === StreamEvents.SUBAGENT_STARTED)).toBe(false);
  });

  it('排队期超时网：backgroundQueueTimeoutMs 到点 → SUBAGENT_FAILED(timeout)', async () => {
    const threadId = 'p1-timeout';
    const bt = new BudgetTracker({ maxConcurrentChildren: 1, maxQueueSize: 5 });
    bt.trySubmit({ speakerId: 'pre-occupied' }); // 永不释放 → 后台子永远排队，靠超时网兜底
    const manager = makeManager(threadId, bt);
    const events: StreamEvent[] = [];
    const { provider } = makeHangingProvider();

    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/pr3-p1-timeout', threadId },
      model: 'claude-sonnet-4-20250514',
      budgetTracker: bt,
      subagentManager: manager,
      backgroundQueueTimeoutMs: 50, // 注入极短排队超时
    });

    const r = await tool.execute(
      { prompt: '永远排队的后台子', background: true },
      makeContext({ threadId, emitStreamEvent: (e: StreamEvent) => events.push(e) }),
    );
    const childId = extractChildId(r.content);

    await tick(140); // > 50ms 排队超时

    const failed = events.find((e) => e.type === StreamEvents.SUBAGENT_FAILED);
    expect(failed, '排队超时应终态 FAILED').toBeTruthy();
    expect((failed!.payload as { error_kind?: string }).error_kind).toBe('timeout');
    expect(manager.has(childId)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// S6：check_agent_id 状态查询
// ─────────────────────────────────────────────────────────────────────

describe('PR3 S6：check_agent_id 状态查询', () => {
  let tmpDir: string;
  afterEach(() => { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('结构化状态 + 同一父 run 冷却期内节流；新父 run 可立即再查', async () => {
    const threadId = 's6-check-once';
    const bt = new BudgetTracker();
    const manager = makeManager(threadId, bt);
    const childId = 'child-check-once';
    const unregister = manager.registerRun(
      childId,
      new AbortController(),
      { state: 'active', background: true, label: '状态查询测试' },
    );
    manager.reportProgress(childId, { stepCount: 2, latestTool: 'probe' });

    const tool = createAgentTool({
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/pr3-s6-check-once', threadId },
      model: 'claude-sonnet-4-20250514',
      budgetTracker: bt,
      subagentManager: manager,
    });

    const first = await tool.execute(
      { check_agent_id: childId },
      makeContext({ threadId, agentRunId: 'parent-run-a' }),
    );
    expect(first.presentation).toMatchObject({
      kind: 'subagent_status_check',
      data: {
        childId,
        status: 'running',
        stepCount: 2,
        latestTool: 'probe',
      },
    });

    const repeated = await tool.execute(
      { check_agent_id: childId },
      makeContext({ threadId, agentRunId: 'parent-run-a' }),
    );
    expect(repeated.isError).toBe(true);
    expect(String(repeated.content)).toContain('距上次查询');
    expect(String(repeated.content)).toContain('不足 15 秒');
    expect(String(repeated.content)).toContain('wait_agent_ids');
    expect(repeated.presentation).toMatchObject({
      kind: 'subagent_status_check',
      data: { childId, status: 'already_checked' },
    });

    const nextParentRun = await tool.execute(
      { check_agent_id: childId },
      makeContext({ threadId, agentRunId: 'parent-run-b' }),
    );
    expect(nextParentRun.presentation).toMatchObject({
      kind: 'subagent_status_check',
      data: { childId, status: 'running' },
    });

    unregister();
  });

  it('check 冷却守卫：冷却后同一父 run 可再 claim', () => {
    let nowMs = 0;
    const guard = createAgentStatusCheckGuard(() => nowMs);
    expect(guard.claim('run-1', 'child-a')).toBe(true);
    expect(guard.claim('run-1', 'child-a')).toBe(false);
    nowMs += CHECK_AGENT_STATUS_COOLDOWN_MS - 1;
    expect(guard.claim('run-1', 'child-a')).toBe(false);
    nowMs += 1;
    expect(guard.claim('run-1', 'child-a')).toBe(true);
    expect(guard.claim(undefined, 'child-a')).toBe(true);
  });

  it('running 后台子 → running + 步数 + 最近工具（内存活体）', async () => {
    const threadId = 's6-running';
    const bt = new BudgetTracker();
    const manager = makeManager(threadId, bt);
    const { provider, release } = makeToolThenHangProvider();

    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider([probeTool]),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/pr3-s6-running', threadId },
      model: 'claude-sonnet-4-20250514',
      budgetTracker: bt,
      subagentManager: manager,
    });

    const r = await tool.execute(
      { prompt: '跑工具后挂起', description: '运行中的子', background: true },
      makeContext({ threadId, emitStreamEvent: () => {} }),
    );
    const childId = extractChildId(r.content);
    // 等到第一个工具完成（stepCount=1），子卡在第二轮
    await waitFor(() => (manager.getStatus(childId)?.stepCount ?? 0) >= 1);

    // check_agent_id 查询（同一个工具实例，新一次 execute）
    const status = await tool.execute(
      { check_agent_id: childId },
      makeContext({ threadId, agentRunId: 'parent-run-a', emitStreamEvent: () => {} }),
    );
    expect(status.isError).toBeFalsy();
    expect(String(status.content)).toContain('运行中');
    expect(String(status.content)).toContain('已执行 1 步');
    expect(String(status.content)).toContain('probe');
    expect(String(status.content)).toContain(`[子 Agent ID: ${childId}]`);
    expect(status.presentation).toMatchObject({
      kind: 'subagent_status_check',
      data: {
        childId,
        status: 'running',
        stepCount: 1,
        latestTool: 'probe',
      },
    });

    const repeated = await tool.execute(
      { check_agent_id: childId },
      makeContext({ threadId, agentRunId: 'parent-run-a', emitStreamEvent: () => {} }),
    );
    expect(repeated.isError).toBe(true);
    expect(String(repeated.content)).toContain('距上次查询');
    expect(String(repeated.content)).toContain('wait_agent_ids');
    expect(repeated.presentation).toMatchObject({
      kind: 'subagent_status_check',
      data: { childId, status: 'already_checked' },
    });

    const nextParentRun = await tool.execute(
      { check_agent_id: childId },
      makeContext({ threadId, agentRunId: 'parent-run-b', emitStreamEvent: () => {} }),
    );
    expect(nextParentRun.presentation).toMatchObject({
      kind: 'subagent_status_check',
      data: { childId, status: 'running' },
    });

    release();
    await tick();
  });

  it('排队中的后台子 → 排队中（北极星①：排队子也查得到）', async () => {
    const threadId = 's6-queued';
    const bt = new BudgetTracker({ maxConcurrentChildren: 1, maxQueueSize: 5 });
    bt.trySubmit({ speakerId: 'pre-occupied' });
    const manager = makeManager(threadId, bt);
    const { provider } = makeHangingProvider();

    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/pr3-s6-queued', threadId },
      model: 'claude-sonnet-4-20250514',
      budgetTracker: bt,
      subagentManager: manager,
    });

    const r = await tool.execute(
      { prompt: '排队后台子', background: true },
      makeContext({ threadId, emitStreamEvent: () => {} }),
    );
    const childId = extractChildId(r.content);
    await tick();

    const status = await tool.execute(
      { check_agent_id: childId },
      makeContext({ threadId, emitStreamEvent: () => {} }),
    );
    expect(status.isError).toBeFalsy();
    expect(String(status.content)).toContain('排队中');
    expect(String(status.content)).toContain(`[子 Agent ID: ${childId}]`);
    expect(status.presentation).toMatchObject({
      kind: 'subagent_status_check',
      data: { childId, status: 'queued' },
    });

    manager.dispose(); // 清理
  });

  it('终态 completed 子 → 已完成（subagents.jsonl 回落）', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr3-s6-done-'));
    const threadId = 's6-done';
    const bt = new BudgetTracker();
    const manager = makeManager(threadId, bt);

    const tool = createAgentTool({
      provider: createMockProvider([
        [{ type: 'text_delta', text: '调研完成：方案 B' }, { type: 'stop', stopReason: 'end_turn' }],
      ]),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: tmpDir, threadId },
      model: 'claude-sonnet-4-20250514',
      budgetTracker: bt,
      subagentManager: manager,
    });

    const r = await tool.execute(
      { prompt: '一轮就完成', description: '已完成的子', background: true },
      makeContext({ threadId, emitStreamEvent: () => {} }),
    );
    const childId = extractChildId(r.content);
    // 等后台子真正完成（Manager 注销 + jsonl 写 ended）
    await waitFor(() => !manager.has(childId));
    await tick();

    const status = await tool.execute(
      { check_agent_id: childId },
      makeContext({ threadId, emitStreamEvent: () => {} }),
    );
    expect(status.isError).toBeFalsy();
    expect(String(status.content)).toContain('已完成');
    expect(String(status.content)).toContain(`[子 Agent ID: ${childId}]`);
    expect(status.presentation).toMatchObject({
      kind: 'subagent_status_check',
      data: { childId, status: 'completed' },
    });
  });

  it('不存在的子 Agent → isError「未找到」', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr3-s6-404-'));
    const threadId = 's6-404';
    const bt = new BudgetTracker();
    const manager = makeManager(threadId, bt);

    const tool = createAgentTool({
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: tmpDir, threadId },
      model: 'claude-sonnet-4-20250514',
      budgetTracker: bt,
      subagentManager: manager,
    });

    const status = await tool.execute(
      { check_agent_id: 'never-existed-xyz' },
      makeContext({ threadId, emitStreamEvent: () => {} }),
    );
    expect(status.isError).toBe(true);
    expect(String(status.content)).toContain('未找到该子 Agent');
    expect(status.presentation).toMatchObject({
      kind: 'subagent_status_check',
      data: { childId: 'never-existed-xyz', status: 'not_found' },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// S7：interrupt 中断重定向
// ─────────────────────────────────────────────────────────────────────

/**
 * 北极星② 场景 provider：turn1 调工具落一轮历史；turn2 缓慢流式直到 requestInterrupt()
 * 后**抛错**模拟上游被中断（配合 cancelSubagent 已 abort 的 signal → forkQuery 记
 * 'cancelled'）；turn3+ 续跑捕获装填 + 完成。
 *
 * 为什么靠「抛错」而非纯 checkAbort：runtime 对 checkAbort 触发的 abort 是**优雅收尾**
 * （yield DONE(ABORT) 不向 forkQuery 抛），forkQuery 会记 'completed'；只有 provider
 * 真抛错且 signal.aborted 时 forkQuery 才记 'cancelled'（与既有 cancel-classification
 * 测试同源）。flag 在 loop 顶部检查（throw 在 yield 之前），保证不会先被 checkAbort 抢走。
 */
function makeInterruptScenarioProvider() {
  let turn = 0;
  let capturedResume: unknown;
  let interruptRequested = false;
  const provider: LLMProvider = {
    async *createStream(request): AsyncIterable<LLMResponseChunk> {
      turn += 1;
      if (turn === 1) {
        yield { type: 'text_delta' as const, text: 'ROUND1_MARKER 先调个工具' };
        yield { type: 'tool_use' as const, toolUse: { id: 'tu-r1', name: 'probe', input: {} } };
        yield { type: 'stop' as const, stopReason: 'tool_use' as const };
        return;
      }
      if (turn === 2) {
        // 缓慢流式，直到 requestInterrupt()：在 yield 前检查 flag → 抛错（此时 interrupt
        // 已 cancelSubagent abort 了 signal）→ forkQuery catch 记 'cancelled'。
        for (let i = 0; i < 100_000; i++) {
          if (interruptRequested) throw new Error('UPSTREAM_INTERRUPTED');
          yield { type: 'text_delta' as const, text: '.' };
          await new Promise((r) => setTimeout(r, 15));
        }
        yield { type: 'stop' as const, stopReason: 'end_turn' as const };
        return;
      }
      // turn3+ = resume 续跑：捕获装填 messages + 立即完成
      if (capturedResume === undefined) {
        capturedResume = (request as { messages?: unknown }).messages;
      }
      yield { type: 'text_delta' as const, text: 'RESUME_DONE 已按新指令完成' };
      yield { type: 'stop' as const, stopReason: 'end_turn' as const };
    },
  };
  return { provider, getCapturedResume: () => capturedResume, requestInterrupt: () => { interruptRequested = true; } };
}

/**
 * turn1 缓慢流式「永不完成一轮」（被 abort 时 checkAbort 优雅收尾、**不落历史**）；
 * turn2+ 立即完成。用于「中断一个无可续跑历史的子 → 降级为全新 spawn」场景。
 */
function makeStreamThenCompleteProvider() {
  let turn = 0;
  const provider: LLMProvider = {
    async *createStream(): AsyncIterable<LLMResponseChunk> {
      turn += 1;
      if (turn === 1) {
        for (let i = 0; i < 100_000; i++) {
          yield { type: 'text_delta' as const, text: '.' };
          await new Promise((r) => setTimeout(r, 15));
        }
        yield { type: 'stop' as const, stopReason: 'end_turn' as const };
        return;
      }
      yield { type: 'text_delta' as const, text: 'FRESH_SPAWN_DONE' };
      yield { type: 'stop' as const, stopReason: 'end_turn' as const };
    },
  };
  return { provider };
}

describe('PR3 S7：interrupt 中断重定向', () => {
  let tmpDir: string;
  afterEach(() => { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('北极星②：interrupt 运行中后台子 → 旧 run cancelled + 等 settle + 新 prompt 续跑 + jsonl 无交错', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr3-s7-'));
    const threadId = 's7-interrupt';
    const bt = new BudgetTracker();
    const manager = makeManager(threadId, bt);
    const { provider, getCapturedResume, requestInterrupt } = makeInterruptScenarioProvider();
    const events: StreamEvent[] = [];

    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider([probeTool]),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: tmpDir, threadId },
      model: 'claude-sonnet-4-20250514',
      budgetTracker: bt,
      subagentManager: manager,
    });

    // 1) 后台 spawn → 立即返回 childId；子进入运行中（turn1 工具完成 → turn2 流式）
    const spawn = await tool.execute(
      { prompt: 'SPAWN_TASK 初始任务', description: '可中断任务', background: true },
      makeContext({ threadId, emitStreamEvent: (e: StreamEvent) => events.push(e) }),
    );
    const childId = extractChildId(spawn.content);
    await waitFor(() => (manager.getStatus(childId)?.stepCount ?? 0) >= 1);
    expect(manager.getStatus(childId)?.state).toBe('active');

    // 2) interrupt + 新 prompt 续跑（前台，等结果）。先置 flag——execute 内 cancelSubagent
    // 同步 abort 在前、provider 下一轮循环顶部 throw 在后，确保 signal 已 abort → cancelled。
    requestInterrupt();
    const resumeResult = await tool.execute(
      { prompt: 'RESUME_DIRECTIVE 改做新任务', resume_agent_id: childId, interrupt: true },
      makeContext({ threadId, emitStreamEvent: (e: StreamEvent) => events.push(e) }),
    );

    // 3) 续跑成功 + 同 childId
    expect(resumeResult.isError, String(resumeResult.content)).toBeFalsy();
    expect(String(resumeResult.content)).toContain('RESUME_DONE');
    expect(extractChildId(resumeResult.content)).toBe(childId);

    // 4) 续跑读回旧历史 + 新指令生效
    const cap = JSON.stringify(getCapturedResume());
    expect(cap, 'restoreMessages 读回旧 run 产出').toContain('ROUND1_MARKER');
    expect(cap, '新指令生效').toContain('RESUME_DIRECTIVE');

    // 5) 索引：旧 run runSeq=1 cancelled，新 run runSeq=2 completed（串行、递增）
    const indexPath = path.join(tmpDir, threadId, 'subagents.jsonl');
    const lines = fs.readFileSync(indexPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    const sub = `agent-${childId}`;
    const ends = lines.filter((l) => l.phase === 'ended' && l.subSessionId === sub);
    expect(ends.find((e) => e.runSeq === 1)?.status, '旧 run cancelled').toBe('cancelled');
    expect(ends.find((e) => e.runSeq === 2)?.status, '新 run completed').toBe('completed');

    // 6) messages.jsonl 无并发交错：每行可独立 JSON.parse（两 run 串行 append 不损坏）
    const msgPath = path.join(tmpDir, threadId, 'subagents', sub, 'messages.jsonl');
    const msgLines = fs.readFileSync(msgPath, 'utf-8').trim().split('\n');
    expect(msgLines.length).toBeGreaterThan(0);
    for (const l of msgLines) expect(() => JSON.parse(l)).not.toThrow();
  });

  it('interrupt 缺省 + 目标运行中 → 仍走 in-flight 守门拒绝并发续跑', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr3-s7-noninterrupt-'));
    const threadId = 's7-noninterrupt';
    const bt = new BudgetTracker();
    const manager = makeManager(threadId, bt);
    const { provider, release } = makeToolThenHangProvider();

    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider([probeTool]),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: tmpDir, threadId },
      model: 'claude-sonnet-4-20250514',
      budgetTracker: bt,
      subagentManager: manager,
    });

    const spawn = await tool.execute(
      { prompt: '跑工具后挂起', background: true },
      makeContext({ threadId, emitStreamEvent: () => {} }),
    );
    const childId = extractChildId(spawn.content);
    // 等到子历史已落盘（subagentSessionExists 通过）+ 仍在运行——确保下面命中的是
    // in-flight 守门而非 resume 早检的「会话不存在」。
    const msgPath = path.join(tmpDir, threadId, 'subagents', `agent-${childId}`, 'messages.jsonl');
    await waitFor(() => fs.existsSync(msgPath) && manager.getStatus(childId)?.state === 'active');

    // resume 不带 interrupt → in-flight 守门拒绝（行为不变）
    const denied = await tool.execute(
      { prompt: '并发续跑', resume_agent_id: childId },
      makeContext({ threadId, emitStreamEvent: () => {} }),
    );
    expect(denied.isError).toBe(true);
    expect(String(denied.content)).toContain('正在运行中');

    release();
    await tick();
  });

  it('interrupt=true + 目标已结束 → 等同普通续跑（无可中断）', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr3-s7-ended-'));
    const threadId = 's7-ended';
    const bt = new BudgetTracker();
    const manager = makeManager(threadId, bt);

    const tool = createAgentTool({
      provider: createMockProvider([
        [{ type: 'text_delta', text: 'SPAWN_DONE' }, { type: 'stop', stopReason: 'end_turn' }],
        [{ type: 'text_delta', text: 'RESUME_DONE' }, { type: 'stop', stopReason: 'end_turn' }],
      ]),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: tmpDir, threadId },
      model: 'claude-sonnet-4-20250514',
      budgetTracker: bt,
      subagentManager: manager,
    });

    // 前台 spawn 一个秒完成的子
    const spawn = await tool.execute(
      { prompt: '一轮完成' },
      makeContext({ threadId, emitStreamEvent: () => {} }),
    );
    const childId = extractChildId(spawn.content);
    expect(manager.has(childId)).toBe(false); // 已结束

    // interrupt=true 续跑已结束的子 → 走普通 resume（不应报「未能停止」）
    const resumeResult = await tool.execute(
      { prompt: '基于结果继续', resume_agent_id: childId, interrupt: true },
      makeContext({ threadId, emitStreamEvent: () => {} }),
    );
    expect(resumeResult.isError, String(resumeResult.content)).toBeFalsy();
    expect(String(resumeResult.content)).toContain('RESUME_DONE');
    expect(extractChildId(resumeResult.content)).toBe(childId);
  });

  // PR3 review P1-1：刚 spawn 的后台子（childId 已交还、messages.jsonl 未落盘）被
  // 并发 resume 时，应报「正在运行中」（in-flight 守门）而非「会话不存在」（盘早检）——
  // 后者会诱导主 Agent 重复派一个新子。验证守门已排在盘早检之前。
  it('P1-1：运行中但未落盘的后台子 → resume(无 interrupt) 报「正在运行中」非「会话不存在」', async () => {
    const threadId = 's7-p1-order';
    const bt = new BudgetTracker();
    const manager = makeManager(threadId, bt);
    // makeHangingProvider：turn1 立即 await hang，不完成任何一轮 → messages.jsonl 不落盘
    const { provider, release } = makeHangingProvider();

    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/pr3-s7-p1-order', threadId },
      model: 'claude-sonnet-4-20250514',
      budgetTracker: bt,
      subagentManager: manager,
    });

    const spawn = await tool.execute(
      { prompt: '挂起不落盘', background: true },
      makeContext({ threadId, emitStreamEvent: () => {} }),
    );
    const childId = extractChildId(spawn.content);
    await waitFor(() => manager.getStatus(childId)?.state === 'active');

    const denied = await tool.execute(
      { prompt: '并发续跑', resume_agent_id: childId },
      makeContext({ threadId, emitStreamEvent: () => {} }),
    );
    expect(denied.isError).toBe(true);
    expect(String(denied.content)).toContain('正在运行中');
    expect(String(denied.content)).not.toContain('会话不存在');

    release();
    await tick();
  });

  // PR3 review 收口：interrupt + 后台续跑时，旧 run 的「已取消」终态通知被抑制——
  // 避免与新 run（同 childId）的「已完成」通知 dedup 撞车把新结果吞掉。
  it('interrupt + 后台续跑：旧 run 取消通知被抑制，只发新 run 完成通知', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr3-s7-notify-'));
    const threadId = 's7-notify';
    const bt = new BudgetTracker();
    const captured: SubagentCompletionInfo[] = [];
    const manager = new SubagentManager({
      parentThreadId: threadId,
      spaceId: 'space-1',
      budgetTracker: bt,
      enqueueNotification: (info) => { captured.push(info); return true; },
    });
    manager.rebindLiveDeps({ budgetTracker: bt });
    const { provider, requestInterrupt } = makeInterruptScenarioProvider();

    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider([probeTool]),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: tmpDir, threadId },
      model: 'claude-sonnet-4-20250514',
      budgetTracker: bt,
      subagentManager: manager,
    });

    const spawn = await tool.execute(
      { prompt: 'SPAWN_TASK', description: '可中断后台子', background: true },
      makeContext({ threadId, emitStreamEvent: () => {} }),
    );
    const childId = extractChildId(spawn.content);
    await waitFor(() => (manager.getStatus(childId)?.stepCount ?? 0) >= 1);

    // interrupt + **后台**续跑（run2 也后台 → 走 notifyCompleted）
    requestInterrupt();
    const resume = await tool.execute(
      { prompt: 'RESUME_DIRECTIVE', resume_agent_id: childId, interrupt: true, background: true },
      makeContext({ threadId, emitStreamEvent: () => {} }),
    );
    expect(String(resume.content)).toContain('已在后台启动');

    // 等 run2 后台完成投递通知
    await waitFor(() => captured.some((i) => i.subagent_run_id === childId && i.status === 'completed'));
    await tick();

    const cancelledNotifs = captured.filter((i) => i.subagent_run_id === childId && i.status === 'cancelled');
    const completedNotifs = captured.filter((i) => i.subagent_run_id === childId && i.status === 'completed');
    // 旧 run 的「已取消」终态通知被抑制（否则会与新 run 完成通知 dedup 撞车）
    expect(cancelledNotifs).toHaveLength(0);
    // 新 run 的「已完成」通知正常投递
    expect(completedNotifs.length).toBeGreaterThanOrEqual(1);
  });

  // PR3 review P0：cancelSubagent 同步删模块表后、run 真 settle 之前，plain resume
  // 必须经 manager.has 仍被守门拒绝——否则新旧两 run 并发写同一 messages.jsonl。
  it('P0：cancel 后未 settle 期间 plain resume 经 manager.has 仍被拒（防并发写）', async () => {
    const { cancelSubagent } = await import('../src/subagent/agent-tool.js');
    const threadId = 's7-p0-guard';
    const bt = new BudgetTracker();
    const manager = makeManager(threadId, bt);
    // turn1 调工具落历史、turn2 await hang **忽略 abort** → cancelSubagent 后 run 不 settle
    const { provider, release } = makeToolThenHangProvider();

    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider([probeTool]),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/pr3-s7-p0-guard', threadId },
      model: 'claude-sonnet-4-20250514',
      budgetTracker: bt,
      subagentManager: manager,
    });

    const spawn = await tool.execute(
      { prompt: '跑工具后挂起', background: true },
      makeContext({ threadId, emitStreamEvent: () => {} }),
    );
    const childId = extractChildId(spawn.content);
    await waitFor(() => (manager.getStatus(childId)?.stepCount ?? 0) >= 1);

    // 模拟 W0 取消 / interrupt 超时：cancelSubagent 同步删模块表，但 run 仍挂起（忽略
    // abort）→ Manager 仍登记 → 守门必须经 manager.has 命中。
    expect(cancelSubagent(childId)).toBe(true);
    expect(manager.has(childId)).toBe(true);

    const denied = await tool.execute(
      { prompt: '并发续跑', resume_agent_id: childId },
      makeContext({ threadId, emitStreamEvent: () => {} }),
    );
    expect(denied.isError).toBe(true);
    expect(String(denied.content)).toContain('正在运行中');

    release();
    await tick();
  });

  // PR3 review：interrupt 一个**无可续跑历史**的子（流式中途未落盘）→ 不报「会话不
  // 存在」，而是降级为全新 spawn（新 childId），兑现 interrupt 的「重定向」契约。
  it('interrupt 无历史的子 → 降级为全新 spawn（新 childId，非「会话不存在」）', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr3-s7-degrade-'));
    const threadId = 's7-degrade';
    const bt = new BudgetTracker();
    const manager = makeManager(threadId, bt);
    const { provider } = makeStreamThenCompleteProvider();

    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: tmpDir, threadId },
      model: 'claude-sonnet-4-20250514',
      budgetTracker: bt,
      subagentManager: manager,
    });

    const spawn = await tool.execute(
      { prompt: '流式不落盘', background: true },
      makeContext({ threadId, emitStreamEvent: () => {} }),
    );
    const childId = extractChildId(spawn.content);
    await waitFor(() => manager.getStatus(childId)?.state === 'active');
    await tick(40); // 确保 turn1 进入流式

    const resume = await tool.execute(
      { prompt: 'REDIRECT 改任务', resume_agent_id: childId, interrupt: true, background: true },
      makeContext({ threadId, emitStreamEvent: () => {} }),
    );
    expect(resume.isError, String(resume.content)).toBeFalsy();
    expect(String(resume.content)).not.toContain('会话不存在');
    // 降级为全新 spawn → 新 childId（不复用被中断的无历史子）
    expect(extractChildId(resume.content)).not.toBe(childId);
    await tick();
  });
});
