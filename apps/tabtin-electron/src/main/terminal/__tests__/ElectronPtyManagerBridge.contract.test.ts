/**
 * ElectronPtyManagerBridge contract test — 跑 terminal-core 的
 * `describeAgentBridgeContract` runner，验证 Electron 端 bridge 实现履行
 * `PtyManagerBridge` 全部契约。
 *
 * **跟 Daemon 端 contract test 严格同源**：两端文件结构 / fixture 形态一致，
 * 让契约漂移在编译期 + 运行期都能被 catch（agent-bridge.ts L477-482 / WP2
 * 北极星指标 #3 "contract test 跑过（两端都跑一遍）"）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AgentSessionCloseReason } from '@tabtin/terminal-core';
import type { PtyHostClient, PtyHostSession, PtySessionCloseReason } from '@tabtin/pty-core';
import { describeAgentBridgeContract } from '../../../../../../packages/terminal-core/src/agent-bridge-contract';
import { PtyManager } from '../PtyManager';
import {
  ElectronPtyManagerBridge,
  __resetElectronPtyManagerBridgeForTesting,
  shouldDetachAgentProcessForPlatform,
} from '../ElectronPtyManagerBridge';

const { getCLIServerInfoMock } = vi.hoisted(() => ({
  getCLIServerInfoMock: vi.fn((): { socketPath?: string; token?: string } | null => null),
}));

vi.mock('../../cli/cli-server', () => ({
  getCLIServerInfo: getCLIServerInfoMock,
}));

// ==================== Mock PTY host（与 PtyManager.lifecycle.test.ts 同款） ====================

class MockHostSession implements PtyHostSession {
  pid = 9527;

  private spawnedHandler?: (event: { pid: number }) => void;
  private dataHandler?: (data: string) => void;
  private exitHandler?: (event: { exitCode: number | null; signal?: number }) => void;

  write = vi.fn();
  pauseOutput = vi.fn();
  resumeOutput = vi.fn();
  resize = vi.fn();
  // 让 mock kill 自动 triggerExit(null) — 模拟真实 node-pty 行为（kill 后内部
  // 触发 onExit），让 bridge / PtyManager 的 onExit listener 跑通 + emit closed。
  kill = vi.fn(() => {
    queueMicrotask(() => this.exitHandler?.({ exitCode: null, signal: 15 }));
  });

  onSpawned = vi.fn((handler: (event: { pid: number }) => void) => {
    this.spawnedHandler = handler;
    return { dispose: vi.fn() };
  });

  onData = vi.fn((handler: (data: string) => void) => {
    this.dataHandler = handler;
    return { dispose: vi.fn() };
  });

  onExit = vi.fn((handler: (event: { exitCode: number | null; signal?: number }) => void) => {
    this.exitHandler = handler;
    return { dispose: vi.fn() };
  });

  triggerData(data: string): void {
    this.dataHandler?.(data);
  }

  triggerExit(exitCode: number | null, signal?: number): void {
    this.exitHandler?.({ exitCode, signal });
  }

  triggerSpawned(pid: number): void {
    this.pid = pid;
    this.spawnedHandler?.({ pid });
  }
}

class MockPtyHostClient implements PtyHostClient {
  readonly sessions: MockHostSession[] = [];

  spawn = vi.fn(() => {
    const session = new MockHostSession();
    this.sessions.push(session);
    return session;
  });
}

class MockProcessTerminator {
  terminateTree = vi.fn();
}

// ==================== Contract runner ====================

describeAgentBridgeContract('Electron', () => {
  getCLIServerInfoMock.mockReset();
  getCLIServerInfoMock.mockReturnValue(null);

  const hostClient = new MockPtyHostClient();
  const processTerminator = new MockProcessTerminator();
  const ptyManager = new PtyManager(hostClient, processTerminator as never);
  const bridge = new ElectronPtyManagerBridge(ptyManager);

  return {
    bridge,
    completeCommand: (sessionId: string) => {
      // 用 ptyManager.kill 触发 PtySessionStore cascade-resolve pending command
      // （deleteSession 内会 resolve pending with exitCode null）。bridge 的
      // executeAgentCommand 把 exitCode null 映射成 status='error'，但 contract
      // test 只验 sessionId / promise resolve，不验 exitCode 数值。
      ptyManager.kill(sessionId);
    },
    cleanup: async () => {
      await bridge.dispose();
      ptyManager.cleanup();
    },
  };
});

// ==================== Per-test Electron-specific behaviors ====================

// ==================== pty-core 字面对齐断言（runner 不能跨包断言，端测补） ====================

describe('Electron: AgentSessionCloseReason ↔ PtySessionCloseReason literal alignment', () => {
  it('two types have identical string union members', () => {
    // 编译期：把 AgentSessionCloseReason 赋给 PtySessionCloseReason 数组、反之亦然——
    // 任一类型加新值都会编译失败。
    const agentVals: AgentSessionCloseReason[] = ['exit', 'kill', 'cleanup', 'idle_timeout'];
    const ptyVals: PtySessionCloseReason[] = agentVals.map((v) => v);
    const backToAgent: AgentSessionCloseReason[] = ptyVals.map((v) => v);
    expect(backToAgent.sort()).toEqual(['cleanup', 'exit', 'idle_timeout', 'kill']);
  });
});

describe('ElectronPtyManagerBridge - Electron-specific behaviors', () => {
  let hostClient: MockPtyHostClient;
  let ptyManager: PtyManager;
  let bridge: ElectronPtyManagerBridge;

  beforeEach(() => {
    getCLIServerInfoMock.mockReset();
    getCLIServerInfoMock.mockReturnValue(null);
    hostClient = new MockPtyHostClient();
    const processTerminator = new MockProcessTerminator();
    ptyManager = new PtyManager(hostClient, processTerminator as never);
    bridge = new ElectronPtyManagerBridge(ptyManager);
  });

  afterEach(async () => {
    await bridge.dispose();
    ptyManager.cleanup();
    __resetElectronPtyManagerBridgeForTesting();
  });

  it('emits agent-session-created to PtyManager EventEmitter (legacy IPC schema)', async () => {
    // 验证：bridge.executeAgentCommand 起 session 时**额外** emit 旧 schema
    // 到 PtyManager EventEmitter —— 让现有 renderer IPC handler 不必改
    // （agent-bridge.ts L429-432 / L640-644 / 总控 D10）。
    // L-WP6-1：legacy IPC payload 必须带 `command` 字段 —— renderer hook 的
    // 中间级 fallback（description 缺失时用 command 首行截断）依赖这条 IPC 链路
    // 透传，让 dogfood「连跑 3 条命令」能区分 tab。
    const legacyEvents: Array<{
      sessionId: string;
      spaceId: string;
      threadId: string | null;
      cwd: string;
      description?: string | null;
      command?: string | null;
    }> = [];
    ptyManager.on(
      'agent-session-created',
      (e: {
        sessionId: string;
        spaceId: string;
        threadId: string | null;
        cwd: string;
        description?: string | null;
        command?: string | null;
      }) => {
        legacyEvents.push(e);
      },
    );

    const exec = bridge.executeAgentCommand({
      command: 'echo legacy-ipc',
      agentMeta: {
        toolUseId: 'tool-1',
        spaceId: 'space-legacy',
        agentId: 'agent-1',
        threadId: 'thread-1',
        originatedBy: 'local-llm-shellcap',
      },
    });

    // 等到 created 事件后立刻 kill 让 exec resolve
    await new Promise((r) => setTimeout(r, 10));
    expect(legacyEvents).toHaveLength(1);
    expect(legacyEvents[0]!.sessionId).toMatch(/^agent-space-legacy-/);
    expect(legacyEvents[0]!.threadId).toBe('thread-1');
    expect(legacyEvents[0]!.cwd).toBeTruthy();
    // L-WP6-1：command 必填透传
    expect(legacyEvents[0]!.command).toBe('echo legacy-ipc');

    ptyManager.kill(legacyEvents[0]!.sessionId);
    await exec;
  });

  it.skipIf(process.platform === 'win32')('executeAgentCommand runs a one-shot child process and returns stdout', async () => {
    const result = await bridge.executeAgentCommand({
      command: "printf 'electron-bridge-ok\\n'",
      agentMeta: {
        toolUseId: 'tool-process',
        spaceId: 'space-process',
        agentId: 'agent-process',
        originatedBy: 'local-llm-shellcap',
      },
    });

    expect(result.status).toBe('ok');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('electron-bridge-ok');
    expect(result.stderr).toBe('');
    expect(result.backgroundedReason).toBeUndefined();
  });

  it('does NOT call setThreadSession (bridge path skips thread→session binding, D3)', async () => {
    // 验证：bridge 路径起的 session **不会** 通过 setThreadSession 写
    // threadSessionMap —— 否则 4 件套人控路径会复用到 bridge 起的 session，
    // 污染语义（agent-bridge.ts L559-562）。
    const exec = bridge.executeAgentCommand({
      command: 'echo no-thread-binding',
      agentMeta: {
        toolUseId: 'tool-no-bind',
        spaceId: 'space-no-bind',
        agentId: 'agent-no-bind',
        threadId: 'thread-no-bind',
        originatedBy: 'local-llm-shellcap',
      },
    });

    await new Promise((r) => setTimeout(r, 10));
    // resolveThreadSession 是 4 件套人控路径的 thread→session 复用入口
    const resolved = ptyManager.resolveThreadSession('thread-no-bind');
    expect(resolved).toBeNull();

    // cleanup
    const allSessions = ptyManager.getAllSessionIds();
    for (const sid of allSessions) {
      if (sid.startsWith('agent-space-no-bind')) {
        ptyManager.kill(sid);
      }
    }
    await exec.catch(() => {});
  });

  it('session.agentMeta is set on the PtySession after spawn (audit field)', async () => {
    const exec = bridge.executeAgentCommand({
      command: 'echo with-agent-meta',
      agentMeta: {
        toolUseId: 'tool-meta',
        spaceId: 'space-meta',
        agentId: 'agent-meta',
        description: 'audit me',
        originatedBy: 'local-llm-shellcap',
      },
    });

    await new Promise((r) => setTimeout(r, 10));
    const session = ptyManager.getAllSessionIds()
      .map((id) => ptyManager.getSession(id))
      .find((s) => s?.agentMeta?.toolUseId === 'tool-meta');
    expect(session).toBeDefined();
    expect(session?.agentMeta?.spaceId).toBe('space-meta');
    expect(session?.agentMeta?.agentId).toBe('agent-meta');
    expect(session?.agentMeta?.description).toBe('audit me');
    expect(session?.agentMeta?.originatedBy).toBe('local-llm-shellcap');

    ptyManager.kill(session!.id);
    await exec;
  });

  it('does not enqueue background completion for foreground_waiting detached tasks ', () => {
    const store = bridge.getManagedTaskStore();
    store.createRecord({
      session_id: 'foreground-session',
      command: 'echo foreground-waiting',
      cwd: '/tmp',
      env: undefined,
      spaceId: 'space-push',
      toolUseId: 'tool-foreground',
      threadId: 'thread-push',
      output_file_path: '/tmp/foreground-session.log',
    });
    store.updateOnExit('foreground-session', { status: 'completed', exit_code: 0, exited_by: 'normal_exit' });

    (bridge as unknown as {
      emitPushNotificationOnExit: (
        sessionId: string,
        exitCode: number,
        exitedBy: 'normal_exit',
        killedReason: undefined,
      ) => void;
    }).emitPushNotificationOnExit('foreground-session', 0, 'normal_exit', undefined);

    expect(bridge.getNotificationQueue().peekByThreadId('thread-push')).toBe(0);
  });

  it('enqueues background completion after task is exposed as background ', () => {
    const store = bridge.getManagedTaskStore();
    store.createRecord({
      session_id: 'background-session',
      command: 'sleep 1',
      cwd: '/tmp',
      env: undefined,
      spaceId: 'space-push',
      toolUseId: 'tool-background',
      threadId: 'thread-push',
      output_file_path: '/tmp/background-session.log',
    });
    store.markBackgroundExposed('background-session');
    store.updateOnExit('background-session', { status: 'completed', exit_code: 0, exited_by: 'normal_exit' });

    (bridge as unknown as {
      emitPushNotificationOnExit: (
        sessionId: string,
        exitCode: number,
        exitedBy: 'normal_exit',
        killedReason: undefined,
      ) => void;
    }).emitPushNotificationOnExit('background-session', 0, 'normal_exit', undefined);

    expect(bridge.getNotificationQueue().peekByThreadId('thread-push')).toBe(1);
    const [env] = bridge.getNotificationQueue().drainByThreadId('thread-push');
    expect(env?.kind).toBe('background-task-completed');
    expect(env?.payload).toMatchObject({
      agent_session_id: 'background-session',
      command: 'sleep 1',
    });
  });

  it('子 Agent 后台完成：入队 childId，不入队父对话', () => {
    const store = bridge.getManagedTaskStore();
    store.createRecord({
      session_id: 'child-background-session',
      command: 'sleep 1',
      cwd: '/tmp',
      env: undefined,
      spaceId: 'space-push',
      toolUseId: 'tool-child-background',
      threadId: 'parent-thread',
      notificationThreadId: 'child-run-id',
      output_file_path: '/tmp/child-background-session.log',
    });
    store.markBackgroundExposed('child-background-session');
    store.updateOnExit('child-background-session', { status: 'completed', exit_code: 0, exited_by: 'normal_exit' });

    (bridge as unknown as {
      emitPushNotificationOnExit: (
        sessionId: string,
        exitCode: number,
        exitedBy: 'normal_exit',
        killedReason: undefined,
      ) => void;
    }).emitPushNotificationOnExit('child-background-session', 0, 'normal_exit', undefined);

    expect(bridge.getNotificationQueue().peekByThreadId('parent-thread')).toBe(0);
    expect(bridge.getNotificationQueue().peekByThreadId('child-run-id')).toBe(1);
    const [env] = bridge.getNotificationQueue().drainByThreadId('child-run-id');
    expect(env?.target.threadId).toBe('child-run-id');
    expect(env?.payload).toMatchObject({
      agent_session_id: 'child-background-session',
      business_thread_id: 'parent-thread',
    });
  });

  it('immediately enqueues user_interrupt when a user-stopped background task is notified', () => {
    const store = bridge.getManagedTaskStore();
    store.createRecord({
      session_id: 'user-stopped-session',
      command: 'sleep 120',
      cwd: '/tmp',
      env: undefined,
      spaceId: 'space-push',
      toolUseId: 'tool-user-stopped',
      threadId: 'thread-user-stopped',
      output_file_path: '/tmp/user-stopped-session.log',
    });
    store.markBackgroundExposed('user-stopped-session');

    expect(bridge.notifyAgentSessionUserInterrupted('user-stopped-session')).toBe(true);
    expect(bridge.getNotificationQueue().peekByThreadId('thread-user-stopped')).toBe(1);

    // 后续真实进程 exit 再触发 producer 时不应重复通知。
    (bridge as unknown as {
      emitPushNotificationOnExit: (
        sessionId: string,
        exitCode: number,
        exitedBy: 'signal',
        killedReason: 'user_interrupt',
      ) => void;
    }).emitPushNotificationOnExit('user-stopped-session', -1, 'signal', 'user_interrupt');

    expect(bridge.getNotificationQueue().peekByThreadId('thread-user-stopped')).toBe(1);
    const [env] = bridge.getNotificationQueue().drainByThreadId('thread-user-stopped');
    expect(env?.kind).toBe('background-task-completed');
    expect(env?.payload).toMatchObject({
      agent_session_id: 'user-stopped-session',
      command: 'sleep 120',
      killed_reason: 'user_interrupt',
      exited_by: 'signal',
    });
  });

  it('does not mark user-stopped foreground_waiting tasks as notified before enqueue', () => {
    const store = bridge.getManagedTaskStore();
    store.createRecord({
      session_id: 'foreground-user-stop-session',
      command: 'sleep 120',
      cwd: '/tmp',
      env: undefined,
      spaceId: 'space-push',
      toolUseId: 'tool-foreground-user-stop',
      threadId: 'thread-foreground-user-stop',
      output_file_path: '/tmp/foreground-user-stop-session.log',
    });

    expect(bridge.notifyAgentSessionUserInterrupted('foreground-user-stop-session')).toBe(true);
    expect(store.get('foreground-user-stop-session')?.notified).toBeFalsy();
    expect(bridge.getNotificationQueue().peekByThreadId('thread-foreground-user-stop')).toBe(0);

    store.markBackgroundExposed('foreground-user-stop-session');
    (bridge as unknown as {
      emitPushNotificationOnExit: (
        sessionId: string,
        exitCode: number,
        exitedBy: 'signal',
        killedReason: 'user_interrupt',
      ) => boolean;
    }).emitPushNotificationOnExit('foreground-user-stop-session', -1, 'signal', 'user_interrupt');

    expect(bridge.getNotificationQueue().peekByThreadId('thread-foreground-user-stop')).toBe(1);
  });

  it('marks UI stop requests as user_interrupt before killing agent sessions', () => {
    const store = bridge.getManagedTaskStore();
    store.createRecord({
      session_id: 'ui-stop-session',
      command: 'sleep 120',
      cwd: '/tmp',
      env: undefined,
      spaceId: 'space-push',
      toolUseId: 'tool-ui-stop',
      threadId: 'thread-ui-stop',
      output_file_path: '/tmp/ui-stop-session.log',
    });

    const internals = bridge as unknown as {
      agentSessions: Map<string, {
        sessionId: string;
        spaceId: string;
        agentMeta: null;
        tail: null;
        process: null;
        processRunning: boolean;
        watchdog: null;
        mode: 'detached';
        pendingKillReason?: 'kill_tool' | 'user_interrupt' | 'hard_timeout';
      }>;
    };
    internals.agentSessions.set('ui-stop-session', {
      sessionId: 'ui-stop-session',
      spaceId: 'space-push',
      agentMeta: null,
      tail: null,
      process: null,
      processRunning: true,
      watchdog: null,
      mode: 'detached',
    });

    expect(bridge.requestKillAgentSession('ui-stop-session')).toBe(true);
    expect(internals.agentSessions.get('ui-stop-session')?.pendingKillReason).toBe('user_interrupt');
  });

  it('does not enqueue app_exit after exit flush already relayed terminal state ', () => {
    const store = bridge.getManagedTaskStore();
    store.createRecord({
      session_id: 'app-exit-session',
      command: 'sleep 1',
      cwd: '/tmp',
      env: undefined,
      spaceId: 'space-push',
      toolUseId: 'tool-app-exit',
      threadId: 'thread-push',
      output_file_path: '/tmp/app-exit-session.log',
    });
    store.markBackgroundExposed('app-exit-session');
    store.updateOnExit('app-exit-session', {
      status: 'killed',
      exit_code: -1,
      exited_by: 'signal',
      killed_reason: 'app_exit',
    });

    (bridge as unknown as {
      emitPushNotificationOnExit: (
        sessionId: string,
        exitCode: number,
        exitedBy: 'normal_exit',
        killedReason: undefined,
      ) => void;
    }).emitPushNotificationOnExit('app-exit-session', 0, 'normal_exit', undefined);

    expect(bridge.getNotificationQueue().peekByThreadId('thread-push')).toBe(0);
  });
});

describe('shouldDetachAgentProcessForPlatform', () => {
  it('does not detach on Windows to avoid a visible console window', () => {
    expect(shouldDetachAgentProcessForPlatform('win32')).toBe(false);
  });

  it('keeps detached process groups on Unix platforms', () => {
    expect(shouldDetachAgentProcessForPlatform('darwin')).toBe(true);
    expect(shouldDetachAgentProcessForPlatform('linux')).toBe(true);
  });
});
