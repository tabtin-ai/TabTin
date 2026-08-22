/**
 * Pdf/Docx/XlsxParser 个体单测（W4.1 收尾 S1）
 *
 * **W4.1 收尾背景**：W4 实施时 PdfParser / DocxParser / XlsxParser 三个
 * parser 共享 `runLocalDocParser` helper 但完全没有 parser 层个体测试。
 * channel 端 (tabcode-adapter-w2-dedup) 的 mock parseLocalAttachment 只测
 * dedup / size race，没钉死 parser 层"runDocParserTask 缺失 / memory-bytes /
 * worker 抛异常 / failure result 派发"等关键边界。
 *
 * **本测试覆盖 9+ case**（三 parser 共享 helper，分组覆盖共享逻辑 + 各自路由）：
 *   1. 路由：PdfParser / DocxParser / XlsxParser matches() 各自正确
 *   2. host 未注入 runDocParserTask → SSoT UNSUPPORTED_FORMAT envelope
 *      （W4 L42 收：让 channel dedup 始终启用，dep 缺失独立判断）
 *   3. memory-bytes source → SSoT INVALID_PARAMETER（local-docparse 当前不支持
 *      in-memory source）
 *   4. parseLocalAttachment 成功 → 返 TextResult（mimeType / pages / text 字段）
 *   5. parseLocalAttachment 返 failure → SSoT envelope（errorClass / message / format / subject）
 *   6. parseLocalAttachment 抛异常 → SSoT UNKNOWN_ERROR envelope
 *   7. oss-url source 透传 declaredMimeType / sizeBytes 给 worker
 *   8. options.timeoutMs / channelLimitBytes 转换给 worker
 *
 * **mock 模式**：用 `vi.mock('@tabtin/local-docparse')` 替 parseLocalAttachment ——
 * 与 `tabcode-adapter-w2-dedup.test.ts:38-43` 同款。local-doc-parsers.ts 用
 * dynamic import 跨包 hoist，本 mock 100% 生效（W4 实施纪要明确说明）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DocxParser,
  FilePipelineErrorCode,
  PdfParser,
  XlsxParser,
} from '../../index.js';
import type { ParseDeps, RunTempPptxParse } from '../../index.js';
import type { LocalDocParseResult, RunDocParserTask } from '@tabtin/local-docparse';

vi.mock('@tabtin/local-docparse', async () => {
  const actual = await vi.importActual<typeof import('@tabtin/local-docparse')>(
    '@tabtin/local-docparse',
  );
  return { ...actual, parseLocalAttachment: vi.fn() };
});

// 拿到 mock 引用以便逐 case 设置返回值
async function getParseLocalAttachmentMock() {
  const mod = await import('@tabtin/local-docparse');
  return mod.parseLocalAttachment as unknown as ReturnType<typeof vi.fn>;
}

const fakeRunDocParserTask: RunDocParserTask = vi.fn() as unknown as RunDocParserTask;
const fakeRunTempPptxParse: RunTempPptxParse = vi.fn() as unknown as RunTempPptxParse;

const depsWithLocalDocparse: ParseDeps = {
  runDocParserTask: fakeRunDocParserTask,
  runTempPptxParse: fakeRunTempPptxParse,
};
const depsWithoutLocalDocparse: ParseDeps = {
  runTempPptxParse: fakeRunTempPptxParse,
};

beforeEach(async () => {
  const mock = await getParseLocalAttachmentMock();
  mock.mockReset();
});

// ─── matches() routing ─────────────────────────────────────────────

describe('PdfParser / DocxParser / XlsxParser — matches() routing', () => {
  it('PdfParser matches .pdf ext + application/pdf mime, not others', () => {
    const parser = new PdfParser();
    expect(parser.matches({ ext: '.pdf' })).toBe(true);
    expect(parser.matches({ ext: '', mime: 'application/pdf' })).toBe(true);
    expect(parser.matches({ ext: '', mime: 'APPLICATION/PDF' })).toBe(true);
    expect(parser.matches({ ext: '.docx' })).toBe(false);
    expect(parser.matches({ ext: '.txt' })).toBe(false);
  });

  it('DocxParser matches .docx ext + DOCX mime, not legacy .doc', () => {
    const parser = new DocxParser();
    expect(parser.matches({ ext: '.docx' })).toBe(true);
    expect(
      parser.matches({
        ext: '',
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    ).toBe(true);
    // 老 .doc 不归 DocxParser（W4 抽象后 .doc 走 SSoT UNSUPPORTED_FORMAT）
    expect(parser.matches({ ext: '.doc' })).toBe(false);
    expect(parser.matches({ ext: '.pdf' })).toBe(false);
  });

  it('XlsxParser matches .xlsx ext + XLSX mime, not legacy .xls', () => {
    const parser = new XlsxParser();
    expect(parser.matches({ ext: '.xlsx' })).toBe(true);
    expect(
      parser.matches({
        ext: '',
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    ).toBe(true);
    expect(parser.matches({ ext: '.xls' })).toBe(false);
    expect(parser.matches({ ext: '.csv' })).toBe(false);
  });
});

// ─── host 未注入 runDocParserTask → UNSUPPORTED_FORMAT ─────────────

describe('PdfParser — runDocParserTask not injected → SSoT UNSUPPORTED_FORMAT envelope (W4 L42)', () => {
  it('PdfParser without dep returns SSoT envelope, not crash', async () => {
    const parser = new PdfParser();
    const result = await parser.parse(
      { kind: 'local-path', path: '/tmp/foo.pdf' },
      {},
      depsWithoutLocalDocparse,
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.code).toBe(FilePipelineErrorCode.UNSUPPORTED_FORMAT);
      expect(result.ctx.format).toBe('.pdf');
      expect(result.ctx.subject).toBe('document');
      expect(result.ctx.filename).toBe('foo.pdf');
      expect(result.message).toMatch(/runDocParserTask/);
    }
  });

  it('DocxParser without dep → same envelope', async () => {
    const parser = new DocxParser();
    const result = await parser.parse(
      { kind: 'local-path', path: '/tmp/foo.docx' },
      {},
      depsWithoutLocalDocparse,
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.code).toBe(FilePipelineErrorCode.UNSUPPORTED_FORMAT);
      expect(result.ctx.format).toBe('.docx');
    }
  });

  it('XlsxParser without dep → same envelope', async () => {
    const parser = new XlsxParser();
    const result = await parser.parse(
      { kind: 'local-path', path: '/tmp/foo.xlsx' },
      {},
      depsWithoutLocalDocparse,
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.code).toBe(FilePipelineErrorCode.UNSUPPORTED_FORMAT);
      expect(result.ctx.format).toBe('.xlsx');
    }
  });
});

// ─── memory-bytes source → INVALID_PARAMETER ──────────────────────

describe('PdfParser — memory-bytes source unsupported → INVALID_PARAMETER', () => {
  it('PDF memory-bytes returns INVALID_PARAMETER (local-docparse 不支持 in-memory)', async () => {
    const parser = new PdfParser();
    const result = await parser.parse(
      {
        kind: 'memory-bytes',
        bytes: Buffer.from('%PDF-1.4'),
        filename: 'foo.pdf',
      },
      {},
      depsWithLocalDocparse,
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.code).toBe(FilePipelineErrorCode.INVALID_PARAMETER);
      expect(result.ctx.format).toBe('.pdf');
      expect(result.ctx.filename).toBe('foo.pdf');
      expect(result.message).toMatch(/memory-bytes/);
    }
  });

  it('XLSX memory-bytes → same INVALID_PARAMETER (parserName transparent in message)', async () => {
    const parser = new XlsxParser();
    const result = await parser.parse(
      { kind: 'memory-bytes', bytes: Buffer.alloc(100), filename: 'sheet.xlsx' },
      {},
      depsWithLocalDocparse,
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.code).toBe(FilePipelineErrorCode.INVALID_PARAMETER);
      expect(result.message).toMatch(/xlsx/);
    }
  });
});

// ─── 成功路径：worker 返 LocalDocParseSuccess → TextResult ────────

describe('PdfParser — local-path success path returns TextResult', () => {
  it('PDF success: text + pages + isScanned + qualityScore 字段透传', async () => {
    const mock = await getParseLocalAttachmentMock();
    const fakeSuccess: LocalDocParseResult = {
      success: true,
      text: 'Hello PDF content extracted by mock parser.',
      pages: 12,
      isScanned: false,
      qualityScore: 0.95,
      mimeType: 'application/pdf',
      fileSizeBytes: 50_000,
      durationMs: 80,
    };
    mock.mockResolvedValueOnce(fakeSuccess);

    const parser = new PdfParser();
    const result = await parser.parse(
      { kind: 'local-path', path: '/tmp/sample.pdf' },
      { timeoutMs: 5000 },
      depsWithLocalDocparse,
    );
    expect(result.kind).toBe('text');
    if (result.kind === 'text') {
      expect(result.text).toBe('Hello PDF content extracted by mock parser.');
      expect(result.pages).toBe(12);
      expect(result.isScanned).toBe(false);
      expect(result.qualityScore).toBe(0.95);
      expect(result.mimeType).toBe('application/pdf');
      expect(result.fileSizeBytes).toBe(50_000);
      expect(result.durationMs).toBe(80);
    }
    // 钉死 worker 调用 contract
    expect(mock).toHaveBeenCalledTimes(1);
    const [input, options, depsArg] = mock.mock.calls[0]!;
    expect(input.source).toEqual({ kind: 'path', path: '/tmp/sample.pdf' });
    expect(input.mimeType).toBe('application/pdf');
    expect(input.filename).toBe('sample.pdf');
    expect(options.timeoutMs).toBe(5000);
    expect(depsArg.runDocParserTask).toBe(fakeRunDocParserTask);
  });

  it('XLSX success: mimeType fallback to cfg.mimeForSource when worker returns undefined', async () => {
    // **W4 SSoT 化（local-doc-parsers.ts:217-219）**：result.mimeType 在 mock /
    // 旧 worker 实现里可能 undefined；parser 必须 fallback 到 cfg.mimeForSource，
    // 让下游消费方拿到稳定字段。本测试钉死 fallback 行为。
    const mock = await getParseLocalAttachmentMock();
    mock.mockResolvedValueOnce({
      success: true,
      text: 'A1\tB1\tC1\n1\t2\t3\n',
      // 故意省略 mimeType
      mimeType: undefined as unknown as string,
      fileSizeBytes: 1000,
      durationMs: 5,
    });

    const parser = new XlsxParser();
    const result = await parser.parse(
      { kind: 'local-path', path: '/tmp/data.xlsx' },
      {},
      depsWithLocalDocparse,
    );
    expect(result.kind).toBe('text');
    if (result.kind === 'text') {
      expect(result.mimeType).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
    }
  });
});

// ─── 失败路径：worker 返 LocalDocParseFailure → SSoT envelope ────

describe('DocxParser — failure result → SSoT envelope (zip-bomb / corrupted DOCX)', () => {
  it.each([
    {
      name: 'CORRUPTED (zip-bomb / 损坏 docx)',
      errorClass: FilePipelineErrorCode.CORRUPTED,
      message: 'DOCX archive is not a valid zip',
    },
    {
      name: 'ENCRYPTED (密码保护 docx)',
      errorClass: FilePipelineErrorCode.ENCRYPTED,
      message: 'Document is password-protected',
    },
    {
      name: 'PARSE_TIMEOUT (worker 超时)',
      errorClass: FilePipelineErrorCode.PARSE_TIMEOUT,
      message: 'mammoth worker exceeded 5000ms timeout',
    },
  ])(
    'DocxParser → $name envelope code/message/format/subject 字段透传',
    async ({ errorClass, message }) => {
      const mock = await getParseLocalAttachmentMock();
      mock.mockResolvedValueOnce({
        success: false,
        errorClass,
        message,
        fallbackToCloud: errorClass !== FilePipelineErrorCode.ENCRYPTED,
        durationMs: 50,
      });

      const parser = new DocxParser();
      const result = await parser.parse(
        { kind: 'local-path', path: '/tmp/broken.docx' },
        { channelLimitBytes: 50 * 1024 * 1024 },
        depsWithLocalDocparse,
      );
      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.code).toBe(errorClass);
        expect(result.message).toBe(message);
        expect(result.ctx.format).toBe('.docx');
        expect(result.ctx.subject).toBe('document');
        expect(result.ctx.filename).toBe('broken.docx');
        expect(result.ctx.rawMessage).toBe(message);
        expect(result.ctx.limitBytes).toBe(50 * 1024 * 1024);
      }
    },
  );
});

// ─── parseLocalAttachment 抛异常 → UNKNOWN_ERROR envelope ───────

describe('PdfParser — worker throws unexpected error → SSoT UNKNOWN_ERROR envelope', () => {
  it('parseLocalAttachment throws → returns ErrorResult with UNKNOWN_ERROR code', async () => {
    const mock = await getParseLocalAttachmentMock();
    mock.mockRejectedValueOnce(new Error('worker pool died unexpectedly'));

    const parser = new PdfParser();
    const result = await parser.parse(
      { kind: 'local-path', path: '/tmp/foo.pdf' },
      {},
      depsWithLocalDocparse,
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.code).toBe(FilePipelineErrorCode.UNKNOWN_ERROR);
      expect(result.ctx.format).toBe('.pdf');
      expect(result.message).toMatch(/Local parser 'pdf' threw/);
      expect(result.message).toContain('worker pool died unexpectedly');
      expect(result.ctx.rawMessage).toContain('worker pool died unexpectedly');
    }
  });
});

// ─── oss-url source → 透传 declaredMimeType / sizeBytes ─────────

describe('PdfParser — oss-url source forwards declaredMimeType + sizeBytes', () => {
  it('passes oss-url + declaredMimeType + sizeBytes through to worker input', async () => {
    const mock = await getParseLocalAttachmentMock();
    mock.mockResolvedValueOnce({
      success: true,
      text: 'Cloud PDF content',
      mimeType: 'application/pdf',
      fileSizeBytes: 200_000,
      durationMs: 300,
    });

    const parser = new PdfParser();
    const result = await parser.parse(
      {
        kind: 'oss-url',
        url: 'https://oss.example.com/temp/foo.pdf?token=xyz',
        filename: 'foo.pdf',
        declaredMimeType: 'application/pdf',
        sizeBytes: 200_000,
      },
      { channelLimitBytes: 50 * 1024 * 1024 }, // 50MB
      depsWithLocalDocparse,
    );
    expect(result.kind).toBe('text');

    expect(mock).toHaveBeenCalledTimes(1);
    const [input, options] = mock.mock.calls[0]!;
    expect(input.source).toEqual({
      kind: 'url',
      url: 'https://oss.example.com/temp/foo.pdf?token=xyz',
    });
    expect(input.mimeType).toBe('application/pdf');
    expect(input.filename).toBe('foo.pdf');
    expect(input.fileSizeBytes).toBe(200_000);
    // channelLimitBytes 50MB → maxFileSizeMb=50（floor 转换）
    expect(options.maxFileSizeMb).toBe(50);
  });
});
