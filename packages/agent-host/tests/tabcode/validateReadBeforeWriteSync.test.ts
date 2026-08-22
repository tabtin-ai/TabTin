/**
 * validateReadBeforeWriteSync 单测（文件并发安全 Wave 2 / 2026-05-13）
 *
 * 覆盖基线 B2-1 ~ B2-3 + B6-1：
 *   - B2-1：跟异步版本 `validateReadBeforeWrite` 行为等价（共享 reducer
 *           思路；同 input 期望同 output，除「没读过」分支字面偏离）
 *   - B2-2：caller 责任收口（currentMtimeMs 已 Math.floor / currentContent
 *           已 normalize）
 *   - B2-3：纯函数，无 fs.* 异步 API
 *   - B6-1：没读过快照 → throw（不是放行）—— 写盘前严格于入口
 *
 * 覆盖基线 A1-4 ~ A1-7 + A2-4：
 *   - A1-4：mtime 量化 Math.floor
 *   - A1-5：+1ms 容忍
 *   - A1-6：isFullRead = offset === undefined && limit === undefined
 *   - A1-7：isFullRead && content 相等 → 放行（云同步抖动假阳性防御）
 *   - A2-4：OR 不变量 partial read 任何变化都 throw
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  canonicalizePath,
  validateReadBeforeWrite,
  validateReadBeforeWriteSync,
} from '../../src/tools/read-file-state.js';
import type {
  ReadFileState,
  ReadFileStateEntry,
} from '@tabtin/agent-runtime';

let tmpDir: string;
let testFilePath: string;
let canonicalTestFilePath: string;

beforeEach(() => {
  // 用 mkdtempSync + realpathSync 跑过 canonicalize 拿到真实路径，保证
  // makeState 写入的 key 跟 validateReadBeforeWriteSync 内部 canonicalize
  // 出的 key 字面一致（macOS `/tmp` → `/private/tmp` 漂移防御）。
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'vrbws-'));
  tmpDir = fs.realpathSync(raw);
  testFilePath = path.join(tmpDir, 'sample.txt');
  fs.writeFileSync(testFilePath, 'placeholder', 'utf8');
  canonicalTestFilePath = canonicalizePath(testFilePath);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeState(
  entries: Array<{ key: string; entry: ReadFileStateEntry }> = [],
): ReadFileState {
  const map: ReadFileState = new Map();
  for (const { key, entry } of entries) map.set(key, entry);
  return map;
}

/**
 * 解析 errorResult.content（JSON string）拿到 envelope 关键字段。
 * 跟 tabcode-adapter.ts 注入的 hook 字面同款解析路径，保证字节级一致。
 */
function parseEnvelope(
  result: { content: string | unknown[]; isError?: boolean } | null,
): {
  errorKind: string;
  errorKind: string;
  hint: string;
  path?: string;
  error: string;
} {
  expect(result).not.toBeNull();
  expect(result?.isError).toBe(true);
  const raw = result!.content;
  expect(typeof raw).toBe('string');
  const parsed = JSON.parse(raw as string) as {
    error_kind: string;
    error_kind: string;
    hint: string;
    path?: string;
    error: string;
  };
  return {
    errorKind: parsed.error_kind,
    errorKind: parsed.error_kind,
    hint: parsed.hint,
    path: parsed.path,
    error: parsed.error,
  };
}

describe('validateReadBeforeWriteSync — 纯函数行为（B2-1 ~ B2-3）', () => {
  it('state 未注入 → 静默放行（兼容 Memory 模式 / 旧测试）', () => {
    const result = validateReadBeforeWriteSync(undefined, testFilePath, {
      currentMtimeMs: 1234567890,
      currentContent: 'hello',
    });
    expect(result).toBeNull();
  });

  it('B6-1：state 存在但路径没读过 → throw STALE_READ（偏离入口校验的放行）', () => {
    const state = makeState(); // 空 state
    const result = validateReadBeforeWriteSync(state, testFilePath, {
      currentMtimeMs: 1234567890,
      currentContent: 'hello',
    });
    const env = parseEnvelope(result);
    expect(env.errorKind).toBe('tool_stale_read');
    expect(env.errorKind).toBe('tool_stale_read');
    expect(env.error).toContain('File has been modified externally');
    expect(env.error).toContain('Your snapshot is stale');
    expect(env.hint).toContain('Re-read the file with read_file');
  });

  it('mtime 一致 → 放行（snapshot 仍有效）', () => {
    const state = makeState([
      {
        key: canonicalTestFilePath,
        entry: {
          content: 'hello',
          timestamp: 1234567890,
          readAt: Date.now(),
          offset: undefined,
          limit: undefined,
        },
      },
    ]);
    const result = validateReadBeforeWriteSync(state, testFilePath, {
      currentMtimeMs: 1234567890,
      currentContent: 'hello',
    });
    expect(result).toBeNull();
  });

  it('A1-5：mtime +1ms 容忍 → 放行', () => {
    const state = makeState([
      {
        key: canonicalTestFilePath,
        entry: {
          content: 'hello',
          timestamp: 1234567890,
          readAt: Date.now(),
          offset: undefined,
          limit: undefined,
        },
      },
    ]);
    const result = validateReadBeforeWriteSync(state, testFilePath, {
      currentMtimeMs: 1234567891, // +1ms 内
      currentContent: 'should not matter',
    });
    expect(result).toBeNull();
  });

  it('A1-7：full read + mtime 漂移 + content 相同 → 放行（云同步抖动假阳性防御）', () => {
    const state = makeState([
      {
        key: canonicalTestFilePath,
        entry: {
          content: 'hello',
          timestamp: 1234567890,
          readAt: Date.now(),
          offset: undefined, // full read
          limit: undefined,
        },
      },
    ]);
    const result = validateReadBeforeWriteSync(state, testFilePath, {
      currentMtimeMs: 1234567999, // 远超 +1ms 容忍
      currentContent: 'hello', // 跟 snapshot content 字面相等
    });
    expect(result).toBeNull();
  });

  it('full read + mtime 漂移 + content 不同 → throw STALE_READ', () => {
    const state = makeState([
      {
        key: canonicalTestFilePath,
        entry: {
          content: 'hello',
          timestamp: 1234567890,
          readAt: Date.now(),
          offset: undefined,
          limit: undefined,
        },
      },
    ]);
    const result = validateReadBeforeWriteSync(state, testFilePath, {
      currentMtimeMs: 1234567999,
      currentContent: 'world (modified externally)',
    });
    const env = parseEnvelope(result);
    expect(env.errorKind).toBe('tool_stale_read');
    expect(env.errorKind).toBe('tool_stale_read');
  });

  it('A2-4 OR 不变量：partial read + mtime 漂移 → 任何 content 都 throw（不享受 isFullRead 兜底）', () => {
    const state = makeState([
      {
        key: canonicalTestFilePath,
        entry: {
          content: 'hello',
          timestamp: 1234567890,
          readAt: Date.now(),
          offset: 1, // partial read（read_file 写入时 offset 总有值）
          limit: 100,
        },
      },
    ]);
    // partial read，即便 content 跟 snapshot 字面相等，mtime 漂移也必 throw
    const result = validateReadBeforeWriteSync(state, testFilePath, {
      currentMtimeMs: 1234567999,
      currentContent: 'hello',
    });
    const env = parseEnvelope(result);
    expect(env.errorKind).toBe('tool_stale_read');
  });

  it('A2-4 OR 不变量：partial read + mtime 漂移 + content 不同 → throw（双重违规）', () => {
    const state = makeState([
      {
        key: canonicalTestFilePath,
        entry: {
          content: 'hello',
          timestamp: 1234567890,
          readAt: Date.now(),
          offset: 1,
          limit: 100,
        },
      },
    ]);
    const result = validateReadBeforeWriteSync(state, testFilePath, {
      currentMtimeMs: 1234567999,
      currentContent: 'modified',
    });
    const env = parseEnvelope(result);
    expect(env.errorKind).toBe('tool_stale_read');
  });

  it('A1-6：isFullRead 判定字面 = offset === undefined && limit === undefined', () => {
    // 仅 offset undefined（limit 有值）→ 不是 isFullRead
    const state1 = makeState([
      {
        key: canonicalTestFilePath,
        entry: {
          content: 'hello',
          timestamp: 1234567890,
          readAt: Date.now(),
          offset: undefined,
          limit: 100, // limit 有值 → 不是 full read
        },
      },
    ]);
    const result1 = validateReadBeforeWriteSync(state1, testFilePath, {
      currentMtimeMs: 1234567999,
      currentContent: 'hello',
    });
    expect(result1).not.toBeNull(); // throw

    // 仅 limit undefined（offset 有值）→ 不是 isFullRead
    const state2 = makeState([
      {
        key: canonicalTestFilePath,
        entry: {
          content: 'hello',
          timestamp: 1234567890,
          readAt: Date.now(),
          offset: 1,
          limit: undefined,
        },
      },
    ]);
    const result2 = validateReadBeforeWriteSync(state2, testFilePath, {
      currentMtimeMs: 1234567999,
      currentContent: 'hello',
    });
    expect(result2).not.toBeNull(); // throw
  });
});

describe('validateReadBeforeWriteSync — 跟 validateReadBeforeWrite 异步版本字节一致性对照', () => {
  // **已知字面偏离（共 2 处，详见 validateReadBeforeWriteSync jsdoc）**：
  //   - B6-1：「没读过快照」异步放行 / 同步 throw
  //   - A1-6 + A1-7：partial read + mtime 漂移异步看 content 字面相等放行 /
  //     同步严格判 isFullRead（partial → throw）—— 是 Wave 2 写盘前严格
  //     的有意 trade-off，dogfood 云盘抖动场景影响登记到「已知风险」段
  // 其他所有分支（snapshot 命中 + mtime 一致 + full read content 相等 + content
  // 不同 throw）必须行为字面一致。
  it('mtime 一致：异步 vs 同步同款放行', async () => {
    const entries = [
      {
        key: canonicalTestFilePath,
        entry: {
          content: 'hello',
          timestamp: 1234567890,
          readAt: Date.now(),
          offset: undefined,
          limit: undefined,
        },
      },
    ];
    const stateAsync: ReadFileState = makeState(entries);
    const stateSync: ReadFileState = makeState(entries);

    const asyncResult = await validateReadBeforeWrite(stateAsync, testFilePath, {
      fileExists: true,
      readToolName: 'read_file',
      currentMtimeMs: 1234567890,
      currentContent: 'hello',
    });
    const syncResult = validateReadBeforeWriteSync(stateSync, testFilePath, {
      currentMtimeMs: 1234567890,
      currentContent: 'hello',
    });

    expect(asyncResult).toBeNull();
    expect(syncResult).toBeNull();
  });

  it('mtime 漂移 + content 不同：异步 vs 同步同款 throw + 字面文案一致（基线 B5-1）', async () => {
    const entries = [
      {
        key: canonicalTestFilePath,
        entry: {
          content: 'hello',
          timestamp: 1234567890,
          readAt: Date.now(),
          offset: undefined,
          limit: undefined,
        },
      },
    ];
    const stateAsync = makeState(entries);
    const stateSync = makeState(entries);

    const asyncResult = await validateReadBeforeWrite(stateAsync, testFilePath, {
      fileExists: true,
      readToolName: 'read_file',
      currentMtimeMs: 1234568000,
      currentContent: 'modified externally',
    });
    const syncResult = validateReadBeforeWriteSync(stateSync, testFilePath, {
      currentMtimeMs: 1234568000,
      currentContent: 'modified externally',
    });

    const asyncEnv = parseEnvelope(asyncResult);
    const syncEnv = parseEnvelope(syncResult);

    // **字节对齐基线 B5-1 核心断言**：errorCode / errorKind / hint 完全一致
    expect(asyncEnv.errorCode).toBe(syncEnv.errorCode);
    expect(asyncEnv.errorKind).toBe(syncEnv.errorKind);
    expect(asyncEnv.hint).toBe(syncEnv.hint);
    // message 前缀一致（path 段可能因 realpath 差异而有大小写漂移，但前缀稳）
    expect(asyncEnv.error).toContain('File has been modified externally since you last read it');
    expect(syncEnv.error).toContain('File has been modified externally since you last read it');
  });
});
