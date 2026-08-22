/**
 * Smoke tests for the W3-simplified `FileToolResultStorage`.
 *
 * The W3 (2026-05-10) rewrite stripped the in-memory cache, LRU eviction,
 * `list()` / `asMap()` / `getAsync()` / `cleanupExpired()` / `rehydrate()`
 * surface, and the `.json` envelope format — all of those existed solely to
 * back the deleted `retrieve_tool_result` tool. The remaining contract is
 * tiny:
 *
 *   - `save(id, toolName, content)` writes raw content to a `.txt` under
 *     `<sessionDir>/tool-results/<safeId>.txt` (fire-and-forget, EEXIST
 *     silently swallowed so microcompact replays are idempotent).
 *   - `getFilePath(id)` returns the absolute path the same `id` would
 *     persist to (stable per id; no I/O).
 *
 * MemoryToolResultStorage is the headless / test fallback that returns an
 * empty path from `getFilePath()` and silently swallows `save()` (with a
 * one-time warning when oversized output would have been persisted).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileToolResultStorage,
  MemoryToolResultStorage,
  resolveToolResultStorage,
} from '../src/engine/tooling/tool-result-storage.js';

describe('FileToolResultStorage (W3 disk-only)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ftrs-test-w3-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('save writes raw content to <sessionDir>/tool-results/<id>.txt', async () => {
    const storage = new FileToolResultStorage(dir);
    storage.save('toolu_01abc', 'web_search', 'hello world');
    // Disk write is fire-and-forget; mkdir + writeFile are macrotasks, not
    // microtasks, so a setImmediate isn't enough. setTimeout(50) gives both
    // promises room to settle on every CI we ship to.
    await new Promise((r) => setTimeout(r, 50));

    const expected = join(dir, 'tool-results', 'toolu_01abc.txt');
    expect(existsSync(expected)).toBe(true);
    expect(readFileSync(expected, 'utf-8')).toBe('hello world');
  });

  it('getFilePath returns the same path that save would write to (deterministic)', () => {
    const storage = new FileToolResultStorage(dir);
    const p1 = storage.getFilePath('toolu_01abc');
    const p2 = storage.getFilePath('toolu_01abc');
    expect(p1).toBe(p2);
    expect(p1.endsWith('toolu_01abc.txt')).toBe(true);
    expect(p1).toContain(join(dir, 'tool-results'));
  });

  it('sanitises non-alphanumerics in id for the filename', () => {
    const storage = new FileToolResultStorage(dir);
    const path = storage.getFilePath('weird/id:with*chars');
    expect(path).toContain('weird_id_with_chars.txt');
  });

  it('duplicate save with same id is idempotent (wx flag swallows EEXIST)', async () => {
    const storage = new FileToolResultStorage(dir);
    const id = 'dup-id';
    storage.save(id, 't', 'first');
    await new Promise((r) => setTimeout(r, 50));
    // Second save should silently skip (wx -> EEXIST -> ignored). The file
    // on disk keeps the first content.
    expect(() => storage.save(id, 't', 'second')).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));
    expect(readFileSync(storage.getFilePath(id), 'utf-8')).toBe('first');
  });

  it('save fire-and-forget does not throw to the caller on disk failure', () => {
    // Pointing the storage at a path that cannot be written (parent file
    // exists as a regular file) — save() must not throw synchronously.
    const blocked = join(dir, 'blocked');
    require('node:fs').writeFileSync(blocked, ''); // make `blocked` a file, not a dir
    const storage = new FileToolResultStorage(blocked);
    expect(() => storage.save('id', 'tool', 'x')).not.toThrow();
  });

  it('logger receives non-EEXIST disk errors when injected', async () => {
    const warnings: Array<{ msg: string; extra?: Record<string, unknown> }> = [];
    const blocked = join(dir, 'asfile');
    require('node:fs').writeFileSync(blocked, ''); // turn target into a file so mkdir fails silently then writeFile fails
    const storage = new FileToolResultStorage(blocked, {
      logger: {
        warn: (msg, extra) => warnings.push({ msg, extra }),
      },
    });
    storage.save('id-123', 'tool', 'x');
    // Wait for the fire-and-forget write to settle.
    await new Promise((r) => setTimeout(r, 20));
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].msg).toContain('writeFile failed');
  });
});

describe('MemoryToolResultStorage (W3 headless fallback)', () => {
  it('save is a no-op (no throw, nothing to inspect)', () => {
    const storage = new MemoryToolResultStorage();
    expect(() => storage.save('id', 'tool', 'content')).not.toThrow();
  });

  it('getFilePath returns empty string (no fake recoverable path)', () => {
    const storage = new MemoryToolResultStorage();
    expect(storage.getFilePath('toolu_01abc')).toBe('');
  });

  it('getFilePath is stable regardless of id sanitisation needs', () => {
    const storage = new MemoryToolResultStorage();
    expect(storage.getFilePath('weird/id:with*chars')).toBe('');
  });

  it('save warns once when oversized output would have been persisted', () => {
    const warn = vi.fn();
    const storage = new MemoryToolResultStorage();
    const originalWarn = console.warn;
    console.warn = warn;
    try {
      storage.save('id-1', 'web_search', 'x'.repeat(100));
      storage.save('id-2', 'grep_search', 'y'.repeat(100));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('MemoryToolResultStorage');
      expect(warn.mock.calls[0]?.[0]).toContain('not persisted');
    } finally {
      console.warn = originalWarn;
    }
  });

  it('does not implement getResultsDir (callers ?.() to undefined)', () => {
    const storage = new MemoryToolResultStorage();
    // Intentional: MemoryToolResultStorage skips getResultsDir so the
    // adapter's `?.getResultsDir?.()` returns undefined → read_file
    // workspace exemption stays off in headless / test mode.
    // Cast to ToolResultStorage to access optional method shape.
    const asInterface = storage as unknown as { getResultsDir?: () => unknown };
    expect(asInterface.getResultsDir).toBeUndefined();
  });
});

describe('FileToolResultStorage.getResultsDir (W4 — read_file workspace 豁免源)', () => {
  it('returns the absolute <sessionDir>/tool-results path (canonical, realpath-resolved)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ftrs-resultsdir-'));
    try {
      const storage = new FileToolResultStorage(tmp);
      const dir = storage.getResultsDir();
      // **W4 (2026-05-12)**：构造函数走 realpathSync canonical normalize（防
      // dogfood 调试场景下 macOS `/var` ↔ `/private/var` symlink 不一致），
      // expected 同步走 realpath 才能字节级匹配。生产 `~/Library/...` 路径
      // 不过 symlink 时 realpath 是 noop，行为不变。
      const expected = realpathSync(join(tmp, 'tool-results'));
      expect(dir).toBe(expected);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('getFilePath(id) sits inside getResultsDir() — adapter 豁免前缀匹配前提', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ftrs-prefix-'));
    try {
      const storage = new FileToolResultStorage(tmp);
      const dir = storage.getResultsDir();
      const file = storage.getFilePath('toolu_test_123');
      // 这是 W4 豁免逻辑成立的前提：banner 里给 LLM 的 path 必须落在
      // getResultsDir() 返回的目录内，否则 checkFilePathSecurity 的精确
      // 前缀匹配豁免分支命不中。
      expect(file.startsWith(dir + '/')).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('resolveToolResultStorage', () => {
  it('returns the host-injected storage when present', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ftrs-resolve-'));
    try {
      const file = new FileToolResultStorage(tmp);
      const resolved = resolveToolResultStorage({ toolResultStorage: file });
      expect(resolved).toBe(file);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('falls back to MemoryToolResultStorage when nothing is wired', () => {
    const resolved = resolveToolResultStorage({});
    expect(resolved).toBeInstanceOf(MemoryToolResultStorage);
    expect(resolved.getFilePath('x')).toBe('');
  });
});

// Avoid unused-import lint warnings on `fsPromises` in CI when only some
// tests actually touch it (kept for future async assertions).
void fsPromises;
