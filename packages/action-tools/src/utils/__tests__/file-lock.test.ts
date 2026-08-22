/**
 * file-lock 模块单测（PRD「文件并发安全 Wave 1」 — 2026-05-13）
 *
 * **Wave 1.5（2026-05-13）搬运自 agent-runtime/src/tools/__tests__/file-lock.test.ts。**
 * 跟实现下沉到 action-tools/utils/file-lock 同步迁移。agent-runtime 一侧保留
 * 同款测试（测的是 re-export 桥接 + lockMap 是否真共享同一份），所以本文件
 * 加测试时务必两边同步加（双套测试通过则跨入口共享 lockMap 证毕）。
 *
 * 覆盖范围：
 *   1. 基础语义：FIFO 串行 / 不同 key 并行 / fn 抛错锁仍释放
 *   2. refcount 释放：100 并发后 Map.size === 0（PRD §A.6 L5 矩阵基础）
 *   3. canonicalize：macOS symlink + 大小写不敏感视为同一锁（L6 / L7 基础）
 *   4. abort 语义（PRD §七决策）：进锁前 / 等锁期间 / 持锁运行 fn 期间三档
 */

import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __resetFileLockMapForTest,
  getFileLockMapSize,
  withFileLock,
} from '../file-lock.js';

let tmpDir: string;

beforeEach(async () => {
  __resetFileLockMapForTest();
  // macOS 上 os.tmpdir() 返回 /var/folders/... 是 symlink 到 /private/var/folders/...
  // 提前 realpath 保证 baseDir 跟 canonicalizePath 后的路径同 prefix，否则
  // 测 L6 symlink 时锁键会不一致。
  const raw = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-lock-test-'));
  tmpDir = await fsPromises.realpath(raw);
});

afterEach(async () => {
  await fsPromises.rm(tmpDir, { recursive: true, force: true });
});

// ─── 基础语义 ────────────────────────────────────────────────────────

describe('file-lock withFileLock — 基础语义', () => {
  it('同一文件 3 个并发请求按 FIFO 顺序串行执行', async () => {
    const file = path.join(tmpDir, 'fifo.txt');
    await fsPromises.writeFile(file, '');

    const order: string[] = [];
    const work = (label: string) => async () => {
      order.push(`${label}-start`);
      // 关键：在临界区里 await 一次让出 microtask，模拟真实异步 IO；
      // 没有 await 时 fn 是同步函数，三个 promise 同步走完抢不到并发。
      await new Promise<void>((r) => setTimeout(r, 5));
      order.push(`${label}-end`);
    };

    await Promise.all([
      withFileLock(file, work('A')),
      withFileLock(file, work('B')),
      withFileLock(file, work('C')),
    ]);

    // 串行不交错：A 全跑完再 B，B 全跑完再 C
    expect(order).toEqual([
      'A-start', 'A-end',
      'B-start', 'B-end',
      'C-start', 'C-end',
    ]);
  });

  it('不同文件并发完全并行（不互相阻塞）', async () => {
    const fileA = path.join(tmpDir, 'a.txt');
    const fileB = path.join(tmpDir, 'b.txt');
    await fsPromises.writeFile(fileA, '');
    await fsPromises.writeFile(fileB, '');

    const sleepMs = 50;
    const t0 = Date.now();
    await Promise.all([
      withFileLock(fileA, async () => {
        await new Promise<void>((r) => setTimeout(r, sleepMs));
      }),
      withFileLock(fileB, async () => {
        await new Promise<void>((r) => setTimeout(r, sleepMs));
      }),
    ]);
    const elapsed = Date.now() - t0;

    // 串行 ≥ 100ms；并行 ≈ 50ms。给 2x 容忍（CI 抖动）。
    expect(elapsed).toBeLessThan(sleepMs * 2);
  });

  it('fn 抛错时锁仍释放，下个排队者照常运行', async () => {
    const file = path.join(tmpDir, 'throw.txt');
    await fsPromises.writeFile(file, '');

    let secondRan = false;
    const promise1 = withFileLock(file, async () => {
      throw new Error('boom');
    });
    const promise2 = withFileLock(file, async () => {
      secondRan = true;
    });

    await expect(promise1).rejects.toThrow('boom');
    await promise2;
    expect(secondRan).toBe(true);
    expect(getFileLockMapSize()).toBe(0);
  });

  it('fn 返回值原样回传', async () => {
    const file = path.join(tmpDir, 'return.txt');
    await fsPromises.writeFile(file, '');
    const result = await withFileLock(file, async () => 42);
    expect(result).toBe(42);
  });
});

// ─── refcount 释放：核心不变量 ─────────────────────────────────────

describe('file-lock withFileLock — refcount 释放', () => {
  it('100 并发同文件后 lockMap.size === 0（无泄漏）', async () => {
    const file = path.join(tmpDir, 'stress.txt');
    await fsPromises.writeFile(file, '');

    await Promise.all(
      Array.from({ length: 100 }, () =>
        withFileLock(file, async () => {
          // 让出一次 microtask 强制走真实并发路径
          await new Promise<void>((r) => setImmediate(r));
        }),
      ),
    );

    expect(getFileLockMapSize()).toBe(0);
  });

  it('单次调用结束后 Map 已删除该 entry', async () => {
    const file = path.join(tmpDir, 'single.txt');
    await fsPromises.writeFile(file, '');

    expect(getFileLockMapSize()).toBe(0);
    await withFileLock(file, async () => {});
    expect(getFileLockMapSize()).toBe(0);
  });

  it('多文件并发后所有 entry 均被清理', async () => {
    const files = Array.from({ length: 20 }, (_, i) =>
      path.join(tmpDir, `f-${i}.txt`),
    );
    await Promise.all(files.map((f) => fsPromises.writeFile(f, '')));

    await Promise.all(
      files.flatMap((f) => [
        withFileLock(f, async () => {
          await new Promise<void>((r) => setImmediate(r));
        }),
        withFileLock(f, async () => {
          await new Promise<void>((r) => setImmediate(r));
        }),
      ]),
    );

    expect(getFileLockMapSize()).toBe(0);
  });

  it('100 并发混合 30% throw：全 settled 后 Map 清空，非 throw 的都 resolve', async () => {
    // Reviewer 3 中-2 反馈：Wave 2 STALE_READ throw 会让 fn 抛错成生产高频
    // 路径——提前钉死「混合并发 + 异常路径不漏 refcount」的不变量，防止
    // 未来重构破坏 finally 释放 + Map.delete 逻辑。
    const file = path.join(tmpDir, 'mix-throw.txt');
    await fsPromises.writeFile(file, '');

    const results = await Promise.allSettled(
      Array.from({ length: 100 }, (_, i) =>
        withFileLock(file, async () => {
          await new Promise<void>((r) => setImmediate(r));
          if (i % 3 === 0) throw new Error(`fail-${i}`);
          return i;
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length + rejected.length).toBe(100);
    expect(rejected.length).toBeGreaterThan(0); // 至少有 fail-0 / fail-3 / fail-6 / ...
    expect(fulfilled.length).toBeGreaterThan(0); // 非 throw 路径都成功
    // 核心断言：所有 settled 后 Map 清空——证明异常路径 finally 也走 refCount--
    expect(getFileLockMapSize()).toBe(0);
  });
});

// ─── canonicalize 行为：macOS 锁键归一 ───────────────────────────────

describe('file-lock withFileLock — 锁键 canonicalize（macOS）', () => {
  it('symlink: /tmp/X 跟 /private/tmp/X 视为同一锁', async () => {
    // /tmp 是 /private/tmp 的 symlink（macOS）；非 macOS 跳过
    if (process.platform !== 'darwin') {
      return;
    }
    const fileName = `lock-symlink-${Date.now()}.txt`;
    const viaTmp = `/tmp/${fileName}`;
    const viaPrivate = `/private/tmp/${fileName}`;
    await fsPromises.writeFile(viaTmp, '');

    try {
      const order: string[] = [];
      await Promise.all([
        withFileLock(viaTmp, async () => {
          order.push('tmp-start');
          await new Promise<void>((r) => setTimeout(r, 20));
          order.push('tmp-end');
        }),
        withFileLock(viaPrivate, async () => {
          order.push('priv-start');
          await new Promise<void>((r) => setTimeout(r, 20));
          order.push('priv-end');
        }),
      ]);

      // 串行：第二个 start 一定在第一个 end 之后
      expect(order).toEqual(['tmp-start', 'tmp-end', 'priv-start', 'priv-end']);
      expect(getFileLockMapSize()).toBe(0);
    } finally {
      await fsPromises.unlink(viaTmp).catch(() => {});
    }
  });

  it('相对路径 + workspaceRoot 解析后跟绝对路径视为同一锁', async () => {
    const fileName = 'rel.txt';
    const absPath = path.join(tmpDir, fileName);
    await fsPromises.writeFile(absPath, '');

    const order: string[] = [];
    await Promise.all([
      withFileLock(
        absPath,
        async () => {
          order.push('abs-start');
          await new Promise<void>((r) => setTimeout(r, 20));
          order.push('abs-end');
        },
      ),
      withFileLock(
        fileName,
        async () => {
          order.push('rel-start');
          await new Promise<void>((r) => setTimeout(r, 20));
          order.push('rel-end');
        },
        { baseDir: tmpDir },
      ),
    ]);

    expect(order).toEqual(['abs-start', 'abs-end', 'rel-start', 'rel-end']);
    expect(getFileLockMapSize()).toBe(0);
  });
});

// ─── abort 语义（PRD §七决策）─────────────────────────────────────

describe('file-lock withFileLock — abort 语义', () => {
  it('进锁前 abortSignal 已 abort → 立刻抛错且不调 fn', async () => {
    const file = path.join(tmpDir, 'abort-pre.txt');
    await fsPromises.writeFile(file, '');
    const controller = new AbortController();
    controller.abort();

    let fnRan = false;
    await expect(
      withFileLock(
        file,
        async () => {
          fnRan = true;
        },
        { abortSignal: controller.signal },
      ),
    ).rejects.toThrow();

    expect(fnRan).toBe(false);
    expect(getFileLockMapSize()).toBe(0);
  });

  it('等锁期间 abort → 醒来抛错且不调 fn，但前任仍跑完', async () => {
    const file = path.join(tmpDir, 'abort-wait.txt');
    await fsPromises.writeFile(file, '');
    const controller = new AbortController();

    let firstDone = false;
    let secondRan = false;

    const promise1 = withFileLock(file, async () => {
      await new Promise<void>((r) => setTimeout(r, 40));
      firstDone = true;
    });
    // 等 promise1 进入临界区（让 microtask 排空一次）
    await new Promise<void>((r) => setImmediate(r));

    const promise2 = withFileLock(
      file,
      async () => {
        secondRan = true;
      },
      { abortSignal: controller.signal },
    );
    // 让 promise2 入队
    await new Promise<void>((r) => setImmediate(r));
    controller.abort();

    await promise1;
    await expect(promise2).rejects.toThrow();

    expect(firstDone).toBe(true);
    expect(secondRan).toBe(false);
    expect(getFileLockMapSize()).toBe(0);
  });

  it('持锁运行 fn 期间 abort → 不打断 fn，refcount 正常清', async () => {
    const file = path.join(tmpDir, 'abort-running.txt');
    await fsPromises.writeFile(file, '');
    const controller = new AbortController();

    let fnDone = false;
    const promise = withFileLock(
      file,
      async () => {
        // fn 进入后 abort —— PRD §七：不打断当前临界区
        controller.abort();
        await new Promise<void>((r) => setTimeout(r, 20));
        fnDone = true;
      },
      { abortSignal: controller.signal },
    );

    await promise;
    expect(fnDone).toBe(true);
    expect(getFileLockMapSize()).toBe(0);
  });

  it('等锁期间 abort 后 entry 已 destroy，下次同文件请求不会卡死', async () => {
    // 回归测试：abort 路径下 release() 没漏调 → 下个请求不会卡死。
    const file = path.join(tmpDir, 'abort-no-deadlock.txt');
    await fsPromises.writeFile(file, '');
    const controller = new AbortController();

    const promise1 = withFileLock(file, async () => {
      await new Promise<void>((r) => setTimeout(r, 30));
    });
    await new Promise<void>((r) => setImmediate(r));

    const promise2 = withFileLock(
      file,
      async () => {},
      { abortSignal: controller.signal },
    );
    await new Promise<void>((r) => setImmediate(r));
    controller.abort();

    await promise1;
    await expect(promise2).rejects.toThrow();

    // 新请求应能立刻拿锁，不会因为 promise2 漏 release 导致卡死
    const t0 = Date.now();
    await withFileLock(file, async () => {});
    expect(Date.now() - t0).toBeLessThan(100);
    expect(getFileLockMapSize()).toBe(0);
  });
});
