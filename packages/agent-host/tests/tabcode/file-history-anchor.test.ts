/**
 * per-file 回退 · anchor 透传接线（§3.9 规则 2）
 *
 * 验收「工具层把备份归到哪个 anchor」：`tabcode-adapter` 的写文件工具在写盘前
 * 调 `ctx.fileHistory.trackEdit(anchorId, path)`，`anchorId` 取
 * `ctx.fileHistoryAnchorId ?? ctx.agentRunId`。
 *
 * 这正是 fork 继承的落点——子 runtime 的 query.ts 把**父轮 anchorId** 填进
 * `ToolContext.fileHistoryAnchorId`，所以子 agent 的 trackEdit 用父轮 anchor，
 * 子改的文件归到父轮、回退父轮一并恢复（语义层不变量见
 * `@tabtin/file-history-core` 的 FileHistoryService.test.ts「§3.9 规则 2」）。
 *
 * 三条断言：
 *   1. fileHistoryAnchorId 存在（子继承父）→ trackEdit 用它，**不**用 agentRunId。
 *   2. 只有 agentRunId（顶层 / legacy）→ trackEdit 回落 agentRunId。
 *   3. 两者都缺（无锚点）→ 跳过 trackEdit（与"无锚点"语义一致，不归错轮）。
 */

import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  FileHistorySink,
  Tool,
  ToolContext,
} from '@tabtin/agent-runtime';
import { createTabCodeTools } from '../../src/tools/tabcode-adapter.js';

let tmpDir: string;

beforeEach(async () => {
  const raw = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'fh-anchor-'));
  tmpDir = await fsPromises.realpath(raw);
});

afterEach(async () => {
  await fsPromises.rm(tmpDir, { recursive: true, force: true });
});

/** 记录每次 trackEdit 的 (anchorId, absPath)，断言归属正确轮。 */
class RecordingFileHistory implements FileHistorySink {
  readonly snapshots: string[] = [];
  readonly edits: Array<{ anchorId: string; absPath: string }> = [];
  async beginSnapshot(anchorId: string): Promise<void> {
    this.snapshots.push(anchorId);
  }
  async trackEdit(anchorId: string, absPath: string): Promise<void> {
    this.edits.push({ anchorId, absPath });
  }
}

function getTool(name: string): Tool {
  const tool = createTabCodeTools().find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not in createTabCodeTools()`);
  return tool;
}

function makeCtx(
  fileHistory: FileHistorySink,
  ids: { agentRunId?: string; fileHistoryAnchorId?: string },
): ToolContext {
  return {
    threadId: 'test',
    runtimeId: 'test',
    abortSignal: new AbortController().signal,
    messages: [],
    workspaceRoot: tmpDir,
    fileHistory,
    agentRunId: ids.agentRunId,
    fileHistoryAnchorId: ids.fileHistoryAnchorId,
  };
}

describe('§3.9 · tabcode-adapter trackEdit anchor 解析', () => {
  it('fileHistoryAnchorId 存在（子继承父）→ trackEdit 用它，不用 agentRunId', async () => {
    const fh = new RecordingFileHistory();
    // 子 runtime：agentRunId=子自己的 runId，fileHistoryAnchorId=父轮 anchorId
    const ctx = makeCtx(fh, { agentRunId: 'child-run', fileHistoryAnchorId: 'parent-run' });
    const file = path.join(tmpDir, 'new-by-child.txt');

    const res = await getTool('write_file').execute({ path: file, contents: 'hi' }, ctx);
    expect(res.isError).toBeFalsy();

    expect(fh.edits).toHaveLength(1);
    expect(fh.edits[0].anchorId).toBe('parent-run'); // ← 归父轮，不是 child-run
    expect(fh.edits[0].absPath).toBe(file);
  });

  it('只有 agentRunId（顶层 / legacy）→ trackEdit 回落 agentRunId', async () => {
    const fh = new RecordingFileHistory();
    const ctx = makeCtx(fh, { agentRunId: 'solo-run' });
    const file = path.join(tmpDir, 'new-solo.txt');

    const res = await getTool('write_file').execute({ path: file, contents: 'hi' }, ctx);
    expect(res.isError).toBeFalsy();

    expect(fh.edits).toHaveLength(1);
    expect(fh.edits[0].anchorId).toBe('solo-run');
  });

  it('两者都缺（无锚点）→ 跳过 trackEdit，绝不归错轮', async () => {
    const fh = new RecordingFileHistory();
    const ctx = makeCtx(fh, {});
    const file = path.join(tmpDir, 'new-anon.txt');

    const res = await getTool('write_file').execute({ path: file, contents: 'hi' }, ctx);
    expect(res.isError).toBeFalsy();

    expect(fh.edits).toHaveLength(0);
    // 文件仍正常写入——无锚点只是丢回退能力，不阻断工具执行（fail-soft）。
    expect(await fsPromises.readFile(file, 'utf8')).toBe('hi');
  });
});
