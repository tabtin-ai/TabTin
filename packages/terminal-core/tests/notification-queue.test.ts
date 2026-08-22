/**
 * NotificationQueue 单测 —— 验证统一优先级队列、dedup、subscribe、GC。
 *
 * 触发 PRD（run-terminal-command_push通知重构_2026-05-23）：
 * §5 D5（统一优先级队列）+ §6.1（数据结构与接口）+ §9.2 架构验收（指标 9.2.1-9.2.9）。
 *
 * 覆盖（§17.6 D4.a 改名后：sessionId → threadId）：
 *   1. enqueue 基础：入队后 size +1、subscribers 被同步调用
 *   2. dedup：同 threadId+kind+dedupKey 24h 内只入一次，第二次 enqueue 返回 false
 *   3. dedup 窗口外：同 key 在 dedup 窗口外可以再次入队
 *   4. dedup undefined：dedupKey 为 undefined 时允许重复入
 *   5. drainByThreadId：按 threadId 取出 + 从队列移除
 *   6. drainByThreadId 优先级排序：'now' > 'next' > 'later'，同优先级 FIFO
 *   7. peekByThreadId：不出队，仅返数量
 *   8. subscribe / unsubscribe：listener 被同步调用；unsubscribe 后不再调用
 *   9. subscribe 异常隔离：listener 抛错不影响其他 listener 也不影响 enqueue 返回
 *   10. GC：TTL 到期的 item 被删；TTL 内的 item 保留
 *   11. GC dedupIndex：dedup 窗口外的 dedup 索引被清理
 *   12. 跨 threadId 隔离：drain threadA 不影响 threadB
 */

import { describe, expect, it, vi } from 'vitest';
import {
  NotificationQueue,
  type BackgroundTaskCompletedPayload,
  type NotificationEnvelope,
  type NotificationPriority,
} from '../src/notification-queue.js';

interface FakeClockHarness {
  now: () => number;
  advance: (ms: number) => void;
  fakeSetInterval: (handler: () => void, ms: number) => unknown;
  fakeClearInterval: (handle: unknown) => void;
  tickInterval: () => void;
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
    tickInterval: () => {
      if (handler) handler();
    },
  };
}

function makeQueue(opts?: {
  ttlMs?: number;
  dedupWindowMs?: number;
  gcIntervalMs?: number;
}) {
  const harness = makeFakeClock();
  const queue = new NotificationQueue({
    clock: harness.now,
    setInterval: harness.fakeSetInterval,
    clearInterval: harness.fakeClearInterval,
    ttlMs: opts?.ttlMs ?? 60_000,
    dedupWindowMs: opts?.dedupWindowMs ?? 60_000,
    gcIntervalMs: opts?.gcIntervalMs ?? 10_000,
    log: () => {},
  });
  return { queue, harness };
}

/** 测试用通知 envelope 构造器，默认填全所有字段。 */
function makeEnvelope(
  overrides: Partial<NotificationEnvelope<BackgroundTaskCompletedPayload>> & {
    enqueuedAt: number;
  },
): NotificationEnvelope<BackgroundTaskCompletedPayload> {
  return {
    kind: 'background-task-completed',
    target: {
      spaceId: 'space-1',
      // §17.6 D4.a：target.threadId → target.threadId（业务对话 thread，
      // 与 host.sessions Map key 同源）。原 chat-session-A 字面已是 thread 维度，
      // 值保留，仅改字段名。
      threadId: 'chat-thread-A',
    },
    priority: 'later',
    payload: {
      agent_session_id: 'agent-space-1-1700000-abcd',
      tool_use_id: 'run_terminal_command:0',
      command: 'echo hi',
      exit_code: 0,
      exited_by: 'normal_exit',
      duration_ms: 12,
      output_file_path: '/tmp/tabtin-agent-tasks/agent-space-1-1700000-abcd.log',
      pid: 12345,
      cwd: '/tmp/work',
    },
    dedupKey: 'agent-space-1-1700000-abcd',
    ...overrides,
  };
}

// ─── enqueue 基础 ─────────────────────────────────────────────────────

describe('NotificationQueue.enqueue', () => {
  it('入队后 size +1，返回 true', () => {
    const { queue, harness } = makeQueue();
    const env = makeEnvelope({ enqueuedAt: harness.now() });
    const result = queue.enqueue(env);
    expect(result).toBe(true);
    expect(queue.size()).toBe(1);
  });

  it('多次入队（不同 dedupKey）累加 size', () => {
    const { queue, harness } = makeQueue();
    queue.enqueue(makeEnvelope({ enqueuedAt: harness.now(), dedupKey: 'a' }));
    queue.enqueue(makeEnvelope({ enqueuedAt: harness.now(), dedupKey: 'b' }));
    queue.enqueue(makeEnvelope({ enqueuedAt: harness.now(), dedupKey: 'c' }));
    expect(queue.size()).toBe(3);
  });
});

// ─── dedup ────────────────────────────────────────────────────────────

describe('NotificationQueue dedup', () => {
  it('同 sessionId+kind+dedupKey 第二次入队返回 false 且不增 size', () => {
    const { queue, harness } = makeQueue();
    const env1 = makeEnvelope({ enqueuedAt: harness.now() });
    expect(queue.enqueue(env1)).toBe(true);
    expect(queue.size()).toBe(1);

    harness.advance(10); // 仍在 dedup 窗口内
    const env2 = makeEnvelope({ enqueuedAt: harness.now() });
    expect(queue.enqueue(env2)).toBe(false);
    expect(queue.size()).toBe(1);
  });

  it('不同 sessionId 同 kind 同 dedupKey 不算 dedup（互不影响）', () => {
    const { queue, harness } = makeQueue();
    const envA = makeEnvelope({
      enqueuedAt: harness.now(),
      target: { spaceId: 'space-1', threadId: 'chat-A' },
      dedupKey: 'same-key',
    });
    const envB = makeEnvelope({
      enqueuedAt: harness.now(),
      target: { spaceId: 'space-1', threadId: 'chat-B' },
      dedupKey: 'same-key',
    });
    expect(queue.enqueue(envA)).toBe(true);
    expect(queue.enqueue(envB)).toBe(true);
    expect(queue.size()).toBe(2);
  });

  it('同 sessionId 不同 kind 同 dedupKey 不算 dedup', () => {
    const { queue, harness } = makeQueue();
    const env1 = makeEnvelope({
      enqueuedAt: harness.now(),
      kind: 'background-task-completed',
      dedupKey: 'same-key',
    });
    const env2 = makeEnvelope({
      enqueuedAt: harness.now(),
      kind: 'subagent-completed',
      dedupKey: 'same-key',
    });
    expect(queue.enqueue(env1)).toBe(true);
    expect(queue.enqueue(env2)).toBe(true);
    expect(queue.size()).toBe(2);
  });

  it('dedup 窗口过期后同 key 可以再次入队', () => {
    const { queue, harness } = makeQueue({ dedupWindowMs: 1000 });
    const env1 = makeEnvelope({ enqueuedAt: harness.now() });
    expect(queue.enqueue(env1)).toBe(true);

    harness.advance(1001); // 超过 dedup 窗口
    const env2 = makeEnvelope({ enqueuedAt: harness.now() });
    expect(queue.enqueue(env2)).toBe(true);
    expect(queue.size()).toBe(2);
  });

  it('dedupKey=undefined 允许重复入', () => {
    const { queue, harness } = makeQueue();
    const env1 = makeEnvelope({ enqueuedAt: harness.now(), dedupKey: undefined });
    const env2 = makeEnvelope({ enqueuedAt: harness.now(), dedupKey: undefined });
    expect(queue.enqueue(env1)).toBe(true);
    expect(queue.enqueue(env2)).toBe(true);
    expect(queue.size()).toBe(2);
  });

  it('drain 后同 dedupKey 可以再次入队（dedupIndex 同步释放）', () => {
    const { queue, harness } = makeQueue();
    // 第一次入队
    expect(queue.enqueue(makeEnvelope({ enqueuedAt: harness.now() }))).toBe(true);
    expect(queue.dedupIndexSize()).toBe(1);

    // drain 应该同步释放 dedupIndex
    const drained = queue.drainByThreadId('chat-thread-A');
    expect(drained).toHaveLength(1);
    expect(queue.dedupIndexSize()).toBe(0);

    // dedup 已释放，同 dedupKey 可以再次入队（不再被 dedup 拦下）
    harness.advance(10);
    expect(queue.enqueue(makeEnvelope({ enqueuedAt: harness.now() }))).toBe(true);
    expect(queue.size()).toBe(1);
  });

  it('drain 后释放 dedupIndex 不影响其他 session 的 dedup 状态', () => {
    const { queue, harness } = makeQueue();
    queue.enqueue(
      makeEnvelope({
        enqueuedAt: harness.now(),
        target: { spaceId: 's', threadId: 'chat-A' },
        dedupKey: 'k',
      }),
    );
    queue.enqueue(
      makeEnvelope({
        enqueuedAt: harness.now(),
        target: { spaceId: 's', threadId: 'chat-B' },
        dedupKey: 'k',
      }),
    );
    expect(queue.dedupIndexSize()).toBe(2);

    queue.drainByThreadId('chat-A');
    expect(queue.dedupIndexSize()).toBe(1); // 只释放了 chat-A 的

    // chat-B 的 dedup 仍生效
    expect(
      queue.enqueue(
        makeEnvelope({
          enqueuedAt: harness.now(),
          target: { spaceId: 's', threadId: 'chat-B' },
          dedupKey: 'k',
        }),
      ),
    ).toBe(false);
  });

  it('drain 后 dedupKey=undefined 的项不报错（无 dedupIndex 项可清）', () => {
    const { queue, harness } = makeQueue();
    queue.enqueue(makeEnvelope({ enqueuedAt: harness.now(), dedupKey: undefined }));
    // 不应抛错
    expect(() => queue.drainByThreadId('chat-thread-A')).not.toThrow();
  });
});

// ─── drainByThreadId ─────────────────────────────────────────────────

describe('NotificationQueue.drainByThreadId', () => {
  it('按 sessionId 取出匹配的项 + 从队列移除', () => {
    const { queue, harness } = makeQueue();
    queue.enqueue(makeEnvelope({ enqueuedAt: harness.now(), dedupKey: 'a' }));
    queue.enqueue(makeEnvelope({ enqueuedAt: harness.now(), dedupKey: 'b' }));
    expect(queue.size()).toBe(2);

    const drained = queue.drainByThreadId('chat-thread-A');
    expect(drained).toHaveLength(2);
    expect(queue.size()).toBe(0);
  });

  it('drain 不匹配 sessionId 返回空数组且队列不变', () => {
    const { queue, harness } = makeQueue();
    queue.enqueue(makeEnvelope({ enqueuedAt: harness.now() }));
    expect(queue.size()).toBe(1);

    const drained = queue.drainByThreadId('non-existent-session');
    expect(drained).toEqual([]);
    expect(queue.size()).toBe(1);
  });

  it('drain 优先级排序：now > next > later', () => {
    const { queue, harness } = makeQueue();
    queue.enqueue(
      makeEnvelope({
        enqueuedAt: harness.now(),
        priority: 'later',
        dedupKey: 'a',
      }),
    );
    queue.enqueue(
      makeEnvelope({
        enqueuedAt: harness.now(),
        priority: 'now',
        dedupKey: 'b',
      }),
    );
    queue.enqueue(
      makeEnvelope({
        enqueuedAt: harness.now(),
        priority: 'next',
        dedupKey: 'c',
      }),
    );

    const drained = queue.drainByThreadId('chat-thread-A');
    const priorities = drained.map(
      (e: NotificationEnvelope) => e.priority as NotificationPriority,
    );
    expect(priorities).toEqual(['now', 'next', 'later']);
  });

  it('同优先级按 FIFO（enqueuedAt 升序）', () => {
    const { queue, harness } = makeQueue();
    queue.enqueue(
      makeEnvelope({
        enqueuedAt: harness.now(),
        priority: 'later',
        dedupKey: 'first',
      }),
    );
    harness.advance(100);
    queue.enqueue(
      makeEnvelope({
        enqueuedAt: harness.now(),
        priority: 'later',
        dedupKey: 'second',
      }),
    );
    harness.advance(100);
    queue.enqueue(
      makeEnvelope({
        enqueuedAt: harness.now(),
        priority: 'later',
        dedupKey: 'third',
      }),
    );

    const drained = queue.drainByThreadId('chat-thread-A');
    const dedupKeys = drained.map((e: NotificationEnvelope) => e.dedupKey);
    expect(dedupKeys).toEqual(['first', 'second', 'third']);
  });

  it('混合优先级 + FIFO：优先级先生效，同优先级 FIFO', () => {
    const { queue, harness } = makeQueue();
    queue.enqueue(
      makeEnvelope({
        enqueuedAt: harness.now(),
        priority: 'later',
        dedupKey: 'later-1',
      }),
    );
    harness.advance(50);
    queue.enqueue(
      makeEnvelope({
        enqueuedAt: harness.now(),
        priority: 'next',
        dedupKey: 'next-1',
      }),
    );
    harness.advance(50);
    queue.enqueue(
      makeEnvelope({
        enqueuedAt: harness.now(),
        priority: 'later',
        dedupKey: 'later-2',
      }),
    );
    harness.advance(50);
    queue.enqueue(
      makeEnvelope({
        enqueuedAt: harness.now(),
        priority: 'next',
        dedupKey: 'next-2',
      }),
    );

    const drained = queue.drainByThreadId('chat-thread-A');
    const dedupKeys = drained.map((e: NotificationEnvelope) => e.dedupKey);
    expect(dedupKeys).toEqual(['next-1', 'next-2', 'later-1', 'later-2']);
  });

  it('跨 sessionId 隔离：drain sessionA 不影响 sessionB', () => {
    const { queue, harness } = makeQueue();
    queue.enqueue(
      makeEnvelope({
        enqueuedAt: harness.now(),
        target: { spaceId: 'space-1', threadId: 'chat-A' },
        dedupKey: 'a-1',
      }),
    );
    queue.enqueue(
      makeEnvelope({
        enqueuedAt: harness.now(),
        target: { spaceId: 'space-1', threadId: 'chat-B' },
        dedupKey: 'b-1',
      }),
    );

    const drainedA = queue.drainByThreadId('chat-A');
    expect(drainedA).toHaveLength(1);
    expect(drainedA[0]?.target.threadId).toBe('chat-A');
    expect(queue.size()).toBe(1);

    const drainedB = queue.drainByThreadId('chat-B');
    expect(drainedB).toHaveLength(1);
    expect(drainedB[0]?.target.threadId).toBe('chat-B');
    expect(queue.size()).toBe(0);
  });
});

// ─── peekByThreadId ──────────────────────────────────────────────────

describe('NotificationQueue.peekByThreadId', () => {
  it('返回匹配 sessionId 的项数，不出队', () => {
    const { queue, harness } = makeQueue();
    queue.enqueue(makeEnvelope({ enqueuedAt: harness.now(), dedupKey: 'a' }));
    queue.enqueue(makeEnvelope({ enqueuedAt: harness.now(), dedupKey: 'b' }));
    expect(queue.peekByThreadId('chat-thread-A')).toBe(2);
    expect(queue.size()).toBe(2); // 仍然 2，没出队
  });

  it('无匹配返回 0', () => {
    const { queue, harness } = makeQueue();
    queue.enqueue(makeEnvelope({ enqueuedAt: harness.now() }));
    expect(queue.peekByThreadId('non-existent')).toBe(0);
  });
});

// ─── subscribe ────────────────────────────────────────────────────────

describe('NotificationQueue.subscribe', () => {
  it('subscribe 后 listener 在 enqueue 同步路径上被调用', () => {
    const { queue, harness } = makeQueue();
    const listener = vi.fn();
    queue.subscribe(listener);

    const env = makeEnvelope({ enqueuedAt: harness.now() });
    queue.enqueue(env);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(env);
  });

  it('多个 subscribers 都被调用', () => {
    const { queue, harness } = makeQueue();
    const l1 = vi.fn();
    const l2 = vi.fn();
    queue.subscribe(l1);
    queue.subscribe(l2);

    queue.enqueue(makeEnvelope({ enqueuedAt: harness.now() }));
    expect(l1).toHaveBeenCalledTimes(1);
    expect(l2).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe 后该 listener 不再被调用', () => {
    const { queue, harness } = makeQueue();
    const listener = vi.fn();
    const unsubscribe = queue.subscribe(listener);

    queue.enqueue(makeEnvelope({ enqueuedAt: harness.now(), dedupKey: 'a' }));
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    queue.enqueue(makeEnvelope({ enqueuedAt: harness.now(), dedupKey: 'b' }));
    expect(listener).toHaveBeenCalledTimes(1); // 仍然 1
  });

  it('listener 异常被吞 + 不影响 enqueue 返回 + 不影响其他 listener', () => {
    const { queue, harness } = makeQueue();
    const throwing = vi.fn(() => {
      throw new Error('boom');
    });
    const normal = vi.fn();
    queue.subscribe(throwing);
    queue.subscribe(normal);

    const result = queue.enqueue(makeEnvelope({ enqueuedAt: harness.now() }));
    expect(result).toBe(true);
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(normal).toHaveBeenCalledTimes(1);
  });

  it('dedup 命中时 listener 不被调用', () => {
    const { queue, harness } = makeQueue();
    const listener = vi.fn();
    queue.subscribe(listener);

    queue.enqueue(makeEnvelope({ enqueuedAt: harness.now() }));
    expect(listener).toHaveBeenCalledTimes(1);

    // dedup 命中
    queue.enqueue(makeEnvelope({ enqueuedAt: harness.now() }));
    expect(listener).toHaveBeenCalledTimes(1); // 仍然 1
  });
});

// ─── GC ───────────────────────────────────────────────────────────────

describe('NotificationQueue GC', () => {
  it('TTL 内的 item 保留', () => {
    const { queue, harness } = makeQueue({ ttlMs: 60_000 });
    queue.enqueue(makeEnvelope({ enqueuedAt: harness.now() }));
    expect(queue.size()).toBe(1);

    harness.advance(30_000); // 半 TTL
    queue.gcTick();
    expect(queue.size()).toBe(1);
  });

  it('TTL 到期的 item 被删', () => {
    const { queue, harness } = makeQueue({ ttlMs: 60_000 });
    queue.enqueue(makeEnvelope({ enqueuedAt: harness.now() }));
    expect(queue.size()).toBe(1);

    harness.advance(60_001); // 超过 TTL
    queue.gcTick();
    expect(queue.size()).toBe(0);
  });

  it('GC 按 enqueuedAt 而不是当前 clock 算 TTL', () => {
    const { queue, harness } = makeQueue({ ttlMs: 60_000 });
    const oldEnv = makeEnvelope({
      enqueuedAt: harness.now(),
      dedupKey: 'old',
    });
    queue.enqueue(oldEnv);

    harness.advance(50_000);
    const recentEnv = makeEnvelope({
      enqueuedAt: harness.now(),
      dedupKey: 'recent',
    });
    queue.enqueue(recentEnv);

    harness.advance(15_000); // 再 15s，old 已 65s，recent 才 15s
    queue.gcTick();
    expect(queue.size()).toBe(1);
    // 留下的是 recent
    const drained = queue.drainByThreadId('chat-thread-A');
    expect(drained[0]?.dedupKey).toBe('recent');
  });

  it('GC 清理过期的 dedupIndex', () => {
    const { queue, harness } = makeQueue({
      dedupWindowMs: 60_000,
    });
    queue.enqueue(makeEnvelope({ enqueuedAt: harness.now() }));
    expect(queue.dedupIndexSize()).toBe(1);

    harness.advance(60_001);
    queue.gcTick();
    expect(queue.dedupIndexSize()).toBe(0);
  });

  it('startGc / stopGc：周期触发 gcTick', () => {
    const { queue, harness } = makeQueue({ ttlMs: 1000 });
    queue.startGc();

    queue.enqueue(makeEnvelope({ enqueuedAt: harness.now() }));
    expect(queue.size()).toBe(1);

    harness.advance(2000);
    harness.tickInterval(); // 触发 fake setInterval handler
    expect(queue.size()).toBe(0);

    queue.stopGc();
    // stop 后再 advance 不会触发 GC（handler 被清掉了）
    queue.enqueue(makeEnvelope({ enqueuedAt: harness.now(), dedupKey: 'after-stop' }));
    harness.advance(2000);
    harness.tickInterval(); // handler 为 null，不会跑
    expect(queue.size()).toBe(1);
  });

  it('startGc 重复调 no-op', () => {
    const { queue } = makeQueue();
    queue.startGc();
    queue.startGc(); // 不应炸
    queue.stopGc();
  });

  it('stopGc 未启动时调 no-op', () => {
    const { queue } = makeQueue();
    queue.stopGc(); // 不应炸
  });
});

// ─── race 防御 3：consumer 退回路径（PRD §6.3） ──────────────────────

describe('NotificationQueue race 防御 3：退回路径', () => {
  it('模拟 consumer drain 后调 handleQueryInternal 失败 → 退回 enqueue 不丢消息', () => {
    const { queue, harness } = makeQueue();
    const env = makeEnvelope({ enqueuedAt: harness.now() });

    // [Step 1] producer 入队
    expect(queue.enqueue(env)).toBe(true);
    expect(queue.size()).toBe(1);

    // [Step 2] consumer drain
    const items = queue.drainByThreadId('chat-thread-A');
    expect(items).toHaveLength(1);
    expect(queue.size()).toBe(0);
    expect(queue.dedupIndexSize()).toBe(0); // 关键：dedupIndex 应已释放

    // [Step 3] 模拟 handleQueryInternal 失败 → consumer 退回
    for (const item of items) {
      // 关键：退回必须返 true（不被 dedup 拦下），否则通知就静默丢失了
      expect(queue.enqueue(item)).toBe(true);
    }
    expect(queue.size()).toBe(1);

    // [Step 4] 下次 idle drain 再次取出，consumer 重试成功
    const itemsRetry = queue.drainByThreadId('chat-thread-A');
    expect(itemsRetry).toHaveLength(1);
    expect(itemsRetry[0]?.dedupKey).toBe(env.dedupKey);
  });

  it('退回多次（极端 race）仍不丢消息', () => {
    const { queue, harness } = makeQueue();
    queue.enqueue(makeEnvelope({ enqueuedAt: harness.now() }));

    // 模拟 3 次 drain → 退回循环
    for (let i = 0; i < 3; i += 1) {
      const items = queue.drainByThreadId('chat-thread-A');
      expect(items).toHaveLength(1);
      // 退回
      for (const item of items) {
        expect(queue.enqueue(item)).toBe(true);
      }
    }

    expect(queue.size()).toBe(1);
  });
});

// ─── 端到端：典型 push notification 场景 ────────────────────────────────

describe('NotificationQueue 端到端', () => {
  it('producer → enqueue → subscriber → drain 完整链路', () => {
    const { queue, harness } = makeQueue();

    // host 注册 idle drain 触发器
    const drainTrigger = vi.fn((env: NotificationEnvelope) => {
      const items = queue.drainByThreadId(env.target.threadId);
      return items;
    });
    queue.subscribe(drainTrigger);

    // producer 入队：3 个后台任务在不同 session 完成
    queue.enqueue(
      makeEnvelope({
        enqueuedAt: harness.now(),
        target: { spaceId: 's', threadId: 'chat-A' },
        priority: 'later',
        dedupKey: 'task-1',
      }),
    );
    harness.advance(10);
    queue.enqueue(
      makeEnvelope({
        enqueuedAt: harness.now(),
        target: { spaceId: 's', threadId: 'chat-B' },
        priority: 'next',
        dedupKey: 'task-2',
      }),
    );
    harness.advance(10);
    queue.enqueue(
      makeEnvelope({
        enqueuedAt: harness.now(),
        target: { spaceId: 's', threadId: 'chat-A' },
        priority: 'later',
        dedupKey: 'task-3',
      }),
    );

    expect(drainTrigger).toHaveBeenCalledTimes(3);
    expect(queue.size()).toBe(0); // 每次 trigger 都 drain 了
  });
});
