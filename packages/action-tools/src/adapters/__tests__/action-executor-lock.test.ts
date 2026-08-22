/**
 * ActionExecutorAdapter 加锁单测（PRD「文件并发安全 Wave 1.5」— 2026-05-13）
 *
 * 覆盖范围（PRD §四.5 W15 测试矩阵）：
 *   - W15-2：ActionExecutorAdapter 路径同文件 N 次并发 → FIFO 串行
 *   - W15-4：不同文件 / 不同 action 并发 → 不互相阻塞
 *   - W15-5：非 FILE_LOCK_ACTIONS（如 read_file）→ 不包锁，立即执行
 *   - 路径字段空 / 不存在时不锁（防御性，不应抛错）
 *   - 跟 agent-runtime 一侧 withFileLock 用同一文件时**串行**（核心 H 不变量）
 *
 * 实现细节：
 *   - 用真实 ActionExecutorAdapter + 内置 AgentTool stub 注册到 adapter
 *   - 不调真实 fileEditTool / fileWriteTool（那是 action-tools tabcode 域的事），
 *     只验「ActionExecutorAdapter 路径有没有进锁 / 锁键归一是否正确」
 *   - 跨入口测试用 withFileLock 直接调（adapter import 路径）模拟另一个入口
 */

import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ActionExecutorAdapter, type FrontendAction } from '../ActionExecutorAdapter';
import {
  __resetFileLockMapForTest,
  getFileLockMapSize,
  withFileLock,
} from '../../utils/file-lock';
import type { AgentTool } from '../../types';

let tmpDir: string;
let adapter: ActionExecutorAdapter;
let executions: Array<{ tool: string; t: number; phase: 'start' | 'end' }>;

/**
 * 构造一个能记录 start/end 时间戳的 stub AgentTool，让测试断言串行 / 并发顺序。
 *
 * `sleepMs` 让 fn 在临界区里 await 一次模拟真实异步 IO，否则同步函数永远抢不到并发。
 */
function makeStubTool(name: string, sleepMs = 20): AgentTool {
  return {
    name,
    description: `stub tool for ${name}`,
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(input: any) {
      executions.push({ tool: name, t: Date.now(), phase: 'start' });
      await new Promise((r) => setTimeout(r, sleepMs));
      executions.push({ tool: name, t: Date.now(), phase: 'end' });
      return { success: true, data: { tool: name, params: input } };
    },
  };
}

function makeAction(type: string, params: Record<string, unknown> = {}): FrontendAction {
  return {
    task_id: `t-${type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type,
    params,
    thread_id: 'test-thread',
  };
}

beforeEach(async () => {
  __resetFileLockMapForTest();
  const raw = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'aea-lock-test-'));
  tmpDir = await fsPromises.realpath(raw);
  adapter = new ActionExecutorAdapter();
  adapter.registerTools([
    makeStubTool('write_file'),
    makeStubTool('edit_file'),
    makeStubTool('delete_file'),
    makeStubTool('read_file'),
    makeStubTool('grep_search'),
  ]);
  executions = [];
});

afterEach(async () => {
  await fsPromises.rm(tmpDir, { recursive: true, force: true });
});

// ─── W15-2：FILE_LOCK_ACTIONS 经 adapter 同文件并发 → FIFO 串行 ─────

describe('action-executor-lock — FILE_LOCK_ACTIONS 单文件并发 → FIFO', () => {
  it('write_file 3 个并发同文件 → 串行（不交错）', async () => {
    const file = path.join(tmpDir, 'serial.txt');
    await fsPromises.writeFile(file, '');

    await Promise.all([
      adapter.executeAction(makeAction('write_file', { path: file, _workspace_root: tmpDir })),
      adapter.executeAction(makeAction('write_file', { path: file, _workspace_root: tmpDir })),
      adapter.executeAction(makeAction('write_file', { path: file, _workspace_root: tmpDir })),
    ]);

    // 串行：每个 start 必须紧跟前一个 end
    expect(executions).toHaveLength(6);
    for (let i = 1; i < 3; i++) {
      const prevEnd = executions[2 * i - 1];
      const currStart = executions[2 * i];
      expect(prevEnd.phase).toBe('end');
      expect(currStart.phase).toBe('start');
      expect(currStart.t).toBeGreaterThanOrEqual(prevEnd.t);
    }
    expect(getFileLockMapSize()).toBe(0);
  });

  it('write_file + edit_file 同文件并发 → 互相 FIFO 串行（同锁键）', async () => {
    const file = path.join(tmpDir, 'mixed.txt');
    await fsPromises.writeFile(file, '');

    await Promise.all([
      adapter.executeAction(makeAction('write_file', { path: file, _workspace_root: tmpDir })),
      adapter.executeAction(makeAction('edit_file', { path: file, _workspace_root: tmpDir })),
    ]);

    expect(executions).toHaveLength(4);
    // 第二个 tool 的 start 一定晚于第一个 tool 的 end
    expect(executions[2].t).toBeGreaterThanOrEqual(executions[1].t);
    expect(getFileLockMapSize()).toBe(0);
  });

  it('delete_file 也在 FILE_LOCK_ACTIONS 集合内（跨入口防御兜底）', async () => {
    const file = path.join(tmpDir, 'del.txt');
    await fsPromises.writeFile(file, '');

    // delete_file 跟 write_file 同文件并发 → 串行（验证 delete 也被锁覆盖）
    await Promise.all([
      adapter.executeAction(makeAction('write_file', { path: file, _workspace_root: tmpDir })),
      adapter.executeAction(makeAction('delete_file', { path: file, _workspace_root: tmpDir })),
    ]);

    expect(executions).toHaveLength(4);
    // 串行不交错
    expect(executions[0].phase).toBe('start');
    expect(executions[1].phase).toBe('end');
    expect(executions[2].phase).toBe('start');
    expect(executions[3].phase).toBe('end');
    expect(getFileLockMapSize()).toBe(0);
  });

  it('file_path 字段（旧 alias）也能识别锁键', async () => {
    const file = path.join(tmpDir, 'alias.txt');
    await fsPromises.writeFile(file, '');

    await Promise.all([
      adapter.executeAction(makeAction('write_file', { file_path: file, _workspace_root: tmpDir })),
      adapter.executeAction(makeAction('write_file', { file_path: file, _workspace_root: tmpDir })),
    ]);

    expect(executions).toHaveLength(4);
    expect(executions[0].phase).toBe('start');
    expect(executions[1].phase).toBe('end');
    expect(executions[2].phase).toBe('start');
    expect(executions[3].phase).toBe('end');
    expect(getFileLockMapSize()).toBe(0);
  });
});

// ─── W15-4：不同文件 / 非 FILE_LOCK_ACTIONS → 不阻塞 ─────────────────

describe('action-executor-lock — 非阻塞场景', () => {
  it('write_file 不同文件并发 → 并行执行（不阻塞）', async () => {
    const fileA = path.join(tmpDir, 'a.txt');
    const fileB = path.join(tmpDir, 'b.txt');
    await fsPromises.writeFile(fileA, '');
    await fsPromises.writeFile(fileB, '');

    const t0 = Date.now();
    await Promise.all([
      adapter.executeAction(makeAction('write_file', { path: fileA, _workspace_root: tmpDir })),
      adapter.executeAction(makeAction('write_file', { path: fileB, _workspace_root: tmpDir })),
    ]);
    const elapsed = Date.now() - t0;

    // 并行 ≈ 20ms；串行 ≥ 40ms。给 2x 容忍。
    expect(elapsed).toBeLessThan(40);
    expect(getFileLockMapSize()).toBe(0);
  });

  it('W15-5：非 FILE_LOCK_ACTIONS（read_file）不进锁，并行执行', async () => {
    const file = path.join(tmpDir, 'read.txt');
    await fsPromises.writeFile(file, '');

    const t0 = Date.now();
    await Promise.all([
      adapter.executeAction(makeAction('read_file', { path: file, _workspace_root: tmpDir })),
      adapter.executeAction(makeAction('read_file', { path: file, _workspace_root: tmpDir })),
      adapter.executeAction(makeAction('read_file', { path: file, _workspace_root: tmpDir })),
    ]);
    const elapsed = Date.now() - t0;

    // 3 个并行 ≈ 20ms；3 个串行 ≥ 60ms。给 2x 容忍。
    expect(elapsed).toBeLessThan(40);
    // read_file 不进锁，所以 lockMap 始终是 0
    expect(getFileLockMapSize()).toBe(0);
  });

  it('grep_search 同款不进锁（非 FILE_LOCK_ACTIONS）', async () => {
    const t0 = Date.now();
    await Promise.all([
      adapter.executeAction(makeAction('grep_search', { query: 'foo' })),
      adapter.executeAction(makeAction('grep_search', { query: 'bar' })),
    ]);
    expect(Date.now() - t0).toBeLessThan(40);
    expect(getFileLockMapSize()).toBe(0);
  });
});

// ─── 防御：path 缺失时不锁不抛错 ──────────────────────────────────

describe('action-executor-lock — path 缺失防御', () => {
  it('write_file 无 path / 无 file_path → 不锁，正常调 tool.execute', async () => {
    // tool.execute 自己会处理缺路径（返 INVALID_PARAMETER），但 adapter 不应该
    // 因为缺路径而提前撞锁层 throw
    const result = await adapter.executeAction(makeAction('write_file', {}));
    // stub 不校验路径，所以 success: true；真实 fileWriteTool 会返 INVALID_PARAMETER。
    // 关键是 adapter 不报错，能走到 tool.execute。
    expect(result.success).toBe(true);
    expect(getFileLockMapSize()).toBe(0);
  });

  it('write_file path 为空字符串 → 不锁', async () => {
    const result = await adapter.executeAction(makeAction('write_file', { path: '' }));
    expect(result.success).toBe(true);
    expect(getFileLockMapSize()).toBe(0);
  });

  it('write_file path 非字符串 → 不锁', async () => {
    const result = await adapter.executeAction(makeAction('write_file', { path: 123 as any }));
    expect(result.success).toBe(true);
    expect(getFileLockMapSize()).toBe(0);
  });
});

// ─── W15-3 核心 H 不变量：跨入口锁串行 ─────────────────────────────

describe('action-executor-lock — 跨入口锁串行（核心 H 不变量）', () => {
  it('agent-runtime adapter 路径持锁 + ActionExecutorAdapter 路径同文件 → 串行', async () => {
    // 模拟「LLM Agent 经 agent-runtime adapter 持锁」：直接 withFileLock 调
    // （agent-runtime adapter 内部就是 withFileLock(resolvedPath, runCritical)）。
    // 同时 ActionExecutorAdapter 经 executeAction 进入同一文件 ——
    // 应该 FIFO 串行，证明 lockMap 跨入口共享。
    //
    // **Round 1 review M1 自修复（2026-05-13）**：旧实现 order 数组只 push
    // agent-runtime 一侧，executions 只 push ActionExecutorAdapter 一侧，
    // 两数组之间没有跨入口时间戳对比 —— 即便 ActionExecutorAdapter 不串行
    // 测试也能通过。新实现把 stub 的 start/end 也 push 到同一份 `order` 数组，
    // 用 `expect(order).toEqual([...])` 钉死跨入口顺序。
    const file = path.join(tmpDir, 'h-invariant.txt');
    await fsPromises.writeFile(file, '');

    const order: string[] = [];

    // 提前 push agent-runtime 一侧 + ActionExecutorAdapter 一侧到同一 order
    // 数组（stub 的 start/end 仍会 push 到 executions，但本测核心信号在
    // order 顺序上）。
    const adapterPathPromise = withFileLock(file, async () => {
      order.push('agent-runtime-start');
      await new Promise<void>((r) => setTimeout(r, 50));
      order.push('agent-runtime-end');
    });

    // 微小延迟让 adapterPathPromise 进临界区
    await new Promise<void>((r) => setImmediate(r));

    // 用一个特别的 stub 让 ActionExecutorAdapter 一侧也能 push 到 order
    const adapterLocal = new ActionExecutorAdapter();
    adapterLocal.registerTool({
      name: 'write_file',
      description: 'stub',
      parameters: { type: 'object', properties: {}, required: [] },
      async execute() {
        order.push('action-executor-start');
        await new Promise<void>((r) => setTimeout(r, 20));
        order.push('action-executor-end');
        return { success: true, data: {} };
      },
    });

    const executorPathPromise = adapterLocal.executeAction(
      makeAction('write_file', { path: file, _workspace_root: tmpDir }),
    );

    await Promise.all([adapterPathPromise, executorPathPromise]);

    // 核心断言：ActionExecutorAdapter 路径必须等 agent-runtime 释放锁 ——
    // 跨入口 FIFO 严格顺序钉死
    expect(order).toEqual([
      'agent-runtime-start',
      'agent-runtime-end',
      'action-executor-start',
      'action-executor-end',
    ]);
    expect(getFileLockMapSize()).toBe(0);
  });

  it('W15-8：canonicalize 跨入口归一 —— 相对路径 vs 绝对路径视为同锁', async () => {
    const fileName = 'canon.txt';
    const absPath = path.join(tmpDir, fileName);
    await fsPromises.writeFile(absPath, '');

    const order: string[] = [];

    // agent-runtime 路径用绝对路径
    const absPromise = withFileLock(
      absPath,
      async () => {
        order.push('abs-start');
        await new Promise<void>((r) => setTimeout(r, 40));
        order.push('abs-end');
      },
      { baseDir: tmpDir },
    );

    await new Promise<void>((r) => setImmediate(r));

    // ActionExecutorAdapter 路径用相对路径（_workspace_root=tmpDir 解析后跟 absPath canonical 一致）
    // 用 local stub 让 order 跨入口可对比（同 M1 自修复）
    const adapterLocal = new ActionExecutorAdapter();
    adapterLocal.registerTool({
      name: 'edit_file',
      description: 'stub',
      parameters: { type: 'object', properties: {}, required: [] },
      async execute() {
        order.push('rel-start');
        await new Promise<void>((r) => setTimeout(r, 20));
        order.push('rel-end');
        return { success: true, data: {} };
      },
    });

    const relPromise = adapterLocal.executeAction(
      makeAction('edit_file', { path: fileName, _workspace_root: tmpDir }),
    );

    await Promise.all([absPromise, relPromise]);

    // 相对路径 + workspace_root 解析后跟绝对路径同锁键 → 严格 FIFO
    expect(order).toEqual(['abs-start', 'abs-end', 'rel-start', 'rel-end']);
    expect(getFileLockMapSize()).toBe(0);
  });
});

// ─── Round 1 review SEV-1 自修复：abortSignal 透传集成测试 ─────────

describe('action-executor-lock — abortSignal 透传（Round 1 SEV-1 自修复）', () => {
  it('等锁期间 signal abort → 后到的 executeAction 不再调 tool.execute', async () => {
    // 旧实现：ActionExecutorAdapter 没透传 abortSignal 给 withFileLock ——
    // 用户取消会话时正在等锁的 ActionExecutorAdapter 调用会"跑空"（文件被改
    // 但结果被丢弃）。Round 1 SEV-1 修：透传 abortSignal 让等锁期间也能取消。
    //
    // 本测试模拟「LLM Agent 持锁 → server push action 进锁 → 用户取消
    // server push 任务」场景，验证 abort 真的把后到的 action 从锁队列里
    // 摘掉，tool.execute 不被调用。
    const file = path.join(tmpDir, 'abort-during-wait.txt');
    await fsPromises.writeFile(file, '');

    // 第一个：经直接 withFileLock 持锁 80ms（模拟 LLM Agent chat）
    let firstDone = false;
    const firstPromise = withFileLock(file, async () => {
      await new Promise<void>((r) => setTimeout(r, 80));
      firstDone = true;
    });
    await new Promise<void>((r) => setImmediate(r));

    // 第二个：经 ActionExecutorAdapter 进入同文件等锁（带 abortSignal）
    const adapterLocal = new ActionExecutorAdapter();
    let secondToolRan = false;
    adapterLocal.registerTool({
      name: 'write_file',
      description: 'stub',
      parameters: { type: 'object', properties: {}, required: [] },
      async execute() {
        secondToolRan = true;
        return { success: true, data: {} };
      },
    });

    const controller = new AbortController();
    const secondPromise = adapterLocal.executeAction(
      makeAction('write_file', { path: file, _workspace_root: tmpDir }),
      controller.signal,
    );
    // 让 secondPromise 入队
    await new Promise<void>((r) => setImmediate(r));
    // 取消
    controller.abort();

    const [, secondResult] = await Promise.all([firstPromise, secondPromise]);

    expect(firstDone).toBe(true);
    // 核心断言：abort 后 tool.execute 不应被调（withFileLock 等锁期间抛 AbortError）
    expect(secondToolRan).toBe(false);
    // executeAction 返回 success: false（被 raceAbortSignal 或 withFileLock 抛错捕获）
    expect(secondResult.success).toBe(false);
    expect(getFileLockMapSize()).toBe(0);
  });

  it('进锁前 signal 已 abort → tool.execute 不被调，且锁队列不变', async () => {
    const file = path.join(tmpDir, 'abort-pre-lock.txt');
    await fsPromises.writeFile(file, '');

    const adapterLocal = new ActionExecutorAdapter();
    let toolRan = false;
    adapterLocal.registerTool({
      name: 'write_file',
      description: 'stub',
      parameters: { type: 'object', properties: {}, required: [] },
      async execute() {
        toolRan = true;
        return { success: true, data: {} };
      },
    });

    const controller = new AbortController();
    controller.abort();

    const result = await adapterLocal.executeAction(
      makeAction('write_file', { path: file, _workspace_root: tmpDir }),
      controller.signal,
    );

    // 已 abort，executeAction 早 return false（在 executeAction 顶部的 `signal?.aborted` 守卫）
    expect(result.success).toBe(false);
    expect(toolRan).toBe(false);
    expect(getFileLockMapSize()).toBe(0);
  });
});

// ─── refcount 不漏：100 并发跨入口 ─────────────────────────────────

describe('action-executor-lock — refcount 释放', () => {
  it('W15-7：100 并发跨入口混合后 lockMap.size === 0', async () => {
    const file = path.join(tmpDir, 'stress.txt');
    await fsPromises.writeFile(file, '');

    const promises = Array.from({ length: 100 }, (_, i) => {
      // 50% 走 ActionExecutorAdapter / 50% 走 withFileLock 直接调
      if (i % 2 === 0) {
        return adapter.executeAction(makeAction('write_file', { path: file, _workspace_root: tmpDir }));
      } else {
        return withFileLock(file, async () => {
          await new Promise<void>((r) => setImmediate(r));
        }, { baseDir: tmpDir });
      }
    });
    await Promise.all(promises);

    expect(getFileLockMapSize()).toBe(0);
  });
});
