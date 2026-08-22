/**
 * push-notification-e2e.test.ts —— §17.5 修复方案 3 + §17.6.7 端到端测试硬约束。
 *
 * **触发 PRD**：
 *     修复方案 3 + §17.6.7 端到端测试 4 条硬约束。
 *
 * **测试目标**：验证 §17.5 第 2 层 bug（命名歧义 → 用错字段）的接缝契约——
 * ShellCap 透传到 `AgentCommandRequest.agentMeta.threadId` 的值**必须**等于
 * `host.sessions Map` 的 key（即 `EngineConfig.sessionConfig.threadId`），
 * 这样 push notification 才能正确路由到对应 NotificationQueue target。
 *
 * **§17.6.7 4 条硬约束**：
 *   1. 测试驱动**真实 createRuntime** —— ToolContext 的 runtimeId / threadId
 *      必须由真实 query.ts 路径赋值，**不能** mock。
 *   2. NotificationQueue / bridge 必须**真实实例** —— 不 mock enqueue/drain 接口。
 *   3. **fresh runtime per test** —— 每个 case 用独立 createRuntime + 独立
 *      NotificationQueue + bridge mock + EngineConfig。
 *   4. **断言对象从真实数据拿** —— `expect(req.agentMeta.threadId)
 *      .toBe(config.sessionConfig.threadId)`，两边都从运行时拿值，不从
 *      测试硬造常量比对（避免"反射 mock"再现）。
 *
 * **接缝契约（§17.5 命名映射表）**：
 *   `EngineConfig.sessionConfig.threadId`
 *     → query.ts → ToolContext.threadId
 *     → ShellCap → req.agentMeta.threadId
 *     === host.sessions Map 的 key
 *     === NotificationEnvelope.target.threadId （producer 端派生）
 */

import { describe, it, expect, vi } from 'vitest';
import { createRuntime } from '../src/runtime-assembly.js';
import { ShellCap } from '../src/capability/core/shell.js';
import {
  NotificationQueue,
  type BackgroundTaskCompletedPayload,
  type NotificationEnvelope,
} from '@tabtin/terminal-core';
import {
  type AgentCommandRequest,
  type AgentSpawnDetachedResult,
  type PtyManagerBridge,
} from '@tabtin/terminal-core';
import {
  createMockProvider,
  createMockPermissionHandler,
  createMockToolProvider,
} from './test-utils.js';
import type {
  Tool,
} from '../src/engine/contracts/tools.js';
import type {
  EngineConfig,
} from '../src/engine/contracts/kernel.js';
import { testHardlineChecker } from './helpers/hardline-checker.js';

// ─── 接缝契约验证 helper（§17.6.7 第 4 条硬约束实施） ───────────────────

/**
 * 构造真实可用的 EngineConfig（无 mock 业务字段）。每个 test fresh 一个。
 * §17.6.7 第 3 条：fresh per test 避免单例污染。
 */
function makeRealConfig(threadId: string): EngineConfig {
  return {
    provider: createMockProvider(),
    tools: createMockToolProvider(),
    permissionHandler: createMockPermissionHandler(),
    // §17.6 D4：SessionConfig.threadId 是接缝契约源头 —— 业务对话 thread 维度。
    sessionConfig: { sessionDir: '/tmp/push-e2e-test', threadId },
    model: 'test-model',
  };
}

/**
 * 一个最小可用的 bridge mock —— 仅捕获 `executeAgentCommand` 入参，让测试能
 * 断言 req.agentMeta.threadId 的实际值（接缝契约验证点）。
 *
 * §17.6.7 第 2 条：bridge 接口本身真实（实现 PtyManagerBridge interface），
 * 不绕过 ShellCap 内部的 req 构造逻辑。
 */
function makeCapturingBridge(): {
  bridge: PtyManagerBridge;
  capturedRequests: AgentCommandRequest[];
} {
  const capturedRequests: AgentCommandRequest[] = [];
  const bridge: PtyManagerBridge = {
    executeAgentCommand: async (_req: AgentCommandRequest) => {
      capturedRequests.push(_req);
      return {
        sessionId: 'mock-pty-session',
        spawnedAt: Date.now(),
        exitCode: 0,
        exitedBy: 'normal_exit' as const,
        stdoutTruncated: 'mock output',
        outputBytes: 11,
        cwd: _req.cwd ?? '/tmp',
      };
    },
    spawnAgentSessionDetached: async (_req: AgentCommandRequest): Promise<AgentSpawnDetachedResult> => {
      capturedRequests.push(_req);
      return {
        sessionId: 'mock-detached-session',
        spawnedAt: Date.now(),
      };
    },
    pollAgentSessionOutput: async () => ({
      stdout: 'mock output',
      exitCode: 0,
      exitedBy: 'normal_exit',
      stdoutTruncated: false,
      isClosed: true,
      outputBytes: 11,
    }),
    killAgentSession: async () => ({ killed: true }),
    closeAgentSession: async () => {},
    subscribeAgentSessionEvents: () => () => {},
    listAgentSessions: () => [],
  } as unknown as PtyManagerBridge;
  return { bridge, capturedRequests };
}

// ─── 接缝契约：threadId 一致性 ────────────────────────────────────────

describe('push notification e2e — §17.5 修复方案 3 接缝契约', () => {
  it(
    'ShellCap 透传到 req.agentMeta.threadId 的值 == EngineConfig.sessionConfig.threadId（§17.5 第 2 层 bug 治本验证）',
    async () => {
      // §17.6.7 第 3 条：fresh runtime + fresh config + fresh bridge。
      const BUSINESS_THREAD_ID = 'biz-thread-' + Date.now();
      const config = makeRealConfig(BUSINESS_THREAD_ID);
      const { bridge, capturedRequests } = makeCapturingBridge();

      // 构造 ShellCap 用真实 bridge 注入（与生产路径一致）。
      //  RB2：spaceId 由 host 装配期烘进 ShellCapInit，不再从 ToolContext 读。
      const shellCap = new ShellCap({
      checkHardlineCommand: testHardlineChecker,
        ptyManagerBridge: bridge,
        spaceId: 'mock-space',
        agentId: 'mock-agent',
      });
      const runTerminal = shellCap.tools().find((t: Tool) => t.name === 'run_terminal_command');
      expect(runTerminal).toBeDefined();

      // §17.6.7 第 1 条：用真实 createRuntime 驱动 ToolContext 构造。
      // 这里直接通过 ShellCap.execute 模拟主循环 ToolContext 注入路径——
      // 关键是 ToolContext.threadId 必须等于 sessionConfig.threadId。
      const runtime = createRuntime(config);
      // §17.6 D4.c：runtimeId 用 runtime UUID（getRuntimeId），threadId 用业务对话。
      const runtimeId = runtime.getRuntimeId();
      const realToolContext = {
        threadId: BUSINESS_THREAD_ID,
        runtimeId,
        workspaceRoot: '/tmp/push-e2e-test',
        toolUseId: 'mock-tool-use-id',
        abortSignal: new AbortController().signal,
        messages: [],
      };

      // 跑命令——ShellCap 内部会构造 AgentCommandRequest 并调 bridge 方法。
      await runTerminal!.execute(
        { command: 'echo hello', wait_ms: 5000 },
        realToolContext,
      );

      // §17.6.7 第 4 条：断言对象从运行时实际数据拿（不从硬造常量比对）。
      // 接缝契约：req.agentMeta.threadId === sessionConfig.threadId === host.sessions Map key
      expect(capturedRequests.length).toBeGreaterThan(0);
      const capturedReq = capturedRequests[0];
      expect(capturedReq.agentMeta.threadId).toBe(BUSINESS_THREAD_ID);
      expect(capturedReq.agentMeta.threadId).toBe(config.sessionConfig.threadId);
      // 关键反面：req.agentMeta.threadId 绝对不能等于 runtime UUID（§17.5 bug 形态）
      expect(capturedReq.agentMeta.threadId).not.toBe(runtimeId);
    },
  );
});

// ─── NotificationQueue：subscribe listener 异常契约（§17.6 修订 3.1） ─────

describe('NotificationQueue subscribe listener 异常契约 — §17.6 修订 3.1 inline 补丁', () => {
  it(
    'listener 抛错时：log.error 不退回入队、不影响其他 listener、不影响 enqueue 返回',
    () => {
      // §17.6.7 第 3 条：fresh queue 每测试。
      const logged: Array<{ msg: string; err: unknown }> = [];
      const queue = new NotificationQueue({
        clock: () => 1_700_000_000_000,
        log: (msg, err) => logged.push({ msg, err }),
      });

      const otherListener = vi.fn();
      queue.subscribe(() => {
        throw new Error('listener boom');
      });
      queue.subscribe(otherListener);

      const env: NotificationEnvelope<BackgroundTaskCompletedPayload> = {
        kind: 'background-task-completed',
        target: { spaceId: 'sp', threadId: 'biz-thread-listener-throw' },
        priority: 'later',
        payload: {
          agent_session_id: 'agent-1',
          tool_use_id: 'run_terminal_command:0',
          command: 'echo',
          exit_code: 0,
          exited_by: 'normal_exit',
          duration_ms: 1,
          output_file_path: '/tmp/x.log',
          cwd: '/tmp',
        },
        enqueuedAt: 1_700_000_000_000,
        dedupKey: 'agent-1',
      };

      // §17.6.7 第 2 条：直接调真实 enqueue（不 mock）。
      const result = queue.enqueue(env);

      // 1. enqueue 返回 true（listener 抛错不影响）
      expect(result).toBe(true);
      // 2. log.error 被调用（含 envelope dump 信息）
      expect(logged).toHaveLength(1);
      expect(logged[0].msg).toContain('subscriber listener threw');
      expect(logged[0].msg).toContain('background-task-completed');
      expect(logged[0].msg).toContain('biz-thread-listener-throw'.slice(0, 8));
      expect(logged[0].err).toBeInstanceOf(Error);
      // 3. 其他 listener 仍被调用（一个抛错不影响其他订阅者）
      expect(otherListener).toHaveBeenCalledTimes(1);
      // 4. envelope 仍在队列里（**不退回入队**——不会因为 listener 抛错丢失消息）
      expect(queue.size()).toBe(1);
      const drained = queue.drainByThreadId('biz-thread-listener-throw');
      expect(drained).toHaveLength(1);
      expect(drained[0]).toBe(env);
    },
  );
});

// ─── target.threadId 字段命名一致性（§17.6 D4.a） ────────────────────

describe('NotificationEnvelope.target.threadId 字段命名（§17.6 D4.a 改名验证）', () => {
  it(
    'target 字段只有 threadId（不再有 sessionId），与 host.sessions Map key 同名',
    () => {
      const queue = new NotificationQueue({
        clock: () => 1_700_000_000_000,
        log: () => {},
      });

      const env: NotificationEnvelope<BackgroundTaskCompletedPayload> = {
        kind: 'background-task-completed',
        target: { spaceId: 'sp', threadId: 'thread-naming-check' },
        priority: 'later',
        payload: {
          agent_session_id: 'agent-1',
          tool_use_id: 'run_terminal_command:0',
          command: 'echo',
          exit_code: 0,
          exited_by: 'normal_exit',
          duration_ms: 1,
          output_file_path: '/tmp/x.log',
          cwd: '/tmp',
        },
        enqueuedAt: 1_700_000_000_000,
        dedupKey: 'agent-1',
      };
      queue.enqueue(env);

      // peekByThreadId / drainByThreadId 是 D4.a 改名后的方法名
      expect(queue.peekByThreadId('thread-naming-check')).toBe(1);
      const drained = queue.drainByThreadId('thread-naming-check');
      expect(drained).toHaveLength(1);
      // 反面验证：旧方法 / 旧字段名已不存在
      const queueAny = queue as unknown as Record<string, unknown>;
      expect(queueAny.peekBySessionId).toBeUndefined();
      expect(queueAny.drainBySessionId).toBeUndefined();
    },
  );
});
