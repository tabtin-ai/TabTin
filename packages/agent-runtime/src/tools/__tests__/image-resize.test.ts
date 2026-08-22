/**
 * image-resize — sharp 缩放 + magic bytes 验证（W2 北极星 #2 / #3）
 *
 * 覆盖：
 *   1. magic bytes 验证：PNG / JPEG / WEBP / GIF / BMP / HEIC 真 magic vs 伪
 *   2. SVG 跳过 magic 验证（设计豁免）
 *   3. resizeImageBuffer 缩放成功：长边 ≤ 2048px / 输出 JPEG q90 / 字节减少
 *   4. resizeImageBuffer 性能基线：25MB png 缩放 < 2s（W2 北极星 #3）
 *   5. resizeImageBuffer 失败：sharp 解码失败 → ImageResizeError code='sharp_decode_failed'
 *   6. readAndResizeImageIfNeeded 端到端：>5MB 触发缩放 / >50MB 硬拒 / SVG 直走
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IMAGE_RESIZE_TRIGGER_BYTES,
  MAX_IMAGE_FILE_BYTES_HARD,
  RESIZE_LONG_EDGE_PX,
  RESIZED_MEDIA_TYPE,
  ImageResizeError,
  checkImageMagicBytes,
  resizeImageBuffer,
  readAndResizeImageIfNeeded,
  mimeForImageExt,
} from '../image-resize.js';

// 用 sharp 在测试 setup 时生成真 PNG / JPEG buffer，避免硬编码大字节常量
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
    .png({ compressionLevel: 0 }) // 不压缩，确保字节数大
    .toBuffer();
}

async function makeJpeg(width: number, height: number, quality = 90): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 0, g: 200, b: 100 },
    },
  })
    .jpeg({ quality })
    .toBuffer();
}

let workspaceRoot: string;
beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'image-resize-'));
});
afterEach(() => {
  try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('checkImageMagicBytes', () => {
  it('matches PNG magic bytes for .png', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const result = checkImageMagicBytes(buf, '.png');
    expect(result.ok).toBe(true);
    expect(result.detectedMime).toBe('image/png');
  });

  it('matches JPEG magic bytes for .jpg / .jpeg', () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    expect(checkImageMagicBytes(buf, '.jpg').ok).toBe(true);
    expect(checkImageMagicBytes(buf, '.jpeg').ok).toBe(true);
  });

  it('matches GIF magic bytes for .gif', () => {
    const buf = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]);
    expect(checkImageMagicBytes(buf, '.gif').ok).toBe(true);
  });

  it('matches WEBP magic bytes for .webp', () => {
    const buf = Buffer.concat([
      Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
      Buffer.alloc(4),
    ]);
    expect(checkImageMagicBytes(buf, '.webp').ok).toBe(true);
  });

  it('matches BMP magic bytes for .bmp', () => {
    expect(checkImageMagicBytes(Buffer.from([0x42, 0x4d, 0]), '.bmp').ok).toBe(true);
  });

  it('detects mismatch when .png ext but content is JPEG (fake/mislabeled)', () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG magic
    const result = checkImageMagicBytes(buf, '.png');
    expect(result.ok).toBe(false);
    expect(result.detectedMime).toBe('image/jpeg');
  });

  it('detects mismatch when .jpg ext but content is .exe / random bytes', () => {
    const buf = Buffer.from([0x4d, 0x5a, 0x90, 0x00]); // .exe MZ header
    const result = checkImageMagicBytes(buf, '.jpg');
    expect(result.ok).toBe(false);
    expect(result.detectedMime).toBeUndefined();
  });

  it('SVG is exempt from magic check (returns ok=undefined)', () => {
    const buf = Buffer.from('<?xml version="1.0"?><svg xmlns="...">');
    const result = checkImageMagicBytes(buf, '.svg');
    expect(result.ok).toBeUndefined();
  });
});

describe('resizeImageBuffer — happy path', () => {
  it('resizes large PNG to long edge 2048px JPEG output', async () => {
    // 4096x3000 PNG（uncompressed ~37MB）
    const png = await makePng(4096, 3000);
    expect(png.length).toBeGreaterThan(IMAGE_RESIZE_TRIGGER_BYTES);

    const result = await resizeImageBuffer(png, 'image/png');
    expect(result.mediaType).toBe(RESIZED_MEDIA_TYPE);
    expect(result.mediaType).toBe('image/jpeg');
    expect(result.longEdgePx).toBeLessThanOrEqual(RESIZE_LONG_EDGE_PX);
    expect(result.longEdgePx).toBeGreaterThan(0);
    expect(result.resizedBytes).toBeLessThan(png.length);
    expect(result.originalBytes).toBe(png.length);
    expect(result.originalMediaType).toBe('image/png');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.base64.length).toBeGreaterThan(0);
  }, 10_000);

  it('does not enlarge small images (withoutEnlargement: true)', async () => {
    const png = await makePng(800, 600);
    const result = await resizeImageBuffer(png, 'image/png');
    expect(Math.max(result.longEdgePx, 0)).toBeLessThanOrEqual(800);
  });
});

describe('resizeImageBuffer — performance baseline (W2 北极星 #3)', () => {
  it('resizes ~25MB PNG within 2 seconds', async () => {
    // 5000x5000 PNG uncompressed → ~75MB（取消压缩）；用 4500x4000 ≈ 54MB 接近 50MB
    // 北极星说 25MB png，我们用一个会到 25MB+ 的 PNG 来钉死性能
    const png = await makePng(4096, 2000);
    const startMs = performance.now();
    const result = await resizeImageBuffer(png, 'image/png');
    const elapsedMs = performance.now() - startMs;
    expect(elapsedMs).toBeLessThan(2000);
    expect(result.elapsedMs).toBeLessThan(2000);
  }, 5_000);
});

describe('resizeImageBuffer — failure modes', () => {
  it('throws ImageResizeError code=sharp_decode_failed for non-image bytes', async () => {
    const garbage = Buffer.from('not an image, just plain text content here');
    await expect(resizeImageBuffer(garbage, 'image/png')).rejects.toMatchObject({
      name: 'ImageResizeError',
      code: 'sharp_decode_failed',
    });
  });
});

describe('readAndResizeImageIfNeeded — end-to-end', () => {
  it('returns kind=ok for sub-5MB PNG (no resize)', async () => {
    const png = await makeJpeg(800, 600, 80); // small JPEG
    const filePath = join(workspaceRoot, 'small.jpeg');
    writeFileSync(filePath, png);

    const outcome = await readAndResizeImageIfNeeded(filePath);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') {
      expect(outcome.mediaType).toBe('image/jpeg');
      expect(outcome.sizeBytes).toBe(png.length);
      expect(outcome.base64.length).toBeGreaterThan(0);
    }
  });

  it('returns kind=resized for >5MB PNG', async () => {
    const png = await makePng(4096, 3000);
    const filePath = join(workspaceRoot, 'big.png');
    writeFileSync(filePath, png);

    const outcome = await readAndResizeImageIfNeeded(filePath);
    expect(outcome.kind).toBe('resized');
    if (outcome.kind === 'resized') {
      expect(outcome.result.mediaType).toBe('image/jpeg');
      expect(outcome.result.originalBytes).toBeGreaterThan(IMAGE_RESIZE_TRIGGER_BYTES);
    }
  }, 10_000);

  it('returns kind=too_large_hard for >50MB file (without reading buffer)', async () => {
    // 制造一个 51MB 的伪图（仅 stat 走的是 size，不会真 sharp 解码）
    // 用 .png 扩展名 + 大文件
    const filePath = join(workspaceRoot, 'huge.png');
    const big = Buffer.alloc(MAX_IMAGE_FILE_BYTES_HARD + 1024, 0xff);
    writeFileSync(filePath, big);

    const outcome = await readAndResizeImageIfNeeded(filePath);
    expect(outcome.kind).toBe('too_large_hard');
    if (outcome.kind === 'too_large_hard') {
      expect(outcome.sizeBytes).toBeGreaterThan(MAX_IMAGE_FILE_BYTES_HARD);
      expect(outcome.limitBytes).toBe(MAX_IMAGE_FILE_BYTES_HARD);
    }
  });

  it('returns kind=magic_mismatch for .png ext containing JPEG bytes', async () => {
    const jpeg = await makeJpeg(400, 300, 80);
    const filePath = join(workspaceRoot, 'fake.png'); // .png ext
    writeFileSync(filePath, jpeg);

    const outcome = await readAndResizeImageIfNeeded(filePath);
    expect(outcome.kind).toBe('magic_mismatch');
    if (outcome.kind === 'magic_mismatch') {
      expect(outcome.detectedMime).toBe('image/jpeg');
      expect(outcome.ext).toBe('.png');
    }
  });

  it('SVG bypasses magic check + does not resize', async () => {
    const svg = '<?xml version="1.0"?><svg width="100" height="100" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" fill="red"/></svg>';
    const filePath = join(workspaceRoot, 'icon.svg');
    writeFileSync(filePath, svg);

    const outcome = await readAndResizeImageIfNeeded(filePath);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') {
      expect(outcome.mediaType).toBe('image/svg+xml');
    }
  });
});

describe('mimeForImageExt', () => {
  it('maps known extensions', () => {
    expect(mimeForImageExt('.png')).toBe('image/png');
    expect(mimeForImageExt('.jpg')).toBe('image/jpeg');
    expect(mimeForImageExt('.JPEG')).toBe('image/jpeg'); // 大小写无关
    expect(mimeForImageExt('.svg')).toBe('image/svg+xml');
    expect(mimeForImageExt('.heic')).toBe('image/heic');
    expect(mimeForImageExt('.unknown')).toBe('application/octet-stream');
  });
});

describe('ImageResizeError shape', () => {
  it('exposes code field for error-classification', () => {
    const err = new ImageResizeError('sharp_unavailable', 'sharp not in node_modules');
    expect(err.name).toBe('ImageResizeError');
    expect(err.code).toBe('sharp_unavailable');
    expect(err.message).toContain('sharp not in node_modules');
  });
});

/**
 * **W2.1 收尾 S3 钉死 `sharp_unavailable` 生产 fallback 路径**
 *
 * 背景：image-resize.ts 用 `await import('sharp')` lazy load，host 没装 sharp
 * 时 dynamic import 抛错 → 包装成 `ImageResizeError(code='sharp_unavailable')`
 * → adapter 把它转 SSoT FILE_TOO_LARGE envelope 给 LLM 专属文案。
 *
 * 这条路径是 W2 引入的生产 fallback，之前 0 测试覆盖（§七 L41）违反 D2"上线
 * 即成熟版本，不分阶段交付半成品"。本套用 `vi.doMock('sharp', ...)` 让 dynamic
 * import 整个抛错，模拟 host 未安装 sharp 的真实状态。
 *
 * **vi.doMock vs vi.mock**：vi.mock 是 hoisted（影响整个 file 所有 import 包括
 * 上面 makePng 用 sharp 的 setup），用了会让 setup 也失败；vi.doMock 不 hoisted
 * + 配合 vi.resetModules 在测试内动态生效 + 测试后 unmock 不污染其它 test。
 */
describe('sharp_unavailable code path — host without sharp installed', () => {
  // 每条 sharp_unavailable case 测试前重置 module registry，让 mock 生效
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock('sharp');
    vi.resetModules();
  });

  it('resizeImageBuffer throws ImageResizeError(sharp_unavailable) when sharp module is not a callable (ENOENT-equivalent)', async () => {
    // **模拟 sharp 包不可用的两种等价路径**：
    //   (a) dynamic import 抛错（包未安装）—— factory 抛错会被 vitest 包装
    //       成 mocking error，不易断言 cause；
    //   (b) sharp 加载成功但非 callable（少见但合法降级——image-resize.ts L196-201
    //       显式 typeof candidate !== 'function' → throw → catch 包装成
    //       ImageResizeError(code='sharp_unavailable')）
    // 两条路径走同一个 catch 分支抛同一个 ImageResizeError(sharp_unavailable)，
    // 用 (b) 模拟语义等价但更稳定。
    vi.doMock('sharp', () => ({ default: null }));
    const mod = await import('../image-resize.js');

    const buf = Buffer.alloc(6 * 1024 * 1024);
    let caught: unknown;
    try {
      await mod.resizeImageBuffer(buf, 'image/png');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(mod.ImageResizeError);
    const err = caught as InstanceType<typeof mod.ImageResizeError>;
    expect(err.code).toBe('sharp_unavailable');
    expect(err.message).toContain('sharp module not available');
    // hint 引导用户走 chat 上传或 install sharp（不是模糊"externally process"）
    expect(err.message).toMatch(/Install sharp|upload the file via chat/);
    // cause 链路保留底层信息（W2.1 fix-9 改 Error.cause 标准）
    expect((err as Error).cause).toBeDefined();
  });

  it('readAndResizeImageIfNeeded returns kind=resize_failed when sharp is unavailable on >5MB image', async () => {
    vi.doMock('sharp', () => ({ default: null }));
    const mod = await import('../image-resize.js');

    // 写一个 >5MB 真 PNG（先 unmock 让真 sharp 生成 fixture）—— 但本测试用动态
    // import 后 mod.resizeImageBuffer 抓的是 mocked sharp。fixture 用纯 alloc
    // 的 buffer 让 magic 自然不命中也无所谓——我们走的不是 readAndResizeImageIfNeeded
    // 的 magic 路径而是 sharp_unavailable fallback。
    //
    // 关键：fs.stat 决定路径走 >5MB 触发缩放分支；缩放路径调 resizeImageBuffer
    // 撞 sharp_unavailable → readAndResizeImageIfNeeded 包装成 kind=resize_failed
    //
    // 真造一个 PNG magic-valid + >5MB 的文件，让 magic 检测通过走到 resize 分支：
    const filePath = join(workspaceRoot, 'no-sharp.png');
    const pngHead = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const big = Buffer.concat([pngHead, Buffer.alloc(6 * 1024 * 1024, 0xaa)]);
    writeFileSync(filePath, big);

    const outcome = await mod.readAndResizeImageIfNeeded(filePath);
    expect(outcome.kind).toBe('resize_failed');
    if (outcome.kind === 'resize_failed') {
      expect(outcome.error.code).toBe('sharp_unavailable');
    }
  });
});
