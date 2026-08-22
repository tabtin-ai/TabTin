/**
 * agent-bridge-contract.test.ts —— terminal-core 自身跑的 contract 桩测。
 *
 * **跑什么**：
 *   1. `unimplementedPtyManagerBridge` 桩验**签名层**：5 个方法都存在 +
 *      非 subscribe 调用 throw `not implemented`
 *   2. 一个**轻量参考 bridge mock**（不依赖 PtyManager）验 contract runner
 *      自身的可执行性 —— 让我们能在 terminal-core 单包内复测 runner，避免
 *      runner 实际有 bug 但 Electron / Daemon 报错才发现
 *
 * **不跑什么**（两端实现各自跑）：
 *   - 真实 bridge × 真实 transcript/session manager 的端到端契约测试
 *   - 数字 limit（两端字面不同）
 *
 * 入口文件路径：与 vitest.config.ts 的 `include: ['tests/**\u002fmd*.test.ts']` 匹配，
 * 不在 `src/__tests__/`（vitest 不发现 src 下 .test.ts；用户清单 25 项写的
 * 路径是 contract runner 文件，本测试文件路径按 vitest config 实际约束摆放）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentOutputTail,
  runAgentOutputTailGC,
  tabtinAgentTaskLogPath,
  tabtinAgentTasksDir,
  unimplementedPtyManagerBridge,
  type AgentCommandRequest,
  type AgentCommandResult,
  type AgentKillSignal,
  type AgentReadOptions,
  type AgentReadResult,
  type AgentSessionCreated,
  type AgentSessionEventHandler,
  type AgentSessionEventName,
  type AgentSessionUnsubscribe,
  type AgentSpawnDetachedResult,
  type PtyManagerBridge,
} from '../src';
import { describeAgentBridgeContract } from '../src/agent-bridge-contract';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ==================== Unimplemented stub: signature layer ====================

describe('unimplementedPtyManagerBridge stub', () => {
  it('exposes all 5 methods as functions', () => {
    expect(typeof unimplementedPtyManagerBridge.executeAgentCommand).toBe('function');
    expect(typeof unimplementedPtyManagerBridge.spawnAgentSessionDetached).toBe('function');
    expect(typeof unimplementedPtyManagerBridge.readAgentSessionOutput).toBe('function');
    expect(typeof unimplementedPtyManagerBridge.killAgentSession).toBe('function');
    expect(typeof unimplementedPtyManagerBridge.subscribe).toBe('function');
  });

  it('executeAgentCommand throws "not implemented"', async () => {
    await expect(
      unimplementedPtyManagerBridge.executeAgentCommand({
        command: 'echo',
        agentMeta: {
          toolUseId: 't',
          spaceId: 's',
          agentId: 'a',
          originatedBy: 'local-llm-shellcap',
        },
      }),
    ).rejects.toThrow(/not implemented/i);
  });

  it('spawnAgentSessionDetached throws "not implemented"', async () => {
    await expect(
      unimplementedPtyManagerBridge.spawnAgentSessionDetached({
        command: 'echo',
        agentMeta: {
          toolUseId: 't',
          spaceId: 's',
          agentId: 'a',
          originatedBy: 'local-llm-shellcap',
        },
      }),
    ).rejects.toThrow(/not implemented/i);
  });

  it('readAgentSessionOutput throws "not implemented"', async () => {
    await expect(unimplementedPtyManagerBridge.readAgentSessionOutput('sid')).rejects.toThrow(
      /not implemented/i,
    );
  });

  it('killAgentSession throws "not implemented"', async () => {
    await expect(unimplementedPtyManagerBridge.killAgentSession('sid')).rejects.toThrow(
      /not implemented/i,
    );
  });

  it('subscribe returns a no-op unsubscribe (does NOT throw)', () => {
    // L705-707：subscribe 桩故意 no-op 不 throw（让契约测试能先注册再调用 throw）。
    const off = unimplementedPtyManagerBridge.subscribe('agent-session-created', () => {});
    expect(typeof off).toBe('function');
    expect(() => {
      off();
      off();
    }).not.toThrow();
  });
});

// ==================== Reference mock bridge ====================
//
// 一个**轻量参考实现** —— 不依赖任何 PtyManager / PTY 真实进程，模拟 bridge
// 的所有契约行为（emit 时序 / threadId null 映射 / subscribe 边界 / limit
// 错误关键词 / outputFilePath realpath）。
//
// **存在意义**：
//   - terminal-core 单包内能跑全套 `describeAgentBridgeContract` runner，
//     不必拉两端 app 依赖；运行 runner 自身 + 验证 runner 正确性
//   - 给两端 bridge 实现一个"参考行为"，避免行为漂移时只是"两端都错但都一致"
//
// **明示不是 MVP**：本 mock 不进生产路径（仅测试用），D7 不留兼容代码原则下
// 这是 contract test 的合理产物——参考 vitest mock / sinon stub 同模式。

interface MockSessionState {
  spaceId: string;
  isRunning: boolean;
  tail: AgentOutputTail | null;
}

class ReferenceMockBridge implements PtyManagerBridge {
  private readonly subscribers: {
    [K in AgentSessionEventName]: Array<AgentSessionEventHandler<K>>;
  } = {
    'agent-session-created': [],
    'agent-session-closed': [],
  };
  private readonly sessions = new Map<string, MockSessionState>();
  private readonly pending = new Map<string, () => void>();
  /** mock 用：测试通过它驱动"命令完成"。 */
  readonly debugComplete = (sessionId: string): void => {
    const resolve = this.pending.get(sessionId);
    if (resolve) {
      this.pending.delete(sessionId);
      resolve();
    }
  };

  private readonly maxPerSpace: number;
  private readonly tmpdirOverride: string;

  constructor(opts: { maxPerSpace?: number; tmpdir: string }) {
    this.maxPerSpace = opts.maxPerSpace ?? 3;
    this.tmpdirOverride = opts.tmpdir;
  }

  async dispose(): Promise<void> {
    for (const sid of [...this.sessions.keys()]) {
      const s = this.sessions.get(sid);
      await s?.tail?.close().catch(() => {});
    }
    this.sessions.clear();
    this.pending.clear();
  }

  async executeAgentCommand(req: AgentCommandRequest): Promise<AgentCommandResult> {
    const sessionId = this.spawnMockSession(req, 'foreground');
    await new Promise<void>((resolve) => {
      this.pending.set(sessionId, resolve);
    });
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`mock: session ${sessionId} vanished`);
    session.isRunning = false;
    return {
      status: 'ok',
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 0,
      truncated: false,
      outputBytes: 0,
      cwd: '/mock',
      sessionId,
    };
  }

  async spawnAgentSessionDetached(req: AgentCommandRequest): Promise<AgentSpawnDetachedResult> {
    const sessionId = this.spawnMockSession(req, 'detached');
    const session = this.sessions.get(sessionId)!;
    return {
      sessionId,
      outputFilePath: session.tail?.getFilePath() ?? '',
    };
  }

  async readAgentSessionOutput(
    sessionId: string,
    _opts?: AgentReadOptions,
  ): Promise<AgentReadResult> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`agent session not found: ${sessionId}`);
    return {
      output: '',
      outputBytes: 0,
      isRunning: s.isRunning,
      exitCode: s.isRunning ? null : 0,
      cwd: '/mock',
      lastOutputAt: Date.now(),
      truncated: false,
    };
  }

  async killAgentSession(sessionId: string, _signal?: AgentKillSignal): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) {
      throw new Error(`agent session not found: ${sessionId}`);
    }
    const spaceId = s.spaceId;
    s.isRunning = false;
    await s.tail?.close().catch(() => {});
    this.sessions.delete(sessionId);
    // 也 resolve 任何 pending（防止 executeAgentCommand 卡住）
    this.debugComplete(sessionId);
    // emit closed event 让 contract test 'P1-F closed event' 用例能跑通
    const handlers = Array.from(this.subscribers['agent-session-closed']);
    for (const h of handlers) {
      try {
        h({ sessionId, spaceId, reason: 'kill' });
      } catch {
        /* swallow */
      }
    }
  }

  subscribe<E extends AgentSessionEventName>(
    event: E,
    handler: AgentSessionEventHandler<E>,
  ): AgentSessionUnsubscribe {
    const list = this.subscribers[event];
    if (!list.includes(handler as never)) {
      list.push(handler as never);
    }
    let off = false;
    return () => {
      if (off) return;
      off = true;
      const idx = list.indexOf(handler as never);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  private spawnMockSession(req: AgentCommandRequest, mode: 'foreground' | 'detached'): string {
    const spaceId = req.agentMeta.spaceId;
    let runningCount = 0;
    for (const s of this.sessions.values()) {
      if (s.spaceId === spaceId && s.isRunning) runningCount++;
    }
    if (runningCount >= this.maxPerSpace) {
      throw new Error(
        `agent session limit reached for space ${spaceId}: ${runningCount}/${this.maxPerSpace}`,
      );
    }
    const sessionId = `agent-${spaceId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    let tail: AgentOutputTail | null = null;
    if (mode === 'detached') {
      tail = AgentOutputTail.create(sessionId, { tmpdir: this.tmpdirOverride });
    }
    this.sessions.set(sessionId, { spaceId, isRunning: true, tail });

    const event: AgentSessionCreated = {
      sessionId,
      spaceId,
      threadId: req.agentMeta.threadId ?? null,
      agentId: req.agentMeta.agentId,
      toolUseId: req.agentMeta.toolUseId,
      cwd: '/mock',
      command: req.command,
      source: 'agent',
      ...(req.agentMeta.description !== undefined ? { description: req.agentMeta.description } : {}),
    };

    const handlers = Array.from(this.subscribers['agent-session-created']);
    for (const h of handlers) {
      try {
        const ret = h(event);
        if (ret && typeof (ret as Promise<unknown>).catch === 'function') {
          (ret as Promise<unknown>).catch(() => {});
        }
      } catch {
        /* swallow */
      }
    }
    return sessionId;
  }
}

// ==================== Reference contract run ====================

describeAgentBridgeContract('ReferenceMockBridge (terminal-core internal)', async () => {
  // 隔离 tmpdir 避免与其他测试 race + 让 fixture cleanup 能彻底删
  const isoTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-contract-'));
  const bridge = new ReferenceMockBridge({ maxPerSpace: 3, tmpdir: isoTmp });
  return {
    bridge,
    completeCommand: (sessionId: string) => {
      bridge.debugComplete(sessionId);
    },
    cleanup: async () => {
      await bridge.dispose();
      // 清理隔离 tmpdir + 内部 tabtin-agent-tasks/
      try {
        fs.rmSync(isoTmp, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
});

// ==================== agent-output-tail.ts directly ====================

describe('AgentOutputTail + GC', () => {
  let isoTmp: string;

  beforeEach(() => {
    isoTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-output-tail-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(isoTmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('create + write + close roundtrip — file persists after close', async () => {
    const tail = AgentOutputTail.create('test-session-A', { tmpdir: isoTmp });
    const filePath = tail.getFilePath();
    expect(filePath).toContain('test-session-A.log');
    tail.write('hello\n');
    tail.write('world\n');
    await tail.close();
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toBe('hello\nworld\n');
  });

  it('getFilePath returns realpath (idempotent fs.realpathSync)', () => {
    const tail = AgentOutputTail.create('test-session-B', { tmpdir: isoTmp });
    const filePath = tail.getFilePath();
    const re = fs.realpathSync(filePath);
    expect(re).toBe(filePath);
    void tail.close();
  });

  it('tabtinAgentTaskLogPath returns the same path layout as create()', () => {
    const logical = tabtinAgentTaskLogPath('test-session-C', isoTmp);
    const tail = AgentOutputTail.create('test-session-C', { tmpdir: isoTmp });
    // tail.getFilePath() 是 realpath 后；logical 是字面拼接——两者通过 realpath
    // 后字面应一致（同款 macOS /var → /private/var 等已展平）
    expect(fs.realpathSync(logical)).toBe(tail.getFilePath());
    void tail.close();
  });

  it('runAgentOutputTailGC: deletes files older than maxAgeMs', async () => {
    const dir = tabtinAgentTasksDir(isoTmp);
    fs.mkdirSync(dir, { recursive: true });
    const oldFile = path.join(dir, 'old.log');
    fs.writeFileSync(oldFile, 'expired');
    // 模拟老化：把 mtime 设到 8 天前
    const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(oldFile, eightDaysAgo, eightDaysAgo);

    const result = await runAgentOutputTailGC({ tmpdir: isoTmp });
    expect(result.deletedExpired).toContain(oldFile);
    expect(fs.existsSync(oldFile)).toBe(false);
  });

  it('runAgentOutputTailGC: truncates files exceeding maxFileBytes (keeps tail)', async () => {
    const dir = tabtinAgentTasksDir(isoTmp);
    fs.mkdirSync(dir, { recursive: true });
    const bigFile = path.join(dir, 'big.log');
    // 写 200 个 'A' + 100 个 'B' → 截断到 keepBytes=100 应保留尾部 'B'×100
    fs.writeFileSync(bigFile, 'A'.repeat(200) + 'B'.repeat(100));

    const result = await runAgentOutputTailGC({
      tmpdir: isoTmp,
      maxFileBytes: 200,
      keepBytes: 100,
    });
    expect(result.truncatedOversize).toContain(bigFile);
    const after = fs.readFileSync(bigFile, 'utf-8');
    expect(after).toBe('B'.repeat(100));
  });

  it('runAgentOutputTailGC: skipped:true when dir does not exist', async () => {
    const ghostTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-output-ghost-'));
    fs.rmSync(ghostTmp, { recursive: true, force: true });
    const result = await runAgentOutputTailGC({ tmpdir: ghostTmp });
    expect(result.skipped).toBe(true);
    expect(result.deletedExpired).toEqual([]);
    expect(result.truncatedOversize).toEqual([]);
  });
});
