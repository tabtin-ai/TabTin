/**
 * TabDocPlanStore HTTP 路径单测。
 *
 * 云端 plan 存储（/api/plan/create|update_todos）从 agent-runtime 迁到本宿主包后，
 * 原 runtime `plan-tools.test.ts` 里的 HTTP / snake_case / 错误翻译断言迁至此。
 * runtime 薄工具层（tracker / emit / planStore 契约）仍由
 * `packages/agent-runtime/tests/plan-tools.test.ts` 覆盖。
 *
 * ：Plan 只挂 Organization，create body 永不带 space_id。
 */

import { describe, it, expect, vi } from 'vitest';
import { TabDocPlanStore } from '../src/tools/tabdoc-plan-store.js';
import type { ToolContext } from '@tabtin/agent-runtime/engine';

const baseContext = {
  threadId: 't-test',
  runtimeId: 'sess-default',
  toolUseId: 'mock-tool-use',
  abortSignal: new AbortController().signal,
  messages: [],
} as ToolContext;

function buildJsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function buildSuccessEnvelope(data: Record<string, unknown>) {
  return { success: true, code: 'SUCCESS', message: 'OK', data };
}

function buildErrorEnvelope(code: string, message: string, status = 409) {
  return {
    body: { success: false, code, message, data: { error_code: code } },
    status,
  };
}

interface MockFetchCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

function createMockFetch(
  responder: (call: MockFetchCall) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: MockFetchCall[] } {
  const calls: MockFetchCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k] = String(v);
      }
    }
    let parsedBody: Record<string, unknown> | null = null;
    if (init?.body && typeof init.body === 'string') {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = null;
      }
    }
    const call: MockFetchCall = {
      url,
      method: init?.method ?? 'GET',
      body: parsedBody,
      headers,
    };
    calls.push(call);
    return responder(call);
  });
  return { fetch: fetchMock as unknown as typeof fetch, calls };
}

describe('TabDocPlanStore.create — HTTP path & field mapping', () => {
  it('POSTs to /api/plan/create with snake_case body and Bearer + organization header', async () => {
    const { fetch: f, calls } = createMockFetch(() =>
      buildJsonResponse(
        buildSuccessEnvelope({
          document_id: 'doc-1',
          collection_id: 'coll-1',
          plan: { name: 'My Plan' },
        }),
      ),
    );
    const store = new TabDocPlanStore({
      apiBaseUrl: 'https://api.test.example.com/api',
      apiAuthToken: 'token-xyz',
      organizationId: 'wt-001',
      threadId: 'sess-default',
      agentId: 'agent-001',
      agentMode: 'plan',
      fetchImpl: f,
    });

    const r = await store.create(
      {
        name: 'My Plan',
        overview: 'overview text',
        planMarkdown: '## Plan body',
        todos: [{ content: 'a' }],
      },
      baseContext,
    );

    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.test.example.com/api/plan/create');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['Authorization']).toBe('Bearer token-xyz');
    expect(calls[0].headers['X-TabTin-Organization-Id']).toBe('wt-001');
    expect(calls[0].body).toEqual({
      organization_id: 'wt-001',
      name: 'My Plan',
      overview: 'overview text',
      plan: '## Plan body',
      todos: [{ id: 'todo-0', content: 'a', status: 'pending' }],
      is_project: false,
      session_id: 'sess-default',
      agent_id: 'agent-001',
      agent_mode_at_create: 'plan',
    });
    expect('space_id' in (calls[0].body as object)).toBe(false);
    if (r.ok) {
      expect(r.value.ref).toEqual({ kind: 'document', document_id: 'doc-1' });
      expect(r.value.collectionId).toBe('coll-1');
    }
  });

  it('does not pollute body with undefined deps fields', async () => {
    const { fetch: f, calls } = createMockFetch(() =>
      buildJsonResponse(buildSuccessEnvelope({ document_id: 'd' })),
    );
    const store = new TabDocPlanStore({
      apiBaseUrl: 'https://api.test.example.com/api',
      apiAuthToken: 'token-xyz',
      organizationId: 'wt-001',
      fetchImpl: f,
    });
    await store.create({ name: 'X' }, baseContext);
    const body = calls[0].body as Record<string, unknown>;
    expect('session_id' in body).toBe(false);
    expect('agent_id' in body).toBe(false);
    expect('agent_mode_at_create' in body).toBe(false);
    expect('space_id' in body).toBe(false);
  });

  it('returns a clear error when organizationId missing in deps', async () => {
    const { fetch: f, calls } = createMockFetch(() => buildJsonResponse(buildSuccessEnvelope({})));
    const store = new TabDocPlanStore({
      apiBaseUrl: 'https://api.test.example.com/api',
      apiAuthToken: 'token-xyz',
      organizationId: '',
      fetchImpl: f,
    });
    const r = await store.create({ name: 'X' }, baseContext);
    expect(calls).toHaveLength(0);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(String(JSON.parse(r.result.content as string).error)).toMatch(/organization_id|配置/);
    }
  });

  it('never includes space_id on create body ', async () => {
    const { fetch: f, calls } = createMockFetch(() =>
      buildJsonResponse(buildSuccessEnvelope({ document_id: 'doc-org' })),
    );
    const store = new TabDocPlanStore({
      apiBaseUrl: 'https://api.test.example.com/api',
      apiAuthToken: 'token-xyz',
      organizationId: 'wt-001',
      fetchImpl: f,
    });
    const r = await store.create({ name: 'Org Plan' }, baseContext);
    expect(r.ok).toBe(true);
    const body = calls[0].body as Record<string, unknown>;
    expect(body.organization_id).toBe('wt-001');
    expect('space_id' in body).toBe(false);
  });

  it('translates PLAN_PERMISSION_DENIED HTTP error into a friendly LLM message', async () => {
    const err = buildErrorEnvelope('PLAN_PERMISSION_DENIED', '当前 Agent 不能编辑该 Plan 文档', 403);
    const { fetch: f } = createMockFetch(() => buildJsonResponse(err.body, { status: err.status }));
    const store = new TabDocPlanStore({
      apiBaseUrl: 'https://api.test.example.com/api',
      organizationId: 'wt-001',
      fetchImpl: f,
    });
    const r = await store.create({ name: 'X' }, baseContext);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const parsed = JSON.parse(r.result.content as string) as Record<string, unknown>;
      expect(parsed.upstream_code).toBe('PLAN_PERMISSION_DENIED');
      expect(parsed.error_kind).toBe('permission_denied');
    }
  });

  it('translates PLAN_NO_USER', async () => {
    const err = buildErrorEnvelope('PLAN_NO_USER', 'PlanService 必须携带 user', 401);
    const { fetch: f } = createMockFetch(() => buildJsonResponse(err.body, { status: err.status }));
    const store = new TabDocPlanStore({
      apiBaseUrl: 'https://api.test.example.com/api',
      organizationId: 'wt-001',
      fetchImpl: f,
    });
    const r = await store.create({ name: 'X' }, baseContext);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const parsed = JSON.parse(r.result.content as string) as Record<string, unknown>;
      expect(parsed.upstream_code).toBe('PLAN_NO_USER');
      expect(parsed.error_kind).toBe('auth_failed');
    }
  });

  it('rejects non-string document_id in response (defensive)', async () => {
    const { fetch: f } = createMockFetch(() =>
      buildJsonResponse(buildSuccessEnvelope({ document_id: 12345, collection_id: 'coll-1' })),
    );
    const store = new TabDocPlanStore({
      apiBaseUrl: 'https://api.test.example.com/api',
      organizationId: 'wt-001',
      fetchImpl: f,
    });
    const r = await store.create({ name: 'X' }, baseContext);
    expect(r.ok).toBe(false);
  });

  it('maps agentMode → agent_mode_at_create / threadId → session_id / agentId → agent_id', async () => {
    const { fetch: f, calls } = createMockFetch(() =>
      buildJsonResponse(buildSuccessEnvelope({ document_id: 'd' })),
    );
    const store = new TabDocPlanStore({
      apiBaseUrl: 'https://api.test.example.com/api',
      organizationId: 'wt-001',
      threadId: 'sess-map',
      agentId: 'agent-x',
      agentMode: 'study',
      fetchImpl: f,
    });
    await store.create({ name: 'X' }, baseContext);
    const body = calls[0].body as Record<string, unknown>;
    expect(body.agent_mode_at_create).toBe('study');
    expect(body.session_id).toBe('sess-map');
    expect(body.agent_id).toBe('agent-x');
    expect(body.agentMode).toBeUndefined();
    expect('space_id' in body).toBe(false);
  });
});

describe('TabDocPlanStore.updateTodos — HTTP path', () => {
  it('POSTs with merge=true by default and snake_case plan_document_id', async () => {
    const { fetch: f, calls } = createMockFetch(() =>
      buildJsonResponse(
        buildSuccessEnvelope({
          document_id: 'doc-1',
          todos_after_update: [{ id: 't-1', content: 'a', status: 'pending' }],
        }),
      ),
    );
    const store = new TabDocPlanStore({
      apiBaseUrl: 'https://api.test.example.com/api',
      organizationId: 'wt-001',
      fetchImpl: f,
    });
    await store.updateTodos(
      { kind: 'document', document_id: 'doc-1' },
      [{ id: 't-1', content: 'a' }],
      true,
      baseContext,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.test.example.com/api/plan/update_todos');
    expect(calls[0].body).toMatchObject({
      plan_document_id: 'doc-1',
      todos: [{ id: 't-1', content: 'a', status: 'pending' }],
      merge: true,
    });
  });

  it('passes merge=false through correctly', async () => {
    const { fetch: f, calls } = createMockFetch(() =>
      buildJsonResponse(buildSuccessEnvelope({ document_id: 'd' })),
    );
    const store = new TabDocPlanStore({
      apiBaseUrl: 'https://api.test.example.com/api',
      organizationId: 'wt-001',
      fetchImpl: f,
    });
    await store.updateTodos(
      { kind: 'document', document_id: 'doc-1' },
      [{ content: 'a' }],
      false,
      baseContext,
    );
    expect(calls[0].body?.merge).toBe(false);
  });

  it('translates PLAN_NOT_DRAFT 409 into a friendly hint', async () => {
    const err = buildErrorEnvelope('PLAN_NOT_DRAFT', 'Plan 已是 approved 状态', 409);
    const { fetch: f } = createMockFetch(() => buildJsonResponse(err.body, { status: err.status }));
    const store = new TabDocPlanStore({
      apiBaseUrl: 'https://api.test.example.com/api',
      organizationId: 'wt-001',
      fetchImpl: f,
    });
    const r = await store.updateTodos(
      { kind: 'document', document_id: 'doc-1' },
      [{ content: 'a' }],
      true,
      baseContext,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const parsed = JSON.parse(r.result.content as string) as Record<string, unknown>;
      expect(parsed.upstream_code).toBe('PLAN_NOT_DRAFT');
      expect(parsed.error_kind).toBe('version_conflict');
    }
  });
});
