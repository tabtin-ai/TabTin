import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockCrawlCleanHtml = vi.hoisted(() => vi.fn());

vi.mock('@tabtin/action-tools/impl', async () => {
  const actual = await vi.importActual<typeof import('@tabtin/action-tools/impl')>('@tabtin/action-tools/impl');
  return {
    ...actual,
    getSharedCrawlToolImpl: () => ({
      crawlCleanHtml: mockCrawlCleanHtml,
    }),
  };
});

vi.mock('../../cli-context', () => ({
  getCLIViewGetter: () => null,
  getCLIActionExecutor: () => null,
  getCLISpaceId: () => null,
  getCLICrawlspaceId: () => null,
  getCLIContextSpaceBridge: () => null,
}));

vi.mock('../shared/error-handler', () => ({
  errorResponse: (code: string, message: string, opts?: Record<string, unknown>) => ({ code, message, ...opts }),
}));

vi.mock('../browser/_helpers', () => ({
  resolveTabId: vi.fn(),
  requireTabWithView: vi.fn(),
  makeTaskId: () => 'test-task-id',
  errorResponse: (code: string, message: string, opts?: Record<string, unknown>) => ({ code, message, ...opts }),
  isSafeUrl: (url: string) => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  },
  sanitizeSavePath: (p: string) => p, // 测试里直接放行临时目录路径
}));

vi.mock('../../../crawlspace/CrawlspaceContextHub', () => ({
  getCrawlspaceContextHub: () => ({ getSnapshot: () => null }),
}));

vi.mock('../../../view-factory/ViewFactory', () => ({
  getViewFactory: () => ({ getViewState: () => null }),
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
  },
}));

import { handlePrintRoute } from '../browser/print';

const TMP_DIR = mkdtempSync(join(tmpdir(), 'tabtin-print-schema-'));

type RoutePayload = {
  code?: string;
  data?: {
    path?: string;
    format?: string;
    schema_warnings?: string[];
  };
};

function createRecorder() {
  const calls: Array<{ status: number; data: RoutePayload }> = [];
  const sendJSON = vi.fn((_res: unknown, status: number, data: RoutePayload) => {
    calls.push({ status, data });
  });
  return { calls, sendJSON };
}

describe('browser print --as json schema 结构化投影', () => {
  it('writes structured_json projection to --save file', async () => {
    mockCrawlCleanHtml.mockResolvedValue({
      success: true,
      clean_html: '<main><h1>Schema Extract</h1><p>Author: Agent</p></main>',
      title: 'Schema Extract',
      url: 'https://example.com/post',
      content_length: 55,
    });
    const { calls, sendJSON } = createRecorder();
    const savePath = join(TMP_DIR, 'data.json');

    await handlePrintRoute('/print', {
      as: 'json',
      save: savePath,
      url: 'https://example.com/post',
      schema: JSON.stringify({
        type: 'object',
        properties: {
          title: { type: 'string' },
          author: { type: 'string' },
          url: { type: 'string', format: 'uri' },
        },
      }),
    }, {} as never, sendJSON, vi.fn() as never);

    expect(calls[0].status).toBe(200);
    expect(calls[0].data.data!.path).toBe(savePath);
    expect(calls[0].data.data!.format).toBe('json');
    const written = JSON.parse(readFileSync(savePath, 'utf-8'));
    expect(written).toEqual({
      title: 'Schema Extract',
      author: 'Agent',
      url: 'https://example.com/post',
    });
  });

  it('returns validation error when --as json lacks schema', async () => {
    mockCrawlCleanHtml.mockResolvedValue({
      success: true,
      clean_html: '<main><h1>Schema Extract</h1></main>',
      title: 'Schema Extract',
      url: 'https://example.com/post',
      content_length: 36,
    });
    const { calls, sendJSON } = createRecorder();

    await handlePrintRoute('/print', {
      as: 'json',
      save: join(TMP_DIR, 'missing-schema.json'),
      url: 'https://example.com/post',
    }, {} as never, sendJSON, vi.fn() as never);

    expect(calls[0].status).toBe(400);
    expect(calls[0].data.code).toBe('VALIDATION_ERROR');
  });

  it('returns validation error for invalid schema', async () => {
    mockCrawlCleanHtml.mockResolvedValue({
      success: true,
      clean_html: '<main><h1>Schema Extract</h1></main>',
      title: 'Schema Extract',
      url: 'https://example.com/post',
      content_length: 36,
    });
    const { calls, sendJSON } = createRecorder();

    await handlePrintRoute('/print', {
      as: 'json',
      save: join(TMP_DIR, 'bad-schema.json'),
      url: 'https://example.com/post',
      schema: '"not an object"',
    }, {} as never, sendJSON, vi.fn() as never);

    expect(calls[0].status).toBe(400);
    expect(calls[0].data.code).toBe('VALIDATION_ERROR');
  });

  it('default markdown format strips filterable content types', async () => {
    mockCrawlCleanHtml.mockResolvedValue({
      success: true,
      clean_html: '<main><h1>Title</h1><p>正文</p><a href="https://x.com">链接</a><img src="a.png"></main>',
      title: 'Title',
      url: 'https://example.com/page',
      content_length: 80,
    });
    const { calls, sendJSON } = createRecorder();
    const savePath = join(TMP_DIR, 'page.md');

    await handlePrintRoute('/print', {
      save: savePath,
      url: 'https://example.com/page',
    }, {} as never, sendJSON, vi.fn() as never);

    expect(calls[0].status).toBe(200);
    const md = readFileSync(savePath, 'utf-8');
    expect(md).toContain('正文');
    expect(md).toContain('链接'); // 链接文本保留（unwrap）
    expect(md).not.toContain('https://x.com'); // href 默认剥离
    expect(md).not.toContain('a.png'); // 图片默认剥离
  });
});
