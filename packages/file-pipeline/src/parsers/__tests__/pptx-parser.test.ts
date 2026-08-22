/**
 * PptxParser 个体单测（W4.1 收尾 S1）
 *
 * **W4.1 收尾背景**：W4 实施时 PptxParser 没有个体测试；W3 PPTX 测试在
 * channel 端 `tabcode-adapter-w3-pptx.test.ts` 走端到端验证 OLE / magic /
 * 北极星语义。但 W4 抽 PptxParser 后 magic-detect / chunk-render / source 限制
 * 等行为搬到了 parser 层，端到端测试不再钉死 parser 层契约。本期补 6 case
 * 直接覆盖 PptxParser 的 magic 检测 / host dep / source 类型 / chunk render。
 *
 * **本测试覆盖 8+ case**：
 *   1. matches() 路由：.pptx + PPTX mime ✓
 *   2. local-path + ZIP magic + runTempPptxParse 成功 → 返 TextResult 含 chunks + viaTempChannel ✓
 *   3. local-path + OLE Compound magic（D0 CF 11 E0）→ ENCRYPTED（**不**调 host，magic 阶段短路）✓
 *   4. local-path + 既不是 ZIP 也不是 OLE → UNSUPPORTED_FORMAT 含 magic-mismatch 引导 ✓
 *   5. host 未注入 runTempPptxParse → UNSUPPORTED_FORMAT envelope（mobile / 测试兼容）✓
 *   6. host runTempPptxParse 抛错 → SSoT UNKNOWN_ERROR / USER_ABORTED 派发 ✓
 *   7. host 返 failure → SSoT 派发对应 errorClass ✓
 *   8. memory-bytes / oss-url source → INVALID_PARAMETER（PptxParser 仅支持 local-path）✓
 *   9. renderPptxChunksAsText helper：empty / heading / paragraph / table / note 边界 ✓
 *
 * **设计取舍**：用临时文件 + magic bytes 写真字节 + mock host 函数 ——
 * 与 `tabcode-adapter-w3-pptx.test.ts` 端到端模式同源，但 mock 边界从 channel
 * 上移到 parser 自身的 deps.runTempPptxParse 上。
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  FilePipelineErrorCode,
  PptxParser,
  renderPptxChunksAsText,
} from '../../index.js';
import type { ParseDeps, RunTempPptxParse } from '../../index.js';

// 真 PPTX magic：PK\x03\x04（与 ZIP 同款）
const PPTX_ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
// OLE Compound File magic：加密 PPTX / 老 .ppt 容器
const OLE_COMPOUND_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

function makeTmpFile(filename: string, contents: Buffer): { dir: string; filePath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'pptx-parser-'));
  const filePath = path.join(dir, filename);
  writeFileSync(filePath, contents);
  return { dir, filePath };
}

describe('PptxParser — matches() routing', () => {
  it('matches .pptx ext + PPTX mime', () => {
    const parser = new PptxParser();
    expect(parser.matches({ ext: '.pptx' })).toBe(true);
    expect(
      parser.matches({
        ext: '',
        mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      }),
    ).toBe(true);
  });

  it('does not match other formats', () => {
    const parser = new PptxParser();
    expect(parser.matches({ ext: '.ppt' })).toBe(false); // 老 .ppt 不归 PptxParser
    expect(parser.matches({ ext: '.docx' })).toBe(false);
    expect(parser.matches({ ext: '' })).toBe(false);
  });
});

describe('PptxParser — non-local-path source unsupported', () => {
  it('memory-bytes → INVALID_PARAMETER (PptxParser 仅支持 local-path)', async () => {
    const parser = new PptxParser();
    const result = await parser.parse(
      { kind: 'memory-bytes', bytes: PPTX_ZIP_MAGIC, filename: 'foo.pptx' },
      {},
      { runTempPptxParse: vi.fn() as unknown as RunTempPptxParse },
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.code).toBe(FilePipelineErrorCode.INVALID_PARAMETER);
      expect(result.ctx.format).toBe('.pptx');
      expect(result.ctx.subject).toBe('presentation');
      expect(result.ctx.filename).toBe('foo.pptx');
      expect(result.message).toMatch(/local-path/);
    }
  });

  it('oss-url → INVALID_PARAMETER + 引导走 fetchCloudSummary', async () => {
    const parser = new PptxParser();
    const result = await parser.parse(
      {
        kind: 'oss-url',
        url: 'https://oss.example.com/foo.pptx',
        filename: 'cloud.pptx',
      },
      {},
      { runTempPptxParse: vi.fn() as unknown as RunTempPptxParse },
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.code).toBe(FilePipelineErrorCode.INVALID_PARAMETER);
      expect(result.message).toMatch(/Host\.fetchCloudSummary/);
    }
  });
});

describe('PptxParser — host runTempPptxParse not injected', () => {
  it('returns SSoT UNSUPPORTED_FORMAT (mobile / 测试 / 老 host 兼容回退)', async () => {
    const { dir, filePath } = makeTmpFile('foo.pptx', PPTX_ZIP_MAGIC);
    try {
      const parser = new PptxParser();
      const deps: ParseDeps = {}; // 不注入 runTempPptxParse
      const result = await parser.parse(
        { kind: 'local-path', path: filePath },
        {},
        deps,
      );
      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.code).toBe(FilePipelineErrorCode.UNSUPPORTED_FORMAT);
        expect(result.ctx.format).toBe('.pptx');
        expect(result.ctx.subject).toBe('presentation');
        expect(result.ctx.filename).toBe('foo.pptx');
        expect(result.message).toMatch(/runTempPptxParse/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PptxParser — magic bytes detection', () => {
  it('OLE Compound File magic (D0 CF 11 E0) → ENCRYPTED, NOT calling host (短路)', async () => {
    // W3 Review 1 H1 + W3.1 S1 同款契约：加密 PPTX 是 OLE 容器，magic 阶段
    // 直接派发 ENCRYPTED；不消耗 OSS upload + parse-sync RTT
    const oleContents = Buffer.concat([OLE_COMPOUND_MAGIC, Buffer.alloc(100)]);
    const { dir, filePath } = makeTmpFile('encrypted.pptx', oleContents);

    try {
      const runTempPptxParse = vi.fn() as unknown as RunTempPptxParse;
      const parser = new PptxParser();
      const result = await parser.parse(
        { kind: 'local-path', path: filePath },
        {},
        { runTempPptxParse },
      );
      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.code).toBe(FilePipelineErrorCode.ENCRYPTED);
        expect(result.ctx.format).toBe('.pptx');
        expect(result.ctx.subject).toBe('presentation');
        expect(result.ctx.filename).toBe('encrypted.pptx');
        expect(result.ctx.rawMessage).toMatch(/OLE Compound File container/i);
        expect(result.ctx.rawMessage).toMatch(/password|encrypted/i);
        // 反向断言：不退化到 UNSUPPORTED_FORMAT / CORRUPTED
        expect(result.code).not.toBe(FilePipelineErrorCode.UNSUPPORTED_FORMAT);
        expect(result.code).not.toBe(FilePipelineErrorCode.CORRUPTED);
      }
      // **关键反向断言**：magic 阶段短路，host 未被调用
      expect(runTempPptxParse).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('unknown magic (既不是 ZIP 也不是 OLE) → UNSUPPORTED_FORMAT magic-mismatch, NOT calling host', async () => {
    const fakeContents = Buffer.from('this is not a pptx file at all xxxxxxx');
    const { dir, filePath } = makeTmpFile('mislabeled.pptx', fakeContents);

    try {
      const runTempPptxParse = vi.fn() as unknown as RunTempPptxParse;
      const parser = new PptxParser();
      const result = await parser.parse(
        { kind: 'local-path', path: filePath },
        {},
        { runTempPptxParse },
      );
      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.code).toBe(FilePipelineErrorCode.UNSUPPORTED_FORMAT);
        expect(result.ctx.format).toBe('.pptx');
        expect(result.ctx.subject).toBe('presentation');
        expect(result.ctx.filename).toBe('mislabeled.pptx');
        // **W5 L31（2026-05-14）契约变更**：用结构化 ctx.failureMode +
        // ctx.subject 替代 SSoT format.ts 检测 rawMessage 字面值前缀
        // （历史："does not start with PPTX magic bytes" 跨包字符串契约脆弱）。
        expect(result.ctx.failureMode).toBe('magic_mismatch');
        // rawMessage 仍透传给 LLM 上下文（含具体技术原因），但 SSoT 不再据此 fork
        expect(result.ctx.rawMessage).toMatch(/ZIP container|OLE Compound File header/i);
        // 反向断言：不退化到 ENCRYPTED / CORRUPTED
        expect(result.code).not.toBe(FilePipelineErrorCode.ENCRYPTED);
      }
      expect(runTempPptxParse).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PptxParser — local-path success path via host', () => {
  it('valid PPTX magic + host returns success → TextResult with chunks + viaTempChannel + slides', async () => {
    const pptxContents = Buffer.concat([PPTX_ZIP_MAGIC, Buffer.alloc(200)]);
    const { dir, filePath } = makeTmpFile('deck.pptx', pptxContents);

    try {
      const runTempPptxParse: RunTempPptxParse = vi.fn(async (p, mime, _opts) => {
        expect(p).toBe(filePath);
        expect(mime).toBe(
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        );
        return {
          success: true,
          pages: 3,
          title: 'My Deck',
          chunks: [
            { page: 1, type: 'heading', content: 'Slide 1 Title', heading_level: 1 },
            { page: 1, type: 'paragraph', content: 'First slide body.' },
            { page: 2, type: 'paragraph', content: 'Second slide body.' },
            { page: 2, type: 'table', content: '| A | B |\n|---|---|\n| 1 | 2 |' },
            { page: 3, type: 'note', content: 'Speaker note line one.\nLine two.' },
          ],
          fileSizeBytes: pptxContents.length,
          durationMs: 250,
        };
      });

      const parser = new PptxParser();
      const result = await parser.parse(
        { kind: 'local-path', path: filePath },
        { timeoutMs: 30_000 },
        { runTempPptxParse },
      );
      expect(result.kind).toBe('text');
      if (result.kind === 'text') {
        expect(result.mimeType).toBe(
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        );
        expect(result.title).toBe('My Deck');
        expect(result.slides).toBe(3);
        expect(result.viaTempChannel).toBe(true);
        expect(result.chunks).toHaveLength(5);
        expect(result.chunks?.[0]?.type).toBe('heading');
        expect(result.chunks?.[0]?.heading_level).toBe(1);
        // text 渲染走 renderPptxChunksAsText（按 page 分组）
        expect(result.text).toContain('--- Slide 1 ---');
        expect(result.text).toContain('# Slide 1 Title');
        expect(result.text).toContain('First slide body.');
        expect(result.text).toContain('--- Slide 2 ---');
        expect(result.text).toContain('| A | B |');
        expect(result.text).toContain('--- Slide 3 ---');
        // note 走 quote 引用
        expect(result.text).toContain('> Speaker note line one.');
        expect(result.text).toContain('> Line two.');
      }
      expect(runTempPptxParse).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PptxParser — host failure paths', () => {
  it('host runTempPptxParse throws ordinary error → SSoT UNKNOWN_ERROR envelope', async () => {
    const pptxContents = Buffer.concat([PPTX_ZIP_MAGIC, Buffer.alloc(50)]);
    const { dir, filePath } = makeTmpFile('boom.pptx', pptxContents);

    try {
      const runTempPptxParse: RunTempPptxParse = vi.fn(async () => {
        throw new Error('OSS presign endpoint returned 500');
      });
      const parser = new PptxParser();
      const result = await parser.parse(
        { kind: 'local-path', path: filePath },
        {},
        { runTempPptxParse },
      );
      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.code).toBe(FilePipelineErrorCode.UNKNOWN_ERROR);
        expect(result.ctx.filename).toBe('boom.pptx');
        expect(result.message).toContain('OSS presign endpoint returned 500');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('host throws AbortError-shaped + signal.aborted → SSoT USER_ABORTED', async () => {
    const pptxContents = Buffer.concat([PPTX_ZIP_MAGIC, Buffer.alloc(50)]);
    const { dir, filePath } = makeTmpFile('abort.pptx', pptxContents);

    try {
      const runTempPptxParse: RunTempPptxParse = vi.fn(async () => {
        throw new Error('The user aborted a request');
      });
      const parser = new PptxParser();
      const controller = new AbortController();
      controller.abort();
      const result = await parser.parse(
        { kind: 'local-path', path: filePath },
        { signal: controller.signal },
        { runTempPptxParse },
      );
      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.code).toBe(FilePipelineErrorCode.USER_ABORTED);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('host returns failure result → SSoT envelope with same errorClass / message / format', async () => {
    const pptxContents = Buffer.concat([PPTX_ZIP_MAGIC, Buffer.alloc(50)]);
    const { dir, filePath } = makeTmpFile('fail.pptx', pptxContents);

    try {
      const runTempPptxParse: RunTempPptxParse = vi.fn(async () => ({
        success: false,
        errorClass: FilePipelineErrorCode.PARSE_TIMEOUT,
        message: 'parse-sync exceeded 27s',
        durationMs: 27_000,
      }));
      const parser = new PptxParser();
      const result = await parser.parse(
        { kind: 'local-path', path: filePath },
        { timeoutMs: 30_000, channelLimitBytes: 50 * 1024 * 1024 },
        { runTempPptxParse },
      );
      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.code).toBe(FilePipelineErrorCode.PARSE_TIMEOUT);
        expect(result.message).toBe('parse-sync exceeded 27s');
        expect(result.ctx.format).toBe('.pptx');
        expect(result.ctx.subject).toBe('presentation');
        expect(result.ctx.filename).toBe('fail.pptx');
        expect(result.ctx.rawMessage).toBe('parse-sync exceeded 27s');
        expect(result.ctx.timeoutMs).toBe(30_000);
        expect(result.ctx.limitBytes).toBe(50 * 1024 * 1024);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('non-existent file → FILE_NOT_FOUND', async () => {
    const parser = new PptxParser();
    const result = await parser.parse(
      {
        kind: 'local-path',
        path: '/tmp/this-pptx-definitely-does-not-exist-tabtin-test.pptx',
      },
      {},
      { runTempPptxParse: vi.fn() as unknown as RunTempPptxParse },
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.code).toBe(FilePipelineErrorCode.FILE_NOT_FOUND);
      expect(result.ctx.format).toBe('.pptx');
    }
  });
});

describe('renderPptxChunksAsText helper — chunk-render boundary cases (W4 L49 共享)', () => {
  it('empty chunks → no extractable text placeholder', () => {
    const out = renderPptxChunksAsText([]);
    expect(out).toMatch(/no extractable text/i);
    expect(out).toMatch(/blank/i);
  });

  it('headings render with markdown # and clamp level to 1-6', () => {
    const out = renderPptxChunksAsText([
      { page: 1, type: 'heading', content: 'H1', heading_level: 1 },
      { page: 1, type: 'heading', content: 'Deep', heading_level: 99 }, // clamp to 6
      { page: 1, type: 'heading', content: 'Negative', heading_level: -1 }, // clamp to 1
      { page: 1, type: 'heading', content: 'NoLevel' }, // default 1
    ]);
    expect(out).toContain('# H1');
    expect(out).toContain('###### Deep');
    expect(out).toContain('# Negative');
    expect(out).toContain('# NoLevel');
  });

  it('multi-line note quotes every line with ">" prefix (W3 R1M2 收尾契约)', () => {
    const out = renderPptxChunksAsText([
      { page: 1, type: 'note', content: 'line one\nline two\n\nline four' },
    ]);
    expect(out).toContain('> line one');
    expect(out).toContain('> line two');
    expect(out).toContain('> line four');
    // 空行也要走 ">"（不是 "> "）
    expect(out).toMatch(/>\s*\n/);
  });

  it('multi-page slides show "--- Slide N ---" separators', () => {
    const out = renderPptxChunksAsText([
      { page: 1, type: 'paragraph', content: 'First.' },
      { page: 2, type: 'paragraph', content: 'Second.' },
      { page: 5, type: 'paragraph', content: 'Fifth.' },
    ]);
    expect(out).toContain('--- Slide 1 ---');
    expect(out).toContain('--- Slide 2 ---');
    expect(out).toContain('--- Slide 5 ---');
    expect(out).toContain('First.');
    expect(out).toContain('Second.');
    expect(out).toContain('Fifth.');
  });
});
