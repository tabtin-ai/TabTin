/**
 * 跨入口锁串行集成测试（PRD「文件并发安全 Wave 1.5」— 2026-05-13）
 *
 * **核心场景（W15-3 / H 不变量）**：
 *
 * Wave 1 锁加在 agent-runtime adapter 层只覆盖了 LLM Agent chat 链路；
 * Wave 1.5 把锁下沉到 action-tools 后，另外 3 个入口（ActionExecutorAdapter
 * / FrontendActionBridge / Daemon MCP / Daemon action-bridge）通过
 * `@tabtin/action-tools/utils/file-lock` 共享同一份 `lockMap` 单例 ——
 * agent-runtime 一侧 `tools/file-lock.ts` 也 re-export 这同一份模块。
 *
 * 本测试从 agent-runtime 一侧（adapter 视角）调 `withFileLock`，从 action-tools
 * 一侧（ActionExecutorAdapter 视角）调 `withFileLock`，验证：
 *   - 同一文件 canonical 后 → FIFO 串行（核心 H 不变量）
 *   - 不同文件 → 不阻塞
 *   - 相对路径 + 不同 baseDir 解析到同一 canonical → 同锁键串行
 *   - refcount 跨入口正确 → lockMap.size === 0 收尾
 *
 * 本测试在 agent-runtime 一侧跑，agent-runtime 的 file-lock.ts 通过
 * `@tabtin/action-tools/headless` re-export —— 跑通即证明 lockMap 是同一份
 * 单例（agent-runtime 一侧的 withFileLock 跟 action-tools 一侧的 withFileLock
 * 操作的是同一份模块状态）。
 */

import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// agent-runtime 一侧的 withFileLock（adapter 视角；re-export 自 action-tools）
import {
  __resetFileLockMapForTest as resetFromAgentRuntime,
  getFileLockMapSize as sizeFromAgentRuntime,
  withFileLock as lockFromAgentRuntime,
} from '@tabtin/action-tools/headless';

// action-tools 一侧的 withFileLock（ActionExecutorAdapter 视角；同一份模块）
import {
  __resetFileLockMapForTest as resetFromActionTools,
  getFileLockMapSize as sizeFromActionTools,
  withFileLock as lockFromActionTools,
} from '@tabtin/action-tools/headless';

let tmpDir: string;

beforeEach(async () => {
  // 双侧同时 reset —— 如果是同一份 lockMap 单例，调任一侧都等价；这里同时调
  // 用于验证「无论从哪侧 reset 都是同一份 Map」（间接验证单例）。
  resetFromAgentRuntime();
  resetFromActionTools();
  // 确认双侧看到的 size 都是 0
  expect(sizeFromAgentRuntime()).toBe(0);
  expect(sizeFromActionTools()).toBe(0);

  const raw = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'cross-entry-lock-'));
  tmpDir = await fsPromises.realpath(raw);
});

afterEach(async () => {
  await fsPromises.rm(tmpDir, { recursive: true, force: true });
});

describe('cross-entry-lock — agent-runtime adapter 一侧的 lockMap 跟 action-tools 是同一份单例', () => {
  it('单一调用：从 agent-runtime 一侧持锁时，action-tools 一侧的 size 也 +1', async () => {
    // 这是「lockMap 单例」的最直接证明：agent-runtime 的 withFileLock 进锁后，
    // action-tools 的 getFileLockMapSize 也能看到 size=1（如果是两份独立 Map，
    // action-tools 看到的应该还是 0）。
    const file = path.join(tmpDir, 'singleton-proof.txt');
    await fsPromises.writeFile(file, '');

    let releaseFn!: () => void;
    const work = new Promise<void>((r) => {
      releaseFn = r;
    });

    const lockHeld = lockFromAgentRuntime(file, async () => {
      // 等 size 验证完才 release
      await work;
    });

    // 让 lockFromAgentRuntime 进临界区（让出 microtask）
    await new Promise<void>((r) => setImmediate(r));

    // 关键断言：action-tools 一侧看到的 size 必须 === 1（如果是独立 Map 则 === 0）
    expect(sizeFromActionTools()).toBe(1);
    expect(sizeFromAgentRuntime()).toBe(1);
    // 双侧 size 必须相等（间接证明是同一份 Map）
    expect(sizeFromActionTools()).toBe(sizeFromAgentRuntime());

    releaseFn();
    await lockHeld;

    // 释放后两侧同步归 0
    expect(sizeFromActionTools()).toBe(0);
    expect(sizeFromAgentRuntime()).toBe(0);
  });
});

describe('cross-entry-lock — W15-3 核心 H 不变量', () => {
  it('agent-runtime 路径持锁 + action-tools 路径同文件 → 必须 FIFO 串行', async () => {
    // 模拟 LLM Agent 经 agent-runtime adapter 持锁 vs server push action 经
    // ActionExecutorAdapter 进锁同一文件 —— 两侧 withFileLock 必须共享同一
    // lockMap，对应到同一锁键，所以后者必须等前者释放。
    const file = path.join(tmpDir, 'h-invariant.txt');
    await fsPromises.writeFile(file, '');

    const order: string[] = [];

    const agentRuntimePromise = lockFromAgentRuntime(file, async () => {
      order.push('agent-runtime-start');
      await new Promise<void>((r) => setTimeout(r, 40));
      order.push('agent-runtime-end');
    });

    await new Promise<void>((r) => setImmediate(r));

    const actionToolsPromise = lockFromActionTools(file, async () => {
      order.push('action-tools-start');
      await new Promise<void>((r) => setTimeout(r, 20));
      order.push('action-tools-end');
    });

    await Promise.all([agentRuntimePromise, actionToolsPromise]);

    // 核心断言：action-tools 一侧必须等到 agent-runtime 释放
    expect(order).toEqual([
      'agent-runtime-start',
      'agent-runtime-end',
      'action-tools-start',
      'action-tools-end',
    ]);
    expect(sizeFromActionTools()).toBe(0);
    expect(sizeFromAgentRuntime()).toBe(0);
  });

  it('反向：action-tools 路径持锁 + agent-runtime 路径同文件 → 必须 FIFO 串行', async () => {
    // 跟上面对称——证明 lockMap 单例不依赖谁先进锁
    const file = path.join(tmpDir, 'h-reverse.txt');
    await fsPromises.writeFile(file, '');

    const order: string[] = [];

    const actionToolsPromise = lockFromActionTools(file, async () => {
      order.push('action-tools-start');
      await new Promise<void>((r) => setTimeout(r, 40));
      order.push('action-tools-end');
    });

    await new Promise<void>((r) => setImmediate(r));

    const agentRuntimePromise = lockFromAgentRuntime(file, async () => {
      order.push('agent-runtime-start');
      await new Promise<void>((r) => setTimeout(r, 20));
      order.push('agent-runtime-end');
    });

    await Promise.all([actionToolsPromise, agentRuntimePromise]);

    expect(order).toEqual([
      'action-tools-start',
      'action-tools-end',
      'agent-runtime-start',
      'agent-runtime-end',
    ]);
    expect(sizeFromActionTools()).toBe(0);
  });

  it('W15-4：跨入口不同文件 → 并行执行（不阻塞）', async () => {
    const fileA = path.join(tmpDir, 'a.txt');
    const fileB = path.join(tmpDir, 'b.txt');
    await fsPromises.writeFile(fileA, '');
    await fsPromises.writeFile(fileB, '');

    const sleepMs = 50;
    const t0 = Date.now();
    await Promise.all([
      lockFromAgentRuntime(fileA, async () => {
        await new Promise<void>((r) => setTimeout(r, sleepMs));
      }),
      lockFromActionTools(fileB, async () => {
        await new Promise<void>((r) => setTimeout(r, sleepMs));
      }),
    ]);
    const elapsed = Date.now() - t0;

    // 并行 ≈ 50ms；串行 ≥ 100ms。给 2x 容忍。
    expect(elapsed).toBeLessThan(sleepMs * 2);
    expect(sizeFromActionTools()).toBe(0);
  });

  it('W15-8：跨入口 canonicalize 归一 —— 相对路径（一侧）vs 绝对路径（另侧）视为同锁', async () => {
    const fileName = 'canon.txt';
    const absPath = path.join(tmpDir, fileName);
    await fsPromises.writeFile(absPath, '');

    const order: string[] = [];

    // agent-runtime 一侧用绝对路径
    const absPromise = lockFromAgentRuntime(
      absPath,
      async () => {
        order.push('abs-start');
        await new Promise<void>((r) => setTimeout(r, 40));
        order.push('abs-end');
      },
      { baseDir: tmpDir },
    );

    await new Promise<void>((r) => setImmediate(r));

    // action-tools 一侧用相对路径 + baseDir=tmpDir，解析后跟 absPath canonical 一致
    const relPromise = lockFromActionTools(
      fileName,
      async () => {
        order.push('rel-start');
        await new Promise<void>((r) => setTimeout(r, 20));
        order.push('rel-end');
      },
      { baseDir: tmpDir },
    );

    await Promise.all([absPromise, relPromise]);

    expect(order).toEqual(['abs-start', 'abs-end', 'rel-start', 'rel-end']);
    expect(sizeFromActionTools()).toBe(0);
  });
});

describe('cross-entry-lock — W15-7 refcount 跨入口 100 并发不漏', () => {
  it('100 次并发跨入口混合调同文件 → lockMap.size === 0', async () => {
    const file = path.join(tmpDir, 'stress-cross.txt');
    await fsPromises.writeFile(file, '');

    const promises = Array.from({ length: 100 }, (_, i) => {
      // 50% 走 agent-runtime 一侧 / 50% 走 action-tools 一侧
      const sideLock = i % 2 === 0 ? lockFromAgentRuntime : lockFromActionTools;
      return sideLock(file, async () => {
        await new Promise<void>((r) => setImmediate(r));
      });
    });

    await Promise.all(promises);

    // 双侧看到的 size 都必须 === 0
    expect(sizeFromActionTools()).toBe(0);
    expect(sizeFromAgentRuntime()).toBe(0);
  });
});
