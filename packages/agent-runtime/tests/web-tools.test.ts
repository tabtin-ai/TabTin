/**
 * web-tools 测试 — 重点覆盖 W7 双层结果（emit RICH_CONTENT + llmStripKeys）。
 *
 * web_search 是 HTTP wrapper（POST /search/web）；mock 全局 fetch 与 data-tools
 * 同模式，让我们专注 emit / strip / 摘要截断的契约。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWebTools } from '../src/tools/web-tools.js';
import type {
  Tool,
  ToolContext,
} from '../src/engine/contracts/tools.js';

const noopContext: ToolContext = {
  threadId: 't',
  runtimeId: 's',
  toolUseId: 'mock-tool-use',
  abortSignal: new AbortController().signal,
  messages: [],
};

/**
 * W4.5 第三波 C1（2026-05-13）fixture 重写：富内容 emit 形态。
 *
 * 工具实际生产路径：`context.emitRichContentBlock({ kind, summary, payload, groupId? })`
 * → `query.ts.makeRichContentBlockEmitter` → envelope 5 件套。
 * 测试 fixture 注入轻量 mock，断言 `richBlocks[i].kind / payload.X`。
 */
type RichBlockArg = {
  kind: string;
  summary: string;
  groupId?: string;
  payload?: Record<string, unknown>;
};

function ctxWithRichEmit(richBlocks: RichBlockArg[]): ToolContext {
  return {
    ...noopContext,
    emitRichContentBlock: (args) => richBlocks.push(args as RichBlockArg),
  };
}

interface MockCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

function buildJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installFetch(): { calls: MockCall[]; setResponder: (r: () => Response) => void } {
  const calls: MockCall[] = [];
  let responder: () => Response = () => buildJson({});
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let parsedBody: Record<string, unknown> | null = null;
    if (init?.body && typeof init.body === 'string') {
      try { parsedBody = JSON.parse(init.body); } catch { parsedBody = null; }
    }
    calls.push({
      url: typeof input === 'string' ? input : input.toString(),
      method: init?.method ?? 'GET',
      body: parsedBody,
    });
    return responder();
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, setResponder: (r) => { responder = r; } };
}

function findTool(tools: Tool[], name: string): Tool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

afterEach(() => { vi.unstubAllGlobals(); });

const deps = { apiBaseUrl: 'https://api.test.example.com/api', apiAuthToken: 'tk', organizationId: 'wt' };

describe('web_search W7 工具结果', () => {
  let mock: ReturnType<typeof installFetch>;
  beforeEach(() => { mock = installFetch(); });

  it('reuses Agent run and tool-use identity across HTTP retries', async () => {
    mock.setResponder(() => buildJson({ results: [], total_count: 0 }));
    const tool = findTool(createWebTools(deps), 'web_search');
    const context: ToolContext = {
      ...noopContext,
      agentRunId: '11111111-1111-1111-1111-111111111111',
      toolUseId: 'tool-search-123',
    };

    await tool.execute({ search_term: 'OpenAI' }, context);
    await tool.execute({ search_term: 'OpenAI' }, context);

    expect(mock.calls.map((call) => call.body)).toEqual([
      {
        query: 'OpenAI',
        count: 8,
        biz_type: 'orchestration.web_search',
        agent_run_id: '11111111-1111-1111-1111-111111111111',
        client_tool_invocation_component: 'tool-search-123',
      },
      {
        query: 'OpenAI',
        count: 8,
        biz_type: 'orchestration.web_search',
        agent_run_id: '11111111-1111-1111-1111-111111111111',
        client_tool_invocation_component: 'tool-search-123',
      },
    ]);
  });

  it('returns preview results for LLM and full results for the tool UI without emitting rich content', async () => {
    mock.setResponder(() => buildJson({
      summary: 'AI summary text',
      results: [
        { title: 'A', url: 'https://a.example/x', snippet: 'first hit' },
        { title: 'B', url: 'https://b.example/y', snippet: 'second hit' },
        { title: 'C', url: 'https://c.example/z', snippet: 'third hit' },
        { title: 'D', url: 'https://d.example/w', snippet: 'fourth hit' },
      ],
      total_count: 4,
    }));
    const richBlocks: RichBlockArg[] = [];
    const ctx = ctxWithRichEmit(richBlocks);
    const tool = findTool(createWebTools(deps), 'web_search');
    const result = await tool.execute({ search_term: 'tabtin docs' }, ctx);

    expect(richBlocks).toHaveLength(0);

    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    // LLM 摘要：3 条预览 + total_count + summary 文本
    expect((parsed.results as unknown[]).length).toBe(3);
    expect(parsed.total_count).toBe(4);
    expect(parsed.shown_in_summary).toBe(3);
    expect(parsed.summary_offset).toBe(0);
    expect(parsed.summary_range).toBe('1-3');
    expect(parsed.has_more_in_summary).toBe(true);
    expect(parsed.next_summary_offset).toBe(3);
    expect(parsed.summary).toBe('AI summary text');
    // 完整列表给前端持久化（被 llmStripKeys 排除 LLM 上下文）
    expect((parsed._search_results as unknown[]).length).toBe(4);
    expect(result.llmStripKeys).toContain('_search_results');
  });

  it('does NOT emit when results are empty', async () => {
    mock.setResponder(() => buildJson({ results: [], total_count: 0 }));
    const richBlocks: RichBlockArg[] = [];
    const ctx = ctxWithRichEmit(richBlocks);
    const tool = findTool(createWebTools(deps), 'web_search');
    const result = await tool.execute({ search_term: 'no hits' }, ctx);
    expect(richBlocks).toHaveLength(0);
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    expect(parsed.success).toBe(true);
    expect(parsed.total_count).toBe(0);
  });

  it('truncates LLM snippet beyond 200 chars + appends ellipsis', async () => {
    const longSnippet = 'z'.repeat(500);
    mock.setResponder(() => buildJson({
      results: [{ title: 'big', url: 'https://x', snippet: longSnippet }],
      total_count: 1,
    }));
    const tool = findTool(createWebTools(deps), 'web_search');
    const result = await tool.execute({ search_term: 'q' }, noopContext);
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    const previewSnippet = (parsed.results as Array<Record<string, string>>)[0].snippet;
    expect(previewSnippet.length).toBeLessThanOrEqual(201);
    expect(previewSnippet.endsWith('…')).toBe(true);
  });

  // L34-cjk：CJK 字符截断守护——`.length` 计 UTF-16 code unit，中文是 1 length
  // 但 UTF-8 3 bytes，emoji 是 2 length（surrogate pair）。当前实现用 `.length` 截断，
  // 行为正确但之前没用例覆盖。本测试加锁，避免后续改成 byteLength 引发体验回退。
  it('L34-cjk: CJK + emoji snippet 截断按 .length 计数（200 字符上限）', async () => {
    const longCjk = '搜'.repeat(800) + '🌟'.repeat(50);
    mock.setResponder(() => buildJson({
      results: [{ title: '中文', url: 'https://x', snippet: longCjk }],
      total_count: 1,
    }));
    const tool = findTool(createWebTools(deps), 'web_search');
    const result = await tool.execute({ search_term: '搜' }, noopContext);
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    const previewSnippet = (parsed.results as Array<Record<string, string>>)[0].snippet;
    expect(previewSnippet.length).toBeLessThanOrEqual(201);
    expect(previewSnippet.endsWith('…')).toBe(true);
    expect(previewSnippet.startsWith('搜')).toBe(true);
  });

  it('ignores rich content emitter failures because web_search no longer emits rich content', async () => {
    mock.setResponder(() => buildJson({
      results: [{ title: 't', url: 'https://x', snippet: 's' }],
      total_count: 1,
    }));
    const ctx: ToolContext = {
      ...noopContext,
      emitRichContentBlock: () => { throw new Error('emit failed'); },
    };
    const tool = findTool(createWebTools(deps), 'web_search');
    const result = await tool.execute({ search_term: 'q' }, ctx);
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    expect(parsed.success).toBe(true);
    expect((parsed.results as unknown[]).length).toBe(1);
  });

  it('rejects empty search_term without calling fetch', async () => {
    const tool = findTool(createWebTools(deps), 'web_search');
    const result = await tool.execute({ search_term: '   ' }, noopContext);
    expect(mock.calls).toHaveLength(0);
    expect(result.isError).toBe(true);
  });

  it('offset 翻页：展示后续摘要窗口并给出 next_summary_offset', async () => {
    mock.setResponder(() => buildJson({
      results: [
        { title: 'A', url: 'https://a.example/x', snippet: 'first hit' },
        { title: 'B', url: 'https://b.example/y', snippet: 'second hit' },
        { title: 'C', url: 'https://c.example/z', snippet: 'third hit' },
        { title: 'D', url: 'https://d.example/w', snippet: 'fourth hit' },
        { title: 'E', url: 'https://e.example/v', snippet: 'fifth hit' },
      ],
      total_count: 5,
    }));
    const tool = findTool(createWebTools(deps), 'web_search');
    const result = await tool.execute({ search_term: 'tabtin docs', offset: 3 }, noopContext);
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    expect(parsed.summary_offset).toBe(3);
    expect(parsed.summary_range).toBe('4-5');
    expect(parsed.shown_in_summary).toBe(2);
    expect(parsed.has_more_in_summary).toBe(false);
    expect(parsed.next_summary_offset).toBeNull();
    const preview = parsed.results as Array<Record<string, unknown>>;
    expect(preview.map((r) => r.index)).toEqual([4, 5]);
    expect(preview.map((r) => r.title)).toEqual(['D', 'E']);
  });

  it('truncates API summary beyond 2000 chars and sets summary_truncated', async () => {
    const longSummary = 's'.repeat(2500);
    mock.setResponder(() => buildJson({
      summary: longSummary,
      results: [{ title: 't', url: 'https://x', snippet: 's' }],
      total_count: 1,
    }));
    const tool = findTool(createWebTools(deps), 'web_search');
    const result = await tool.execute({ search_term: 'q' }, noopContext);
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    expect(parsed.summary_truncated).toBe(true);
    expect((parsed.summary as string).length).toBeLessThanOrEqual(2001);
    expect((parsed.summary as string).endsWith('…')).toBe(true);
  });
});
