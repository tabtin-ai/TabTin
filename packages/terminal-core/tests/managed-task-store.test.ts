/**
 * ManagedTaskStore 单测 —— 用 fake clock + fake setInterval 验证 lifecycle 与 GC race。
 *
 * 触发 PRD（run-terminal-command_后台执行重构_2026-05-18）：
 * §0.5 状态机表 A + §4.2 schema + §4.2.3 lifecycle + §5.5 GC race 保护 + §6.2 hard timeout。
 *
 * 覆盖：
 *   1. createRecord：基础字段写入、status='running'、env_hash 计算
 *   2. updateOnExit：terminal state 写入 + 幂等
 *   3. findDedupCandidate：1 秒窗口内同 cwd/command/env_hash/threadId 命中
 *   4. GC：完成态 record TTL 到期后直接 deleteAndCleanup + output_file 删除
 *   5. hard timeout：6h warning emit 一次；12h kill handler 被调
 *
 * 2026-05-23 push 通知重构 commit B：删 await 工具后所有"延迟删除"相关字段
 * 与方法（active counter / pending-delete flag / increment / decrement）全部下线，
 * GC race 保护退化为"到期直接删"。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ManagedTaskStore,
  hashEnvVars,
  resolveNotificationRouteThreadId,
  resolveBackgroundTaskRelayThreadId,
  type ManagedTaskHardTimeoutHandlers,
} from '../src/managed-task-store.js';

interface FakeClockHarness {
  now: () => number;
  advance: (ms: number) => void;
  fakeSetInterval: (handler: () => void, ms: number) => unknown;
  fakeClearInterval: (handle: unknown) => void;
  tickInterval: () => Promise<void>;
}

function makeFakeClock(initial = 1_700_000_000_000): FakeClockHarness {
  let clock = initial;
  let handler: (() => void) | null = null;
  return {
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    fakeSetInterval: (h: () => void, _ms: number) => {
      handler = h;
      return 'fake-handle';
    },
    fakeClearInterval: () => {
      handler = null;
    },
    tickInterval: async () => {
      if (handler) await handler();
    },
  };
}

function makeStore(opts?: {
  ttl?: number;
  warningMs?: number;
  killMs?: number;
  handlers?: ManagedTaskHardTimeoutHandlers;
  unlinkSpy?: ReturnType<typeof vi.fn>;
}) {
  const harness = makeFakeClock();
  const unlink = opts?.unlinkSpy ?? vi.fn(async () => {});
  const store = new ManagedTaskStore({
    clock: harness.now,
    setInterval: harness.fakeSetInterval,
    clearInterval: harness.fakeClearInterval,
    recordTtlMs: opts?.ttl ?? 30_000,
    gcIntervalMs: 5_000,
    hardTimeoutWarningMs: opts?.warningMs ?? 600_000,
    hardTimeoutKillMs: opts?.killMs ?? 1_200_000,
    hardTimeoutHandlers: opts?.handlers,
    unlinkFile: unlink,
    log: () => {},
  });
  return { store, harness, unlink };
}

describe('hashEnvVars', () => {
  it('空 / undefined env 返回固定标记 "empty"', () => {
    expect(hashEnvVars(undefined)).toBe('empty');
    expect(hashEnvVars({})).toBe('empty');
  });

  it('key 顺序不影响 hash', () => {
    const a = hashEnvVars({ A: '1', B: '2', C: '3' });
    const b = hashEnvVars({ C: '3', A: '1', B: '2' });
    expect(a).toBe(b);
  });

  it('value 不同 hash 必不同', () => {
    const a = hashEnvVars({ KEY: 'v1' });
    const b = hashEnvVars({ KEY: 'v2' });
    expect(a).not.toBe(b);
  });
});

describe('ManagedTaskStore.createRecord + updateOnExit', () => {
  it('createRecord 写入基础字段，status="running"', () => {
    const { store } = makeStore();
    const record = store.createRecord({
      session_id: 's1',
      command: 'ls',
      cwd: '/tmp',
      env: { FOO: 'bar' },
      spaceId: 'sp1',
      toolUseId: 'tu1',
      output_file_path: '/tmp/agent-tasks/s1.log',
    });
    expect(record.status).toBe('running');
    expect(record.command).toBe('ls');
    expect(record.env_hash).toBe(hashEnvVars({ FOO: 'bar' }));
    expect(record.stdout_byte_count).toBe(0);
  });

  it('createRecord 同 session_id 重复 throw（防 race）', () => {
    const { store } = makeStore();
    store.createRecord({
      session_id: 'dup',
      command: 'a',
      cwd: '/tmp',
      env: undefined,
      spaceId: 'sp',
      toolUseId: 'tu',
      output_file_path: '/tmp/x',
    });
    expect(() =>
      store.createRecord({
        session_id: 'dup',
        command: 'b',
        cwd: '/tmp',
        env: undefined,
        spaceId: 'sp',
        toolUseId: 'tu',
        output_file_path: '/tmp/y',
      }),
    ).toThrow(/already exists/);
  });

  it('updateOnExit 写 terminal state；幂等不重写', () => {
    const { store, harness } = makeStore();
    store.createRecord({
      session_id: 's2',
      command: 'a',
      cwd: '/tmp',
      env: undefined,
      spaceId: 'sp',
      toolUseId: 'tu',
      output_file_path: '/tmp/x',
    });
    harness.advance(100);
    store.updateOnExit('s2', {
      status: 'completed',
      exit_code: 0,
      exited_by: 'normal_exit',
    });
    const r = store.get('s2')!;
    expect(r.status).toBe('completed');
    expect(r.exit_code).toBe(0);
    expect(r.completed_at).toBe(harness.now());

    // 幂等：再次调用不覆盖
    store.updateOnExit('s2', {
      status: 'killed',
      exit_code: -9,
      exited_by: 'signal',
      killed_reason: 'kill_tool',
    });
    expect(store.get('s2')!.status).toBe('completed'); // 没变
  });

  it('incrementOutputBytes 累加 + 更新 last_output_at', () => {
    const { store, harness } = makeStore();
    store.createRecord({
      session_id: 's3',
      command: 'a',
      cwd: '/tmp',
      env: undefined,
      spaceId: 'sp',
      toolUseId: 'tu',
      output_file_path: '/tmp/x',
    });
    harness.advance(50);
    store.incrementOutputBytes('s3', 100);
    expect(store.get('s3')!.stdout_byte_count).toBe(100);
    harness.advance(20);
    store.incrementOutputBytes('s3', 50);
    expect(store.get('s3')!.stdout_byte_count).toBe(150);
    expect(store.get('s3')!.last_output_at).toBe(harness.now());
  });
});

// 2026-05-23 push 通知重构 commit 2：新增字段 + markNotified 行为单测。
// §17.6 D4：原 conversation_session_id 字段已合并到 threadId（双重用途——
// UI 关联 + push notification 路由），下方测试改名跟随。
describe('ManagedTaskStore push notification 字段（commit 2 + §17.6 D4 合并）', () => {
  it('createRecord 不传 threadId 时字段为 undefined', () => {
    const { store } = makeStore();
    const record = store.createRecord({
      session_id: 'np1',
      command: 'ls',
      cwd: '/tmp',
      env: undefined,
      spaceId: 'sp',
      toolUseId: 'tu',
      output_file_path: '/tmp/x',
    });
    expect(record.threadId).toBeUndefined();
    expect(record.notified).toBeUndefined();
    expect(record.notification_state).toBe('foreground_waiting');
  });

  it('createRecord 传 threadId 写入 record（UI / relay；通知可另填 notificationThreadId）', () => {
    const { store } = makeStore();
    const record = store.createRecord({
      session_id: 'np2',
      command: 'ls',
      cwd: '/tmp',
      env: undefined,
      spaceId: 'sp',
      toolUseId: 'tu',
      output_file_path: '/tmp/x',
      threadId: 'chat-thread-A',
      notificationThreadId: 'child-run-id',
    });
    expect(record.threadId).toBe('chat-thread-A');
    expect(record.notificationThreadId).toBe('child-run-id');
    expect(resolveNotificationRouteThreadId(record)).toBe('child-run-id');
    expect(resolveNotificationRouteThreadId({ threadId: 'chat-thread-A' })).toBe('chat-thread-A');
    expect(resolveBackgroundTaskRelayThreadId({
      target: { threadId: 'child-run-id' },
      payload: { business_thread_id: 'chat-thread-A' },
    })).toBe('chat-thread-A');
    expect(resolveBackgroundTaskRelayThreadId({
      target: { threadId: 'chat-thread-A' },
      payload: {},
    })).toBe('chat-thread-A');
  });

  it('markNotified 把 record.notified 设为 true', () => {
    const { store } = makeStore();
    store.createRecord({
      session_id: 'np3',
      command: 'ls',
      cwd: '/tmp',
      env: undefined,
      spaceId: 'sp',
      toolUseId: 'tu',
      output_file_path: '/tmp/x',
      threadId: 'chat-A',
    });
    expect(store.get('np3')!.notified).toBeUndefined();

    store.markNotified('np3');
    expect(store.get('np3')!.notified).toBe(true);
  });

  it('markNotified 幂等（重复调 no-op）', () => {
    const { store } = makeStore();
    store.createRecord({
      session_id: 'np4',
      command: 'ls',
      cwd: '/tmp',
      env: undefined,
      spaceId: 'sp',
      toolUseId: 'tu',
      output_file_path: '/tmp/x',
    });
    store.markNotified('np4');
    expect(store.get('np4')!.notified).toBe(true);

    // 第二次调不抛错，结果仍为 true
    expect(() => store.markNotified('np4')).not.toThrow();
    expect(store.get('np4')!.notified).toBe(true);
  });

  it('markNotified 对不存在 sessionId no-op（不抛错）', () => {
    const { store } = makeStore();
    expect(() => store.markNotified('non-existent')).not.toThrow();
  });

  it('sync notification claim 可被 markNotified 或 running 释放路径清理', () => {
    const { store } = makeStore();
    store.createRecord({
      session_id: 'claim-completed',
      command: 'ls',
      cwd: '/tmp',
      env: undefined,
      spaceId: 'sp',
      threadId: 'thread',
      toolUseId: 'tu',
      output_file_path: '/tmp/claim-completed.log',
      sync_notification_claim: true,
    });
    expect(store.get('claim-completed')!.sync_notification_claim).toBe(true);
    store.markNotified('claim-completed');
    expect(store.get('claim-completed')!.notified).toBe(true);
    expect(store.get('claim-completed')!.sync_notification_claim).toBeUndefined();

    store.createRecord({
      session_id: 'claim-running',
      command: 'sleep 5',
      cwd: '/tmp',
      env: undefined,
      spaceId: 'sp',
      threadId: 'thread',
      toolUseId: 'tu',
      output_file_path: '/tmp/claim-running.log',
      sync_notification_claim: true,
    });
    const released = store.releaseSyncNotificationClaim('claim-running');
    expect(released?.status).toBe('running');
    expect(store.get('claim-running')!.notified).toBeUndefined();
    expect(store.get('claim-running')!.sync_notification_claim).toBeUndefined();
  });

  it('markBackgroundExposed 把通知语义切到 background_exposed 并保持幂等', () => {
    const { store } = makeStore();
    store.createRecord({
      session_id: 'np5',
      command: 'sleep 1',
      cwd: '/tmp',
      env: undefined,
      spaceId: 'sp',
      toolUseId: 'tu',
      output_file_path: '/tmp/x',
      threadId: 'chat-A',
    });
    expect(store.get('np5')!.notification_state).toBe('foreground_waiting');

    store.markBackgroundExposed('np5');
    expect(store.get('np5')!.notification_state).toBe('background_exposed');
    expect(() => store.markBackgroundExposed('np5')).not.toThrow();
    expect(store.get('np5')!.notification_state).toBe('background_exposed');
  });

  it('markBackgroundExposed 对不存在 sessionId no-op（不抛错）', () => {
    const { store } = makeStore();
    expect(() => store.markBackgroundExposed('non-existent')).not.toThrow();
  });

  it('requestDetach / consumeDetachRequest：running 可读清、读后清除、terminal 不可请求', () => {
    const { store } = makeStore();
    store.createRecord({
      session_id: 'detach-1',
      command: 'sleep 5',
      cwd: '/tmp',
      env: undefined,
      spaceId: 'sp',
      toolUseId: 'tu',
      output_file_path: '/tmp/x',
    });

    expect(store.requestDetach('missing')).toBe(false);
    expect(store.consumeDetachRequest('missing')).toBe(false);

    expect(store.requestDetach('detach-1')).toBe(true);
    expect(store.consumeDetachRequest('detach-1')).toBe(true);
    expect(store.consumeDetachRequest('detach-1')).toBe(false);

    store.updateOnExit('detach-1', {
      status: 'completed',
      exit_code: 0,
      exited_by: 'normal_exit',
    });
    expect(store.requestDetach('detach-1')).toBe(false);
  });
});

describe('ManagedTaskStore.findDedupCandidate', () => {
  it('1 秒窗口内同 cwd + command + env_hash + threadId 命中', () => {
    const { store, harness } = makeStore();
    store.createRecord({
      session_id: 's1',
      command: 'du -sh ~',
      cwd: '/tmp',
      env: { X: '1' },
      spaceId: 'sp',
      threadId: 'thread-a',
      toolUseId: 'tu',
      output_file_path: '/tmp/x',
    });
    harness.advance(500); // 500ms 后查
    const hit = store.findDedupCandidate({
      command: 'du -sh ~',
      cwd: '/tmp',
      env: { X: '1' },
      threadId: 'thread-a',
    });
    expect(hit?.session_id).toBe('s1');
  });

  it('超过 1 秒窗口不命中', () => {
    const { store, harness } = makeStore();
    store.createRecord({
      session_id: 's1',
      command: 'du -sh ~',
      cwd: '/tmp',
      env: undefined,
      spaceId: 'sp',
      threadId: 'thread-a',
      toolUseId: 'tu',
      output_file_path: '/tmp/x',
    });
    harness.advance(1_500); // 1.5s 后
    expect(
      store.findDedupCandidate({
        command: 'du -sh ~',
        cwd: '/tmp',
        env: undefined,
        threadId: 'thread-a',
      }),
    ).toBeUndefined();
  });

  it('env 不同不命中（env_hash 差）', () => {
    const { store } = makeStore();
    store.createRecord({
      session_id: 's1',
      command: 'a',
      cwd: '/tmp',
      env: { K: 'v1' },
      spaceId: 'sp',
      toolUseId: 'tu',
      output_file_path: '/tmp/x',
    });
    expect(
      store.findDedupCandidate({
        command: 'a',
        cwd: '/tmp',
        env: { K: 'v2' },
      }),
    ).toBeUndefined();
  });

  it('terminal state record 不命中（只匹配 running）', () => {
    const { store } = makeStore();
    store.createRecord({
      session_id: 's1',
      command: 'a',
      cwd: '/tmp',
      env: undefined,
      spaceId: 'sp',
      toolUseId: 'tu',
      output_file_path: '/tmp/x',
    });
    store.updateOnExit('s1', { status: 'completed', exit_code: 0, exited_by: 'normal_exit' });
    expect(
      store.findDedupCandidate({ command: 'a', cwd: '/tmp', env: undefined }),
    ).toBeUndefined();
  });
});

describe('ManagedTaskStore GC + race 保护', () => {
  it('terminal state record cleanup_at 到期 → 真删 + 删 output_file', async () => {
    const { store, harness, unlink } = makeStore({ ttl: 1_000 });
    store.createRecord({
      session_id: 's1',
      command: 'a',
      cwd: '/tmp',
      env: undefined,
      spaceId: 'sp',
      toolUseId: 'tu',
      output_file_path: '/tmp/agent/s1.log',
    });
    store.updateOnExit('s1', { status: 'completed', exit_code: 0, exited_by: 'normal_exit' });

    harness.advance(1_500); // 超过 TTL
    await store.gcTick();
    expect(store.get('s1')).toBeUndefined();
    expect(unlink).toHaveBeenCalledWith('/tmp/agent/s1.log');
  });

  it('running record 不被 GC 删（不管 TTL）', async () => {
    const { store, harness } = makeStore({ ttl: 1_000 });
    store.createRecord({
      session_id: 's1',
      command: 'a',
      cwd: '/tmp',
      env: undefined,
      spaceId: 'sp',
      toolUseId: 'tu',
      output_file_path: '/tmp/x',
    });
    harness.advance(10_000); // 远超 TTL
    await store.gcTick();
    expect(store.get('s1')?.status).toBe('running');
  });
});

describe('ManagedTaskStore hard timeout', () => {
  it('running ≥ warningMs → onWarning 调一次（不重复）', async () => {
    const onWarning = vi.fn();
    const { store, harness } = makeStore({
      warningMs: 6_000,
      killMs: 12_000,
      handlers: { onWarning },
    });
    store.createRecord({
      session_id: 's1',
      command: 'long',
      cwd: '/tmp',
      env: undefined,
      spaceId: 'sp',
      toolUseId: 'tu',
      output_file_path: '/tmp/x',
    });

    // 还没到 warning
    harness.advance(5_000);
    await store.gcTick();
    expect(onWarning).not.toHaveBeenCalled();

    // 过 warning 阈值
    harness.advance(2_000); // total 7s
    await store.gcTick();
    expect(onWarning).toHaveBeenCalledTimes(1);

    // 再 tick 不重复
    harness.advance(1_000);
    await store.gcTick();
    expect(onWarning).toHaveBeenCalledTimes(1);
  });

  it('running ≥ killMs → onKill 调用', async () => {
    const onKill = vi.fn(async () => {});
    const { store, harness } = makeStore({
      warningMs: 6_000,
      killMs: 12_000,
      handlers: { onKill },
    });
    store.createRecord({
      session_id: 's1',
      command: 'long',
      cwd: '/tmp',
      env: undefined,
      spaceId: 'sp',
      toolUseId: 'tu',
      output_file_path: '/tmp/x',
    });
    harness.advance(13_000); // 超 kill 阈值
    await store.gcTick();
    expect(onKill).toHaveBeenCalledWith('s1');
  });
});

describe('ManagedTaskStore startGc / stopGc', () => {
  it('startGc 注册 interval；stopGc 清除', () => {
    const { store } = makeStore();
    store.startGc();
    store.stopGc();
    // 不报错即可（确保 stopGc 幂等）
    store.stopGc();
  });

  it('startGc 幂等', () => {
    const { store } = makeStore();
    store.startGc();
    store.startGc(); // 不报错
    store.stopGc();
  });
});
