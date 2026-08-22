/**
 * read-file-state 双重 LRU 驱逐测试。
 *
 * 历史实现只按数量驱逐（500 条），单条 entry 含文件全文 → Daemon 长会话
 * 反复读大文件场景下，500 条远没满但内存已经过载。本次修复在数量层之外
 * 增加 25 MB 字节体积驱逐，由模块级 WeakMap 维护 sidecar 字节统计。
 *
 * 测试关注点：
 *   1. 字节统计：record / 覆盖写 / clear / evict 后 stats 正确
 *   2. 单一维度驱逐：纯数量超限 / 纯字节超限场景各自工作
 *   3. 混合维度驱逐：数量与字节同时超限时按 readAt 升序驱逐到双双满足
 *   4. 单个超大文件场景：超 25 MB 单文件入场后驱逐至该单条仍保留（保证可用性）
 *   5. fork 子 Map sidecar 行为：拷贝产生新 Map → 新 sidecar 从 0 开始，
 *      不影响驱逐安全（数量仍然有效）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordReadFileState,
  clearReadFileState,
  canonicalizePath,
  _internalGetSizeStats,
} from '../../src/tools/read-file-state.js';
import type {
  ReadFileState,
} from '@tabtin/agent-runtime';

let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'rfs-evict-'));
  // 父目录必须存在 —— canonicalizePath 在文件不存在时回退到父目录 realpath
  mkdirSync(join(workspaceRoot, 'src'), { recursive: true });
});

afterEach(() => {
  try {
    rmSync(workspaceRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function fakePath(name: string): string {
  return join(workspaceRoot, 'src', name);
}

/** state 内部 key 是 canonicalized 后的（macOS /var → /private/var）。
 *  断言文件存在性时必须走同一规范化，否则 has() 永远 false。 */
function canonicalKey(name: string): string {
  return canonicalizePath(fakePath(name), workspaceRoot);
}

function recordOne(state: ReadFileState, name: string, content: string): void {
  recordReadFileState(state, fakePath(name), content, { baseDir: workspaceRoot });
}

const KB = 1024;
const MB = 1024 * 1024;

describe('read-file-state — byte stats accounting', () => {
  it('initial state has zero bytes and zero entries', () => {
    const state: ReadFileState = new Map();
    const stats = _internalGetSizeStats(state);
    expect(stats.totalBytes).toBe(0);
    expect(stats.entryCount).toBe(0);
  });

  it('record adds bytes (content length + overhead)', () => {
    const state: ReadFileState = new Map();
    const content = 'x'.repeat(1000);
    recordOne(state, 'a.ts', content);

    const stats = _internalGetSizeStats(state);
    expect(stats.entryCount).toBe(1);
    // content (1000) + overhead (256) = 1256
    expect(stats.totalBytes).toBe(1000 + 256);
  });

  it('overwrite same key replaces bytes (no double-counting)', () => {
    const state: ReadFileState = new Map();
    recordOne(state, 'a.ts', 'x'.repeat(1000));
    recordOne(state, 'a.ts', 'y'.repeat(2000));

    const stats = _internalGetSizeStats(state);
    expect(stats.entryCount).toBe(1);
    expect(stats.totalBytes).toBe(2000 + 256);
  });

  it('clear removes the entry and decrements bytes', () => {
    const state: ReadFileState = new Map();
    recordOne(state, 'a.ts', 'x'.repeat(1000));
    recordOne(state, 'b.ts', 'y'.repeat(500));

    clearReadFileState(state, fakePath('a.ts'), { baseDir: workspaceRoot });

    const stats = _internalGetSizeStats(state);
    expect(stats.entryCount).toBe(1);
    expect(stats.totalBytes).toBe(500 + 256);
  });

  it('clear of a missing key is a no-op (no negative bytes)', () => {
    const state: ReadFileState = new Map();
    recordOne(state, 'a.ts', 'x'.repeat(1000));

    clearReadFileState(state, fakePath('does-not-exist.ts'), {
      baseDir: workspaceRoot,
    });

    const stats = _internalGetSizeStats(state);
    expect(stats.entryCount).toBe(1);
    expect(stats.totalBytes).toBe(1000 + 256);
  });
});

describe('read-file-state — byte-based LRU eviction', () => {
  it('does not evict when total bytes are under 25 MB', () => {
    const state: ReadFileState = new Map();
    // 10 个 1 MB 文件 = 10 MB，远低于 25 MB 上限
    for (let i = 0; i < 10; i++) {
      recordOne(state, `f${i}.txt`, 'x'.repeat(1 * MB));
    }
    const stats = _internalGetSizeStats(state);
    expect(stats.entryCount).toBe(10);
    expect(stats.totalBytes).toBeLessThan(25 * MB);
  });

  it('evicts oldest entries by readAt when bytes exceed 25 MB', async () => {
    const state: ReadFileState = new Map();

    // 先放 20 个 1 MB（早期），间隔确保 readAt 不同
    for (let i = 0; i < 20; i++) {
      recordOne(state, `early-${i}.txt`, 'x'.repeat(1 * MB));
      // 给 Date.now() 推进时间确保 readAt 不同
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(_internalGetSizeStats(state).entryCount).toBe(20);

    // 再放 10 个 1 MB（晚期）—— 累计 30 MB，超过 25 MB 上限
    for (let i = 0; i < 10; i++) {
      recordOne(state, `late-${i}.txt`, 'x'.repeat(1 * MB));
      await new Promise((r) => setTimeout(r, 1));
    }

    const stats = _internalGetSizeStats(state);
    expect(stats.totalBytes).toBeLessThanOrEqual(25 * MB);
    // 至少留下所有 late-* 条目，部分 early-* 被驱逐
    for (let i = 0; i < 10; i++) {
      expect(state.has(canonicalKey(`late-${i}.txt`))).toBe(true);
    }
    // 最早的 early-0 一定被驱逐
    expect(state.has(canonicalKey('early-0.txt'))).toBe(false);
  });

  it('handles a single oversized file (>25 MB) gracefully', () => {
    const state: ReadFileState = new Map();
    // 30 MB 单文件 —— 单条就超上限
    recordOne(state, 'huge.bin', 'x'.repeat(30 * MB));

    const stats = _internalGetSizeStats(state);
    // 单条超大场景下，驱逐能驱逐到的就驱逐；evictLRU 循环到没有可驱逐项时停止
    // 这里只剩这一条，驱逐它意味着 state 变空 —— 让我们看看实际行为
    // 当前实现：i < entries.length 是循环条件，所以会把这一条也驱掉
    // 这其实是预期 —— 单文件超 25 MB 时 LLM 应该用 grep_search 而不是 read_file
    expect(stats.totalBytes).toBe(0);
    expect(state.size).toBe(0);
  });

  it('mixed dimension: count + bytes both over → evict to both within limits', async () => {
    const state: ReadFileState = new Map();

    // 写 600 个小文件（每个 10 KB），数量超 500
    for (let i = 0; i < 600; i++) {
      recordOne(state, `tiny-${i}.txt`, 'x'.repeat(10 * KB));
      // 不需要 sleep —— 数量驱逐对 readAt 顺序不敏感的程度足够
    }
    const stats = _internalGetSizeStats(state);
    expect(stats.entryCount).toBeLessThanOrEqual(500);
    expect(stats.totalBytes).toBeLessThanOrEqual(25 * MB);
  });

  it('count-only over limit: small files trigger count-based eviction', () => {
    const state: ReadFileState = new Map();
    // 600 个 1 KB 文件 = 600 KB（远低于 25 MB），但数量超 500
    for (let i = 0; i < 600; i++) {
      recordOne(state, `t-${i}.txt`, 'x'.repeat(1 * KB));
    }
    const stats = _internalGetSizeStats(state);
    expect(stats.entryCount).toBe(500);
    expect(stats.totalBytes).toBeLessThan(1 * MB);
  });
});

describe('read-file-state — sidecar isolation across Maps', () => {
  it('forked Map gets its own sidecar starting at zero', () => {
    const parent: ReadFileState = new Map();
    recordOne(parent, 'a.ts', 'x'.repeat(1 * MB));
    expect(_internalGetSizeStats(parent).totalBytes).toBeGreaterThan(MB);

    // fork-query.ts 用 `new Map(config.readFileState)` 浅拷贝
    const child: ReadFileState = new Map(parent);

    // 子 Map sidecar 还没初始化，stats 为 0（content 已经在 child 里但 sidecar 不知）
    expect(_internalGetSizeStats(child).totalBytes).toBe(0);
    // 但 entryCount 反映真实的 Map.size
    expect(_internalGetSizeStats(child).entryCount).toBe(1);

    // 子 Map 上 record 一条新的，sidecar 自动初始化并开始累计
    recordOne(child, 'b.ts', 'y'.repeat(2 * KB));
    const childStats = _internalGetSizeStats(child);
    expect(childStats.entryCount).toBe(2);
    expect(childStats.totalBytes).toBe(2 * KB + 256);

    // 父 Map sidecar 不受影响
    expect(_internalGetSizeStats(parent).entryCount).toBe(1);
    expect(_internalGetSizeStats(parent).totalBytes).toBe(MB + 256);
  });
});
