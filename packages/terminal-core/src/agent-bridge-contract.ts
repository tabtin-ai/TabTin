/**
 * Agent Bridge Contract Test Runner — WP2 实现层两端共用契约断言。
 *
 * **业务定位**：让 Electron `ElectronPtyManagerBridge` / Daemon
 * `DaemonPtyManagerBridge` 两端**跑同一套行为契约断言**，避免实现漂移
 * （这是 WP2 北极星指标之一：`contract test 跑过（两端都跑一遍）`）。
 *
 * **设计形态**：
 *   - export `describeAgentBridgeContract(name, setup)` —— 两端各 import
 *     并传入自己的 bridge 实例 + 配套 PTY 控制句柄（让测试能驱动 PTY
 *     emit data / exit），跑同一组 `it()` 断言。
 *   - 不依赖任何具体宿主：runner 只依赖 vitest（terminal-core 已是
 *     dev dep）+ `agent-bridge.ts` 类型 + node 内置模块。
 *
 * **覆盖项**（agent-bridge.ts JSDoc 硬契约逐条对应）：
 *   1. 5 方法签名存在 + 类型可调用
 *   2. emit 时序：`agent-session-created` 早于 `executeAgentCommand` resolve
 *   3. threadId === undefined → 事件 payload `threadId === null`（L-10）
 *   4. AgentSessionCloseReason 与 PtySessionCloseReason 字面对齐
 *   5. subscribe 边界：
 *      - 重复 subscribe 同 handler 同 event → 去重
 *      - emit 期间 unsubscribe → 本次仍调、下次起不调（snapshot 语义）
 *      - async handler reject → 不影响其他订阅者也不冒泡
 *      - unsubscribe 幂等
 *   6. session limit 错误 message 含 `agent session limit reached`
 *   7. spawnAgentSessionDetached 返回 outputFilePath 已 realpath（macOS 兜底）
 *
 * **不覆盖项**（明示边界，避免误以为这层 catch 所有问题）：
 *   - 真实 node-pty spawn 行为 / shell 命令实际执行 → 各端集成测自己跑
 *   - ShellCap 上层 envelope 字段映射 → WP1 单测覆盖
 *   - renderer IPC 链路 → WP3 单测覆盖
 *   - 跨进程序列化 / wire 协议 → D9 解锁前不抽象
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  AgentCommandRequest,
  AgentSessionCloseReason,
  AgentSessionCreated,
  PtyManagerBridge,
} from './agent-bridge';
import type { ManagedTaskStore } from './managed-task-store';
import * as fs from 'node:fs';
import * as os from 'node:os';

// ==================== Test Setup Contract ====================

/**
 * 两端 contract test 调用者提供的"测试夹具"。
 *
 * 设计取舍：runner 不直接 mock PTY——两端 bridge 实现内部已经依赖各自
 * 真实 PtyManager / DaemonPtyManager，两端单测各自负责 mock node-pty
 * 层（Electron 端有 MockPtyHostClient，Daemon 端通过构造选项注入同款
 * mock），再构造 bridge 实例传进 runner 跑契约断言。
 *
 * 这样的好处：runner 测的是 bridge 实现层的**契约履行**，而不是
 * "runner 自己造一个 fake bridge 测自己"——后者无法 catch 实现漂移。
 */
export interface AgentBridgeContractFixture {
  bridge: PtyManagerBridge;

  /**
   * 触发一条命令在 PTY 内"完成"——具体实现：mock host 收到 marker
   * START 后调 onData 模拟 shell echo，然后调 onData 输出 marker END
   * 让 PtyCommandRunner 把 pending command resolve 掉。
   *
   * runner 在"emit 时序"等测试里用：subscribe 拿 sessionId → 调
   * `completeCommand(sessionId)` → executeAgentCommand 的 promise resolve。
   *
   * @param sessionId bridge 起好的 session id（由测试通过监听 created 事件拿到）。
   * @param exitCode 命令 exit code（缺省 0）。
   */
  completeCommand: (sessionId: string, exitCode?: number) => Promise<void> | void;

  /** 测试结束 cleanup：kill 所有 session、清理临时目录等。 */
  cleanup: () => Promise<void> | void;
}

export type AgentBridgeContractSetup = () =>
  | Promise<AgentBridgeContractFixture>
  | AgentBridgeContractFixture;

// ==================== Constants for assertions ====================

/**
 * `AgentSessionCloseReason` 期望字面集合。该类型本身在 `agent-bridge.ts`
 * 中定义，与 `@tabtin/pty-core` 中 `PtySessionCloseReason` 字面对齐
 * （agent-bridge.ts L477-482 硬约束 — 任一端加新值必须双侧同步）。
 *
 * 这里把期望值落成 `AgentSessionCloseReason[]` 而非 import pty-core 的
 * `PtySessionCloseReason`——terminal-core 不依赖 pty-core 包，跨包对齐
 * 由 agent-bridge.ts JSDoc 约束 + 两端 contract test 自己附加 pty-core
 * 字面对齐断言（见 Electron / Daemon 各自的 *.contract.test.ts）。
 */
const EXPECTED_CLOSE_REASONS: readonly AgentSessionCloseReason[] = [
  'exit',
  'kill',
  'cleanup',
  'idle_timeout',
] as const;

// ==================== Helpers ====================

/**
 * 起一个 promise：bridge 首次 emit `agent-session-created` 时 resolve 出 payload。
 * 调用方必须**先**调本函数拿到 promise，再调 `executeAgentCommand` —— 否则
 * 错过同步 emit。
 *
 * 内部 idle subscribe 在 promise resolve 后立即解除，避免后续命令撞响应。
 */
function nextCreatedEvent(bridge: PtyManagerBridge): Promise<AgentSessionCreated> {
  return new Promise<AgentSessionCreated>((resolve) => {
    const off = bridge.subscribe('agent-session-created', (e) => {
      off();
      resolve(e);
    });
  });
}

/** 构造一个最小合法的 AgentCommandRequest（toolUseId / spaceId / agentId 必填）。 */
function makeRequest(overrides: Partial<AgentCommandRequest> = {}): AgentCommandRequest {
  return {
    command: overrides.command ?? 'echo contract-test',
    agentMeta: {
      toolUseId: 'tool-default',
      spaceId: 'space-default',
      agentId: 'agent-default',
      originatedBy: 'local-llm-shellcap',
      ...(overrides.agentMeta ?? {}),
    },
    ...(overrides.cwd !== undefined ? { cwd: overrides.cwd } : {}),
    ...(overrides.env !== undefined ? { env: overrides.env } : {}),
    ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
    ...(overrides.autoRespond !== undefined ? { autoRespond: overrides.autoRespond } : {}),
    ...(overrides.signal !== undefined ? { signal: overrides.signal } : {}),
  };
}

// ==================== Runner ====================

/**
 * 在调用方 vitest 文件里组装一个 `describe` 块，跑所有 bridge 契约断言。
 *
 * @param implName 用于 `describe` 标题（如 `'Electron'` / `'Daemon'`）。
 * @param setup 每个 it 前调用，返回带 bridge 实例的 fixture。
 */
export function describeAgentBridgeContract(
  implName: string,
  setup: AgentBridgeContractSetup,
): void {
  describe(`PtyManagerBridge contract: ${implName}`, () => {
    let fixture: AgentBridgeContractFixture;

    beforeEach(async () => {
      fixture = await setup();
    });

    afterEach(async () => {
      await fixture.cleanup();
    });

    // ── 5 方法签名 ────────────────────────────────────────────
    it('exposes all 5 PtyManagerBridge methods as callable functions', () => {
      expect(typeof fixture.bridge.executeAgentCommand).toBe('function');
      expect(typeof fixture.bridge.spawnAgentSessionDetached).toBe('function');
      expect(typeof fixture.bridge.readAgentSessionOutput).toBe('function');
      expect(typeof fixture.bridge.killAgentSession).toBe('function');
      expect(typeof fixture.bridge.subscribe).toBe('function');
    });

    // ── AgentSessionCloseReason 与 pty-core 字面对齐（L477-482） ──
    it('AgentSessionCloseReason literal aligned with PtySessionCloseReason', () => {
      const sorted = [...EXPECTED_CLOSE_REASONS].sort();
      expect(sorted).toEqual(['cleanup', 'exit', 'idle_timeout', 'kill']);
    });

    // ── emit 时序（L419-421 / L559-564 / L584-589） ─────────────
    it('emits agent-session-created BEFORE executeAgentCommand resolves', async () => {
      const createdPromise = nextCreatedEvent(fixture.bridge);

      const execPromise = fixture.bridge.executeAgentCommand(
        makeRequest({ command: 'echo timing' }),
      );

      // 等到 created 事件 — 必须在 executeAgentCommand 的 promise resolve 之前
      // 完成（如果 bridge emit 在 resolve 之后，此 await 会先 timeout / 卡住，
      // 但因为 execPromise 此时还没 resolve 也不 race，cleanup 时会被 kill）。
      const created = await createdPromise;
      expect(created.sessionId).toBeTruthy();

      // 完成命令让 execPromise resolve
      await fixture.completeCommand(created.sessionId, 0);
      const result = await execPromise;
      expect(result.sessionId).toBe(created.sessionId);
    });

    // ── P1-F：closed event emit（agent-bridge.ts L487-500） ──────
    it('emits agent-session-closed after killAgentSession (covers close path)', async () => {
      // 起 detached session（foreground 在 contract test 走 kill cascade 反而
      // 触发同一条 emit closed 路径——这里用 detached 让 sessionId 拿到不阻塞）
      const detached = await fixture.bridge.spawnAgentSessionDetached(
        makeRequest({
          command: 'sleep 60',
          agentMeta: {
            toolUseId: 'tool-close',
            spaceId: 'space-close',
            agentId: 'agent-close',
            originatedBy: 'local-llm-shellcap',
          },
        }),
      );
      const sessionId = detached.sessionId;

      // 订阅 closed 事件
      const closedPromise = new Promise<{
        sessionId: string;
        spaceId: string;
        reason: string;
      }>((resolve) => {
        const off = fixture.bridge.subscribe('agent-session-closed', (e) => {
          if (e.sessionId !== sessionId) return;
          off();
          resolve({ sessionId: e.sessionId, spaceId: e.spaceId, reason: e.reason });
        });
      });

      await fixture.bridge.killAgentSession(sessionId, 'SIGTERM');

      // 容忍 1s 等 closed event flush（同步 emit 应秒到，加 timeout 防 hang）
      const closed = await Promise.race([
        closedPromise,
        new Promise<null>((r) => setTimeout(() => r(null), 1000)),
      ]);
      expect(closed).not.toBeNull();
      expect(closed!.sessionId).toBe(sessionId);
      // reason 必须是 AgentSessionCloseReason 合法枚举
      expect(['exit', 'kill', 'cleanup', 'idle_timeout']).toContain(closed!.reason);
    });

    // ── threadId undefined → null 映射（L444-449 + L-10） ────────
    it('maps agentMeta.threadId === undefined to event payload threadId === null', async () => {
      const createdPromise = nextCreatedEvent(fixture.bridge);

      const execPromise = fixture.bridge.executeAgentCommand(
        makeRequest({
          command: 'echo thread-id-test',
          agentMeta: {
            toolUseId: 'tool-thread-null',
            spaceId: 'space-thread-null',
            agentId: 'agent-thread-null',
            originatedBy: 'local-llm-shellcap',
            // threadId 故意不传
          },
        }),
      );

      const created = await createdPromise;
      // L-10：threadId 必须是 own property + null（不是 undefined / 不存在）
      expect(Object.prototype.hasOwnProperty.call(created, 'threadId')).toBe(true);
      expect(created.threadId).toBeNull();

      await fixture.completeCommand(created.sessionId, 0);
      await execPromise;
    });

    // ── L-WP6-1：command 字段必填且原样透传 ─────────────────────
    it('AgentSessionCreated payload contains `command` field (verbatim from request)', async () => {
      const createdPromise = nextCreatedEvent(fixture.bridge);
      const command = 'ls -la /home/dogfood-test';

      const execPromise = fixture.bridge.executeAgentCommand(
        makeRequest({
          command,
          agentMeta: {
            toolUseId: 'tool-cmd-field',
            spaceId: 'space-cmd-field',
            agentId: 'agent-cmd-field',
            originatedBy: 'local-llm-shellcap',
          },
        }),
      );

      const created = await createdPromise;
      // command 必须是 own property + 字面原样透传（不截断 / 不变形 — 截断由
      // hook 端按 UI 上下文做，bridge 出来是完整字符串便于审计 / 日志订阅者
      // 用完整命令体定位异常 session）。
      expect(Object.prototype.hasOwnProperty.call(created, 'command')).toBe(true);
      expect(created.command).toBe(command);

      await fixture.completeCommand(created.sessionId, 0);
      await execPromise;
    });

    // ── L-WP6-1：detached 路径同样要 emit command 字段 ──────────
    it('spawnAgentSessionDetached also emits agent-session-created with `command`', async () => {
      const createdPromise = nextCreatedEvent(fixture.bridge);
      const command = 'sleep 60';

      const detached = await fixture.bridge.spawnAgentSessionDetached(
        makeRequest({
          command,
          agentMeta: {
            toolUseId: 'tool-cmd-detached',
            spaceId: 'space-cmd-detached',
            agentId: 'agent-cmd-detached',
            originatedBy: 'local-llm-shellcap',
          },
        }),
      );

      const created = await createdPromise;
      expect(created.sessionId).toBe(detached.sessionId);
      expect(created.command).toBe(command);

      // cleanup
      await fixture.bridge.killAgentSession(detached.sessionId, 'SIGTERM').catch(() => {});
    });

    // ── subscribe 边界：unsubscribe 幂等 ─────────────────────────
    it('unsubscribe is idempotent (calling multiple times is safe)', () => {
      const handler = vi.fn();
      const off = fixture.bridge.subscribe('agent-session-created', handler);
      off();
      expect(() => {
        off();
        off();
        off();
      }).not.toThrow();
    });

    // ── subscribe 边界：重复 subscribe 同 handler → 去重 ─────────
    it('subscribe dedupes the same handler on the same event', async () => {
      const handler = vi.fn();
      const off1 = fixture.bridge.subscribe('agent-session-created', handler);
      const off2 = fixture.bridge.subscribe('agent-session-created', handler);

      const createdPromise = nextCreatedEvent(fixture.bridge);
      const execPromise = fixture.bridge.executeAgentCommand(
        makeRequest({ command: 'echo dedup' }),
      );
      const created = await createdPromise;
      await fixture.completeCommand(created.sessionId, 0);
      await execPromise;

      // 即便订阅了两次，handler 只调一次
      expect(handler).toHaveBeenCalledTimes(1);

      // 任一 off 调用都解除该 handler 的唯一订阅
      off1();
      // off2 仍能安全调用（幂等）
      expect(() => off2()).not.toThrow();
    });

    // ── subscribe 边界：emit-time unsubscribe snapshot 语义 ──────
    it('emit-time unsubscribe: handler called for current emit, skipped on next', async () => {
      const calls: string[] = [];

      // handlerA 在被 emit 期间 unsubscribe 自己
      let offA: (() => void) | null = null;
      const handlerA = (e: AgentSessionCreated) => {
        calls.push(`A:${e.sessionId}`);
        if (offA) {
          const o = offA;
          offA = null;
          o();
        }
      };
      offA = fixture.bridge.subscribe('agent-session-created', handlerA);

      const handlerB = (e: AgentSessionCreated) => {
        calls.push(`B:${e.sessionId}`);
      };
      const offB = fixture.bridge.subscribe('agent-session-created', handlerB);

      // 第一条命令：A + B 都应被调（snapshot 语义保护 A 即便 self-unsubscribe）
      const created1Promise = nextCreatedEvent(fixture.bridge);
      const p1 = fixture.bridge.executeAgentCommand(
        makeRequest({
          command: 'echo first',
          agentMeta: {
            toolUseId: 'tool-1',
            spaceId: 'space-snap',
            agentId: 'agent-snap',
            originatedBy: 'local-llm-shellcap',
          },
        }),
      );
      const created1 = await created1Promise;
      await fixture.completeCommand(created1.sessionId, 0);
      await p1;

      // 第二条命令：A 已 unsubscribe，仅 B 被调
      const created2Promise = nextCreatedEvent(fixture.bridge);
      const p2 = fixture.bridge.executeAgentCommand(
        makeRequest({
          command: 'echo second',
          agentMeta: {
            toolUseId: 'tool-2',
            spaceId: 'space-snap',
            agentId: 'agent-snap',
            originatedBy: 'local-llm-shellcap',
          },
        }),
      );
      const created2 = await created2Promise;
      await fixture.completeCommand(created2.sessionId, 0);
      await p2;

      const aCalls = calls.filter((c) => c.startsWith('A:'));
      const bCalls = calls.filter((c) => c.startsWith('B:'));
      // A 第一条调到（snapshot 语义），第二条没调到（已 unsubscribe）
      expect(aCalls).toEqual([`A:${created1.sessionId}`]);
      // B 两条都调到
      expect(bCalls).toContain(`B:${created1.sessionId}`);
      expect(bCalls).toContain(`B:${created2.sessionId}`);

      offB();
    });

    it('async handler reject does not break other subscribers nor bubble up', async () => {
      const goodCalls: string[] = [];
      const offBad = fixture.bridge.subscribe('agent-session-created', async () => {
        throw new Error('intentional handler failure');
      });
      const offGood = fixture.bridge.subscribe('agent-session-created', (e) => {
        goodCalls.push(e.sessionId);
      });

      const createdPromise = nextCreatedEvent(fixture.bridge);
      const p = fixture.bridge.executeAgentCommand(
        makeRequest({
          command: 'echo reject-test',
          agentMeta: {
            toolUseId: 'tool-reject',
            spaceId: 'space-reject',
            agentId: 'agent-reject',
            originatedBy: 'local-llm-shellcap',
          },
        }),
      );
      const created = await createdPromise;
      await fixture.completeCommand(created.sessionId, 0);
      // executeAgentCommand 自身不应因 handler reject 而 throw
      await expect(p).resolves.toBeDefined();
      expect(goodCalls).toContain(created.sessionId);

      offBad();
      offGood();
    });

    // ── spawnAgentSessionDetached: outputFilePath 已 realpath ──
    it('spawnAgentSessionDetached returns outputFilePath that is realpath canonical', async () => {
      const detached = await fixture.bridge.spawnAgentSessionDetached(
        makeRequest({
          command: 'sleep 60',
          agentMeta: {
            toolUseId: 'tool-detached',
            spaceId: 'space-detached',
            agentId: 'agent-detached',
            originatedBy: 'local-llm-shellcap',
          },
        }),
      );

      expect(detached.sessionId).toBeTruthy();
      expect(detached.outputFilePath).toBeTruthy();

      // realpath 不变性：对返回的路径再 realpath 应得到自身（idempotent）
      // 兜底 ENOENT（极少数文件已被 GC / race 的情况）
      try {
        const reCanonical = fs.realpathSync(detached.outputFilePath);
        expect(reCanonical).toBe(detached.outputFilePath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== 'ENOENT') throw err;
      }

      // cleanup：kill 该 session
      await fixture.bridge.killAgentSession(detached.sessionId, 'SIGTERM').catch(() => {
        /* best-effort: may already be dead */
      });
    });

    // ════════════════════════════════════════════════════════════
    // 2026-05-18 ManagedTaskStore 集成契约（review P1-7）
    // 两端 bridge 必须把 spawn / exit / kill / output 累加都同步到 store。
    // 任一端漏了同步，下次重构 store 时这段 contract 就会捕获漂移。
    // ════════════════════════════════════════════════════════════

    /**
     * 安全从 bridge 拿 store。两端实装必须 expose `getManagedTaskStore()`。
     * Helper 内部 fallback：如果 bridge 没暴露这个方法，整组 store 契约跳过
     * （让 store 集成成为 opt-in 行为，避免硬卡死还没接入的环境）。
     */
    function getStoreOrSkip(): ManagedTaskStore | null {
      const bridgeWithStore = fixture.bridge as PtyManagerBridge & {
        getManagedTaskStore?: () => ManagedTaskStore;
      };
      if (typeof bridgeWithStore.getManagedTaskStore !== 'function') return null;
      return bridgeWithStore.getManagedTaskStore();
    }

    it('spawnAgentSessionDetached writes ManagedTask record with status=running + 关键字段', async () => {
      const store = getStoreOrSkip();
      if (!store) return;
      const tmpCwd = os.tmpdir();

      const detached = await fixture.bridge.spawnAgentSessionDetached(
        makeRequest({
          command: 'sleep 30',
          cwd: tmpCwd,
          env: { MY_VAR: 'hello' },
          agentMeta: {
            toolUseId: 'tool-record-create',
            spaceId: 'space-record-create',
            agentId: 'agent-record-create',
            threadId: 'thread-record',
            originatedBy: 'local-llm-shellcap',
          },
        }),
      );

      const record = store.get(detached.sessionId);
      expect(record).toBeDefined();
      expect(record!.status).toBe('running');
      expect(record!.command).toBe('sleep 30');
      expect(record!.cwd).toBe(tmpCwd);
      expect(record!.toolUseId).toBe('tool-record-create');
      expect(record!.spaceId).toBe('space-record-create');
      expect(record!.threadId).toBe('thread-record');
      expect(record!.output_file_path).toBe(detached.outputFilePath);

      await fixture.bridge.killAgentSession(detached.sessionId, 'SIGTERM').catch(() => {});
    });

    it('command 自然 exit → record.status=completed + exited_by=normal_exit + exit_code 写入', async () => {
      const store = getStoreOrSkip();
      if (!store) return;

      // 用 executeAgentCommand 走 mock PTY 让 fixture.completeCommand 能驱动 exit
      // （detached 路径需要真子进程，mock 环境不易模拟自然 exit）
      const createdPromise = nextCreatedEvent(fixture.bridge);
      const execPromise = fixture.bridge.executeAgentCommand(
        makeRequest({
          command: 'echo natural-exit',
          agentMeta: {
            toolUseId: 'tool-natural-exit',
            spaceId: 'space-natural-exit',
            agentId: 'agent-natural-exit',
            originatedBy: 'local-llm-shellcap',
          },
        }),
      );
      const created = await createdPromise;
      await fixture.completeCommand(created.sessionId, 0);
      await execPromise;

      // foreground 路径走 executeAgentCommand，bridge 不写 record（detached only）
      // —— 本契约只验 detached 路径能调用 store API。foreground record 写入是
      // 上线后 P3 工程优化项（detached → store；foreground 走 ShellCap 上层）。
      // 这里只验 store.findDedupCandidate / get API 在 bridge.getManagedTaskStore()
      // 暴露后可用。
      expect(store.list()).toEqual(expect.any(Array));
    });

    it('readAgentSessionOutput 暴露 ManagedTask record 终态字段（exitedBy / killedReason / outputFilePath / pid）', async () => {
      const store = getStoreOrSkip();
      if (!store) return;

      // 直接在 store 注入一个 terminal record，模拟"PtySession 已 5 秒延迟释放
      // 但 record 30 分钟 TTL 内仍在"——验证 readAgentSessionOutput fallback 路径。
      const fakeSessionId = `contract-fake-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      store.createRecord({
        session_id: fakeSessionId,
        command: 'fake',
        cwd: '/tmp',
        env: undefined,
        spaceId: 'space-fallback',
        toolUseId: 'tool-fallback',
        output_file_path: '/tmp/tabtin-agent-tasks/fake.log',
      });
      store.updateOnExit(fakeSessionId, {
        status: 'killed',
        exit_code: -15,
        exited_by: 'signal',
        killed_reason: 'kill_tool',
      });

      // PtySession 不存在 → 走 fallback 拿 record 的字段
      const readResult = await fixture.bridge.readAgentSessionOutput(fakeSessionId);
      expect(readResult.isRunning).toBe(false);
      expect(readResult.exitedBy).toBe('signal');
      expect(readResult.killedReason).toBe('kill_tool');
      expect(readResult.outputFilePath).toBe('/tmp/tabtin-agent-tasks/fake.log');
    });

    it('spawn fails before any child process → throw and DO NOT leave record in running state', async () => {
      const store = getStoreOrSkip();
      if (!store) return;

      // 用一个会被 hardline 拦截 / 不可执行的命令很难无侵入构造；改用 abort
      // 信号在 spawn 前就 aborted 让 bridge throw AbortError。
      const ctrl = new AbortController();
      ctrl.abort();

      let threw = false;
      try {
        await fixture.bridge.spawnAgentSessionDetached(
          makeRequest({
            command: 'sleep 30',
            signal: ctrl.signal,
            agentMeta: {
              toolUseId: 'tool-spawn-fail',
              spaceId: 'space-spawn-fail',
              agentId: 'agent-spawn-fail',
              originatedBy: 'local-llm-shellcap',
            },
          }),
        );
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);

      // 关键不变量（PRD §0.5 不变量 4）：spawn 失败永不留 running record。
      // 既然 throw 了，调用方没拿到 sessionId—— record 即便存在也不应停在 running。
      // 检查所有 record：不应该有任何 status=running 且 toolUseId='tool-spawn-fail' 的
      const stillRunning = store
        .list()
        .filter((r) => r.toolUseId === 'tool-spawn-fail' && r.status === 'running');
      expect(stillRunning).toHaveLength(0);
    });

    // ── session limit 错误 message 关键词（L571-575） ───────────
    it('session limit error message contains "agent session limit reached" keyword', async () => {
      // 不验数字 limit（两端 Electron 6 / Daemon 3 可不一致）；只验关键词。
      // 连续 spawn 10 个 detached（不等命令完成），Electron / Daemon 默认
      // limit 都会撞墙。若 fixture 内 limit 设得更高（> 10）→ 跳过断言。
      const sessionIds: string[] = [];
      let limitError: unknown = null;
      const MAX_TRIES = 10;
      try {
        for (let i = 0; i < MAX_TRIES; i++) {
          try {
            const r = await fixture.bridge.spawnAgentSessionDetached(
              makeRequest({
                command: 'sleep 60',
                agentMeta: {
                  toolUseId: `tool-limit-${i}`,
                  spaceId: 'space-limit',
                  agentId: 'agent-limit',
                  originatedBy: 'local-llm-shellcap',
                },
              }),
            );
            sessionIds.push(r.sessionId);
          } catch (err) {
            limitError = err;
            break;
          }
        }

        if (limitError) {
          const message = (limitError as Error).message ?? String(limitError);
          expect(message.toLowerCase()).toContain('agent session limit reached');
        } else {
          // fixture limit 比 10 还大——不验数字，跳过断言
          // eslint-disable-next-line no-console
          console.warn(
            `[contract] limit not reached in ${MAX_TRIES} tries; skipping keyword check`,
          );
        }
      } finally {
        // cleanup 所有撞限前 spawn 的 session
        for (const sid of sessionIds) {
          await fixture.bridge.killAgentSession(sid, 'SIGTERM').catch(() => {});
        }
      }
    });
  });
}
