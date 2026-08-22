/**
 * memo-store-interface.test.ts — MemoStore 接口契约测试
 *
 * 用一个最小实现（mock）满足接口契约，确保：
 *   - lookup 是同步纯查
 *   - putAlways / revoke 是 Promise
 *   - generation / sync 接口完整
 *   - 实现方可以用 lookupMemo helper 满足 lookup 契约
 */

import { describe, it, expect } from 'vitest';
import type {
  MemoStore,
  ApprovalMemoEntry,
  ApprovalMemoLookupResult,
} from '../src/types-v3';
import { lookupMemo } from '../src/pattern-key';

class MockMemoStore implements MemoStore {
  private entries: Record<string, ApprovalMemoEntry> = {};
  private _gen = 0;

  constructor(initial?: Record<string, ApprovalMemoEntry>) {
    if (initial) this.entries = { ...initial };
  }

  get generation(): number {
    return this._gen;
  }

  lookup(params: {
    toolName: string;
    subcmd: string;
    input: unknown;
    inWorkspace: boolean;
  }): ApprovalMemoLookupResult | null {
    return lookupMemo(this.entries, params);
  }

  async putAlways(key: string, entry: ApprovalMemoEntry): Promise<void> {
    this.entries[key] = entry;
    this._gen += 1;
  }

  async revoke(key: string): Promise<void> {
    delete this.entries[key];
    this._gen += 1;
  }

  async maybeRefetch(remoteGeneration: number): Promise<boolean> {
    if (remoteGeneration <= this._gen) return false;
    this._gen = remoteGeneration;
    return true;
  }

  async bootstrap(): Promise<void> {
    // no-op for test
  }

  replaceAll(entries: Record<string, ApprovalMemoEntry>, generation: number): void {
    this.entries = { ...entries };
    this._gen = generation;
  }
}

function entry(decision: 'allow' | 'deny'): ApprovalMemoEntry {
  return {
    decision,
    created_at: '2026-05-02T00:00:00Z',
    updated_at: '2026-05-02T00:00:00Z',
    approver_user_id: 'u-1',
    scope_description: `${decision}-entry`,
  };
}

describe('MemoStore 接口契约', () => {
  it('lookup 同步返回（不返 Promise）', () => {
    const store = new MockMemoStore();
    const r = store.lookup({ toolName: 'x', subcmd: 'y', input: {}, inWorkspace: false });
    // 类型上必须是 ApprovalMemoLookupResult | null（不能是 Promise）
    expect(r).toBeNull();
  });

  it('putAlways 异步 + 推进 generation', async () => {
    const store = new MockMemoStore();
    expect(store.generation).toBe(0);
    await store.putAlways('x::y:*', entry('allow'));
    expect(store.generation).toBe(1);
  });

  it('revoke 异步 + 推进 generation', async () => {
    const store = new MockMemoStore({ 'x::y:*': entry('allow') });
    await store.revoke('x::y:*');
    expect(store.lookup({ toolName: 'x', subcmd: 'y', input: {}, inWorkspace: true })).toBeNull();
  });

  it('maybeRefetch：本地 < remote 时返回 true 并更新 generation', async () => {
    const store = new MockMemoStore();
    expect(await store.maybeRefetch(5)).toBe(true);
    expect(store.generation).toBe(5);
    expect(await store.maybeRefetch(3)).toBe(false);
  });

  it('replaceAll 全量替换', () => {
    const store = new MockMemoStore({ 'a::b:*': entry('allow') });
    store.replaceAll({ 'c::d:*': entry('deny') }, 100);
    expect(store.generation).toBe(100);
    expect(store.lookup({ toolName: 'c', subcmd: 'd', input: {}, inWorkspace: true })?.decision).toBe('deny');
  });

  it('lookup 借助 lookupMemo helper 满足契约：specificity 顺序', () => {
    const tool = 'run_terminal_command';
    const subcmd = 'rm';
    const input = { command: 'rm -rf ./build' };
    // 构造 wildcard 级 entry
    const wildKey = `${tool}::${subcmd}:*`;
    const store = new MockMemoStore({ [wildKey]: entry('deny') });
    const r = store.lookup({ toolName: tool, subcmd, input, inWorkspace: true });
    expect(r?.decision).toBe('deny');
    expect(r?.specificity).toBe('wildcard');
  });
});
