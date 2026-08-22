/**
 * EpubParser 个体单测（W4.1 收尾 S1）
 *
 * **W4.1 收尾背景**：W4 实施时 EpubParser 仅在 `file-resolver.test.ts` 里有
 * 1 个真实 ZIP 解析 + 1 个非 ZIP magic 拒绝 + 1 个 channelLimitBytes 检查
 * （3 case），缺成功路径的 chunks/text 字段验证 + 缺 source 类型限制 + 缺 empty
 * 内容信号 + 缺损坏 ZIP（ZIP magic 通过但 Central Directory 解析失败）的
 * CORRUPTED 派发。本期补 5 case 覆盖完整 SSoT 错误派发 + 边界情况。
 *
 * **本测试覆盖 EpubParser 6 case**：
 *   1. matches() 路由（.epub / mime / 反向不命中）✓
 *   2. 合法 EPUB（zip + 多个 .xhtml 章节）→ 返 chunks 含文本 + 字段语义 ✓
 *   3. 损坏 ZIP（ZIP magic 通过但 EOCD 缺失）→ CORRUPTED 派发 ✓
 *   4. > channelLimitBytes → FILE_TOO_LARGE 含 actualBytes / limitBytes ✓
 *   5. empty EPUB（ZIP 容器但无 .xhtml/.html 文件）→ 返 success + 空文本信号 ✓
 *   6. memory-bytes / oss-url source → INVALID_PARAMETER（EpubParser 仅支持 local-path）✓
 *
 * **加密 EPUB（DRM）说明**：手写 ZIP parser 不内嵌 DRM 检测；DRM 加密的章节
 * 通常解 ZIP 后 chunk 是乱码二进制，stripXhtml 不会报错但返回乱码文本。当前
 * 实现把这种归类为"成功但内容是乱码"——不是 ENCRYPTED 也不是 CORRUPTED。
 * 真正的加密 EPUB 检测需要解 META-INF/encryption.xml，本期不实现，登记
 * 总控 §七 L 项观察。
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EpubParser, FilePipelineErrorCode } from '../../index.js';

/**
 * 构造一个最简 EPUB（ZIP 容器 + 章节，stored 压缩）。
 * 与 file-resolver.test.ts:103-172 同款 builder——独立复用避免跨文件 import
 * helper（test fixtures 之间不互相 import 让单测独立可运行）。
 */
function buildMinimalEpub(chapters: Array<{ name: string; content: string }>): Buffer {
  const localHeaders: Buffer[] = [];
  const centralEntries: Buffer[] = [];
  let offset = 0;

  for (const ch of chapters) {
    const data = Buffer.from(ch.content, 'utf8');
    const nameBuf = Buffer.from(ch.name, 'utf8');

    // local file header (30 bytes + name)
    const lh = Buffer.alloc(30 + nameBuf.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); // method=stored
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(0, 14); // crc32 skipped
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    nameBuf.copy(lh, 30);

    const lhWithData = Buffer.concat([lh, data]);
    localHeaders.push(lhWithData);

    // central directory entry (46 bytes + name)
    const ce = Buffer.alloc(46 + nameBuf.length);
    ce.writeUInt32LE(0x02014b50, 0);
    ce.writeUInt16LE(20, 4);
    ce.writeUInt16LE(20, 6);
    ce.writeUInt16LE(0, 8);
    ce.writeUInt16LE(0, 10);
    ce.writeUInt16LE(0, 12);
    ce.writeUInt16LE(0, 14);
    ce.writeUInt32LE(0, 16);
    ce.writeUInt32LE(data.length, 20);
    ce.writeUInt32LE(data.length, 24);
    ce.writeUInt16LE(nameBuf.length, 28);
    ce.writeUInt16LE(0, 30);
    ce.writeUInt16LE(0, 32);
    ce.writeUInt16LE(0, 34);
    ce.writeUInt16LE(0, 36);
    ce.writeUInt32LE(0, 38);
    ce.writeUInt32LE(offset, 42);
    nameBuf.copy(ce, 46);
    centralEntries.push(ce);

    offset += lhWithData.length;
  }

  const localPart = Buffer.concat(localHeaders);
  const cdPart = Buffer.concat(centralEntries);

  // EOCD (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(chapters.length, 8);
  eocd.writeUInt16LE(chapters.length, 10);
  eocd.writeUInt32LE(cdPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localPart, cdPart, eocd]);
}

describe('EpubParser — matches() routing', () => {
  it('matches by .epub extension', () => {
    const parser = new EpubParser();
    expect(parser.matches({ ext: '.epub' })).toBe(true);
    expect(parser.matches({ ext: '.EPUB' })).toBe(false); // 当前实现只看 lowercase ext
  });

  it('matches by application/epub+zip mime', () => {
    const parser = new EpubParser();
    expect(parser.matches({ ext: '', mime: 'application/epub+zip' })).toBe(true);
    expect(parser.matches({ ext: '.unknown', mime: 'APPLICATION/EPUB+ZIP' })).toBe(true);
  });

  it('does not match other formats', () => {
    const parser = new EpubParser();
    expect(parser.matches({ ext: '.pdf' })).toBe(false);
    expect(parser.matches({ ext: '.zip' })).toBe(false);
    expect(parser.matches({ ext: '.html' })).toBe(false);
    expect(parser.matches({ ext: '' })).toBe(false);
  });
});

describe('EpubParser — local-path success path', () => {
  it('parses valid EPUB with multiple xhtml chapters into text result', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'epub-parser-success-'));
    const epubPath = path.join(tmp, 'sample.epub');
    const epubBytes = buildMinimalEpub([
      { name: 'mimetype', content: 'application/epub+zip' },
      {
        name: 'OEBPS/chap01.xhtml',
        content:
          '<?xml version="1.0"?><html><body><h1>Chapter One</h1><p>Hello world content.</p></body></html>',
      },
      {
        name: 'OEBPS/chap02.xhtml',
        content:
          '<?xml version="1.0"?><html><body><p>Second chapter body text.</p></body></html>',
      },
    ]);
    writeFileSync(epubPath, epubBytes);

    try {
      const parser = new EpubParser();
      const result = await parser.parse(
        { kind: 'local-path', path: epubPath },
        {},
        {},
      );
      expect(result.kind).toBe('text');
      if (result.kind === 'text') {
        expect(result.text).toContain('Chapter One');
        expect(result.text).toContain('Hello world content.');
        expect(result.text).toContain('Second chapter body text.');
        // pages = 实际有内容的 xhtml 数（不含 mimetype）
        expect(result.pages).toBe(2);
        expect(result.mimeType).toBe('application/epub+zip');
        expect(result.fileSizeBytes).toBe(epubBytes.length);
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
        // strip 后文本不应含原 XML 标签
        expect(result.text).not.toMatch(/<[a-zA-Z]+/);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns success + empty signal when EPUB contains no xhtml/html files', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'epub-parser-empty-'));
    const epubPath = path.join(tmp, 'empty.epub');
    // 仅含 mimetype 文件，无任何 xhtml/html/htm 章节 —— 当前实现走"empty
    // result"分支返 placeholder text "(no extractable text...)"，pages=0
    const epubBytes = buildMinimalEpub([
      { name: 'mimetype', content: 'application/epub+zip' },
    ]);
    writeFileSync(epubPath, epubBytes);

    try {
      const parser = new EpubParser();
      const result = await parser.parse(
        { kind: 'local-path', path: epubPath },
        {},
        {},
      );
      expect(result.kind).toBe('text');
      if (result.kind === 'text') {
        expect(result.pages).toBe(0);
        expect(result.text).toMatch(/no extractable text/i);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('EpubParser — error paths (SSoT 13 类派发)', () => {
  it('non-ZIP content (magic mismatch) → SSoT UNSUPPORTED_FORMAT', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'epub-parser-magic-'));
    const fakePath = path.join(tmp, 'fake.epub');
    writeFileSync(fakePath, Buffer.from('definitely not an epub file at all'));
    try {
      const parser = new EpubParser();
      const result = await parser.parse(
        { kind: 'local-path', path: fakePath },
        {},
        {},
      );
      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.code).toBe(FilePipelineErrorCode.UNSUPPORTED_FORMAT);
        expect(result.ctx.format).toBe('.epub');
        expect(result.ctx.subject).toBe('document');
        expect(result.ctx.filename).toBe('fake.epub');
        expect(result.ctx.rawMessage).toMatch(/ZIP magic bytes/i);
        // 反向断言：不退化到 CORRUPTED / FILE_NOT_FOUND
        expect(result.code).not.toBe(FilePipelineErrorCode.CORRUPTED);
        expect(result.code).not.toBe(FilePipelineErrorCode.FILE_NOT_FOUND);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('valid ZIP magic but corrupted Central Directory → CORRUPTED', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'epub-parser-corrupt-'));
    const corruptPath = path.join(tmp, 'broken.epub');
    // ZIP magic 50 4B 03 04 通过 magic 校验，但 Central Directory / EOCD 不存在
    // → parseZipCentralDirectory 抛 "EOCD record not found"，被 catch 走 CORRUPTED
    const fakeZip = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]), // ZIP magic
      Buffer.alloc(100, 0x00), // 后续 100 字节零，不构成合法 ZIP 结构
    ]);
    writeFileSync(corruptPath, fakeZip);
    try {
      const parser = new EpubParser();
      const result = await parser.parse(
        { kind: 'local-path', path: corruptPath },
        {},
        {},
      );
      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.code).toBe(FilePipelineErrorCode.CORRUPTED);
        expect(result.ctx.format).toBe('.epub');
        expect(result.ctx.filename).toBe('broken.epub');
        expect(result.ctx.rawMessage).toBeDefined();
        // 反向断言：不混淆为 UNSUPPORTED_FORMAT（ZIP magic 通过了）
        expect(result.code).not.toBe(FilePipelineErrorCode.UNSUPPORTED_FORMAT);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('exceeds channelLimitBytes → FILE_TOO_LARGE with actualBytes + limitBytes', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'epub-parser-toolarge-'));
    const bigPath = path.join(tmp, 'big.epub');
    // 构造一个有效 EPUB，但 channelLimitBytes 设得很小
    const epubBytes = buildMinimalEpub([
      { name: 'mimetype', content: 'application/epub+zip' },
      {
        name: 'a.xhtml',
        content: '<?xml version="1.0"?><html><body>' + 'x'.repeat(5000) + '</body></html>',
      },
    ]);
    writeFileSync(bigPath, epubBytes);
    try {
      const parser = new EpubParser();
      const result = await parser.parse(
        { kind: 'local-path', path: bigPath },
        { channelLimitBytes: 1000 }, // 强制 1KB 上限
        {},
      );
      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.code).toBe(FilePipelineErrorCode.FILE_TOO_LARGE);
        expect(result.ctx.format).toBe('.epub');
        expect(result.ctx.actualBytes).toBe(epubBytes.length);
        expect(result.ctx.limitBytes).toBe(1000);
        expect(result.ctx.filename).toBe('big.epub');
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('non-existent file → FILE_NOT_FOUND with rawMessage from fs error', async () => {
    const parser = new EpubParser();
    const result = await parser.parse(
      { kind: 'local-path', path: '/tmp/this-file-definitely-does-not-exist-tabtin-test.epub' },
      {},
      {},
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.code).toBe(FilePipelineErrorCode.FILE_NOT_FOUND);
      expect(result.ctx.format).toBe('.epub');
      expect(result.ctx.filename).toBe('this-file-definitely-does-not-exist-tabtin-test.epub');
      expect(result.ctx.rawMessage).toBeDefined();
    }
  });
});

describe('EpubParser — non-local-path source unsupported', () => {
  it('memory-bytes source → INVALID_PARAMETER (not implemented)', async () => {
    const parser = new EpubParser();
    const result = await parser.parse(
      { kind: 'memory-bytes', bytes: Buffer.from('PK\x03\x04'), filename: 'foo.epub' },
      {},
      {},
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.code).toBe(FilePipelineErrorCode.INVALID_PARAMETER);
      expect(result.ctx.format).toBe('.epub');
      expect(result.message).toMatch(/local-path/);
    }
  });

  it('oss-url source → INVALID_PARAMETER (not implemented)', async () => {
    const parser = new EpubParser();
    const result = await parser.parse(
      { kind: 'oss-url', url: 'https://example.com/foo.epub', filename: 'foo.epub' },
      {},
      {},
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.code).toBe(FilePipelineErrorCode.INVALID_PARAMETER);
      expect(result.ctx.filename).toBe('foo.epub');
    }
  });
});
