/**
 * PlanStore adapter 单测—— LocalFilePlanStore + 共享校验。
 *
 * 覆盖：
 *   - normalizePlanTodos：默认值 / 去重 / 非空校验；
 *   - LocalFilePlanStore.create：落 working_dir/plans/*.plan.md、file ref、
 *     frontmatter + 正文、fileHistory.trackEdit 登记（回退锚点）；
 *   - 缺 workspaceRoot → 明确报错（不降级）；
 *   - updateTodos：merge 合并、revision 递增；文件缺失 → resource_not_found。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  LocalFilePlanStore,
  normalizePlanTodos,
  type PlanContentInput,
} from '../src/tools/plan-store.js';
import type { PlanRef } from '../src/engine/contracts/wire-payloads.js';
import type {
  ToolContext,
} from '../src/engine/contracts/tools.js';

let workRoot: string;
let trackedPaths: string[];

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    threadId: 't-test',
    runtimeId: 'sess',
    toolUseId: 'tu',
    agentRunId: 'run-1',
    abortSignal: new AbortController().signal,
    messages: [],
    workspaceRoot: workRoot,
    fileHistory: {
      beginSnapshot: async () => {},
      trackEdit: async (_anchor: string, absPath: string) => {
        trackedPaths.push(absPath);
      },
    },
    ...overrides,
  } as ToolContext;
}

beforeEach(async () => {
  workRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'planstore-'));
  trackedPaths = [];
});

afterEach(async () => {
  await fsp.rm(workRoot, { recursive: true, force: true }).catch(() => {});
});

describe('normalizePlanTodos', () => {
  it('填充默认 id / status', () => {
    const r = normalizePlanTodos([{ content: 'a' }, { content: 'b', status: 'completed' }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.todos).toEqual([
        { id: 'todo-0', content: 'a', status: 'pending' },
        { id: 'todo-1', content: 'b', status: 'completed' },
      ]);
    }
  });

  it('拒绝重复 id', () => {
    const r = normalizePlanTodos([
      { id: 'x', content: 'a' },
      { id: 'x', content: 'b' },
    ]);
    expect(r.ok).toBe(false);
  });

  it('拒绝空 content', () => {
    const r = normalizePlanTodos([{ content: '   ' }]);
    expect(r.ok).toBe(false);
  });

  it('空数组返回空 todos', () => {
    const r = normalizePlanTodos(undefined);
    expect(r.ok && r.todos.length === 0).toBe(true);
  });
});

describe('LocalFilePlanStore.create', () => {
  const content: PlanContentInput = {
    name: 'My Local Plan',
    overview: 'do the thing',
    planMarkdown: '## Body\n\ndetails',
    todos: [{ content: 'step 1' }],
  };

  it('写 plans/*.plan.md，返回 file ref，并登记 fileHistory 回退锚点', async () => {
    const store = new LocalFilePlanStore({ threadId: 'sess', agentMode: 'plan' });
    const ctx = makeContext();
    const r = await store.create(content, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const ref = r.value.ref as Extract<PlanRef, { kind: 'file' }>;
    expect(ref.kind).toBe('file');
    expect(ref.path.startsWith('.tabtin/plans/')).toBe(true);
    expect(ref.path.endsWith('.plan.md')).toBe(true);

    const abs = path.join(workRoot, ref.path);
    expect(fs.existsSync(abs)).toBe(true);
    const raw = await fsp.readFile(abs, 'utf-8');
    //  markdown 友好格式：机器元数据在 HTML 注释里，可见部分是规范 markdown。
    expect(raw.startsWith('<!-- tabtin:plan')).toBe(true);
    expect(raw).toContain('plan_name: My Local Plan'); // YAML 在注释内
    expect(raw).toContain('revision: 0');
    expect(raw).toContain('# My Local Plan'); // 可见 markdown 标题
    expect(raw).toContain('## 待办');
    expect(raw).toContain('- [ ] step 1'); // 待办清单渲染
    expect(raw).toContain('## Body'); // 方案正文

    // 写盘前登记了回退锚点（checkpoint / file-history 回滚可覆盖）。
    // store 内部对 workspaceRoot 做了 realpath canonicalize（macOS /var → /private/var），
    // 因此按 ref.path 后缀断言，避免 symlink 前缀差异。
    expect(trackedPaths).toHaveLength(1);
    expect(trackedPaths[0].endsWith(ref.path)).toBe(true);

    expect(r.value.revision).toBe(0);
    expect(r.value.todos).toEqual([{ id: 'todo-0', content: 'step 1', status: 'pending' }]);
  });

  it('缺 workspaceRoot → 明确报错（不降级）', async () => {
    const store = new LocalFilePlanStore();
    const ctx = makeContext({ workspaceRoot: undefined });
    const r = await store.create(content, ctx);
    expect(r.ok).toBe(false);
  });

  it('同名 plan 不互相覆盖（追加序号）', async () => {
    const store = new LocalFilePlanStore();
    const ctx = makeContext();
    const r1 = await store.create(content, ctx);
    const r2 = await store.create(content, ctx);
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.value.ref).not.toEqual(r2.value.ref);
    }
  });
});

describe('LocalFilePlanStore.updateTodos', () => {
  it('merge 合并 todos 并递增 revision', async () => {
    const store = new LocalFilePlanStore();
    const ctx = makeContext();
    const created = await store.create(
      { name: 'P', todos: [{ id: 'a', content: 'A' }] },
      ctx,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const updated = await store.updateTodos(
      created.value.ref,
      [{ id: 'a', content: 'A', status: 'completed' }, { id: 'b', content: 'B' }],
      true,
      ctx,
    );
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.revision).toBe(1);
    expect(updated.value.todos).toEqual([
      { id: 'a', content: 'A', status: 'completed' },
      { id: 'b', content: 'B', status: 'pending' },
    ]);
  });

  it('文件被删除（回滚场景）→ resource_not_found', async () => {
    const store = new LocalFilePlanStore();
    const ctx = makeContext();
    const created = await store.create({ name: 'P', todos: [{ content: 'A' }] }, ctx);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // 模拟 checkpoint 回滚把文件删掉
    await fsp.rm(path.join(workRoot, (created.value.ref as { path: string }).path));

    const updated = await store.updateTodos(created.value.ref, [{ content: 'X' }], true, ctx);
    expect(updated.ok).toBe(false);
  });
});
