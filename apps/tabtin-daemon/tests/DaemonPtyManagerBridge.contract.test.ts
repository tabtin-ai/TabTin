/**
 * DaemonPtyManagerBridge contract test — 跑 terminal-core 的
 * `describeAgentBridgeContract` runner，验证 Daemon 端 bridge 实现履行
 * `PtyManagerBridge` 全部契约。
 *
 * **跟 Electron 端 contract test 严格同源**：fixture 形态 / 触发完成方式
 * 一致，让契约漂移在两端跑同套断言时能被对比 catch（WP2 北极星指标 #3）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeAgentBridgeContract } from '@tabtin/terminal-core/agent-bridge-contract';
import { type AgentSessionCloseReason } from '@tabtin/terminal-core';
import type { PtyHostClient, PtyHostSession, PtySessionCloseReason } from '@tabtin/pty-core';
import { DaemonPtyManager } from '../src/platform/terminal/daemon-pty-manager.js';
import { DaemonPtyManagerBridge } from '../src/platform/terminal/DaemonPtyManagerBridge.js';

// ==================== Mock PTY host（与 Electron MockHostSession 同款） ====================

class MockHostSession implements PtyHostSession {
  pid = 9527;

  private spawnedHandler?: (event: { pid: number }) => void;
  private dataHandler?: (data: string) => void;
  private exitHandler?: (event: { exitCode: number | null; signal?: number }) => void;

  write = vi.fn();
  pauseOutput = vi.fn();
  resumeOutput = vi.fn();
  resize = vi.fn();
  // 让 mock kill 自动 triggerExit(null) — 模拟真实 node-pty 行为（kill 后
  // 内部触发 onExit），让 bridge onExit listener 能跑通 + emit closed event。
  kill = vi.fn(() => {
    // 异步触发模拟 PTY 信号 → 进程退出 → onExit 的微小延迟
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
}

class MockPtyHostClient implements PtyHostClient {
  readonly sessions: MockHostSession[] = [];

  spawn = vi.fn(() => {
    const session = new MockHostSession();
    this.sessions.push(session);
    return session;
  });
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as never;
}

// ==================== Contract runner ====================
//
// **关键**：DaemonPtyManager 的 ptyHost 通过构造选项注入（WP2 加的扩展点），
// 跳过 `await import('node-pty')`，让 contract test 在无 node-pty 环境也能跑。

describeAgentBridgeContract('Daemon', async () => {
  const hostClient = new MockPtyHostClient();
  const logger = createLogger();
  const ptyManager = new DaemonPtyManager(logger, { ptyHost: hostClient });
  const ready = await ptyManager.initialize();
  if (!ready) throw new Error('DaemonPtyManager.initialize failed with injected ptyHost');
  const bridge = new DaemonPtyManagerBridge(ptyManager, logger);

  return {
    bridge,
    completeCommand: (sessionId: string) => {
      // 与 Electron contract test 同款：kill 触发 cascade-resolve pending command
      ptyManager.kill(sessionId);
    },
    cleanup: async () => {
      await bridge.dispose();
      ptyManager.cleanup();
    },
  };
});

// ==================== Per-test Daemon-specific behaviors ====================

// ==================== pty-core 字面对齐断言（runner 不能跨包断言，端测补） ====================

describe('Daemon: AgentSessionCloseReason ↔ PtySessionCloseReason literal alignment', () => {
  it('two types have identical string union members', () => {
    const agentVals: AgentSessionCloseReason[] = ['exit', 'kill', 'cleanup', 'idle_timeout'];
    const ptyVals: PtySessionCloseReason[] = agentVals.map((v) => v);
    const backToAgent: AgentSessionCloseReason[] = ptyVals.map((v) => v);
    expect(backToAgent.sort()).toEqual(['cleanup', 'exit', 'idle_timeout', 'kill']);
  });
});

describe('DaemonPtyManagerBridge - Daemon-specific behaviors', () => {
  let hostClient: MockPtyHostClient;
  let logger: ReturnType<typeof createLogger>;
  let ptyManager: DaemonPtyManager;
  let bridge: DaemonPtyManagerBridge;

  beforeEach(async () => {
    hostClient = new MockPtyHostClient();
    logger = createLogger();
    ptyManager = new DaemonPtyManager(logger, { ptyHost: hostClient });
    await ptyManager.initialize();
    bridge = new DaemonPtyManagerBridge(ptyManager, logger);
  });

  afterEach(async () => {
    await bridge.dispose();
    ptyManager.cleanup();
  });

  it('writes structured agent_session_created log via logger.info (运维 grep 关键词)', async () => {
    // 总控 L403 + agent-bridge.ts L412-415 硬契约：bridge emit 时
    // logger.info({ event: 'agent_session_created', ... })。
    // L-WP6-1：日志带完整 command 字符串（不截断），便于运维 grep 命令体定位异常 session。
    const exec = bridge.executeAgentCommand({
      command: 'echo log-keyword-check',
      agentMeta: {
        toolUseId: 'tool-log',
        spaceId: 'space-log',
        agentId: 'agent-log',
        originatedBy: 'local-llm-shellcap',
      },
    });
    await new Promise((r) => setTimeout(r, 10));

    const infoLogs = (logger.info as ReturnType<typeof vi.fn>).mock.calls.map((args) =>
      JSON.stringify(args),
    );
    const matched = infoLogs.find((msg) => msg.includes('agent_session_created'));
    expect(matched).toBeDefined();
    expect(matched).toContain('space-log');
    expect(matched).toContain('agent-log');
    expect(matched).toContain('tool-log');
    // L-WP6-1：log 必须包含完整命令字符串（运维 grep 用）
    expect(matched).toContain('echo log-keyword-check');

    // cleanup
    const allSids = ptyManager.getAllSessionIds();
    for (const sid of allSids) {
      if (sid.startsWith('agent-space-log')) ptyManager.kill(sid);
    }
    await exec.catch(() => {});
  });

  it.skipIf(process.platform === 'win32')('executeAgentCommand runs a one-shot child process and returns stdout', async () => {
    const result = await bridge.executeAgentCommand({
      command: "printf 'daemon-bridge-ok\\n'",
      agentMeta: {
        toolUseId: 'tool-daemon-process',
        spaceId: 'space-daemon-process',
        agentId: 'agent-daemon-process',
        originatedBy: 'local-llm-shellcap',
      },
    });

    expect(result.status).toBe('ok');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('daemon-bridge-ok');
    expect(result.stderr).toBe('');
    expect(result.backgroundedReason).toBeUndefined();
  });

  it('session.agentMeta is set on PtySession (audit field, both ends consistent)', async () => {
    const exec = bridge.executeAgentCommand({
      command: 'echo daemon-meta',
      agentMeta: {
        toolUseId: 'tool-daemon-meta',
        spaceId: 'space-daemon-meta',
        agentId: 'agent-daemon-meta',
        originatedBy: 'local-llm-shellcap',
      },
    });

    await new Promise((r) => setTimeout(r, 10));
    const sids = ptyManager.getAllSessionIds();
    const session = sids
      .map((id) => ptyManager.getSession(id))
      .find((s) => s?.agentMeta?.toolUseId === 'tool-daemon-meta');
    expect(session).toBeDefined();
    expect(session?.agentMeta?.originatedBy).toBe('local-llm-shellcap');

    ptyManager.kill(session!.id);
    await exec;
  });

  it('does NOT bind threadId to threadSession map (D3 / agent-bridge.ts L559-562)', async () => {
    const exec = bridge.executeAgentCommand({
      command: 'echo no-thread-bind',
      agentMeta: {
        toolUseId: 'tool-tb',
        spaceId: 'space-tb',
        agentId: 'agent-tb',
        threadId: 'thread-should-not-bind',
        originatedBy: 'local-llm-shellcap',
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(ptyManager.resolveThreadSession('thread-should-not-bind')).toBeNull();

    const allSids = ptyManager.getAllSessionIds();
    for (const sid of allSids) {
      if (sid.startsWith('agent-space-tb')) ptyManager.kill(sid);
    }
    await exec.catch(() => {});
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
