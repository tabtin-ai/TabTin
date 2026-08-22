/**
 * data-tools 测试
 *
 * 7 个工具均为 HTTP wrapper，测试目标：
 *   - 调用 URL / method / query / body 与云端 REST 契约一致
 *   - 关键产品决策（D7.1 source=agent / D7.2 App 密码降级 / D7.3 不截断）落实
 *   - 错误处理统一（4xx / 5xx / network / timeout 归一化为 success:false）
 *
 * mock 全局 fetch（与 web-tools / document-tools 同模式）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createDataTools,
  callMemorySearchAPI,
  type DataToolsDeps,
  type MemoryRecallFetchOutcome,
} from '../src/tools/data-tools.js';
import type {
  Tool,
  ToolContext,
} from '@tabtin/agent-runtime';
import { MemoryToolResultStorage } from '@tabtin/agent-runtime/engine';

const noopContext: ToolContext = {
  threadId: 't-test',
  runtimeId: 'sess-default',
  toolUseId: 'mock-tool-use',
  abortSignal: new AbortController().signal,
  messages: [],
};

/**
 * W4.5 第三波 C1（2026-05-13）fixture 重写：富内容 emit 形态。
 *
 * 工具实际生产路径：`context.emitRichContentBlock({ kind, summary, payload, groupId? })`
 * → `query.ts.makeRichContentBlockEmitter` → `envelopeEmitter.emitDetachedMiniMessage`
 * 5 件套（message_start + cb_start + cb_stop + message_stop）。
 *
 * 测试 fixture 注入轻量 `emitRichContentBlock` mock，直接 push args 到数组——
 * 断言 `richBlocks[i].kind / payload.X` 即可，不模拟 envelope 5 件套（envelope 真
 * 主路径已由 `tests/wave2/envelope-emitter.test.ts::emitDetachedMiniMessage` 覆盖）。
 */
type RichBlockArg = {
  kind: string;
  summary: string;
  groupId?: string;
  payload?: Record<string, unknown>;
};

function ctxWithRichEmit(richBlocks: RichBlockArg[], extra?: Partial<ToolContext>): ToolContext {
  return {
    ...noopContext,
    emitRichContentBlock: (args) => richBlocks.push(args as RichBlockArg),
    ...extra,
  };
}

interface MockFetchCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

interface MockFetchHandle {
  calls: MockFetchCall[];
  setResponder: (responder: (call: MockFetchCall) => Response | Promise<Response>) => void;
}

function buildJsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installMockFetch(initial?: (call: MockFetchCall) => Response | Promise<Response>): MockFetchHandle {
  const handle: MockFetchHandle = {
    calls: [],
    setResponder: () => {},
  };
  let current: (call: MockFetchCall) => Response | Promise<Response> =
    initial ?? (() => buildJsonResponse({}));
  handle.setResponder = (r) => { current = r; };

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const raw = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(raw)) {
        headers[k] = String(v);
      }
    }
    let parsedBody: Record<string, unknown> | null = null;
    if (init?.body && typeof init.body === 'string') {
      try { parsedBody = JSON.parse(init.body); } catch { parsedBody = null; }
    }
    const call: MockFetchCall = {
      url,
      method: init?.method ?? 'GET',
      body: parsedBody,
      headers,
    };
    handle.calls.push(call);
    const result = current(call);
    return result instanceof Promise ? result : result;
  });

  // 替换全局 fetch
  vi.stubGlobal('fetch', fetchMock);
  return handle;
}

function buildDeps(overrides: Partial<DataToolsDeps> = {}): DataToolsDeps {
  return {
    apiBaseUrl: 'https://api.test.example.com/api',
    apiAuthToken: 'token-xyz',
    organizationId: 'wt-001',
    //  W2b：记忆按 (organization, agent, subject) 隔离，agent_id 是可信上下文
    // 必备键——默认注入让 memory_* 工具可用；缺失路径由专门用例覆盖。
    agentId: 'ag-001',
    ...overrides,
  };
}

function findTool(tools: Tool[], name: string): Tool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}

function parseToolContent(content: string): Record<string, unknown> {
  return JSON.parse(content) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Factory shape ───────────────────────────────────────────────────

describe('createDataTools — factory shape', () => {
  it('returns 5 tools (memory ×3 + credential ×2; rag_search removed in )', () => {
    const tools = createDataTools(buildDeps());
    expect(tools.map((t) => t.name).sort()).toEqual([
      'credential_lookup',
      'credential_retrieve',
      'memory_delete',
      'memory_search',
      'memory_write',
    ]);
  });

  it('marks read tools as isReadOnly=true and write tools as false', () => {
    const tools = createDataTools(buildDeps());
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.memory_search.isReadOnly).toBe(true);
    expect(byName.memory_write.isReadOnly).toBe(false);
    expect(byName.memory_delete.isReadOnly).toBe(false);
    expect(byName.credential_lookup.isReadOnly).toBe(true);
    expect(byName.credential_retrieve.isReadOnly).toBe(true);
  });

  it('blocks credential retrieval from pre-start execution', () => {
    const tools = createDataTools(buildDeps());
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.credential_retrieve.disablePreStart).toBe(true);
  });

  //  W2b（运行时侧）：隐私总闸关闭 → 不注册 memory_search / memory_write，
  // 但保留 memory_delete（forget）+ credential 工具。
  it('memoryEnabled=false: drops memory_search/memory_write, keeps memory_delete + credential tools', () => {
    const tools = createDataTools(buildDeps({ memoryEnabled: false }));
    expect(tools.map((t) => t.name).sort()).toEqual([
      'credential_lookup',
      'credential_retrieve',
      'memory_delete',
    ]);
  });

  it('memoryEnabled=true (explicit) keeps all 5 tools', () => {
    const tools = createDataTools(buildDeps({ memoryEnabled: true }));
    expect(tools.map((t) => t.name).sort()).toEqual([
      'credential_lookup',
      'credential_retrieve',
      'memory_delete',
      'memory_search',
      'memory_write',
    ]);
  });
});

// ─── memory_search ───────────────────────────────────────────────────

describe('memory_search', () => {
  let mock: MockFetchHandle;
  beforeEach(() => { mock = installMockFetch(); });

  it('GETs /agent-memory/memories/ scoped by organization_id + agent_id ( 隔离)', async () => {
    mock.setResponder(() => buildJsonResponse({
      success: true, code: 'OK', data: { items: [], next_cursor: '', has_more: false },
    }));
    const tool = findTool(createDataTools(buildDeps()), 'memory_search');
    await tool.execute({ query: 'login' }, noopContext);

    expect(mock.calls).toHaveLength(1);
    const call = mock.calls[0];
    expect(call.method).toBe('GET');
    //  关键断言：打独立 /agent-memory 域，按 (org, agent) 隔离，不再带 source=agent
    expect(call.url).toContain('/agent-memory/memories/');
    expect(call.url).not.toContain('source=agent');
    expect(call.url).not.toContain('for_recall');
    expect(call.url).toContain('organization_id=wt-001');
    expect(call.url).toContain('agent_id=ag-001');
    expect(call.url).toContain('search=login');
  });

  it('returns error if organization_id missing in deps', async () => {
    const tool = findTool(createDataTools(buildDeps({ organizationId: undefined })), 'memory_search');
    const result = await tool.execute({ query: 'x' }, noopContext);
    expect(mock.calls).toHaveLength(0);
    expect(result.isError).toBe(true);
    // W13：runtime 装配缺失走 runtime_misconfig（不是 invalid_input）
    expect(parseToolContent(result.content as string).error_kind).toBe('runtime_misconfig');
  });

  // /#4118：缺 agent_id（可信上下文）→ 调 HTTP 前明确 runtime_misconfig，
  // 不发无归属请求、不返回空数组伪装无记忆。
  it('returns runtime_misconfig if agent_id missing in deps (no HTTP)', async () => {
    const tool = findTool(createDataTools(buildDeps({ agentId: undefined })), 'memory_search');
    const result = await tool.execute({ query: 'x' }, noopContext);
    expect(mock.calls).toHaveLength(0);
    expect(result.isError).toBe(true);
    const parsed = parseToolContent(result.content as string);
    expect(parsed.error_kind).toBe('runtime_misconfig');
    expect(parsed.missing).toBe('agent_id');
  });

  it('maps backend items into LLM-summary preview shape (W7 双层, /agent-memory DTO)', async () => {
    mock.setResponder(() => buildJsonResponse({
      success: true,
      data: {
        items: [{
          id: 'm1',
          // /agent-memory DTO 字段：content / memory_type / source_ref（W2a schemas.py）
          content: 'hello world',
          memory_type: 'insight',
          tags: ['login', 'oauth'],
          created_at: '2026-04-01T10:00:00Z',
        }],
        next_cursor: 'm1',
        has_more: true,
      },
    }));
    const tool = findTool(createDataTools(buildDeps()), 'memory_search');
    const result = await tool.execute({ query: 'h' }, noopContext);
    const parsed = parseToolContent(result.content as string);
    expect(parsed.success).toBe(true);
    expect(parsed.count).toBe(1);
    expect(parsed.shown_in_summary).toBe(1);
    // memories 是 LLM 摘要 preview 数组（带 index/content_preview/...）
    const previewMemo = (parsed.memories as Array<Record<string, unknown>>)[0];
    expect(previewMemo.id).toBe('m1');
    expect(previewMemo.content_preview).toBe('hello world');
    expect(previewMemo.memo_type).toBe('insight');
    expect(previewMemo.tags).toEqual(['login', 'oauth']);
    expect(parsed.next_cursor).toBe('m1');
    expect(parsed.has_more).toBe(true);
    expect((parsed._memories as unknown[]).length).toBe(1);
    expect(result.llmStripKeys).toContain('_memories');
  });

  it('W7: emits memory_card rich content block when memories present', async () => {
    mock.setResponder(() => buildJsonResponse({
      success: true,
      data: {
        items: [
          { id: 'm1', content: 'A', memory_type: 'about_you' },
          { id: 'm2', content: 'B', memory_type: 'insight' },
        ],
        next_cursor: '',
        has_more: false,
      },
    }));
    const richBlocks: RichBlockArg[] = [];
    const ctx = ctxWithRichEmit(richBlocks);
    const tool = findTool(createDataTools(buildDeps()), 'memory_search');
    await tool.execute({ query: 'login' }, ctx);

    expect(richBlocks).toHaveLength(1);
    const block = richBlocks[0];
    expect(block.kind).toBe('memory_card');
    const payload = block.payload ?? {};
    expect(payload.query).toBe('login');
    expect((payload.memories as unknown[]).length).toBe(2);
    expect(payload.total_count).toBe(2);
    //  W5：富块随可信 agent_id 下发，供聊天记忆卡深链精确落到该 Agent。
    expect(payload.agent_id).toBe('ag-001');
  });

  it('W7: LLM summary truncates memo content beyond 300 chars', async () => {
    const longContent = 'y'.repeat(800);
    mock.setResponder(() => buildJsonResponse({
      success: true,
      data: { items: [{ id: 'm1', content: longContent }], next_cursor: '', has_more: false },
    }));
    const tool = findTool(createDataTools(buildDeps()), 'memory_search');
    const result = await tool.execute({ query: 'y' }, noopContext);
    const parsed = parseToolContent(result.content as string);
    const previewMemo = (parsed.memories as Array<Record<string, string>>)[0];
    expect(previewMemo.content_preview.length).toBeLessThanOrEqual(301);
    expect(previewMemo.content_preview.endsWith('…')).toBe(true);
  });

  // L34-cjk：CJK memo 截断（与 rag_search 同测试套覆盖一致——300 length 上限）
  it('W7 / L34-cjk: memo content_preview 截断对中文 memo 正确（300 字符上限）', async () => {
    const longCjkContent = '记'.repeat(500) + '🎉';
    mock.setResponder(() => buildJsonResponse({
      success: true,
      data: {
        items: [{ id: 'm1', content: longCjkContent, memory_type: 'insight' }],
        next_cursor: '',
        has_more: false,
      },
    }));
    const tool = findTool(createDataTools(buildDeps()), 'memory_search');
    const result = await tool.execute({ query: '记' }, noopContext);
    const parsed = parseToolContent(result.content as string);
    const previewMemo = (parsed.memories as Array<Record<string, string>>)[0];
    expect(previewMemo.content_preview.length).toBeLessThanOrEqual(301);
    expect(previewMemo.content_preview.endsWith('…')).toBe(true);
    expect(previewMemo.content_preview.startsWith('记')).toBe(true);
  });

  it('W7: does NOT emit when items list is empty', async () => {
    mock.setResponder(() => buildJsonResponse({
      success: true,
      data: { items: [], next_cursor: '', has_more: false },
    }));
    const richBlocks: RichBlockArg[] = [];
    const ctx = ctxWithRichEmit(richBlocks);
    const tool = findTool(createDataTools(buildDeps()), 'memory_search');
    await tool.execute({ query: 'none' }, ctx);
    // Empty list 不 emit rich content（避免空卡片噪音；与 web_search 同口径）
    expect(richBlocks).toHaveLength(0);
  });

  it('W7: emit failure does not break the tool result', async () => {
    mock.setResponder(() => buildJsonResponse({
      success: true,
      data: { items: [{ id: 'm1', content: 'x' }], next_cursor: '', has_more: false },
    }));
    const ctx: ToolContext = {
      ...noopContext,
      emitRichContentBlock: () => { throw new Error('emit failed'); },
    };
    const tool = findTool(createDataTools(buildDeps()), 'memory_search');
    const result = await tool.execute({ query: 'x' }, ctx);
    const parsed = parseToolContent(result.content as string);
    expect(parsed.success).toBe(true);
    expect(parsed.count).toBe(1);
  });
});

// ─── memory_write ────────────────────────────────────────────────────

describe('memory_write', () => {
  let mock: MockFetchHandle;
  beforeEach(() => { mock = installMockFetch(); });

  it('POSTs /agent-memory/memories/ with (org, agent) attribution from trusted context ', async () => {
    mock.setResponder(() => buildJsonResponse({
      success: true,
      data: { id: 'memo-uuid', memory_type: 'about_you' },
    }, { status: 201 }));
    const tool = findTool(createDataTools(buildDeps()), 'memory_write');
    const result = await tool.execute({
      content: '# 用户喜欢深色主题',
      memo_type: 'about_you',
      importance: 4,
      tags: ['preference'],
      source_url: 'thread://sess-1',
    }, noopContext);

    expect(mock.calls).toHaveLength(1);
    const call = mock.calls[0];
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://api.test.example.com/api/agent-memory/memories/');
    expect(call.body).toMatchObject({
      organization_id: 'wt-001',
      // ：归属 = 可信上下文的 agent_id，非 LLM 自选 space
      agent_id: 'ag-001',
      content: '# 用户喜欢深色主题',
      memory_type: 'about_you',
      importance: 4,
      tags: ['preference'],
      source_ref: 'thread://sess-1',
    });
    // 旧 Memo 分流字段不再出现
    expect(call.body!.source).toBeUndefined();
    expect(call.body!.content_markdown).toBeUndefined();
    expect(call.body!.space_id).toBeUndefined();
    const parsed = parseToolContent(result.content as string);
    expect(parsed.success).toBe(true);
    expect(parsed.memo_id).toBe('memo-uuid');
    expect(parsed.memo_type).toBe('about_you');
  });

  it('defaults memory_type to insight when not specified', async () => {
    mock.setResponder(() => buildJsonResponse({
      success: true, data: { id: 'memo-2', memory_type: 'insight' },
    }, { status: 201 }));
    const tool = findTool(createDataTools(buildDeps()), 'memory_write');
    await tool.execute({ content: 'note' }, noopContext);
    expect(mock.calls[0].body!.memory_type).toBe('insight');
  });

  it('rejects empty content', async () => {
    const tool = findTool(createDataTools(buildDeps()), 'memory_write');
    const result = await tool.execute({ content: '' }, noopContext);
    expect(mock.calls).toHaveLength(0);
    expect(result.isError).toBe(true);
  });

  // ：缺 agent_id（可信上下文）→ 写入前明确失败，绝不写无主行。
  it('returns runtime_misconfig if agent_id missing (no unowned write)', async () => {
    const tool = findTool(createDataTools(buildDeps({ agentId: undefined })), 'memory_write');
    const result = await tool.execute({ content: 'remember this' }, noopContext);
    expect(mock.calls).toHaveLength(0);
    expect(result.isError).toBe(true);
    const parsed = parseToolContent(result.content as string);
    expect(parsed.error_kind).toBe('runtime_misconfig');
    expect(parsed.missing).toBe('agent_id');
  });
});

// ─── memory_delete ───────────────────────────────────────────────────

describe('memory_delete', () => {
  let mock: MockFetchHandle;
  beforeEach(() => { mock = installMockFetch(); });

  it('POSTs /agent-memory/memories/{id}/forget/ with (org, agent) body ', async () => {
    mock.setResponder(() => buildJsonResponse({
      success: true, data: { memory_id: 'abc-123', forgotten: true, changed: true },
    }));
    const tool = findTool(createDataTools(buildDeps()), 'memory_delete');
    const result = await tool.execute({ memo_id: 'abc-123' }, noopContext);

    expect(mock.calls[0].method).toBe('POST');
    // ：按 ID 的 forget 走 /agent-memory 显式端点，不再落 Memo 表 archive/
    expect(mock.calls[0].url).toBe('https://api.test.example.com/api/agent-memory/memories/abc-123/forget/');
    expect(mock.calls[0].body).toMatchObject({ organization_id: 'wt-001', agent_id: 'ag-001' });
    const parsed = parseToolContent(result.content as string);
    expect(parsed.forgotten).toBe(true);
    expect(parsed.changed).toBe(true);
  });

  it('rejects empty memo_id', async () => {
    const tool = findTool(createDataTools(buildDeps()), 'memory_delete');
    const result = await tool.execute({}, noopContext);
    expect(mock.calls).toHaveLength(0);
    expect(result.isError).toBe(true);
  });

  // /#4118：缺 agent_id（可信上下文）→ forget 前明确失败。
  it('returns runtime_misconfig if agent_id missing (no unscoped forget)', async () => {
    const tool = findTool(createDataTools(buildDeps({ agentId: undefined })), 'memory_delete');
    const result = await tool.execute({ memo_id: 'abc-123' }, noopContext);
    expect(mock.calls).toHaveLength(0);
    expect(result.isError).toBe(true);
    const parsed = parseToolContent(result.content as string);
    expect(parsed.error_kind).toBe('runtime_misconfig');
    expect(parsed.missing).toBe('agent_id');
  });
});

// ─── list_conversations ──────────────────────────────────────────────

// list_conversations / read_conversation 已在工具系统宪法 W1 中删除。

// ─── credential_lookup ───────────────────────────────────────────────

describe('credential_lookup', () => {
  let mock: MockFetchHandle;
  beforeEach(() => { mock = installMockFetch(); });

  it('queries /website/match when domain is given', async () => {
    const SECRET = 'lookup-secret-should-not-leak';
    mock.setResponder(() => buildJsonResponse([
      {
        id: 'wc-1',
        url: 'https://github.com',
        username: 'me',
        masked_password: '****',
        password: SECRET,
        secret: SECRET,
      },
    ]));
    const tool = findTool(createDataTools(buildDeps()), 'credential_lookup');
    const result = await tool.execute({ domain: 'github.com' }, noopContext);

    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].url).toContain('/credential-vault/website/match');
    expect(mock.calls[0].url).toContain('domain=github.com');
    const parsed = parseToolContent(result.content as string);
    const credentials = parsed.website_credentials as Array<Record<string, unknown>>;
    expect(credentials.length).toBe(1);
    expect(credentials[0].id).toBe('wc-1');
    expect(credentials[0].username).toBe('me');
    expect(credentials[0].masked_password).toBe('****');
    expect(credentials[0].password).toBeUndefined();
    expect(credentials[0].secret).toBeUndefined();
    expect(result.content as string).not.toContain(SECRET);
  });

  it('queries both website and app endpoints when both inputs are given', async () => {
    mock.setResponder((call) => {
      if (call.url.includes('/website/')) {
        return buildJsonResponse([{ id: 'w', url: 'x', username: 'u', masked_password: '****' }]);
      }
      if (call.url.includes('/app/')) {
        return buildJsonResponse([{ id: 'a', app_package: 'com.x', username: 'u', masked_password: '****' }]);
      }
      return buildJsonResponse([]);
    });
    const tool = findTool(createDataTools(buildDeps()), 'credential_lookup');
    const result = await tool.execute({ domain: 'x.com', app_package: 'com.x' }, noopContext);

    expect(mock.calls).toHaveLength(2);
    const parsed = parseToolContent(result.content as string);
    const websiteCreds = parsed.website_credentials as Array<Record<string, unknown>>;
    const appCreds = parsed.app_credentials as Array<Record<string, unknown>>;
    expect(websiteCreds.length).toBe(1);
    expect(appCreds.length).toBe(1);
    // 修复 4：每条凭据带 credential_type，让 retrieve 不必猜
    expect(websiteCreds[0].credential_type).toBe('website');
    expect(appCreds[0].credential_type).toBe('app');
  });

  it('rejects when neither domain nor app_package given', async () => {
    const tool = findTool(createDataTools(buildDeps()), 'credential_lookup');
    const result = await tool.execute({}, noopContext);
    expect(mock.calls).toHaveLength(0);
    expect(result.isError).toBe(true);
  });
});

// ─── credential_retrieve ─────────────────────────────────────────────

describe('credential_retrieve', () => {
  let mock: MockFetchHandle;
  beforeEach(() => { mock = installMockFetch(); });

  it('GETs /credential-vault/list?category=website_login and withholds secret from ToolResult.content', async () => {
    const SECRET = 'secret123';
    mock.setResponder((call) => {
      if (call.method === 'GET' && call.url.includes('/credential-vault/list')) {
        return buildJsonResponse([
          {
            id: 'wc-1',
            category: 'website_login',
            service_name: 'github.com',
            is_active: true,
            masked_data: {
              url: 'https://github.com',
              username: 'me',
              password: '****',
            },
          },
        ]);
      }
      return buildJsonResponse({ success: false });
    });
    const tool = findTool(createDataTools(buildDeps()), 'credential_retrieve');
    const result = await tool.execute({
      credential_id: 'wc-1',
      credential_type: 'website',
    }, noopContext);

    expect(mock.calls[0].method).toBe('GET');
    expect(mock.calls[0].url).toBe(
      'https://api.test.example.com/api/credential-vault/list?category=website_login',
    );
    const parsed = parseToolContent(result.content as string);
    expect(parsed.success).toBe(true);
    expect(parsed.username).toBe('me');
    expect(parsed.url).toBe('https://github.com');
    expect(parsed.password).toBeUndefined();
    expect(parsed.secret_value_returned).toBe(false);
    expect(parsed.status).toBe('available_not_revealed');
    expect(parsed.credential_handle).toEqual({
      credential_id: 'wc-1',
      credential_type: 'website',
    });
    expect(result.content as string).not.toContain(SECRET);
  });

  it('GETs /credential-vault/list?category=app_login and withholds app secret from ToolResult.content', async () => {
    const SECRET = 'wx_secret';
    mock.setResponder((call) => {
      if (call.method === 'GET' && call.url.includes('/credential-vault/list')) {
        return buildJsonResponse([
          {
            id: 'ac-1',
            category: 'app_login',
            service_name: 'com.example.app',
            is_active: true,
            masked_data: {
              username: 'wx_user',
              password: '****',
            },
          },
        ]);
      }
      return buildJsonResponse({ success: false });
    });
    const tool = findTool(createDataTools(buildDeps()), 'credential_retrieve');
    const result = await tool.execute({
      credential_id: 'ac-1',
      credential_type: 'app',
    }, noopContext);

    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].method).toBe('GET');
    expect(mock.calls[0].url).toBe(
      'https://api.test.example.com/api/credential-vault/list?category=app_login',
    );
    expect(result.isError).toBeFalsy();
    const parsed = parseToolContent(result.content as string);
    expect(parsed.success).toBe(true);
    expect(parsed.credential_type).toBe('app');
    expect(parsed.username).toBe('wx_user');
    expect(parsed.password).toBeUndefined();
    expect(parsed.secret_value_returned).toBe(false);
    expect(parsed.status).toBe('available_not_revealed');
    expect(parsed.next_step).toContain('secure injection');
    expect(result.content as string).not.toContain(SECRET);
    expect(parsed.url).toBeUndefined();
  });

  it('does not persist mock secret when credential_retrieve result is archived in tool storage', async () => {
    const SECRET = 'archive_should_not_have_this_secret';
    mock.setResponder((call) => {
      if (call.method === 'GET' && call.url.includes('/credential-vault/list')) {
        return buildJsonResponse([
          {
            id: 'wc-archive',
            category: 'website_login',
            is_active: true,
            masked_data: {
              url: 'https://example.com',
              username: 'safe-user',
              password: '****',
            },
          },
        ]);
      }
      return buildJsonResponse({ success: false });
    });
    const tool = findTool(createDataTools(buildDeps()), 'credential_retrieve');
    const result = await tool.execute({
      credential_id: 'wc-archive',
      credential_type: 'website',
    }, noopContext);

    // Capture exactly what the runtime would feed `storage.save(id, _, content)`.
    let savedContent: string | null = null;
    const storage = new MemoryToolResultStorage();
    const wrapped = {
      save(id: string, toolName: string, content: string): void {
        savedContent = content;
        storage.save(id, toolName, content);
      },
    };
    wrapped.save('tool-call-credential', 'credential_retrieve', result.content as string);

    expect(result.content as string).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(savedContent).not.toBeNull();
    expect(savedContent!).not.toContain(SECRET);
  });

  it('returns failure when credential is inactive in list metadata', async () => {
    mock.setResponder(() => buildJsonResponse([
      {
        id: 'wc-disabled',
        category: 'website_login',
        is_active: false,
        masked_data: { username: 'disabled-user', password: '****' },
      },
    ]));
    const tool = findTool(createDataTools(buildDeps()), 'credential_retrieve');
    const result = await tool.execute({
      credential_id: 'wc-disabled',
      credential_type: 'website',
    }, noopContext);
    const parsed = parseToolContent(result.content as string);

    expect(result.isError).toBe(true);
    expect(parsed.success).toBe(false);
    expect(parsed.error_kind).toBe('resource_not_found');
    expect(parsed.upstream_code).toBe('CREDENTIAL_INACTIVE');
    expect(parsed.error).toContain('inactive');
  });

  it('returns failure when credential is expired in list metadata', async () => {
    mock.setResponder(() => buildJsonResponse([
      {
        id: 'ac-expired',
        category: 'app_login',
        is_active: true,
        expires_at: '2020-01-01T00:00:00.000Z',
        masked_data: { username: 'expired-user', password: '****' },
      },
    ]));
    const tool = findTool(createDataTools(buildDeps()), 'credential_retrieve');
    const result = await tool.execute({
      credential_id: 'ac-expired',
      credential_type: 'app',
    }, noopContext);
    const parsed = parseToolContent(result.content as string);

    expect(result.isError).toBe(true);
    expect(parsed.error_kind).toBe('resource_not_found');
    expect(parsed.upstream_code).toBe('CREDENTIAL_EXPIRED');
    expect(parsed.error).toContain('expired');
  });

  it('returns failure when credential id is missing from list metadata', async () => {
    mock.setResponder(() => buildJsonResponse([]));
    const tool = findTool(createDataTools(buildDeps()), 'credential_retrieve');
    const result = await tool.execute({
      credential_id: 'wc-gone',
      credential_type: 'website',
    }, noopContext);
    const parsed = parseToolContent(result.content as string);
    const raw = String(result.content);

    expect(result.isError).toBe(true);
    expect(parsed.error_kind).toBe('resource_not_found');
    expect(parsed.error).toContain('not found');
    expect(parsed.hint).toMatch(/credential_lookup|re-save/i);
    expect(parsed.upstream_code).toBe('NOT_FOUND');
    // 运维归因码安全：不含 credential id / secret / masked payload
    expect(raw).not.toContain('wc-gone');
    expect(raw).not.toMatch(/password|secret|token|api[_-]?key/i);
  });

  it('propagates rate_limited (429) from list endpoint as normalized failure', async () => {
    mock.setResponder(() => buildJsonResponse(
      { success: false, message: '请求过于频繁', code: 'RATE_LIMITED' },
      { status: 429 },
    ));
    const tool = findTool(createDataTools(buildDeps()), 'credential_retrieve');
    const result = await tool.execute({
      credential_id: 'ac-1',
      credential_type: 'app',
    }, noopContext);
    expect(result.isError).toBe(true);
    const parsed = parseToolContent(result.content as string);
    expect(parsed.error_kind).toBe('rate_limited');
    expect(parsed.error_label).toBe('rate_limited');
    expect(parsed.hint).toContain('credential_retrieve');
  });

  it('propagates list lookup HTTP errors as normalized failure', async () => {
    mock.setResponder(() => buildJsonResponse(
      { success: false, message: '凭据不存在', code: 'NOT_FOUND' },
      { status: 404 },
    ));
    const tool = findTool(createDataTools(buildDeps()), 'credential_retrieve');
    const result = await tool.execute({
      credential_id: 'ac-gone',
      credential_type: 'app',
    }, noopContext);
    expect(result.isError).toBe(true);
    const parsed = parseToolContent(result.content as string);
    expect(parsed.error_kind).toBe('resource_not_found');
    expect(parsed.error_label).toBe('not_found');
  });

  it('rejects missing credential_type (must be explicit, prevents app→website misuse)', async () => {
    const tool = findTool(createDataTools(buildDeps()), 'credential_retrieve');
    const result = await tool.execute({ credential_id: 'wc-2' }, noopContext);
    // 不传 credential_type 时必须返回参数错；不允许默认 website 路径
    // （否则 App 凭据 ID 漏传 type 会走错路径，命中 404 或泄漏到错误 API）。
    expect(mock.calls).toHaveLength(0);
    expect(result.isError).toBe(true);
    const parsed = parseToolContent(result.content as string);
    // W13：参数格式不合法 → error_kind=invalid_param_format
    expect(parsed.error_kind).toBe('invalid_param_format');
    expect(parsed.error).toContain('credential_type');
  });

  it('rejects empty credential_id', async () => {
    const tool = findTool(createDataTools(buildDeps()), 'credential_retrieve');
    const result = await tool.execute({}, noopContext);
    expect(mock.calls).toHaveLength(0);
    expect(result.isError).toBe(true);
  });
});

// ─── 错误处理统一 ─────────────────────────────────────────────────────

describe('callApi — error normalization', () => {
  let mock: MockFetchHandle;
  beforeEach(() => { mock = installMockFetch(); });

  it('maps HTTP 401 to error_label=unauthorized', async () => {
    mock.setResponder(() => buildJsonResponse(
      { success: false, message: 'Token 已过期' },
      { status: 401 },
    ));
    const tool = findTool(createDataTools(buildDeps()), 'memory_search');
    const result = await tool.execute({ query: 'x' }, noopContext);
    expect(result.isError).toBe(true);
    const parsed = parseToolContent(result.content as string);
    expect(parsed.error_label).toBe('unauthorized');
    expect(parsed.error_kind).toBe('auth_failed');
    expect(parsed.error).toBe('Authentication is required for this operation.');
    expect(parsed.hint).toContain('sign in again');
  });

  it('maps HTTP 429 to error_label=rate_limited', async () => {
    mock.setResponder(() => buildJsonResponse(
      { success: false, message: '请求过于频繁' },
      { status: 429 },
    ));
    const tool = findTool(createDataTools(buildDeps()), 'memory_search');
    const result = await tool.execute({ query: 'q' }, noopContext);
    const parsed = parseToolContent(result.content as string);
    expect(parsed.error_label).toBe('rate_limited');
    expect(parsed.error_kind).toBe('rate_limited');
  });

  it('maps generic HTTP 400 to invalid_param_format', async () => {
    mock.setResponder(() => buildJsonResponse(
      { success: false, message: 'serializer.errors: request_dict invalid' },
      { status: 400 },
    ));
    const tool = findTool(createDataTools(buildDeps()), 'memory_write');
    const result = await tool.execute({ content: 'remember this' }, noopContext);
    const parsed = parseToolContent(result.content as string);
    expect(parsed.error_label).toBe('invalid_input');
    expect(parsed.error_kind).toBe('invalid_param_format');
    expect(JSON.stringify(parsed)).not.toMatch(/serializer\.errors|request_dict/);
  });

  it('maps HTTP 5xx to error_label=service_unavailable', async () => {
    mock.setResponder(() => buildJsonResponse({}, { status: 503 }));
    const tool = findTool(createDataTools(buildDeps()), 'memory_search');
    const result = await tool.execute({ query: 'q' }, noopContext);
    const parsed = parseToolContent(result.content as string);
    expect(parsed.error_label).toBe('service_unavailable');
    expect(parsed.error_kind).toBe('upstream_error');
  });

  it('maps fetch network failures to error_label=network_error', async () => {
    mock.setResponder(() => { throw new TypeError('fetch failed'); });
    const tool = findTool(createDataTools(buildDeps()), 'memory_search');
    const result = await tool.execute({ query: 'q' }, noopContext);
    const parsed = parseToolContent(result.content as string);
    expect(parsed.error_label).toBe('network_error');
    expect(parsed.error_kind).toBe('network_failed');
  });

  it('handles non-JSON 200 body as error_label=bad_response', async () => {
    mock.setResponder(() => new Response('plain text not json', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    }));
    const tool = findTool(createDataTools(buildDeps()), 'memory_search');
    const result = await tool.execute({ query: 'q' }, noopContext);
    const parsed = parseToolContent(result.content as string);
    expect(parsed.error_label).toBe('bad_response');
    expect(parsed.error_kind).toBe('upstream_error');
  });
});

// ─── 凭据缺失或代理工作正常 (Authorization header / organization header) ──

describe('headers injection', () => {
  let mock: MockFetchHandle;
  beforeEach(() => { mock = installMockFetch(); });

  it('omits Authorization when token is undefined', async () => {
    mock.setResponder(() => buildJsonResponse({ success: true, query: 'q', total: 0, hits: [], type_counts: {} }));
    const tool = findTool(createDataTools(buildDeps({ apiAuthToken: undefined })), 'memory_search');
    await tool.execute({ query: 'q' }, noopContext);
    expect(mock.calls[0].headers['Authorization']).toBeUndefined();
  });

  it('injects X-TabTin-Organization-Id when organizationId provided', async () => {
    mock.setResponder(() => buildJsonResponse({ success: true, query: 'q', total: 0, hits: [], type_counts: {} }));
    const tool = findTool(createDataTools(buildDeps()), 'memory_search');
    await tool.execute({ query: 'q' }, noopContext);
    expect(mock.calls[0].headers['X-TabTin-Organization-Id']).toBe('wt-001');
  });
});

// ─── callMemorySearchAPI helper (memory-injector recall path, /#4100) ──

describe('callMemorySearchAPI — recall helper', () => {
  let mock: MockFetchHandle;
  beforeEach(() => { mock = installMockFetch(); });

  it('GETs /agent-memory/memories/ scoped by (org, agent), maps DTO fields', async () => {
    mock.setResponder(() => buildJsonResponse({
      success: true,
      data: {
        items: [{
          id: 'm1',
          content: 'user prefers tabs',
          memory_type: 'about_you',
          tags: ['pref'],
          created_at: '2026-04-01T10:00:00Z',
          source_ref: 'thread://s1',
        }],
        next_cursor: '',
        has_more: false,
      },
    }));
    const memos = await callMemorySearchAPI(buildDeps(), { query: 'tabs', limit: 5 });

    expect(mock.calls).toHaveLength(1);
    const call = mock.calls[0];
    expect(call.method).toBe('GET');
    expect(call.url).toContain('/agent-memory/memories/');
    expect(call.url).toContain('organization_id=wt-001');
    expect(call.url).toContain('agent_id=ag-001');
    expect(call.url).not.toContain('source=agent');
    expect(memos).toHaveLength(1);
    expect(memos[0]).toMatchObject({
      id: 'm1',
      content: 'user prefers tabs',
      memo_type: 'about_you',
      source_url: 'thread://s1',
    });
  });

  it('#4100: reports ok(count) outcome on hits', async () => {
    mock.setResponder(() => buildJsonResponse({
      success: true,
      data: { items: [{ id: 'm1', content: 'a' }, { id: 'm2', content: 'b' }], next_cursor: '', has_more: false },
    }));
    const outcomes: MemoryRecallFetchOutcome[] = [];
    const memos = await callMemorySearchAPI(buildDeps(), { query: 'x' }, {
      reportOutcome: (o) => outcomes.push(o),
    });
    expect(memos).toHaveLength(2);
    expect(outcomes).toEqual([{ kind: 'ok', count: 2 }]);
  });

  it('#4100: reports zero_hit outcome on empty result (not混同失败)', async () => {
    mock.setResponder(() => buildJsonResponse({
      success: true, data: { items: [], next_cursor: '', has_more: false },
    }));
    const outcomes: MemoryRecallFetchOutcome[] = [];
    const memos = await callMemorySearchAPI(buildDeps(), { query: 'x' }, {
      reportOutcome: (o) => outcomes.push(o),
    });
    expect(memos).toHaveLength(0);
    expect(outcomes).toEqual([{ kind: 'zero_hit' }]);
  });

  it('#4100: reports error(misconfig) when agent_id missing, no HTTP', async () => {
    const outcomes: MemoryRecallFetchOutcome[] = [];
    const memos = await callMemorySearchAPI(buildDeps({ agentId: undefined }), { query: 'x' }, {
      reportOutcome: (o) => outcomes.push(o),
    });
    expect(mock.calls).toHaveLength(0);
    expect(memos).toHaveLength(0);
    expect(outcomes).toEqual([{ kind: 'error', category: 'misconfig' }]);
  });

  it('#4100: maps HTTP 401 → error(auth), 429 → error(rate_limited), 503 → error(server)', async () => {
    const cases: Array<{ status: number; category: string }> = [
      { status: 401, category: 'auth' },
      { status: 429, category: 'rate_limited' },
      { status: 503, category: 'server' },
    ];
    for (const c of cases) {
      const outcomes: MemoryRecallFetchOutcome[] = [];
      mock.setResponder(() => buildJsonResponse({ success: false }, { status: c.status }));
      const memos = await callMemorySearchAPI(buildDeps(), { query: 'x' }, {
        reportOutcome: (o) => outcomes.push(o),
      });
      expect(memos).toHaveLength(0);
      expect(outcomes).toEqual([{ kind: 'error', category: c.category }]);
    }
  });

  it('#4100: maps network failure → error(network)', async () => {
    mock.setResponder(() => { throw new TypeError('fetch failed'); });
    const outcomes: MemoryRecallFetchOutcome[] = [];
    const memos = await callMemorySearchAPI(buildDeps(), { query: 'x' }, {
      reportOutcome: (o) => outcomes.push(o),
    });
    expect(memos).toHaveLength(0);
    expect(outcomes).toEqual([{ kind: 'error', category: 'network' }]);
  });
});
