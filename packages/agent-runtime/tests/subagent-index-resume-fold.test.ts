/**
 * W2（resume 索引 phase，2026-05-30）：subagents.jsonl 在 resume 双写下的
 * 「按最新 run 折叠」+ run 序号计算回归。
 *
 * 背景：resume 复用同一 childId → 同一 subSessionId 会再写一对 started/ended。
 * 消费方若按 subSessionId 朴素折叠会被多组 started/ended 搞乱状态 / 孤儿判定。
 * `foldSubagentRuns` 按 (subSessionId, runSeq) 取**最新 run** 折叠：
 *   - resume 正常完成 → 折到最新 run 的终态；
 *   - 最新 run 起跑但无 ended（崩溃孤儿）→ 如实折成 'running'，不被上一 run 的
 *     'completed' 污染（这正是 electron 端 last-write-wins reader 的盲区，本工具补齐）。
 *
 * `getNextRunSeq` 算下一次 run 的序号（spawn=1，第 N 次 resume=N+1），跨进程重启
 * 也正确（读持久化文件）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  SubagentIndexWriter,
  foldSubagentRuns,
  type SubagentIndexEntry,
} from '../src/session/subagent-index.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-fold-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function start(subSessionId: string, runSeq: number, createdAt: number, extra: Partial<SubagentIndexEntry> = {}): SubagentIndexEntry {
  return {
    phase: 'started',
    parentSessionId: 'p',
    subSessionId,
    childId: subSessionId.replace(/^agent-/, ''),
    shortId: 'sh',
    runSeq,
    resumedFrom: runSeq > 1 ? subSessionId.replace(/^agent-/, '') : undefined,
    task: `task-run-${runSeq}`,
    model: 'sonnet',
    createdAt,
    createdAtISO: new Date(createdAt).toISOString(),
    paths: { sessionDir: 's', messagesPath: 'm', snapshotsPath: 'sn', eventsPath: 'e' },
    ...extra,
  } as SubagentIndexEntry;
}

function ended(subSessionId: string, runSeq: number, status: 'completed' | 'failed' | 'cancelled', endedAt: number): SubagentIndexEntry {
  return {
    phase: 'ended',
    parentSessionId: 'p',
    subSessionId,
    childId: subSessionId.replace(/^agent-/, ''),
    runSeq,
    status,
    endedAt,
    endedAtISO: new Date(endedAt).toISOString(),
    finalTextLength: 10,
    durationMs: 5,
  } as SubagentIndexEntry;
}

describe('foldSubagentRuns', () => {
  it('单次 spawn：折成 1 个 run，runSeq=1，resumed=false，终态取 ended', () => {
    const entries = [
      start('agent-a', 1, 100),
      ended('agent-a', 1, 'completed', 105),
    ];
    const folded = foldSubagentRuns(entries);
    expect(folded).toHaveLength(1);
    expect(folded[0].runSeq).toBe(1);
    expect(folded[0].totalRuns).toBe(1);
    expect(folded[0].resumed).toBe(false);
    expect(folded[0].status).toBe('completed');
    expect(folded[0].childId).toBe('a');
  });

  it('spawn + resume 都正常完成：折到最新 run（runSeq=2, resumed=true, 终态取 run2）', () => {
    const entries = [
      start('agent-a', 1, 100),
      ended('agent-a', 1, 'completed', 105),
      start('agent-a', 2, 200),
      ended('agent-a', 2, 'failed', 205),
    ];
    const folded = foldSubagentRuns(entries);
    expect(folded).toHaveLength(1);
    const r = folded[0];
    expect(r.runSeq).toBe(2);
    expect(r.totalRuns).toBe(2);
    expect(r.resumed).toBe(true);
    // 最新 run 的终态（不是 run1 的 completed）
    expect(r.status).toBe('failed');
    expect(r.createdAt).toBe(200);
    expect(r.endedAt).toBe(205);
    expect(r.task).toBe('task-run-2');
  });

  it('started 行带 role → 折叠后 role 透出（重启 / 刷新后 chip 显示角色而非「子 Agent · 短id」）', () => {
    const entries = [
      start('agent-a', 1, 100, { role: '科普撰稿人' } as Partial<SubagentIndexEntry>),
      ended('agent-a', 1, 'completed', 105),
    ];
    const folded = foldSubagentRuns(entries);
    expect(folded).toHaveLength(1);
    expect(folded[0].role).toBe('科普撰稿人');
  });

  it('started 行无 role（旧条目 / 主 Agent 没填）→ 折叠后 role 缺省（消费方回落）', () => {
    const folded = foldSubagentRuns([
      start('agent-a', 1, 100),
      ended('agent-a', 1, 'completed', 105),
    ]);
    expect(folded[0].role).toBeUndefined();
  });

  it('resume run 起跑无 ended（崩溃孤儿）：如实折成 running，不被 run1 的 completed 污染', () => {
    const entries = [
      start('agent-a', 1, 100),
      ended('agent-a', 1, 'completed', 105),
      start('agent-a', 2, 200), // run2 起跑后崩溃，无 ended
    ];
    const folded = foldSubagentRuns(entries);
    expect(folded).toHaveLength(1);
    expect(folded[0].runSeq).toBe(2);
    expect(folded[0].status).toBe('running'); // 关键：不是 'completed'
    expect(folded[0].endedAt).toBeUndefined();
  });

  it('多 subSession 混合 + 旧条目无 runSeq（视为 1）：互不串号，按 createdAt 升序', () => {
    const entries: SubagentIndexEntry[] = [
      // 老格式：无 runSeq 字段
      { ...start('agent-old', 1, 50), runSeq: undefined } as SubagentIndexEntry,
      ended('agent-old', 1, 'completed', 55),
      start('agent-a', 1, 100),
      ended('agent-a', 1, 'completed', 105),
      start('agent-a', 2, 300),
      ended('agent-a', 2, 'completed', 305),
      start('agent-b', 1, 200),
      ended('agent-b', 1, 'cancelled', 205),
    ];
    const folded = foldSubagentRuns(entries);
    expect(folded).toHaveLength(3);
    // 升序 createdAt：old(50) < b(200) < a(300, 最新 run)
    expect(folded.map((f) => f.childId)).toEqual(['old', 'b', 'a']);
    const a = folded.find((f) => f.childId === 'a')!;
    expect(a.runSeq).toBe(2);
    expect(a.resumed).toBe(true);
    const old = folded.find((f) => f.childId === 'old')!;
    expect(old.runSeq).toBe(1); // undefined runSeq 视为 1
    expect(old.resumed).toBe(false);
  });
});

describe('SubagentIndexWriter.recordStart role 落盘', () => {
  it('recordStart({ role }) → readEntries 读回 started 行带 role → foldSubagentRuns 透出', async () => {
    const writer = new SubagentIndexWriter(tmpDir, 'parent-role-1');
    await writer.recordStart({
      subSessionId: 'agent-r',
      childId: 'r',
      shortId: 'r0',
      runSeq: 1,
      task: '撰写内行星科普文章',
      role: '科普撰稿人',
      model: 'sonnet',
      createdAt: 1,
      paths: { sessionDir: 's', messagesPath: 'm', snapshotsPath: 'sn', eventsPath: 'e' },
    });
    const entries = await writer.readEntries();
    const started = entries.find((e) => e.phase === 'started');
    expect(started && 'role' in started ? started.role : undefined).toBe('科普撰稿人');
    expect(foldSubagentRuns(entries)[0].role).toBe('科普撰稿人');
  });
});

describe('SubagentIndexWriter.getNextRunSeq', () => {
  it('空索引 → 下一个 run 序号为 1', async () => {
    const writer = new SubagentIndexWriter(tmpDir, 'parent-seq-1');
    expect(await writer.getNextRunSeq('agent-x')).toBe(1);
  });

  it('已有 1 条 started → 下一个为 2；按 subSessionId 隔离计数', async () => {
    const writer = new SubagentIndexWriter(tmpDir, 'parent-seq-2');
    await writer.recordStart({
      subSessionId: 'agent-x',
      childId: 'x',
      shortId: 'x0',
      runSeq: 1,
      task: 't',
      model: 'sonnet',
      createdAt: 1,
      paths: { sessionDir: 's', messagesPath: 'm', snapshotsPath: 'sn', eventsPath: 'e' },
    });
    // 另一个 subSession 的 started 不应影响 agent-x 计数
    await writer.recordStart({
      subSessionId: 'agent-y',
      childId: 'y',
      shortId: 'y0',
      runSeq: 1,
      task: 't',
      model: 'sonnet',
      createdAt: 1,
      paths: { sessionDir: 's', messagesPath: 'm', snapshotsPath: 'sn', eventsPath: 'e' },
    });

    expect(await writer.getNextRunSeq('agent-x')).toBe(2);
    expect(await writer.getNextRunSeq('agent-y')).toBe(2);
    expect(await writer.getNextRunSeq('agent-z')).toBe(1);
  });
});
