/**
 * Wave 2 envelope path 字段一致性 e2e 测试（2026-05-13）
 *
 * **Round 1 technical reviewer M-1 共识修复后回归测试**：
 *
 * 实施 Wave 2 时 action-tools 一侧 fileEditTool / fileWriteTool catch 后
 * 透传 `path: err.path` 到 standardizeLegacyResult；adapter
 * `actionResultToToolResult` 提取 `result.path` 传给 errorResultEnvelope。
 * 修复前：写盘前同步校验产出的 envelope 缺 `path` 字段，偏离基线 B5-1
 * 「字节一致」承诺；修复后：写盘前 envelope 跟入口校验 envelope 字段对齐。
 *
 * **跟入口校验对照**：入口 validateReadBeforeWrite 走 errorResultEnvelope
 * 默认就带 path（read-file-state.ts:617-624）；写盘前同步路径要通过
 * actionResultToToolResult 提取 path 透传。本测试断言两条路径的 envelope
 * 都含 path 字段，且 path 值跟 canonical 路径字面对齐。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTabCodeTools } from '../../src/tools/tabcode-adapter';
import {
  canonicalizePath,
  recordReadFileState,
} from '../../src/tools/read-file-state';
import type {
  ReadFileState,
  ToolContext,
} from '@tabtin/agent-runtime';

let tmpDir: string;
let file: string;

beforeEach(async () => {
  const raw = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'wave2-envelope-'));
  tmpDir = await fsPromises.realpath(raw);
  file = path.join(tmpDir, 'test.txt');
  await fsPromises.writeFile(file, 'original\n');
});

afterEach(async () => {
  await fsPromises.rm(tmpDir, { recursive: true, force: true });
});

function makeCtx(state: ReadFileState): ToolContext {
  return {
    readFileState: state,
    workspaceRoot: tmpDir,
    // **关键**：messages 字段必须有（read_file dedup 用），否则
    // maybeReturnUnchangedReadStub 内 `ctx.messages.length` NPE。
    // 本测试不调 read_file，所以空数组够用。
    messages: [],
  } as unknown as ToolContext;
}

describe('Wave 2 envelope path 字段一致性 (端到端 / B5-1 基线对齐回归)', () => {
  it('写盘前 B6-1「没读过快照」throw → envelope 含 path 字段', async () => {
    const state: ReadFileState = new Map();
    const ctx = makeCtx(state);
    const tools = createTabCodeTools({ workspaceRoot: () => tmpDir });
    const editTool = tools.find((t) => t.name === 'edit_file')!;

    const res = await editTool.execute(
      { path: file, old_string: 'original', new_string: 'edited' },
      ctx,
    );
    const parsed = JSON.parse(res.content as string);

    expect(parsed.success).toBe(false);
    expect(parsed.error_kind).toBe('tool_stale_read');
    expect(parsed.error_kind).toBe('tool_stale_read');
    expect('path' in parsed).toBe(true);
    expect(typeof parsed.path).toBe('string');
    // path 字段 = canonical 路径（realpath 解析后绝对路径）
    expect(parsed.path).toBe(canonicalizePath(file));
  });

  it('写盘前真 stale（content 不一致）throw → envelope 含 path 字段', async () => {
    const state: ReadFileState = new Map();
    // 先 record snapshot 模拟 LLM 之前 read 过
    recordReadFileState(state, file, 'original\n', {
      mtimeMs: Math.floor(Date.now() - 60_000),
      baseDir: tmpDir,
    });
    const ctx = makeCtx(state);

    // 外部改文件让 content 不一致
    await fsPromises.writeFile(file, 'externally modified\n');
    const future = (Date.now() + 60_000) / 1000;
    await fsPromises.utimes(file, future, future);

    const tools = createTabCodeTools({ workspaceRoot: () => tmpDir });
    const editTool = tools.find((t) => t.name === 'edit_file')!;
    const res = await editTool.execute(
      { path: file, old_string: 'externally', new_string: 'replaced' },
      ctx,
    );
    const parsed = JSON.parse(res.content as string);

    expect(parsed.success).toBe(false);
    expect(parsed.error_kind).toBe('tool_stale_read');
    expect(parsed.error_kind).toBe('tool_stale_read');
    expect('path' in parsed).toBe(true);
    expect(parsed.path).toBe(canonicalizePath(file));
  });

  it('write_file 覆写路径 throw → envelope 含 path 字段', async () => {
    const state: ReadFileState = new Map();
    recordReadFileState(state, file, 'original\n', {
      mtimeMs: Math.floor(Date.now() - 60_000),
      baseDir: tmpDir,
    });
    const ctx = makeCtx(state);

    await fsPromises.writeFile(file, 'externally modified\n');
    const future = (Date.now() + 60_000) / 1000;
    await fsPromises.utimes(file, future, future);

    const tools = createTabCodeTools({ workspaceRoot: () => tmpDir });
    const writeTool = tools.find((t) => t.name === 'write_file')!;
    const res = await writeTool.execute(
      { path: file, contents: 'agent override\n' },
      ctx,
    );
    const parsed = JSON.parse(res.content as string);

    expect(parsed.success).toBe(false);
    expect(parsed.error_kind).toBe('tool_stale_read');
    expect(parsed.error_kind).toBe('tool_stale_read');
    expect('path' in parsed).toBe(true);
    expect(parsed.path).toBe(canonicalizePath(file));
  });
});
