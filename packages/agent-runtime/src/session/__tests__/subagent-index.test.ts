/**
 * SubagentIndexWriter 单元测试（阶段 8 子 Agent 可观测性）。
 *
 * 覆盖：
 *   1. start / end 两类条目独立 append。
 *   2. 字段映射（ISO timestamp / truncate 超长 task）。
 *   3. 文件路径在父 session 顶层（不是 subagents/ 子目录里）。
 *   4. append-only：同一 subSessionId 出现 started + ended 两条独立行。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SubagentIndexWriter } from '../subagent-index.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-index-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readLines(parentSessionId: string): unknown[] {
  const filePath = path.join(tmpDir, parentSessionId, 'subagents.jsonl');
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('SubagentIndexWriter', () => {
  it('writes index at {parentSessionDir}/{parentSessionId}/subagents.jsonl', () => {
    const writer = new SubagentIndexWriter(tmpDir, 'parent-1');
    const expected = path.join(tmpDir, 'parent-1', 'subagents.jsonl');
    expect(writer.getFilePath()).toBe(expected);
    expect(fs.existsSync(path.join(tmpDir, 'parent-1'))).toBe(true);
  });

  it('recordStart appends a phase=started row with ISO + relative paths + parentToolCallId', async () => {
    const writer = new SubagentIndexWriter(tmpDir, 'parent-2');
    const createdAt = Date.parse('2026-05-21T00:00:00.000Z');
    await writer.recordStart({
      subSessionId: 'agent-xyz',
      childId: 'xyz',
      shortId: 'xyz0',
      parentToolCallId: 'toolu_parent_abc',
      task: 'do something',
      model: 'sonnet',
      createdAt,
      paths: {
        sessionDir: 'subagents/agent-xyz',
        messagesPath: 'subagents/agent-xyz/messages.jsonl',
        snapshotsPath: 'subagents/agent-xyz/snapshots.jsonl',
        eventsPath: 'subagents/agent-xyz/events.jsonl',
      },
    });

    const lines = readLines('parent-2');
    expect(lines).toHaveLength(1);
    const entry = lines[0] as Record<string, unknown>;
    expect(entry.phase).toBe('started');
    expect(entry.parentSessionId).toBe('parent-2');
    expect(entry.subSessionId).toBe('agent-xyz');
    expect(entry.childId).toBe('xyz');
    expect(entry.shortId).toBe('xyz0');
    expect(entry.parentToolCallId).toBe('toolu_parent_abc');
    expect(entry.task).toBe('do something');
    expect(entry.model).toBe('sonnet');
    expect(entry.createdAt).toBe(createdAt);
    expect(entry.createdAtISO).toBe('2026-05-21T00:00:00.000Z');
    expect(entry.paths).toEqual({
      sessionDir: 'subagents/agent-xyz',
      messagesPath: 'subagents/agent-xyz/messages.jsonl',
      snapshotsPath: 'subagents/agent-xyz/snapshots.jsonl',
      eventsPath: 'subagents/agent-xyz/events.jsonl',
    });
  });

  it('recordStart with no parentToolCallId omits the field (caller 直接调 forkQuery 场景)', async () => {
    const writer = new SubagentIndexWriter(tmpDir, 'parent-2b');
    await writer.recordStart({
      subSessionId: 'agent-xyz',
      childId: 'xyz',
      shortId: 'xyz0',
      task: 't',
      model: 'sonnet',
      createdAt: 0,
      paths: {
        sessionDir: 'subagents/agent-xyz',
        messagesPath: 'subagents/agent-xyz/messages.jsonl',
        snapshotsPath: 'subagents/agent-xyz/snapshots.jsonl',
        eventsPath: 'subagents/agent-xyz/events.jsonl',
      },
    });
    const entry = readLines('parent-2b')[0] as Record<string, unknown>;
    expect('parentToolCallId' in entry).toBe(false);
  });

  it('recordEnd appends a phase=ended row with status + duration', async () => {
    const writer = new SubagentIndexWriter(tmpDir, 'parent-3');
    const endedAt = Date.parse('2026-05-21T00:00:10.000Z');
    await writer.recordEnd({
      subSessionId: 'agent-xyz',
      childId: 'xyz',
      status: 'completed',
      endedAt,
      finalTextLength: 42,
      durationMs: 10_000,
    });

    const lines = readLines('parent-3');
    expect(lines).toHaveLength(1);
    const entry = lines[0] as Record<string, unknown>;
    expect(entry.phase).toBe('ended');
    expect(entry.status).toBe('completed');
    expect(entry.finalTextLength).toBe(42);
    expect(entry.durationMs).toBe(10_000);
    expect(entry.endedAtISO).toBe('2026-05-21T00:00:10.000Z');
    expect(entry.errorMessage).toBeUndefined();
  });

  it('append-only: a full subagent lifecycle leaves two independent rows', async () => {
    const writer = new SubagentIndexWriter(tmpDir, 'parent-4');
    await writer.recordStart({
      subSessionId: 'agent-aaa',
      childId: 'aaa',
      shortId: 'aaa0',
      task: 't',
      model: 'sonnet',
      createdAt: 1,
      paths: {
        sessionDir: '/p',
        messagesPath: '/p/m',
        snapshotsPath: '/p/s',
        eventsPath: '/p/e',
      },
    });
    await writer.recordEnd({
      subSessionId: 'agent-aaa',
      childId: 'aaa',
      status: 'failed',
      endedAt: 2,
      finalTextLength: 0,
      durationMs: 1,
      errorMessage: 'boom',
    });

    const lines = readLines('parent-4') as Array<{ phase: string; status?: string }>;
    expect(lines).toHaveLength(2);
    expect(lines[0].phase).toBe('started');
    expect(lines[1].phase).toBe('ended');
    expect(lines[1].status).toBe('failed');
  });

  it('truncates task and errorMessage that exceed 500 chars', async () => {
    const writer = new SubagentIndexWriter(tmpDir, 'parent-5');
    const longTask = 'x'.repeat(2000);
    const longErr = 'y'.repeat(2000);
    await writer.recordStart({
      subSessionId: 'agent-zzz',
      childId: 'zzz',
      shortId: 'zzz0',
      task: longTask,
      model: 'sonnet',
      createdAt: 0,
      paths: {
        sessionDir: '/p',
        messagesPath: '/p/m',
        snapshotsPath: '/p/s',
        eventsPath: '/p/e',
      },
    });
    await writer.recordEnd({
      subSessionId: 'agent-zzz',
      childId: 'zzz',
      status: 'failed',
      endedAt: 1,
      finalTextLength: 0,
      durationMs: 1,
      errorMessage: longErr,
    });

    const [start, end] = readLines('parent-5') as Array<{ task?: string; errorMessage?: string }>;
    expect(start.task!.length).toBeLessThanOrEqual(500);
    expect(start.task!.endsWith('...')).toBe(true);
    expect(end.errorMessage!.length).toBeLessThanOrEqual(500);
    expect(end.errorMessage!.endsWith('...')).toBe(true);
  });
});
