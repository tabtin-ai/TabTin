/**
 * edit-lock 集成矩阵（PRD「文件并发安全 Wave 1」§A.6 — 2026-05-13）
 *
 * 验收的是「业务场景」：单 Agent streaming 多 tool_call / 多 Agent 同进程
 * 并发改同一文件时，所有改动都成功不丢数据。
 *
 * L1-L8 八条矩阵（PRD §A.6）：
 *   L1: 同文件并发 2 次 edit，old_string 不重叠 → 两次都成功，内容含两处改动
 *   L2: 同文件并发 2 次 edit，old_string 重叠 → 一个成功，另一个 OLD_STRING_NOT_FOUND（不是覆盖）
 *   L3: 不同文件并发 edit → 并行执行（性能断言）
 *   L4: edit + write 同文件并发 → 串行，不互相覆盖
 *   L5: 100 次并发 write 同文件后 lockMap.size === 0（无泄漏）
 *   L6: 软链路径并发（macOS /tmp ↔ /private/tmp）→ 串行
 *   L7: 大小写路径并发（macOS）→ 串行
 *   L8: refreshSnapshot 在锁内 → 并发 2 次 write 都成功（间接验证）
 */

import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  ReadFileState,
  Tool,
  ToolContext,
} from '@tabtin/agent-runtime';
import { createTabCodeTools } from '../../src/tools/tabcode-adapter.js';
import { __resetFileLockMapForTest, getFileLockMapSize } from '@tabtin/action-tools/headless';

let tmpDir: string;

beforeEach(async () => {
  __resetFileLockMapForTest();
  const raw = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'edit-lock-matrix-'));
  tmpDir = await fsPromises.realpath(raw);
});

afterEach(async () => {
  await fsPromises.rm(tmpDir, { recursive: true, force: true });
});

function makeCtx(state?: ReadFileState): ToolContext {
  return {
    threadId: 'test',
    runtimeId: 'test',
    abortSignal: new AbortController().signal,
    messages: [],
    workspaceRoot: tmpDir,
    readFileState: state,
  };
}

function getTool(name: string): Tool {
  const tools = createTabCodeTools();
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not in createTabCodeTools()`);
  return tool;
}

async function writeTempFile(name: string, content: string): Promise<string> {
  const p = path.join(tmpDir, name);
  await fsPromises.writeFile(p, content, 'utf8');
  return p;
}

/** 让 readFileState 写入对应 entry——edit / write 的 staleness 检查依赖此 entry。 */
async function primeReadSnapshot(file: string, ctx: ToolContext): Promise<void> {
  const res = await getTool('read_file').execute({ path: file }, ctx);
  if (res.isError) throw new Error(`prime read failed: ${JSON.stringify(res.content)}`);
}

// ─── L1 — 不重叠 edit 并发 ─────────────────────────────────────────

describe('edit-lock L1: 同文件并发不重叠 edit', () => {
  it('两次都成功，最终内容包含两处改动', async () => {
    const file = await writeTempFile('l1.txt', 'AAA\nBBB\nCCC\n');
    const ctx = makeCtx(new Map());
    await primeReadSnapshot(file, ctx);
    const editTool = getTool('edit_file');

    const [r1, r2] = await Promise.all([
      editTool.execute(
        { path: file, old_string: 'AAA', new_string: 'XXX' },
        ctx,
      ),
      editTool.execute(
        { path: file, old_string: 'CCC', new_string: 'ZZZ' },
        ctx,
      ),
    ]);

    expect(r1.isError).toBeUndefined();
    expect(r2.isError).toBeUndefined();

    const finalContent = await fsPromises.readFile(file, 'utf8');
    expect(finalContent).toBe('XXX\nBBB\nZZZ\n');
    expect(getFileLockMapSize()).toBe(0);
  });
});

// ─── L2 — 重叠 edit 并发：一成功 一失败（不互相覆盖）───────────────

describe('edit-lock L2: 同文件并发重叠 edit', () => {
  it('两个 edit 改同一段：一个成功，另一个 OLD_STRING_NOT_FOUND（非覆盖）', async () => {
    const file = await writeTempFile('l2.txt', 'PAYLOAD\n');
    const ctx = makeCtx(new Map());
    await primeReadSnapshot(file, ctx);
    const editTool = getTool('edit_file');

    // 两个 edit 都想改 PAYLOAD。串行后第二个发现 PAYLOAD 已被改成 X 或 Y，
    // old_string 'PAYLOAD' 找不到 → error_kind=old_string_not_found。
    const [r1, r2] = await Promise.all([
      editTool.execute(
        { path: file, old_string: 'PAYLOAD', new_string: 'X' },
        ctx,
      ),
      editTool.execute(
        { path: file, old_string: 'PAYLOAD', new_string: 'Y' },
        ctx,
      ),
    ]);

    // 一个 success / 一个 isError=true（OLD_STRING_NOT_FOUND）。
    const results = [r1, r2];
    const successes = results.filter((r) => !r.isError);
    const failures = results.filter((r) => r.isError);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    // **Wave 3 整体收尾 L-6 修复**：失败的必为 OLD_STRING_NOT_FOUND（不能是覆盖、
    // 不能是 STALE_READ）。旧实现用 phrase regex `/old_string|not.*found/i` 太宽松
    // —— message 一旦措辞改动就漂移，且不能区分「真 NOT_FOUND」vs「STALE_READ
    // 文案恰好含 'not' 字样」。改成钉死 envelope error_kind=old_string_not_found。
    const failedContent = failures[0]!.content as string;
    const failedEnvelope = JSON.parse(failedContent) as {
      error_kind?: string;
      error_kind?: string;
    };
    expect(failedEnvelope.error_kind).toBe('old_string_not_found'); // 'old_string_not_found'
    expect(failedEnvelope.error_kind).toBe('old_string_not_found');

    // 最终文件内容应该是 X 或 Y 其一，不会是 'PAYLOAD'（确保至少一次写入生效）
    // 也不会两个改动叠加。
    const finalContent = await fsPromises.readFile(file, 'utf8');
    expect(['X\n', 'Y\n']).toContain(finalContent);
    expect(getFileLockMapSize()).toBe(0);
  });
});

// ─── L3 — 不同文件并发 edit 完全并行 ───────────────────────────────

describe('edit-lock L3: 不同文件并发 edit', () => {
  it('两个 edit 并行执行（总耗时接近单 edit 而非 2 倍）', async () => {
    const fileA = await writeTempFile('l3-a.txt', 'AAA');
    const fileB = await writeTempFile('l3-b.txt', 'BBB');
    const ctx = makeCtx(new Map());
    await primeReadSnapshot(fileA, ctx);
    await primeReadSnapshot(fileB, ctx);
    const editTool = getTool('edit_file');

    // 每个 edit 大约几十 ms（read + match + write + refreshSnapshot）。
    // 拿单次耗时做 baseline。
    const tSingle = Date.now();
    await editTool.execute(
      { path: fileA, old_string: 'AAA', new_string: 'CCC' },
      ctx,
    );
    const singleElapsed = Date.now() - tSingle;

    // 复位状态（snapshot 已被 edit 后 refresh）
    await fsPromises.writeFile(fileA, 'AAA');
    await fsPromises.writeFile(fileB, 'BBB');
    await primeReadSnapshot(fileA, ctx);
    await primeReadSnapshot(fileB, ctx);

    const tParallel = Date.now();
    await Promise.all([
      editTool.execute(
        { path: fileA, old_string: 'AAA', new_string: 'CCC' },
        ctx,
      ),
      editTool.execute(
        { path: fileB, old_string: 'BBB', new_string: 'DDD' },
        ctx,
      ),
    ]);
    const parallelElapsed = Date.now() - tParallel;

    // 并行应远小于 2x single（理论 ≈ 1x；给 1.5x 容忍 CI 抖动）。
    // 用 max(singleElapsed * 1.5, 30ms) 兜底：单 edit 太快时 timing 噪声大。
    const upperBound = Math.max(singleElapsed * 1.5, 30);
    expect(parallelElapsed).toBeLessThan(upperBound);

    expect(getFileLockMapSize()).toBe(0);
  });
});

// ─── L4 — edit + write 同文件并发 ──────────────────────────────────

describe('edit-lock L4: edit + write 同文件并发', () => {
  it('串行执行不互相覆盖：最终内容 === OVERWRITTEN（write 总会盖到最后），write 一定成功', async () => {
    // 三家 reviewer 都指出之前断言「'EDITED\n' 或 'OVERWRITTEN\n'」过于宽容
    // ——实际两种执行顺序的最终内容**必定**是 'OVERWRITTEN\n'：
    //   - edit 先：edit 改 INITIAL→EDITED；write 再覆盖 → 'OVERWRITTEN\n'
    //   - write 先：write 覆盖 → 'OVERWRITTEN\n'；edit 找 'INITIAL' 找不到失败
    // 收紧断言钉死这条不变量；write 必定成功；edit 失败时错误信号必须是
    // OLD_STRING_NOT_FOUND（不是被覆盖、不是 STALE_READ）。
    const file = await writeTempFile('l4.txt', 'INITIAL\n');
    const ctx = makeCtx(new Map());
    await primeReadSnapshot(file, ctx);

    const [editRes, writeRes] = await Promise.all([
      getTool('edit_file').execute(
        { path: file, old_string: 'INITIAL', new_string: 'EDITED' },
        ctx,
      ),
      getTool('write_file').execute(
        { path: file, contents: 'OVERWRITTEN\n' },
        ctx,
      ),
    ]);

    // write 永远成功（无论 edit 先后）
    expect(writeRes.isError).toBeUndefined();
    // 最终内容必定是 write 的内容（write 是后写或唯一写）
    const finalContent = await fsPromises.readFile(file, 'utf8');
    expect(finalContent).toBe('OVERWRITTEN\n');

    // edit 要么成功（edit 先 + write 后 = 两个都成功）
    // 要么失败 + 错误是 OLD_STRING_NOT_FOUND（write 先 → INITIAL 不在磁盘上）
    if (editRes.isError) {
      const editContent = editRes.content as string;
      expect(editContent.toLowerCase()).toMatch(/old_string|not.*found/i);
      // 关键反向断言：不应是 STALE_READ（说明锁内 refreshSnapshot 同步过了）
      expect(editContent.toLowerCase()).not.toMatch(/stale|stale_read/i);
    }

    expect(getFileLockMapSize()).toBe(0);
  });
});

// ─── L5 — 100 并发 stress test：Map 不漏 ───────────────────────────

describe('edit-lock L5: 100 并发同文件无泄漏', () => {
  it('100 次并发 write 同文件后 lockMap.size === 0', async () => {
    const file = await writeTempFile('l5.txt', 'initial');
    const ctx = makeCtx(new Map());
    await primeReadSnapshot(file, ctx);

    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        getTool('write_file').execute(
          { path: file, contents: `content-${i}` },
          ctx,
        ),
      ),
    );

    // 100 个 write 应全部成功（串行 + refreshSnapshot 在锁内同步 state.mtime
    // → 每次进锁的 validateReadBeforeWrite 都通过）
    const failures = results.filter((r) => r.isError);
    expect(failures).toHaveLength(0);

    // 关键断言：refcount 释放策略生效，Map 已清空
    expect(getFileLockMapSize()).toBe(0);

    // 最终内容是其中之一（无序，因为 100 并发的 entry 顺序不定）
    const finalContent = await fsPromises.readFile(file, 'utf8');
    expect(finalContent).toMatch(/^content-\d+$/);
  });
});

// ─── L6 — macOS symlink 路径 ────────────────────────────────────────

describe('edit-lock L6: macOS symlink 路径', () => {
  it('/tmp/X 跟 /private/tmp/X 视为同一锁串行', async () => {
    if (process.platform !== 'darwin') {
      return; // /tmp ↔ /private/tmp symlink 是 macOS 特性，其他平台跳过
    }

    const fileName = `lock-symlink-${Date.now()}.txt`;
    const viaTmp = `/tmp/${fileName}`;
    const viaPrivate = `/private/tmp/${fileName}`;
    await fsPromises.writeFile(viaTmp, 'INITIAL\n');

    try {
      // 用 /tmp 路径 prime snapshot；canonicalize 后 entry key = /private/tmp/...
      const ctx: ToolContext = {
        threadId: 'test',
        runtimeId: 'test',
        abortSignal: new AbortController().signal,
        messages: [],
        workspaceRoot: '/tmp',
        readFileState: new Map(),
      };
      await getTool('read_file').execute({ path: viaTmp }, ctx);

      // 并发 2 个 edit：一个走 /tmp，一个走 /private/tmp。
      // 如果锁键归一了，两次串行（一成功一 OLD_STRING_NOT_FOUND）。
      // 如果没归一，可能两次同时跑撞 fs 竞态——任一种都不期望。
      const [r1, r2] = await Promise.all([
        getTool('edit_file').execute(
          { path: viaTmp, old_string: 'INITIAL', new_string: 'A' },
          ctx,
        ),
        getTool('edit_file').execute(
          { path: viaPrivate, old_string: 'INITIAL', new_string: 'B' },
          ctx,
        ),
      ]);

      const results = [r1, r2];
      const successes = results.filter((r) => !r.isError);
      // 串行后只有一次能改 INITIAL，另一次 OLD_STRING_NOT_FOUND（被第一次改完）
      expect(successes).toHaveLength(1);

      const finalContent = await fsPromises.readFile(viaTmp, 'utf8');
      expect(['A\n', 'B\n']).toContain(finalContent);
      expect(getFileLockMapSize()).toBe(0);
    } finally {
      await fsPromises.unlink(viaTmp).catch(() => {});
    }
  });
});

// ─── L7 — macOS 大小写路径 ─────────────────────────────────────────

describe('edit-lock L7: macOS 大小写不敏感路径', () => {
  it('/Foo/x.txt 跟 /foo/x.txt 视为同一锁串行', async () => {
    if (process.platform !== 'darwin') {
      return; // 大小写不敏感是 macOS HFS+/APFS 默认；Linux/Windows ext4 / NTFS 不通用
    }

    const upperDir = path.join(tmpDir, 'MixedCase');
    await fsPromises.mkdir(upperDir);
    const upperFile = path.join(upperDir, 'x.txt');
    await fsPromises.writeFile(upperFile, 'INITIAL\n');

    const lowerFile = path.join(tmpDir, 'mixedcase', 'x.txt');

    // 运行时检测 case-sensitivity：如果当前卷大小写敏感（APFS 大小写敏感
    // 卷），不同大小写路径访问失败 → 测试条件不成立，直接跳过。在 case-
    // insensitive 卷上 fs.realpathSync 把两个路径都归一为磁盘真实版本。
    const fsModule = await import('node:fs');
    let upperReal: string;
    let lowerReal: string;
    try {
      upperReal = fsModule.realpathSync(upperFile);
      lowerReal = fsModule.realpathSync(lowerFile);
    } catch {
      return; // 不能解析 lower 路径 → 文件系统 case-sensitive → 跳过
    }
    if (upperReal !== lowerReal) {
      return; // 解析后不一致 → case-sensitive 卷 → 跳过（本测不适用）
    }

    const ctx = makeCtx(new Map());
    const readRes = await getTool('read_file').execute({ path: upperFile }, ctx);
    if (readRes.isError) return;

    // 并发 2 个 edit：一个走 MixedCase 路径，一个走 mixedcase 路径
    const [r1, r2] = await Promise.all([
      getTool('edit_file').execute(
        { path: upperFile, old_string: 'INITIAL', new_string: 'A' },
        ctx,
      ),
      getTool('edit_file').execute(
        { path: lowerFile, old_string: 'INITIAL', new_string: 'B' },
        ctx,
      ),
    ]);

    const results = [r1, r2];
    const successes = results.filter((r) => !r.isError);
    // 锁归一后串行：一成功一 OLD_STRING_NOT_FOUND
    expect(successes).toHaveLength(1);
    expect(getFileLockMapSize()).toBe(0);
  });
});

// ─── L8 — refreshSnapshot 在锁内（核心不变量）──────────────────────

describe('edit-lock L8: refreshSnapshot 在锁内', () => {
  it('连续 2 次 write 都成功——证明 refreshSnapshot 在锁内更新 state.mtime', async () => {
    // 这条是 PRD §A.4「这条特别重要」的硬证据：
    //   - 如果 refreshSnapshot 出锁外，第一次 write 释放锁后 state.mtime 还
    //     是 read 时的旧值，第二次进锁 validateReadBeforeWrite 会看到磁盘
    //     mtime > state.mtime → 比较内容（pre-write != post-write）→ 不一致
    //     → throw STALE_READ → 第二次失败
    //   - 在锁内：第一次写完 refreshSnapshot 把 state.mtime 同步到 post-write
    //     mtime，第二次进锁的 state.mtime 跟磁盘 mtime 一致 → 通过 → 成功
    const file = await writeTempFile('l8.txt', 'INITIAL\n');
    const ctx = makeCtx(new Map());
    await primeReadSnapshot(file, ctx);

    const [r1, r2] = await Promise.all([
      getTool('write_file').execute(
        { path: file, contents: 'A\n' },
        ctx,
      ),
      getTool('write_file').execute(
        { path: file, contents: 'B\n' },
        ctx,
      ),
    ]);

    // 两个 write 都应成功（refreshSnapshot 在锁内同步 state.mtime）
    expect(r1.isError).toBeUndefined();
    expect(r2.isError).toBeUndefined();

    const finalContent = await fsPromises.readFile(file, 'utf8');
    expect(['A\n', 'B\n']).toContain(finalContent);
    expect(getFileLockMapSize()).toBe(0);
  });

  it('10 次连续 edit 都成功（snapshot 链式同步）', async () => {
    // 强化版 L8：10 个连续 edit 都要成功，串行结束后文件内容含所有改动。
    // edit 用唯一 old_string 避免 NOT_FOUND；snapshot 同步要在每次 edit 后
    // 立刻生效，否则下个 edit 撞 STALE_READ。
    const initial = Array.from({ length: 10 }, (_, i) => `LINE-${i}-OLD`).join('\n') + '\n';
    const file = await writeTempFile('l8-chain.txt', initial);
    const ctx = makeCtx(new Map());
    await primeReadSnapshot(file, ctx);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        getTool('edit_file').execute(
          { path: file, old_string: `LINE-${i}-OLD`, new_string: `LINE-${i}-NEW` },
          ctx,
        ),
      ),
    );

    // 全部 10 个 edit 都成功
    const failures = results.filter((r) => r.isError);
    expect(failures).toHaveLength(0);

    // 文件最终包含 10 处改动
    const finalContent = await fsPromises.readFile(file, 'utf8');
    for (let i = 0; i < 10; i++) {
      expect(finalContent).toContain(`LINE-${i}-NEW`);
      expect(finalContent).not.toContain(`LINE-${i}-OLD`);
    }
    expect(getFileLockMapSize()).toBe(0);
  });
});

// ─── 装配期 assertion ──────────────────────────────────────────────

describe('edit-lock — 装配期 assertion', () => {
  it('createTabCodeTools 返回的 edit_file / write_file 装配通过（callback 已注册）', () => {
    // 正向验证：能调到 createTabCodeTools 说明 LOCK_REQUIRED_TOOLS 都填了 callback
    expect(() => createTabCodeTools()).not.toThrow();

    const tools = createTabCodeTools();
    const editTool = tools.find((t) => t.name === 'edit_file');
    const writeTool = tools.find((t) => t.name === 'write_file');
    expect(editTool).toBeDefined();
    expect(writeTool).toBeDefined();
  });

  it('adaptAgentTool 对 edit_file 缺 requiresFileLock 装配期 throw', async () => {
    // Reviewer 3 中-3：反向钉死 assertion 路径，防止有人重构 adapter 时
    // 删 assertion 还能通过正向测试（regression silently merge）。
    const { adaptAgentTool } = await import('../../src/tools/tabcode-adapter.js');
    const fakeAgentTool = {
      name: 'edit_file',
      description: '',
      parameters: {},
      execute: async () => ({ success: true }),
    } as unknown as Parameters<typeof adaptAgentTool>[0];
    expect(() =>
      adaptAgentTool(fakeAgentTool, {
        deps: {},
        isReadOnly: false,
        llmDescription: 'test stub',
      }),
    ).toThrow(/requiresFileLock/);
  });

  it('adaptAgentTool 对 write_file 缺 requiresFileLock 装配期 throw', async () => {
    const { adaptAgentTool } = await import('../../src/tools/tabcode-adapter.js');
    const fakeAgentTool = {
      name: 'write_file',
      description: '',
      parameters: {},
      execute: async () => ({ success: true }),
    } as unknown as Parameters<typeof adaptAgentTool>[0];
    expect(() =>
      adaptAgentTool(fakeAgentTool, {
        deps: {},
        isReadOnly: false,
        llmDescription: 'test stub',
        // 故意填 osErrorPath（write_file 需要它）单独测 requiresFileLock 缺失路径
        osErrorPath: () => '/tmp/x',
      }),
    ).toThrow(/requiresFileLock/);
  });

  it('adaptAgentTool 对 read_file / delete_file 不强制 requiresFileLock（不在 LOCK_REQUIRED_TOOLS）', async () => {
    // 反向边界：read_file（PRD §A.5 决策不做读锁）+ delete_file（PRD §九
    // 范围外项）不应触发 requiresFileLock 装配期 throw。
    //
    // **Wave 3 整体收尾 L-13 修复**：旧实现只对 fakeRead 做反向断言，fakeDelete
    // 没单独断言（测试自述 vs 覆盖面不一致）。本测试现已加 fakeDelete 同款反向
    // 断言，让两个不在 LOCK_REQUIRED_TOOLS 集合的工具的反向边界都钉死。
    const { adaptAgentTool } = await import('../../src/tools/tabcode-adapter.js');
    const fakeRead = {
      name: 'read_file',
      description: '',
      parameters: {},
      execute: async () => ({ success: true }),
    } as unknown as Parameters<typeof adaptAgentTool>[0];
    // read_file 需要 osErrorPath（已有 W11 assertion）
    expect(() =>
      adaptAgentTool(fakeRead, {
        deps: {},
        isReadOnly: true,
        llmDescription: 'test stub',
        osErrorPath: () => '/tmp/x',
      }),
    ).not.toThrow();

    // **L-13 修复**：delete_file 也加反向断言 —— PRD §九「delete 并发安全」
    // 单独 PRD 处理；本期不强制 requiresFileLock。装配期不应 throw。
    // 注意 delete_file 同款需要 osErrorPath（W11 assertion）。
    const fakeDelete = {
      name: 'delete_file',
      description: '',
      parameters: {},
      execute: async () => ({ success: true }),
    } as unknown as Parameters<typeof adaptAgentTool>[0];
    expect(() =>
      adaptAgentTool(fakeDelete, {
        deps: {},
        isReadOnly: false,
        llmDescription: 'test stub',
        osErrorPath: () => '/tmp/x',
        // delete_file 现在在 FILE_HISTORY_REQUIRED_TOOLS（删前备份以支持回退），
        // 必须声明 tracksFileHistory；本测试只验它不强制 requiresFileLock。
        tracksFileHistory: () => '/tmp/x',
      }),
    ).not.toThrow();
  });

  it('adaptAgentTool 对 edit_file 缺 tracksFileHistory 装配期 throw（per-file 回退必需）', async () => {
    const { adaptAgentTool } = await import('../../src/tools/tabcode-adapter.js');
    const fakeEdit = {
      name: 'edit_file',
      description: '',
      parameters: {},
      execute: async () => ({ success: true }),
    } as unknown as Parameters<typeof adaptAgentTool>[0];
    // 传 requiresFileLock + osErrorPath 绕过前两个断言，单独钉死 tracksFileHistory 缺失路径。
    expect(() =>
      adaptAgentTool(fakeEdit, {
        deps: {},
        isReadOnly: false,
        llmDescription: 'test stub',
        requiresFileLock: () => '/tmp/x',
        osErrorPath: () => '/tmp/x',
      }),
    ).toThrow(/tracksFileHistory/);
  });

  it('adaptAgentTool 对 delete_file 缺 tracksFileHistory 装配期 throw（per-file 回退必需）', async () => {
    const { adaptAgentTool } = await import('../../src/tools/tabcode-adapter.js');
    const fakeDelete = {
      name: 'delete_file',
      description: '',
      parameters: {},
      execute: async () => ({ success: true }),
    } as unknown as Parameters<typeof adaptAgentTool>[0];
    // delete_file 不在 LOCK_REQUIRED_TOOLS，但在 FILE_HISTORY_REQUIRED_TOOLS：
    // 传 osErrorPath 绕过 W11 断言后，仍应因缺 tracksFileHistory 而 throw。
    expect(() =>
      adaptAgentTool(fakeDelete, {
        deps: {},
        isReadOnly: false,
        llmDescription: 'test stub',
        osErrorPath: () => '/tmp/x',
      }),
    ).toThrow(/tracksFileHistory/);
  });
});
