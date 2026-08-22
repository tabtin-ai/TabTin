/**
 * plan-tools 薄工具层单测。
 *
 * HTTP TabDocPlanStore 已迁到宿主包；本文件只覆盖 runtime 侧薄工具层：
 *   - createPlanTools 工厂形状
 *   - 参数校验 / planStore 调用契约
 *   - active-plan-tracker 记账
 *   - plan rich-content block / plan_proposal 发射
 *
 * 云端 HTTP 路径（snake_case body / 错误翻译 / 字段映射）见宿主包
 * `packages/@tabtin/host-side/tests/tabdoc-plan-store.test.ts`（路径示意；
 * 实际在宿主包 tests/ 下，此处刻意不写触发 AH-003 字面量）。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createPlanTools,
  type PlanToolsDeps,
} from '../src/tools/plan-tools.js';
import type {
  PlanContentInput,
  PlanSnapshot,
  PlanStore,
  PlanStoreResult,
  PlanTodoInput,
} from '../src/tools/plan-store.js';
import {
  __resetActivePlanTrackerForTests,
  getActivePlanRef,
  __snapshotActivePlans,
  setActivePlanChangeListener,
  type ActivePlanChangeEvent,
} from '../src/state/active-plan-tracker.js';
import type { PlanRef } from '../src/engine/contracts/wire-payloads.js';
import type {
  Tool,
  ToolContext,
} from '../src/engine/contracts/tools.js';

const baseContext: ToolContext = {
  threadId: 't-test',
  runtimeId: 'sess-default',
  toolUseId: 'mock-tool-use',
  abortSignal: new AbortController().signal,
  messages: [],
};

function makeSnapshot(overrides?: Partial<PlanSnapshot>): PlanSnapshot {
  return {
    ref: { kind: 'file', path: 'plans/demo.plan.md' },
    name: 'My Plan',
    overview: 'overview text',
    todos: [{ id: 'todo-0', content: 'a', status: 'pending' }],
    markdown: '## Plan body',
    revision: 1,
    collectionId: null,
    ...overrides,
  };
}

/** 可脚本化的 mock PlanStore——工具层不关心存储介质细节。 */
function makeMockStore(opts?: {
  kind?: 'file' | 'document';
  create?: (
    input: PlanContentInput,
    context: ToolContext,
  ) => Promise<PlanStoreResult<PlanSnapshot>>;
  updateTodos?: (
    ref: PlanRef,
    todos: PlanTodoInput[],
    merge: boolean,
    context: ToolContext,
  ) => Promise<PlanStoreResult<PlanSnapshot>>;
}): PlanStore & {
  createCalls: PlanContentInput[];
  updateCalls: Array<{ ref: PlanRef; todos: PlanTodoInput[]; merge: boolean }>;
} {
  const createCalls: PlanContentInput[] = [];
  const updateCalls: Array<{ ref: PlanRef; todos: PlanTodoInput[]; merge: boolean }> = [];
  const kind = opts?.kind ?? 'file';
  return {
    kind,
    createCalls,
    updateCalls,
    async create(input, context) {
      createCalls.push(input);
      if (opts?.create) return opts.create(input, context);
      const ref: PlanRef =
        kind === 'file'
          ? { kind: 'file', path: `plans/${input.name.trim().replace(/\s+/g, '-')}.plan.md` }
          : { kind: 'document', document_id: `doc-${createCalls.length}` };
      return {
        ok: true,
        value: makeSnapshot({
          ref,
          name: input.name.trim(),
          overview: input.overview ?? '',
          markdown: input.planMarkdown ?? '',
          todos: (input.todos ?? []).map((t, i) => ({
            id: t.id ?? `todo-${i}`,
            content: t.content,
            status: t.status ?? 'pending',
          })),
        }),
      };
    },
    async updateTodos(ref, todos, merge, context) {
      updateCalls.push({ ref, todos, merge });
      if (opts?.updateTodos) return opts.updateTodos(ref, todos, merge, context);
      return {
        ok: true,
        value: makeSnapshot({
          ref,
          todos: todos.map((t, i) => ({
            id: t.id ?? `todo-${i}`,
            content: t.content,
            status: t.status ?? 'pending',
          })),
          revision: 2,
        }),
      };
    },
  };
}

function buildDeps(overrides: Partial<PlanToolsDeps> & { store?: ReturnType<typeof makeMockStore> } = {}): {
  deps: PlanToolsDeps;
  store: ReturnType<typeof makeMockStore>;
} {
  const store = overrides.store ?? makeMockStore();
  const { store: _drop, ...rest } = overrides;
  return {
    store,
    deps: {
      planStore: store,
      threadId: 'sess-default',
      ...rest,
    },
  };
}

function findTool(tools: Tool[], name: string): Tool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}

beforeEach(() => {
  __resetActivePlanTrackerForTests();
});

describe('createPlanTools — factory shape', () => {
  it('returns two tools: plan_create / plan_update_todos (no plan_exit)', () => {
    const { deps } = buildDeps();
    const tools = createPlanTools(deps);
    expect(tools.map((t) => t.name).sort()).toEqual([
      'plan_create',
      'plan_update_todos',
    ]);
    expect(tools.every((t) => t.isReadOnly === false)).toBe(true);
  });
});

describe('plan_create — thin tool layer', () => {
  it('calls planStore.create with normalized content fields', async () => {
    const { deps, store } = buildDeps();
    const tool = findTool(createPlanTools(deps), 'plan_create');
    const result = await tool.execute(
      { name: 'My Plan', overview: 'overview text', plan: '## Plan body', todos: [{ content: 'a' }] },
      baseContext,
    );
    expect(store.createCalls).toHaveLength(1);
    expect(store.createCalls[0]).toMatchObject({
      name: 'My Plan',
      overview: 'overview text',
      planMarkdown: '## Plan body',
    });
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    expect(parsed.success).toBe(true);
    expect(typeof parsed.plan_ref).toBe('string');
  });

  it('emits a persistent plan rich-content block (kind=plan) with pointer + light fields ', async () => {
    const store = makeMockStore({
      create: async () => ({
        ok: true,
        value: makeSnapshot({
          ref: { kind: 'document', document_id: 'doc-99' },
          name: 'My Plan',
          overview: 'overview text',
          todos: [
            { id: 't-1', content: 'one', status: 'pending' },
            { id: 't-2', content: 'two', status: 'in_progress' },
          ],
          collectionId: 'coll-1',
        }),
      }),
    });
    const { deps } = buildDeps({ store });
    const tool = findTool(createPlanTools(deps), 'plan_create');
    const richBlocks: Array<{ kind: string; summary: string; payload?: Record<string, unknown> }> = [];
    const ctx: ToolContext = {
      ...baseContext,
      emitRichContentBlock: (args) => richBlocks.push(args),
    };
    await tool.execute({ name: 'My Plan' }, ctx);

    expect(richBlocks).toHaveLength(1);
    const block = richBlocks[0];
    expect(block.kind).toBe('plan');
    expect(block.summary).toBe('My Plan');
    expect(block.payload).toMatchObject({
      plan_document_id: 'doc-99',
      plan_ref: { kind: 'document', document_id: 'doc-99' },
      plan_name: 'My Plan',
      overview: 'overview text',
      executed: false,
    });
    expect(block.payload).not.toHaveProperty('description_markdown');
  });

  it('does not throw when emitStreamEvent / emitRichContentBlock is missing', async () => {
    const { deps } = buildDeps();
    const tool = findTool(createPlanTools(deps), 'plan_create');
    const r = await tool.execute({ name: 'X' }, baseContext);
    const parsed = JSON.parse(r.content as string) as Record<string, unknown>;
    expect(parsed.success).toBe(true);
  });

  it('writes the returned plan_ref into active-plan-tracker (key=threadId)', async () => {
    const store = makeMockStore({
      create: async () => ({
        ok: true,
        value: makeSnapshot({ ref: { kind: 'document', document_id: 'doc-42' } }),
      }),
    });
    const { deps } = buildDeps({ store, threadId: 'sess-tracker-A' });
    const tool = findTool(createPlanTools(deps), 'plan_create');
    await tool.execute({ name: 'X' }, baseContext);

    expect(getActivePlanRef('sess-tracker-A')).toEqual({
      kind: 'document',
      document_id: 'doc-42',
    });
    expect(getActivePlanRef('sess-other')).toBeNull();
  });

  it('returns plan name validation error when name missing (no store call)', async () => {
    const { deps, store } = buildDeps();
    const tool = findTool(createPlanTools(deps), 'plan_create');
    const r = await tool.execute({ overview: 'no name' }, baseContext);
    expect(store.createCalls).toHaveLength(0);
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content as string) as Record<string, unknown>;
    expect(parsed.success).toBe(false);
    expect(String(parsed.error)).toMatch(/name 必填/);
  });

  it('propagates store.create failure ToolResult', async () => {
    const store = makeMockStore({
      create: async () => ({
        ok: false,
        result: {
          content: JSON.stringify({
            success: false,
            error: 'permission denied',
            error_kind: 'permission_denied',
            upstream_code: 'PLAN_PERMISSION_DENIED',
            hint: 'Ask for editor access',
          }),
          isError: true,
        },
      }),
    });
    const { deps } = buildDeps({ store });
    const tool = findTool(createPlanTools(deps), 'plan_create');
    const r = await tool.execute({ name: 'X' }, baseContext);
    const parsed = JSON.parse(r.content as string) as Record<string, unknown>;
    expect(r.isError).toBe(true);
    expect(parsed.upstream_code).toBe('PLAN_PERMISSION_DENIED');
  });

  it('warns LLM when overwriting an unsettled plan in the same session', async () => {
    let counter = 1;
    const store = makeMockStore({
      create: async () => ({
        ok: true,
        value: makeSnapshot({
          ref: { kind: 'document', document_id: `doc-${counter++}` },
        }),
      }),
    });
    const { deps } = buildDeps({ store, threadId: 'sess-overwrite' });
    const tool = findTool(createPlanTools(deps), 'plan_create');

    await tool.execute({ name: 'first' }, baseContext);
    const r = await tool.execute({ name: 'second' }, baseContext);
    const parsed = JSON.parse(r.content as string) as Record<string, unknown>;
    expect(String(parsed.message)).toMatch(/已覆盖之前未结算的 plan 草稿/);
    expect(getActivePlanRef('sess-overwrite')).toEqual({
      kind: 'document',
      document_id: 'doc-2',
    });
  });
});

describe('plan_update_todos — thin tool layer', () => {
  it('passes merge=true by default to planStore.updateTodos', async () => {
    const { deps, store } = buildDeps();
    const tool = findTool(createPlanTools(deps), 'plan_update_todos');
    await tool.execute(
      {
        plan_ref: 'file:plans/demo.plan.md',
        todos: [{ id: 't-1', content: 'a' }],
      },
      baseContext,
    );
    expect(store.updateCalls).toHaveLength(1);
    expect(store.updateCalls[0].merge).toBe(true);
    expect(store.updateCalls[0].ref).toEqual({
      kind: 'file',
      path: 'plans/demo.plan.md',
    });
  });

  it('passes merge=false through correctly', async () => {
    const { deps, store } = buildDeps();
    const tool = findTool(createPlanTools(deps), 'plan_update_todos');
    await tool.execute(
      {
        plan_ref: 'file:plans/demo.plan.md',
        todos: [{ content: 'a' }],
        merge: false,
      },
      baseContext,
    );
    expect(store.updateCalls[0].merge).toBe(false);
  });

  it('rejects empty todos array without store call', async () => {
    const { deps, store } = buildDeps();
    const tool = findTool(createPlanTools(deps), 'plan_update_todos');
    const r = await tool.execute(
      { plan_ref: 'file:plans/demo.plan.md', todos: [] },
      baseContext,
    );
    expect(store.updateCalls).toHaveLength(0);
    expect(r.isError).toBe(true);
  });

  it('falls back to active plan tracker when plan_ref missing', async () => {
    const store = makeMockStore({
      create: async () => ({
        ok: true,
        value: makeSnapshot({
          ref: { kind: 'file', path: 'plans/tracked.plan.md' },
        }),
      }),
    });
    const { deps } = buildDeps({ store, threadId: 'sess-fallback' });
    await findTool(createPlanTools(deps), 'plan_create').execute({ name: 'X' }, baseContext);

    const r = await findTool(createPlanTools(deps), 'plan_update_todos').execute(
      { todos: [{ content: 'a' }] } as unknown,
      baseContext,
    );
    expect(r.isError).toBeFalsy();
    expect(store.updateCalls[0].ref).toEqual({
      kind: 'file',
      path: 'plans/tracked.plan.md',
    });
  });

  it('rejects plan_ref kind mismatch against store.kind', async () => {
    const { deps } = buildDeps({ store: makeMockStore({ kind: 'file' }) });
    const tool = findTool(createPlanTools(deps), 'plan_update_todos');
    const r = await tool.execute(
      {
        plan_ref: 'document:doc-1',
        todos: [{ content: 'a' }],
      },
      baseContext,
    );
    expect(r.isError).toBe(true);
    expect(String(JSON.parse(r.content as string).error)).toMatch(/不匹配/);
  });
});

describe('active-plan-tracker — multi-session isolation & lifecycle', () => {
  it('tracks plans per threadId without cross-talk', async () => {
    let n = 0;
    const store = makeMockStore({
      create: async () => {
        n += 1;
        return {
          ok: true,
          value: makeSnapshot({
            ref: { kind: 'document', document_id: `doc-${n}` },
          }),
        };
      },
    });

    await findTool(createPlanTools({ planStore: store, threadId: 'sess-A' }), 'plan_create').execute(
      { name: 'A' },
      baseContext,
    );
    await findTool(createPlanTools({ planStore: store, threadId: 'sess-B' }), 'plan_create').execute(
      { name: 'B' },
      baseContext,
    );

    expect(getActivePlanRef('sess-A')).toEqual({ kind: 'document', document_id: 'doc-1' });
    expect(getActivePlanRef('sess-B')).toEqual({ kind: 'document', document_id: 'doc-2' });
    expect(__snapshotActivePlans().length).toBe(2);
  });

  it('emits "set" change event to registered listener on plan_create', async () => {
    const events: ActivePlanChangeEvent[] = [];
    setActivePlanChangeListener((e) => events.push(e));

    const store = makeMockStore({
      create: async () => ({
        ok: true,
        value: makeSnapshot({
          ref: { kind: 'document', document_id: 'doc-evt' },
        }),
      }),
    });
    await findTool(createPlanTools({ planStore: store, threadId: 'sess-evt' }), 'plan_create').execute(
      { name: 'X' },
      baseContext,
    );

    setActivePlanChangeListener(undefined);

    const setEvt = events.find((e) => e.type === 'set');
    expect(setEvt?.type).toBe('set');
    expect(setEvt && setEvt.type === 'set' ? setEvt.ref : null).toEqual({
      kind: 'document',
      document_id: 'doc-evt',
    });
  });
});
