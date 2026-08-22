/**
 * fork-observability-fault.test.ts — 阶段 8 Review fix
 *
 * 验证 fork-query.ts 的 finally 段在 storage dispose 抛错时**仍**会写出父
 * subagents.jsonl 的 ended 行。生产里这条容错由 `Promise.allSettled([...
 * dispose])` 实现（JS 标准），但需要被测试守护，否则未来重构成串行 await 就
 * 会让"子文件 flush 失败的子任务永远找不到 ended 索引"。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createMockProvider, createMockPermissionHandler, createMockToolProvider } from './test-utils.js';

// 让 SnapshotStorage.dispose 必然 throw —— 模拟磁盘满 / 权限被剥夺。
// EventStorage 同款 reject 也加上，验证两件都 throw 时索引仍写出。
// SessionStorage / SubagentIndexWriter / query.js **保持真实**——索引仍走真实 fs。
vi.mock('../src/session/snapshot-storage.js', () => ({
  SnapshotStorage: vi.fn().mockImplementation(() => ({
    filePath: '/tmp/mocked-snapshot.jsonl',
    append: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockRejectedValue(new Error('snapshot dispose blew up')),
  })),
}));

vi.mock('../src/session/event-storage.js', () => ({
  EventStorage: vi.fn().mockImplementation(() => ({
    filePath: '/tmp/mocked-event.jsonl',
    append: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockRejectedValue(new Error('event dispose blew up')),
  })),
}));

const { forkQuery } = await import('../src/subagent/fork-query.js');

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-fault-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readJsonLines(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('forkQuery dispose 容错（Review fix）', () => {
  it('Snapshot/Event dispose 双 throw 时，父 subagents.jsonl 仍写 ended 行', async () => {
    const provider = createMockProvider([
      [
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);

    const gen = forkQuery({
      parentMessages: [],
      taskPrompt: '容错测试',
      systemPrompt: '',
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      model: 'sonnet',
      sessionConfig: { sessionDir: tmpDir, threadId: 'parent-fault' },
    });

    // drain；fork-query finally 的 Promise.allSettled 应吞掉两个 dispose reject，
    // 不让异常冒出来阻断 recordEnd。
    let caught: unknown = null;
    try {
      for await (const _ of gen) {
        void _;
      }
    } catch (err) {
      caught = err;
    }
    // happy path 子 query 跑完不抛——fork-query 也不应因 dispose reject rethrow
    expect(caught).toBeNull();

    const indexFile = path.join(tmpDir, 'parent-fault', 'subagents.jsonl');
    const lines = readJsonLines(indexFile) as Array<{ phase: string; status?: string }>;
    expect(lines).toHaveLength(2);
    expect(lines[0].phase).toBe('started');
    expect(lines[1].phase).toBe('ended');
    expect(lines[1].status).toBe('completed');
  });
});
