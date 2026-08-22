/**
 * 终端"假运行"根治 Layer 1 共享纯核心回归护栏（A1：本 PRD 命脉补齐零回归测试）。
 *
 * 覆盖 runtime 仍拥有的进程执行核心：
 *   - `runBackgroundTaskExitFlush`（= flushRunningBackgroundTasksOnExit）
 *     ① seal-then-kill 不变量（封存发生在第一个 await 之前）+ **防回归**；
 *     ② flush 期间命令"自然退出"不产生第二条真实 exit_code 终态（updateOnExit 幂等 +
 *        bridge producer 对 app_exit 终态 no-op）；
 *     ③ 空 store no-op；④ !threadId 走 warn 不投递；
 *     ⑤ killProcessGroupSafe 以 -pid 被调；⑥ relay 超时 → 落盘；
 *     + A4：2s 宽限 + SIGKILL 整组兜底 fire-and-forget（不阻塞退出链）。
 *   - `killProcessGroupSafe`：-pid 杀整组 + ESRCH 回退单进程。
 *
 * relay ACK、重试、持久化与 reconcile 已迁到宿主 delivery 层，
 * 对应回归测试随实现位于该宿主包。
 */
import { describe, it, expect, vi } from 'vitest';
import { ManagedTaskStore } from '@tabtin/terminal-core';
import {
  killProcessGroupSafe,
  parseRelayFailure,
  runBackgroundTaskExitFlush,
  type ExitFlushStore,
} from '../src/terminal/terminal-state-relay.js';
import type { PersistedEntryOwner } from '../src/session/index.js';

const OWNER: PersistedEntryOwner = { userId: 'u1', organizationId: 'wt1' };

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

function seedRunningRecord(
  store: ManagedTaskStore,
  over: Partial<{ sessionId: string; threadId?: string; pid?: number; toolUseId: string }> = {},
) {
  const sessionId = over.sessionId ?? `sess-${Math.random().toString(36).slice(2, 8)}`;
  store.createRecord({
    session_id: sessionId,
    command: 'pnpm dev',
    cwd: '/repo',
    env: undefined,
    spaceId: 'space-1',
    threadId: 'threadId' in over ? over.threadId : 'thread-1',
    toolUseId: over.toolUseId ?? 'run_terminal_command:0',
    owner: OWNER,
    pid: 'pid' in over ? over.pid : 4321,
    output_file_path: `/tmp/${sessionId}.log`,
  });
  return sessionId;
}

describe('terminal-state relay ACK 解析', () => {
  it('WS 超时/未连接保持可重试，确定性 schema/权限错误不可重试', () => {
    expect(parseRelayFailure({
      ok: false,
      error: { code: 'WS_REQUEST_TIMEOUT', message: 'request timeout' },
    })).toEqual({
      errorCode: 'WS_REQUEST_TIMEOUT',
      retryable: true,
    });
    expect(parseRelayFailure({
      ok: false,
      error: { code: 'WS_NOT_CONNECTED', message: 'socket is not open' },
    })).toEqual({
      errorCode: 'WS_NOT_CONNECTED',
      retryable: true,
    });
    expect(parseRelayFailure({
      ok: false,
      error: { code: 'WS_1003_SCHEMA_INVALID', message: 'ts out of acceptable range' },
    })).toEqual({
      errorCode: 'WS_1003_SCHEMA_INVALID',
      retryable: false,
    });
    expect(parseRelayFailure({
      ok: false,
      error: { code: 'WS_NEW_TRANSIENT', message: 'new gateway transient' },
    })).toEqual({
      errorCode: 'WS_NEW_TRANSIENT',
      retryable: true,
    });
  });
});

// ─── killProcessGroupSafe ────────────────────────────────────────────

describe('killProcessGroupSafe（-pid 杀整组 + ESRCH 回退单进程）', () => {
  it('合法 pid → kill(-pid, signal)（⑤ 以 -pid 被调）', () => {
    const kill = vi.fn();
    killProcessGroupSafe(kill, 4321, 'SIGTERM');
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(-4321, 'SIGTERM');
  });

  it('pid 缺失 / 0 / 负 → 不调 kill', () => {
    const kill = vi.fn();
    killProcessGroupSafe(kill, undefined, 'SIGTERM');
    killProcessGroupSafe(kill, 0, 'SIGTERM');
    killProcessGroupSafe(kill, -5, 'SIGTERM');
    expect(kill).not.toHaveBeenCalled();
  });

  it('kill(-pid) 抛（ESRCH，daemon detached:false）→ 回退单进程 kill(pid)', () => {
    const kill = vi.fn((pid: number) => {
      if (pid < 0) throw new Error('ESRCH');
    });
    killProcessGroupSafe(kill, 4321, 'SIGKILL');
    expect(kill).toHaveBeenNthCalledWith(1, -4321, 'SIGKILL');
    expect(kill).toHaveBeenNthCalledWith(2, 4321, 'SIGKILL');
  });

  it('整组与单进程都抛 → 静默吞错（进程已退）', () => {
    const kill = vi.fn(() => { throw new Error('ESRCH'); });
    expect(() => killProcessGroupSafe(kill, 4321, 'SIGTERM')).not.toThrow();
  });
});

// ─── runBackgroundTaskExitFlush ──────────────────────────────────────

describe('runBackgroundTaskExitFlush（退出 flush：seal-then-kill + A4 fire-and-forget）', () => {
  function makeFlushDeps(store: ExitFlushStore, over: Record<string, unknown> = {}) {
    const callLog: string[] = [];
    const killProcessGroup = vi.fn((pid: number | undefined, signal: NodeJS.Signals) => {
      callLog.push(`kill:${signal}:${pid}`);
    });
    const relayWithRetry = vi.fn(async (_o, threadId: string) => {
      callLog.push(`relay:${threadId}`);
    });
    const log = makeLogger();
    let sigkillCb: (() => void) | null = null;
    const scheduleSigkill = vi.fn((fn: () => void) => { sigkillCb = fn; });
    const deps = {
      store,
      killProcessGroup,
      relayWithRetry,
      log,
      scheduleSigkill,
      hostLabel: 'test',
      ...over,
    };
    return { deps, callLog, killProcessGroup, relayWithRetry, log, scheduleSigkill, runSigkill: () => sigkillCb?.() };
  }

  it('③ 空 store → no-op（不 kill / 不 relay / 不调度 SIGKILL）', async () => {
    const store = new ManagedTaskStore();
    const { deps, killProcessGroup, relayWithRetry, scheduleSigkill } = makeFlushDeps(store);
    await runBackgroundTaskExitFlush(deps as never);
    expect(killProcessGroup).not.toHaveBeenCalled();
    expect(relayWithRetry).not.toHaveBeenCalled();
    expect(scheduleSigkill).not.toHaveBeenCalled();
  });

  it('① seal-then-kill 不变量：所有 record 在第一个 relay await 前已 seal + SIGTERM（防回归）', async () => {
    const store = new ManagedTaskStore();
    const s1 = seedRunningRecord(store, { sessionId: 's1' });
    const s2 = seedRunningRecord(store, { sessionId: 's2' });

    const sealOrder: string[] = [];
    const updSpy = vi.spyOn(store, 'updateOnExit');
    const markSpy = vi.spyOn(store, 'markNotified');
    updSpy.mockImplementation((sid, res) => {
      sealOrder.push(`seal:${sid}`);
      return ManagedTaskStore.prototype.updateOnExit.call(store, sid, res);
    });
    markSpy.mockImplementation((sid) => {
      sealOrder.push(`mark:${sid}`);
      return ManagedTaskStore.prototype.markNotified.call(store, sid);
    });

    const { deps, callLog } = makeFlushDeps(store, {
      killProcessGroup: vi.fn((pid: number | undefined, signal: NodeJS.Signals) => {
        sealOrder.push(`kill:${signal}`);
      }),
      relayWithRetry: vi.fn(async () => { sealOrder.push('relay'); }),
    });
    await runBackgroundTaskExitFlush(deps as never);

    // 所有 seal + mark + SIGTERM 必须在第一个 relay 之前（封存发生在第一个 await 之前）。
    const firstRelay = sealOrder.indexOf('relay');
    expect(firstRelay).toBeGreaterThan(-1);
    const before = sealOrder.slice(0, firstRelay);
    expect(before).toContain('seal:s1');
    expect(before).toContain('seal:s2');
    expect(before).toContain('mark:s1');
    expect(before).toContain('mark:s2');
    expect(before).toContain('kill:SIGTERM');
    // 防回归：seal/mark 各 2 次（两 record），且无 relay 混入 seal 段。
    expect(before.filter((x) => x.startsWith('seal:'))).toHaveLength(2);
    expect(before).not.toContain('relay');
    void callLog; void s1; void s2;
  });

  it('② flush 期间命令"自然退出"不产生第二条终态（updateOnExit 幂等 + app_exit producer no-op）', async () => {
    const store = new ManagedTaskStore();
    const s1 = seedRunningRecord(store, { sessionId: 's1' });
    const { deps } = makeFlushDeps(store);
    await runBackgroundTaskExitFlush(deps as never);

    const rec = store.get(s1)!;
    expect(rec.status).toBe('killed');
    expect(rec.killed_reason).toBe('app_exit');
    expect(rec.notified).toBe(true); // 兼容旧 notified seal；producer 现在通过 app_exit 终态 no-op

    // 模拟被杀进程稍后触发 bridge 的自然 exit handler：updateOnExit(completed) 必须幂等 no-op。
    store.updateOnExit(s1, { status: 'completed', exit_code: 0, exited_by: 'normal_exit' });
    const after = store.get(s1)!;
    expect(after.status).toBe('killed'); // 仍是 killed，不被 completed 覆盖（无双写）
    expect(after.exit_code).toBe(-1);
  });

  it('④ record 无 threadId → 走 warn 分支，不投递 relay', async () => {
    const store = new ManagedTaskStore();
    seedRunningRecord(store, { sessionId: 's1', threadId: undefined });
    const { deps, relayWithRetry, log } = makeFlushDeps(store);
    await runBackgroundTaskExitFlush(deps as never);
    expect(relayWithRetry).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/no threadId/));
  });

  it('⑤ SIGTERM 整组以 record.pid 被调（killProcessGroup 收到 pid）', async () => {
    const store = new ManagedTaskStore();
    seedRunningRecord(store, { sessionId: 's1', pid: 9999 });
    const { deps, killProcessGroup } = makeFlushDeps(store);
    await runBackgroundTaskExitFlush(deps as never);
    expect(killProcessGroup).toHaveBeenCalledWith(9999, 'SIGTERM');
  });

  it('A4：SIGKILL 整组兜底 fire-and-forget——flush 返回时尚未 SIGKILL，调度回调后才 SIGKILL', async () => {
    const store = new ManagedTaskStore();
    seedRunningRecord(store, { sessionId: 's1', pid: 7777 });
    const { deps, killProcessGroup, scheduleSigkill, runSigkill } = makeFlushDeps(store);

    await runBackgroundTaskExitFlush(deps as never);

    // flush 已返回：只发了 SIGTERM，SIGKILL 还没发（fire-and-forget 调度，未 await）。
    expect(scheduleSigkill).toHaveBeenCalledTimes(1);
    expect(killProcessGroup).toHaveBeenCalledWith(7777, 'SIGTERM');
    expect(killProcessGroup).not.toHaveBeenCalledWith(7777, 'SIGKILL');

    // 手动触发调度的兜底回调 → 此时才 SIGKILL 整组。
    runSigkill();
    expect(killProcessGroup).toHaveBeenCalledWith(7777, 'SIGKILL');
  });

  it('⑥ relay 失败（relayWithRetry 内部已落盘）不阻断 flush；threadId 命令仍尝试 relay', async () => {
    const store = new ManagedTaskStore();
    seedRunningRecord(store, { sessionId: 's1' });
    const relayWithRetry = vi.fn(async () => { /* host 内部已落盘，flush 视为成功收尾 */ });
    const { deps } = makeFlushDeps(store, { relayWithRetry });
    await expect(runBackgroundTaskExitFlush(deps as never)).resolves.toBeUndefined();
    expect(relayWithRetry).toHaveBeenCalledWith(
      OWNER,
      'thread-1',
      expect.any(Array),
      { timeoutMs: 2_500 },
    );
  });

  // ── A1 强化（2026-05-31 第三轮修复 P2）──────────────────────────────
  //
  // 第二轮 review 指出：① 用例的"seal-then-kill 零 await 不变量"防回归只用**同步**
  // mock，抓不到"未来有人在 seal→SIGTERM→第一个 relay 之间插入一句 await"——同步
  // mock 下不管插不插 await，sealOrder 里 seal/kill 都排在 relay 之前，用例恒绿。
  //
  // 本用例补两条真护栏：
  //   (a) **微任务探针真正抓 await 插入**：探针在第一个 seal 时排一个 microtask；
  //       microtask 只在 await 边界才执行。若 seal→kill→第一个 relay-call 整段同步
  //       （无 await），探针必在 `syncSectionDone=true` 之后才跑；一旦有人在这段里
  //       插一句 await，事件循环让位 → 探针抢在 syncSectionDone 之前跑 →
  //       `awaitLeakedBeforeFirstRelay=true`，用例红。
  //   (b) **异步窗口内并发 exit handler 不双写**（这才是「真护栏」）：在 relay 的
  //       await 窗口内模拟"被 SIGTERM 杀的进程，其 bridge 自然 exit handler 并发触发
  //       updateOnExit(completed)"。即便万一同步不变量被破坏，updateOnExit 幂等 +
  //       markNotified 仍保证这条 completed 被吞掉、不覆盖 killed(app_exit)、不二次
  //       推送。结构上的"零 await"是 defense-in-depth，**幂等 + markNotified 才是
  //       根本护栏**。
  it('A1 强化：seal→kill 零 await（微任务探针）+ 异步窗口内自然 exit handler 并发不双写', async () => {
    const store = new ManagedTaskStore();
    const s1 = seedRunningRecord(store, { sessionId: 's1', pid: 111 });
    const s2 = seedRunningRecord(store, { sessionId: 's2', pid: 222 });

    let syncSectionDone = false;
    let awaitLeakedBeforeFirstRelay = false;
    let probeQueued = false;
    const updSpy = vi.spyOn(store, 'updateOnExit');
    updSpy.mockImplementation((sid, res) => {
      const ret = ManagedTaskStore.prototype.updateOnExit.call(store, sid, res);
      if (!probeQueued) {
        probeQueued = true;
        // 第一个 seal 时排探针：只有 await 让出事件循环时它才会跑。
        void Promise.resolve().then(() => {
          if (!syncSectionDone) awaitLeakedBeforeFirstRelay = true;
        });
      }
      return ret;
    });

    // 在 relay 的 await 窗口内观测到的 record 状态（断言放 flush 之后，避免
    // Promise.allSettled 吞掉 mock 内 expect 抛错导致假绿）。
    let exitHandlerFired = false;
    let observedStatusDuringWindow: string | undefined;
    let observedExitCodeDuringWindow: number | undefined;
    let observedNotifiedDuringWindow: boolean | undefined;

    const relayWithRetry = vi.fn(async () => {
      // relayWithRetry 第一次被调用 = 同步段（seal + SIGTERM）已跑完、进入第一个 await。
      syncSectionDone = true;
      if (!exitHandlerFired) {
        exitHandlerFired = true;
        // 模拟被杀进程的自然 exit handler 在 flush 异步窗口内并发触发 completed 终态。
        store.updateOnExit(s1, { status: 'completed', exit_code: 0, exited_by: 'normal_exit' });
        const rec = store.get(s1)!;
        observedStatusDuringWindow = rec.status;
        observedExitCodeDuringWindow = rec.exit_code;
        observedNotifiedDuringWindow = rec.notified;
      }
    });

    const { deps } = makeFlushDeps(store, {
      relayWithRetry,
      // 注入确定性 buildEvents，不依赖真实构造器（只需返回非空数组让 relay 被调）。
      buildEvents: () => [{ type: 'agent.stream.tool_result', payload: { client_event_id: 'x' } }],
    });

    await runBackgroundTaskExitFlush(deps as never);

    // (a) 同步段零 await：探针没抢在 syncSectionDone 之前跑。
    expect(awaitLeakedBeforeFirstRelay).toBe(false);

    // (b) 异步窗口内的自然 exit handler 确实触发过，且被幂等吞掉（无双写）。
    expect(exitHandlerFired).toBe(true);
    expect(observedStatusDuringWindow).toBe('killed');
    expect(observedExitCodeDuringWindow).toBe(-1);
    expect(observedNotifiedDuringWindow).toBe(true);

    // flush 收尾后两条 record 仍是 killed(app_exit)，没有被 completed 覆盖。
    for (const sid of [s1, s2]) {
      const rec = store.get(sid)!;
      expect(rec.status).toBe('killed');
      expect(rec.killed_reason).toBe('app_exit');
      expect(rec.exit_code).toBe(-1);
    }
  });
});
