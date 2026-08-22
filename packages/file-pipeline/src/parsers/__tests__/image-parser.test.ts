/**
 * ImageParser 个体单测（W4.1 收尾 S1）
 *
 * **W4.1 收尾背景**：W4 实施时 5 个 parser 文件全没有个体单测，FileResolver
 * 整体测试只覆盖路由 + EpubParser 真实解析；image / pdf / docx / xlsx / pptx
 * 各自的 SSoT 错误派发 + 边界 case 全靠 channel 端 (tabcode-adapter) 端到端
 * 测试间接覆盖。这是反思 §八 #14（修了不补测试）+ #15（教训不对称应用）
 * 的第 N+1 次重演。本期补 4 个 parser 个体单测，每个 ≥5 case，覆盖：
 *   - 成功路径
 *   - SSoT 错误派发关键 case
 *   - 边界条件（magic mismatch / dep 缺失 / source 类型不支持等）
 *
 * **本测试覆盖 ImageParser 6 case**：
 *   1. memory-bytes source → base64 + media_type 输出 ✓
 *   2. oss-url source → pass-through 不读字节 ✓
 *   3. > 5MB（IMAGE_RESIZE_TRIGGER_BYTES）触发 sharp 缩放，缩放后 < 50MB ✓
 *   4. > 50MB 触发 SSoT FILE_TOO_LARGE envelope ✓
 *   5. magic bytes mismatch（扩展名 .png 但内容是 PDF）→ SSoT UNSUPPORTED_FORMAT 含 magic-mismatch 引导 ✓
 *   6. sharp 不可用（spy resizeImageBufferIfNeeded 抛 sharp_unavailable）→ SSoT FILE_TOO_LARGE 含 "Local image processing failed" ✓
 *
 * **设计取舍**：用 `imageResizeBindings` 公开绑定做 vi.spyOn（与
 * `tabcode-adapter-w2-dedup.test.ts:227-233` W2.1 同款模式），而不是
 * `vi.doMock('sharp')`——后者会让 makePng setup 也失败。
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FilePipelineErrorCode,
  IMAGE_RESIZE_TRIGGER_BYTES,
  MAX_IMAGE_FILE_BYTES_HARD,
  ImageParser,
  ImageResizeError,
  imageResizeBindings,
} from '../../index.js';

/** 用 sharp 真生成 PNG buffer（与 image-resize.test.ts 同款）。 */
async function makePng(width: number, height: number): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  })
    .png({ compressionLevel: 0 }) // 不压缩，撑大字节方便触发软上限
    .toBuffer();
}

describe('ImageParser — matches() routing', () => {
  it('matches by image extensions', () => {
    const parser = new ImageParser();
    expect(parser.matches({ ext: '.png' })).toBe(true);
    expect(parser.matches({ ext: '.jpg' })).toBe(true);
    expect(parser.matches({ ext: '.jpeg' })).toBe(true);
    expect(parser.matches({ ext: '.gif' })).toBe(true);
    expect(parser.matches({ ext: '.webp' })).toBe(true);
    expect(parser.matches({ ext: '.heic' })).toBe(true);
    expect(parser.matches({ ext: '.svg' })).toBe(true);
  });

  it('matches by mime fallback when ext is empty/unknown', () => {
    const parser = new ImageParser();
    expect(parser.matches({ ext: '', mime: 'image/jpeg' })).toBe(true);
    expect(parser.matches({ ext: '.unknown', mime: 'image/png' })).toBe(true);
  });

  it('does not match non-image ext + non-image mime', () => {
    const parser = new ImageParser();
    expect(parser.matches({ ext: '.pdf' })).toBe(false);
    expect(parser.matches({ ext: '.txt', mime: 'text/plain' })).toBe(false);
    expect(parser.matches({ ext: '' })).toBe(false);
  });
});

describe('ImageParser — oss-url source (pass-through, no IO)', () => {
  it('returns ImageUrlPayload directly without reading bytes', async () => {
    const parser = new ImageParser();
    const result = await parser.parse(
      {
        kind: 'oss-url',
        url: 'https://oss.example.com/img/foo.png',
        declaredMimeType: 'image/png',
        filename: 'foo.png',
      },
      {},
      {},
    );
    expect(result.kind).toBe('image');
    if (result.kind === 'image' && result.payload.source === 'url') {
      expect(result.payload.url).toBe('https://oss.example.com/img/foo.png');
      expect(result.payload.mediaType).toBe('image/png');
    }
    // resize 字段不应填（pass-through 不缩放）
    if (result.kind === 'image') {
      expect(result.resize).toBeUndefined();
    }
  });

  it('infers mediaType from URL extension when declaredMimeType missing', async () => {
    const parser = new ImageParser();
    const result = await parser.parse(
      { kind: 'oss-url', url: 'https://oss.example.com/photo.jpeg' },
      {},
      {},
    );
    expect(result.kind).toBe('image');
    if (result.kind === 'image' && result.payload.source === 'url') {
      expect(result.payload.mediaType).toBe('image/jpeg');
    }
  });
});

describe('ImageParser — memory-bytes source', () => {
  it('returns ImageBytesPayload with base64 + mediaType for small image', async () => {
    const png = await makePng(100, 100);
    expect(png.length).toBeLessThan(IMAGE_RESIZE_TRIGGER_BYTES);

    const parser = new ImageParser();
    const result = await parser.parse(
      { kind: 'memory-bytes', bytes: png, filename: 'small.png' },
      {},
      {},
    );
    expect(result.kind).toBe('image');
    if (result.kind === 'image' && result.payload.source === 'bytes') {
      expect(result.payload.mediaType).toBe('image/png');
      expect(result.payload.sizeBytes).toBe(png.length);
      // base64 解码后应等于原 buf
      expect(Buffer.from(result.payload.base64, 'base64').equals(png)).toBe(true);
    }
    // < 5MB 不触发缩放
    if (result.kind === 'image') {
      expect(result.resize).toBeUndefined();
    }
  });

  it(
    '> 5MB triggers sharp resize, returns resized < 50MB with resize meta',
    async () => {
      // 3000x2000 不压缩 PNG ≈ 18MB（红色实心图也不容易压缩到 5MB 以下）
      const png = await makePng(3000, 2000);
      expect(png.length).toBeGreaterThan(IMAGE_RESIZE_TRIGGER_BYTES);
      expect(png.length).toBeLessThan(MAX_IMAGE_FILE_BYTES_HARD);

      const parser = new ImageParser();
      const result = await parser.parse(
        { kind: 'memory-bytes', bytes: png, filename: 'big.png' },
        {},
        {},
      );
      expect(result.kind).toBe('image');
      if (result.kind === 'image' && result.payload.source === 'bytes') {
        // 缩放后 mime 统一 JPEG
        expect(result.payload.mediaType).toBe('image/jpeg');
        // 缩放后字节 < 5MB（强断言而不是 < 原图：原图 18MB / 触发阈值 5MB
        // 是 W2.1 fix-1 收尾 sanity check 的同款断言精度）
        expect(result.payload.sizeBytes).toBeLessThan(IMAGE_RESIZE_TRIGGER_BYTES);
        expect(result.payload.sizeBytes).toBeGreaterThan(0);
      }
      // resize 元数据应填
      if (result.kind === 'image') {
        expect(result.resize).toBeDefined();
        if (result.resize) {
          expect(result.resize.originalMediaType).toBe('image/png');
          expect(result.resize.originalBytes).toBe(png.length);
          expect(result.resize.longEdgePx).toBeLessThanOrEqual(2048);
          expect(result.resize.elapsedMs).toBeGreaterThan(0);
        }
      }
    },
    15_000,
  );
});

describe('ImageParser — local-path source', () => {
  it('> 50MB hard limit returns SSoT FILE_TOO_LARGE envelope', async () => {
    // 直接构造一个大于 50MB 的虚假 png 文件（不走 makePng，省时间）。
    // readAndResizeImageIfNeeded 先 stat 大小判定 hard limit，不读 buffer。
    const tmp = mkdtempSync(join(tmpdir(), 'image-parser-toolarge-'));
    const bigPath = join(tmp, 'huge.png');
    // 写一个 51MB 的纯零字节文件 —— hard limit check 只看 stat.size
    const fakeBig = Buffer.alloc(MAX_IMAGE_FILE_BYTES_HARD + 1, 0);
    writeFileSync(bigPath, fakeBig);
    try {
      const parser = new ImageParser();
      const result = await parser.parse(
        { kind: 'local-path', path: bigPath },
        {},
        {},
      );
      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.code).toBe(FilePipelineErrorCode.FILE_TOO_LARGE);
        expect(result.ctx.subject).toBe('image');
        expect(result.ctx.actualBytes).toBe(MAX_IMAGE_FILE_BYTES_HARD + 1);
        expect(result.ctx.limitBytes).toBe(MAX_IMAGE_FILE_BYTES_HARD);
        expect(result.ctx.filename).toBe('huge.png');
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('magic bytes mismatch (.png ext + PDF content) → SSoT UNSUPPORTED_FORMAT with magic-mismatch raw signal', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'image-parser-magic-'));
    const fakePath = join(tmp, 'fake.png');
    // PDF magic bytes 25 50 44 46 ('%PDF') 写到 .png 文件
    writeFileSync(fakePath, Buffer.from('%PDF-1.4\n%fake pdf content\n'));
    try {
      const parser = new ImageParser();
      const result = await parser.parse(
        { kind: 'local-path', path: fakePath },
        {},
        {},
      );
      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.code).toBe(FilePipelineErrorCode.UNSUPPORTED_FORMAT);
        expect(result.ctx.subject).toBe('image');
        expect(result.ctx.format).toBe('.png');
        expect(result.ctx.filename).toBe('fake.png');
        // **W5 L31（2026-05-14）契约变更**：用结构化 ctx.failureMode +
        // ctx.subject 替代 SSoT format.ts 检测 rawMessage 字面值前缀。
        expect(result.ctx.failureMode).toBe('magic_mismatch');
        // rawMessage 仍透传给 LLM 上下文（含 detectedMime 等技术原因），
        // 但 SSoT 不再据此 fork 派发分支。
        expect(result.ctx.rawMessage).toMatch(/detected/i);
        // 反向断言：不是 ENCRYPTED / FILE_NOT_FOUND 退化
        expect(result.code).not.toBe(FilePipelineErrorCode.ENCRYPTED);
        expect(result.code).not.toBe(FilePipelineErrorCode.FILE_NOT_FOUND);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('ImageParser — sharp unavailable fallback (W2.1 fix-3 同款契约)', () => {
  it.each([
    'sharp_unavailable' as const,
    'sharp_decode_failed' as const,
    'too_large_after_resize' as const,
  ])(
    'memory-bytes > 5MB + ImageResizeError code=%s → SSoT IMAGE_RESIZE_FAILED（W5 L38 拆为独立 enum 数字码 19）',
    async (code) => {
      // 与 tabcode-adapter-w2-dedup.test.ts:205-281 W2.1 收尾 S3 同款 spy 模式
      // ——比 vi.doMock('sharp') 更稳，不会让 setup 中 makePng 也失败。
      const png = await makePng(3000, 2000);
      expect(png.length).toBeGreaterThan(IMAGE_RESIZE_TRIGGER_BYTES);

      const spy = vi
        .spyOn(imageResizeBindings, 'resizeImageBufferIfNeeded')
        .mockResolvedValue({
          kind: 'resize_failed',
          error: new ImageResizeError(code, `mock ${code} message`),
        });
      try {
        const parser = new ImageParser();
        const result = await parser.parse(
          { kind: 'memory-bytes', bytes: png, filename: 'fail.png' },
          {},
          {},
        );
        expect(result.kind).toBe('error');
        if (result.kind === 'error') {
          // **W5 L38（2026-05-14）契约变更**：sharp 缩放失败拆为独立 enum
          // `IMAGE_RESIZE_FAILED`（数字码 19），不再走 FILE_TOO_LARGE +
          // rawMessage "Auto-resize failed" 字面值契约。
          expect(result.code).toBe(FilePipelineErrorCode.IMAGE_RESIZE_FAILED);
          expect(result.ctx.subject).toBe('image');
          expect(result.ctx.filename).toBe('fail.png');
          // **W5 L31 契约**：用结构化 ctx.resizeFailureCause 替代 rawMessage
          // 字面值前缀检测，让 SSoT format.ts 派发 cause-specific 文案。
          expect(result.ctx.resizeFailureCause).toBe(code);
          expect(result.ctx.rawMessage).toContain(code);
        }
      } finally {
        spy.mockRestore();
      }
    },
    15_000,
  );
});
