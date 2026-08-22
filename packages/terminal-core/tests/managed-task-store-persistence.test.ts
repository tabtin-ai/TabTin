/**
 * Layer 2 ManagedTaskStore 落盘单测（终端假运行根治 v3 / 治 F9）。
 *
 * 用 fake `ManagedTaskPersistence` 端口（依赖倒置，不碰 fs）+ fake clock 验证：
 *   1. createRecord → upsert（status running）；statusfile_path 进 record。
 *   2. setPid → 再 upsert（带真实 pid）。
 *   3. updateOnExit terminal → delete（命令收尾，不再需要崩溃兜底）。
 *   4. 端口未注入 → 纯内存，零落盘调用（行为不劣化）。
 *   5. GC deleteAndCleanup → unlink output_file + statusfile（对称清理）。
 *   6. setManagedTaskPersistence 后续注入也生效。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ManagedTaskStore,
  type ManagedTaskPersistence,
  type PersistedManagedTask,
} from '../src/managed-task-store.js';

function makeFakeClock(initial = 1_700_000_000_000) {
  let clock = initial;
  let handler: (() => void) | null = null;
  return {
    now: () => clock,
    advance: (ms: number) => { clock += ms; },
    fakeSetInterval: (h: () => void) => { handler = h; return 'h'; },
    fakeClearInterval: () => { handler = null; },
    tick: async () => { if (handler) await handler(); },
  };
}

function makeFakePersistence() {
  const upsert = vi.fn<(r: PersistedManagedTask) => void>();
  const del = vi.fn<(sessionId: string, owner: unknown) => void>();
  const port: ManagedTaskPersistence = {
    upsert: (r) => upsert(r),
    delete: (s, o) => del(s, o),
  };
  return { port, upsert, del };
}

function baseCreateInput(over?: Partial<Parameters<ManagedTaskStore['createRecord']>[0]>) {
  return {
    session_id: 'agent-s1',
    command: 'pnpm dev',
    cwd: '/work',
    env: { A: '1' },
    spaceId: 'space-1',
    threadId: 'thread-1',
    toolUseId: 'tool-1',
    owner: { userId: 'u1', organizationId: 'wt1' },
    output_file_path: '/tmp/tasks/agent-s1.log',
    statusfile_path: '/tmp/tasks/agent-s1.status',
    hard_timeout_ms: 60_000,
    ...over,
  };
}

describe('ManagedTaskStore Layer 2 落盘', () => {
  it('createRecord → upsert(running) + statusfile_path 写入 record', () => {
    const { port, upsert } = makeFakePersistence();
    const store = new ManagedTaskStore({ persistence: port, log: () => {} });
    const rec = store.createRecord(baseCreateInput({ notificationThreadId: 'child-run-id' }));

    expect(rec.statusfile_path).toBe('/tmp/tasks/agent-s1.status');
    expect(upsert).toHaveBeenCalledTimes(1);
    const persisted = upsert.mock.calls[0]![0];
    expect(persisted.status).toBe('running');
    expect(persisted.session_id).toBe('agent-s1');
    expect(persisted.toolUseId).toBe('tool-1');
    expect(persisted.threadId).toBe('thread-1');
    expect(persisted.notificationThreadId).toBe('child-run-id');
    expect(persisted.output_file_path).toBe('/tmp/tasks/agent-s1.log');
    expect(persisted.statusfile_path).toBe('/tmp/tasks/agent-s1.status');
    expect(persisted.owner).toEqual({ userId: 'u1', organizationId: 'wt1' });
    expect(persisted.command).toBe('pnpm dev');
    expect(persisted.cwd).toBe('/work');
    expect(persisted.notification_state).toBe('foreground_waiting');
    expect(typeof persisted.started_at).toBe('number');
    // env_hash 不在落盘子集（无需，对账不用）
    expect((persisted as Record<string, unknown>).env_hash).toBeUndefined();
  });

  it('markBackgroundExposed → 再 upsert（崩溃恢复保留后台暴露语义）', () => {
    const { port, upsert } = makeFakePersistence();
    const store = new ManagedTaskStore({ persistence: port, log: () => {} });
    store.createRecord(baseCreateInput());
    upsert.mockClear();

    store.markBackgroundExposed('agent-s1');
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0]![0].notification_state).toBe('background_exposed');
  });

  it('setPid → 再 upsert（带真实 pid，对账才能探活）', () => {
    const { port, upsert } = makeFakePersistence();
    const store = new ManagedTaskStore({ persistence: port, log: () => {} });
    store.createRecord(baseCreateInput());
    upsert.mockClear();

    store.setPid('agent-s1', 4242);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0]![0].pid).toBe(4242);
  });

  it('updateOnExit terminal → delete（盘上不再留 running record）', () => {
    const { port, del } = makeFakePersistence();
    const store = new ManagedTaskStore({ persistence: port, log: () => {} });
    store.createRecord(baseCreateInput());

    store.updateOnExit('agent-s1', { status: 'completed', exit_code: 0, exited_by: 'normal_exit' });
    expect(del).toHaveBeenCalledTimes(1);
    expect(del.mock.calls[0]![0]).toBe('agent-s1');
    expect(del.mock.calls[0]![1]).toEqual({ userId: 'u1', organizationId: 'wt1' });
  });

  it('app_exit 退出 flush 路径同样删盘（Layer 1 relay 负责持久投递）', () => {
    const { port, del } = makeFakePersistence();
    const store = new ManagedTaskStore({ persistence: port, log: () => {} });
    store.createRecord(baseCreateInput());
    store.updateOnExit('agent-s1', {
      status: 'killed', exit_code: -1, exited_by: 'signal', killed_reason: 'app_exit',
    });
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('端口未注入 → 纯内存，零落盘副作用（行为不劣化）', () => {
    const store = new ManagedTaskStore({ log: () => {} });
    // 不抛错即可（无端口时 persist/delete no-op）
    const rec = store.createRecord(baseCreateInput());
    store.setPid('agent-s1', 7);
    store.updateOnExit('agent-s1', { status: 'completed', exit_code: 0, exited_by: 'normal_exit' });
    expect(rec.session_id).toBe('agent-s1');
  });

  it('setManagedTaskPersistence 后注入也生效', () => {
    const { port, upsert } = makeFakePersistence();
    const store = new ManagedTaskStore({ log: () => {} });
    store.createRecord(baseCreateInput());
    expect(upsert).not.toHaveBeenCalled();

    store.setManagedTaskPersistence(port);
    store.setPid('agent-s1', 99);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0]![0].pid).toBe(99);
  });

  it('GC deleteAndCleanup → unlink output_file + statusfile（对称清理）', async () => {
    const unlink = vi.fn(async () => {});
    const harness = makeFakeClock();
    const store = new ManagedTaskStore({
      clock: harness.now,
      setInterval: harness.fakeSetInterval,
      clearInterval: harness.fakeClearInterval,
      recordTtlMs: 1_000,
      gcIntervalMs: 500,
      unlinkFile: unlink,
      log: () => {},
    });
    store.createRecord(baseCreateInput());
    store.updateOnExit('agent-s1', { status: 'completed', exit_code: 0, exited_by: 'normal_exit' });
    harness.advance(2_000); // 超 TTL
    await store.gcTick();

    const unlinked = unlink.mock.calls.map((c) => c[0]);
    expect(unlinked).toContain('/tmp/tasks/agent-s1.log');
    expect(unlinked).toContain('/tmp/tasks/agent-s1.status');
  });

  it('落盘端口 upsert 抛错不打断 createRecord（best-effort）', () => {
    const port: ManagedTaskPersistence = {
      upsert: () => { throw new Error('disk full'); },
      delete: () => {},
    };
    const store = new ManagedTaskStore({ persistence: port, log: () => {} });
    expect(() => store.createRecord(baseCreateInput())).not.toThrow();
    expect(store.get('agent-s1')?.status).toBe('running');
  });
});
