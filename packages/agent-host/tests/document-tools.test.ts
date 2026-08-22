/**
 * document-tools 测试 — 重点覆盖 W7 双层结果（emit document_excerpt + 异步状态）。
 *
 * parse_document 是 HTTP wrapper（GET /services/docparse/content/:fileId）。
 * 测试目标：
 *   - status='parsing' / 'pending' / 'success' / 'partial' 都 emit 对应 RICH_CONTENT
 *   - chunks 被截断到 UI_CHUNK_PREVIEW_CHARS 后送 UI；LLM 仍看完整文本拼接
 *   - 失败 / 空内容兜底
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDocumentTools } from '../src/tools/document-tools.js';
import type {
  Tool,
  ToolContext,
} from '@tabtin/agent-runtime';

const noopContext: ToolContext = {
  threadId: 't',
  runtimeId: 's',
  toolUseId: 'mock-tool-use',
  abortSignal: new AbortController().signal,
  messages: [],
};

/**
 * W4.5 第三波 C1（2026-05-13）fixture 重写：富内容 emit 形态。
 * 工具实际生产路径走 `context.emitRichContentBlock({ kind, summary, payload })`。
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

function buildJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installFetch(): { setResponder: (r: () => Response) => void } {
  let responder: () => Response = () => buildJson({});
  const fetchMock = vi.fn(async (): Promise<Response> => responder());
  vi.stubGlobal('fetch', fetchMock);
  return { setResponder: (r) => { responder = r; } };
}

function findTool(tools: Tool[], name: string): Tool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

afterEach(() => { vi.unstubAllGlobals(); });

const deps = { apiBaseUrl: 'https://api.test.example.com/api', apiAuthToken: 'tk', organizationId: 'wt' };

describe('parse_document W7 双层结果', () => {
  let mock: ReturnType<typeof installFetch>;
  beforeEach(() => { mock = installFetch(); });

  it('does not present lossy parsed text as a substitute for opening the original file', () => {
    const tool = findTool(createDocumentTools(deps), 'parse_document');
    expect(tool.description).toContain('save_attachment');
    expect(tool.description).toContain('browser open');
    expect(tool.description).toContain('present_to_user');
  });

  it('emits document_excerpt with parsing status when backend reports parsing', async () => {
    mock.setResponder(() => buildJson({
      status: 'parsing',
      retry_after_ms: 15_000,
      message: 'Parsing in progress',
      parsed_pages: 5,
      total_pages: 20,
    }));
    const richBlocks: RichBlockArg[] = [];
    const ctx = ctxWithRichEmit(richBlocks);
    const tool = findTool(createDocumentTools(deps), 'parse_document');
    const result = await tool.execute({ file_id: 'f1' }, ctx);

    expect(richBlocks).toHaveLength(1);
    const block = richBlocks[0];
    expect(block.kind).toBe('document_excerpt');
    const payload = block.payload ?? {};
    expect(payload.parse_status).toBe('parsing');
    expect(payload.parsed_pages).toBe(5);
    expect(payload.total_pages).toBe(20);
    expect(payload.file_id).toBe('f1');

    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    expect(parsed.success).toBe(false);
    expect(parsed.status).toBe('parsing');
    expect(result.isError).toBe(true);
    expect(parsed.error_kind).toBe('document_not_ready');
    expect(typeof parsed.error).toBe('string');
    expect(typeof parsed.hint).toBe('string');
    expect((parsed.hint as string).length).toBeGreaterThan(0);
    expect(parsed.retryable).toBe(true);
    expect(parsed.retry).toBeUndefined();
    expect(parsed.message).toBeUndefined();
  });

  it('emits document_excerpt with pending status when backend reports pending', async () => {
    mock.setResponder(() => buildJson({ status: 'pending', retry_after_ms: 15_000 }));
    const richBlocks: RichBlockArg[] = [];
    const ctx = ctxWithRichEmit(richBlocks);
    const tool = findTool(createDocumentTools(deps), 'parse_document');
    const result = await tool.execute({ file_id: 'f1' }, ctx);
    expect(richBlocks).toHaveLength(1);
    expect(richBlocks[0].payload?.parse_status).toBe('pending');
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    expect(parsed.error_kind).toBe('document_not_ready');
    expect(typeof parsed.error).toBe('string');
    expect(typeof parsed.hint).toBe('string');
    expect(parsed.retryable).toBe(true);
    expect(parsed.retry).toBeUndefined();
    expect(parsed.message).toBeUndefined();
  });

  it('emits document_excerpt with success status + truncated chunks for normal response', async () => {
    const longContent = 'a'.repeat(2000);
    mock.setResponder(() => buildJson({
      total_chunks: 3,
      returned: 3,
      has_more: false,
      total_pages: 5,
      parsed_pages: 5,
      chunks: [
        { type: 'heading', content: 'Title', page: 1, heading_level: 1 },
        { type: 'paragraph', content: longContent, page: 1 },
        { type: 'paragraph', content: 'second page', page: 2 },
      ],
    }));
    const richBlocks: RichBlockArg[] = [];
    const ctx = ctxWithRichEmit(richBlocks);
    const tool = findTool(createDocumentTools(deps), 'parse_document');
    const result = await tool.execute({ file_id: 'f1' }, ctx);

    const block = richBlocks[0];
    const payload = block.payload ?? {};
    expect(payload.parse_status).toBe('success');
    const uiChunks = payload.document_chunks as Array<Record<string, unknown>>;
    expect(uiChunks).toHaveLength(3);
    expect((uiChunks[1].content as string).length).toBeLessThanOrEqual(1025); // 1024 + ellipsis
    expect((uiChunks[1].content as string).endsWith('…')).toBe(true);

    // LLM 仍看完整文本拼接（不被 UI 端截断影响）
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    expect(parsed.success).toBe(true);
    expect((parsed.content as string)).toContain('a'.repeat(2000));
  });

  it('waits through pending and returns the ready overview in one tool call', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    let attempt = 0;
    mock.setResponder(() => {
      attempt += 1;
      if (attempt === 1) {
        return buildJson({ status: 'pending', retry_after_ms: 0 });
      }
      return buildJson({
        status: 'ready',
        mode: 'overview',
        total_pages: 23,
        total_chunks: 150,
        returned: 2,
        has_more: false,
        coverage_pages: [1, 23],
        chunks: [
          { type: 'heading', content: 'Overview', page: 1, heading_level: 1 },
          { type: 'heading', content: 'Legal', page: 23, heading_level: 1 },
        ],
      });
    });

    const tool = findTool(createDocumentTools(deps), 'parse_document');
    const result = await tool.execute({ file_id: 'f1', mode: 'overview' }, noopContext);
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(parsed.status).toBe('complete');
    expect(parsed.total_pages).toBe(23);
    expect(parsed.content).toContain('Legal');
  });

  it('reports document_not_ready when the bounded wait times out', async () => {
    const timeoutError = new Error('bounded wait expired');
    timeoutError.name = 'TimeoutError';
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(timeoutError);

    const tool = findTool(createDocumentTools(deps), 'parse_document');
    const result = await tool.execute({ file_id: 'f1' }, noopContext);
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    expect(parsed.error_kind).toBe('document_not_ready');
    expect(parsed.status).toBe('pending');
    expect(parsed.retryable).toBe(true);
    expect(parsed.error).toContain('wait limit');
  });

  it('emits document_excerpt with partial status when has_more=true', async () => {
    mock.setResponder(() => buildJson({
      total_chunks: 100,
      returned: 50,
      has_more: true,
      offset: 0,
      chunks: [{ type: 'paragraph', content: 'x', page: 1 }],
    }));
    const richBlocks: RichBlockArg[] = [];
    const ctx = ctxWithRichEmit(richBlocks);
    const tool = findTool(createDocumentTools(deps), 'parse_document');
    const result = await tool.execute({ file_id: 'f1', mode: 'chunks' }, ctx);
    expect(richBlocks[0].payload?.parse_status).toBe('partial');
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    expect(parsed.status).toBe('partial');
    expect(parsed.returned_chunks).toBe(50);
    expect(parsed.warning).toContain('PARTIAL');
  });

  it('emits empty document_excerpt when chunks list is empty', async () => {
    mock.setResponder(() => buildJson({
      total_chunks: 0,
      returned: 0,
      has_more: false,
      chunks: [],
    }));
    const richBlocks: RichBlockArg[] = [];
    const ctx = ctxWithRichEmit(richBlocks);
    const tool = findTool(createDocumentTools(deps), 'parse_document');
    await tool.execute({ file_id: 'f1' }, ctx);
    const payload = richBlocks[0].payload ?? {};
    expect(payload.parse_status).toBe('success');
    expect((payload.document_chunks as unknown[])).toEqual([]);
  });

  it('emit failure does not break tool result', async () => {
    mock.setResponder(() => buildJson({
      total_chunks: 1,
      returned: 1,
      has_more: false,
      chunks: [{ type: 'paragraph', content: 'x', page: 1 }],
    }));
    const ctx: ToolContext = {
      ...noopContext,
      emitRichContentBlock: () => { throw new Error('emit failed'); },
    };
    const tool = findTool(createDocumentTools(deps), 'parse_document');
    const result = await tool.execute({ file_id: 'f1' }, ctx);
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    expect(parsed.success).toBe(true);
  });

  it('returns error and does NOT emit when status=failed', async () => {
    mock.setResponder(() => buildJson({ status: 'failed', message: 'OCR error' }));
    const richBlocks: RichBlockArg[] = [];
    const ctx = ctxWithRichEmit(richBlocks);
    const tool = findTool(createDocumentTools(deps), 'parse_document');
    const result = await tool.execute({ file_id: 'f1' }, ctx);
    expect(result.isError).toBe(true);
    // Failed 走 jsonError 路径，没有 emit（前端会从 tool error block 渲染）
    expect(richBlocks).toHaveLength(0);
  });

  // L34-cjk：CJK chunk 截断守护——document_chunks 用 .length 截断（1024 chars）
  // CJK 1 length 但 UTF-8 3 bytes，emoji 2 length；当前实现用 .length 是对的
  // （UI 卡片防撑爆按字符宽度更合理），本测试加锁避免回退到 byteLength。
  it('L34-cjk: CJK document chunk content 按 .length 截断（1024 字符上限）', async () => {
    const longCjk = '段'.repeat(2000);
    mock.setResponder(() => buildJson({
      total_chunks: 1,
      returned: 1,
      has_more: false,
      total_pages: 1,
      parsed_pages: 1,
      chunks: [{ type: 'paragraph', content: longCjk, page: 1 }],
    }));
    const richBlocks: RichBlockArg[] = [];
    const ctx = ctxWithRichEmit(richBlocks);
    const tool = findTool(createDocumentTools(deps), 'parse_document');
    const result = await tool.execute({ file_id: 'f1' }, ctx);
    const payload = richBlocks[0].payload ?? {};
    const uiChunks = payload.document_chunks as Array<Record<string, unknown>>;
    expect((uiChunks[0].content as string).length).toBeLessThanOrEqual(1025); // 1024 + ellipsis
    expect((uiChunks[0].content as string).endsWith('…')).toBe(true);
    expect((uiChunks[0].content as string).startsWith('段')).toBe(true);
    // LLM 仍应看到完整 CJK 内容
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    expect((parsed.content as string)).toContain('段'.repeat(2000));
  });
});

describe('parse_document limit & budget ', () => {
  let mock: ReturnType<typeof installFetch>;
  beforeEach(() => { mock = installFetch(); });

  it('declares maxResultSizeChars for enforceToolOutputBudget Phase 1', () => {
    const tool = findTool(createDocumentTools(deps), 'parse_document');
    expect(tool.maxResultSizeChars).toBe(50_000);
  });

  it('defaults to a page-balanced overview when no precise selector is provided', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    mock.setResponder(() => buildJson({
      total_chunks: 1,
      returned: 1,
      has_more: false,
      total_pages: 23,
      coverage_pages: [1, 12, 23],
      chunks: [{ type: 'paragraph', content: 'x', page: 1 }],
    }));
    const tool = findTool(createDocumentTools(deps), 'parse_document');
    await tool.execute({ file_id: 'f1' }, noopContext);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('mode=overview');
    expect(url).toContain('limit=20');
  });

  it('keeps total pages separate from chunk count and reports overview coverage', async () => {
    mock.setResponder(() => buildJson({
      status: 'ready',
      mode: 'overview',
      total_pages: 23,
      total_chunks: 430,
      returned: 3,
      has_more: false,
      coverage_pages: [1, 12, 23],
      chunks: [
        { type: 'heading', content: 'Start', page: 1, heading_level: 1 },
        { type: 'heading', content: 'Middle', page: 12, heading_level: 1 },
        { type: 'heading', content: 'Legal', page: 23, heading_level: 1 },
      ],
    }));
    const tool = findTool(createDocumentTools(deps), 'parse_document');
    const result = await tool.execute({ file_id: 'f1', mode: 'overview' }, noopContext);
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    expect(parsed.status).toBe('complete');
    expect(parsed.total_pages).toBe(23);
    expect(parsed.total_chunks).toBe(430);
    expect(parsed.coverage_pages).toEqual([1, 12, 23]);
    expect(parsed.content).toContain('Legal');
  });

  it('caps explicit limit at 500', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    mock.setResponder(() => buildJson({
      total_chunks: 1,
      returned: 1,
      has_more: false,
      chunks: [{ type: 'paragraph', content: 'x', page: 1 }],
    }));
    const tool = findTool(createDocumentTools(deps), 'parse_document');
    await tool.execute({ file_id: 'f1', limit: 999 }, noopContext);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('limit=500');
  });
});
