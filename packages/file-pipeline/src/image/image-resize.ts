/**
 * image-resize — 大图自动缩放 + magic bytes 验证
 *
 * **W4（2026-05-13）位置变更**：从 `packages/agent-runtime/src/tools/image-resize.ts`
 * 搬到 `@tabtin/file-pipeline`，让通道（channel）与 parser（image）层物理分离。
 * agent-runtime adapter 不再直接 import 本模块；ImageParser 内部用它做缩放。
 *
 * **W4（2026-05-13）L44 收敛**：硬上限 / 软上限常量退役本地定义，全部从
 * `@tabtin/file-pipeline-errors` 包 SSoT 拿，避免三处独立字面值漂移。
 *
 * **设计取舍**（沿用 W2 实施纪要）：
 *   1. 软上限 `IMAGE_RESIZE_TRIGGER_BYTES = 5MB`：>5MB 走 sharp 长边 2048px JPEG 90%
 *   2. 硬上限 `MAX_IMAGE_FILE_BYTES_HARD = 50MB`：>50MB 才硬拒
 *   3. SVG 不缩放
 *   4. magic bytes 验证（不变量 #4 局部落实）
 *   5. 缩放失败抛 `ImageResizeError` 让 caller 走 SSoT FILE_TOO_LARGE envelope
 *
 * **不在本包硬依赖 sharp**：用 `peerDependenciesMeta.sharp.optional: true`，
 * 通过 dynamic `import('sharp')` lazy load；缺 sharp 时退化为走 SSoT envelope。
 */

import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import {
  IMAGE_RESIZE_TRIGGER_BYTES,
  MAX_IMAGE_FILE_BYTES_HARD,
} from '@tabtin/file-pipeline-errors';

// 让 channel + tests 沿用同一份字面值（不破坏原有 import 链）。
export { IMAGE_RESIZE_TRIGGER_BYTES, MAX_IMAGE_FILE_BYTES_HARD };

/** 缩放后长边像素（保比例）。2048 是 OpenAI tile 切割的天然分界。 */
export const RESIZE_LONG_EDGE_PX = 2048;

/** 缩放输出 JPEG 质量（90 平衡画质 + 体积；96+ 收益边际，80- 文字模糊）。 */
export const RESIZE_JPEG_QUALITY = 90;

/** 缩放后输出 mime（统一 JPEG —— 减少历史里 mime 多样性 + 体积最优）。 */
export const RESIZED_MEDIA_TYPE = 'image/jpeg';

// ─── magic bytes 验证 ────────────────────────────────────────────────

export interface ImageMagicCheck {
  /** true = magic bytes 与扩展名一致；false = 不一致（伪图）；undefined = 扩展名我们不验证（如 .svg）。 */
  ok: boolean | undefined;
  /** 实际探测到的 mime（unknown 时 undefined）。 */
  detectedMime?: string;
}

export function checkImageMagicBytes(buf: Buffer, ext: string): ImageMagicCheck {
  const lowerExt = ext.toLowerCase();
  // SVG 是文本格式（XML），跳过 magic 验证
  if (lowerExt === '.svg') return { ok: undefined };

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return { ok: lowerExt === '.png', detectedMime: 'image/png' };
  }
  // JPEG: FF D8 FF
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ok: lowerExt === '.jpg' || lowerExt === '.jpeg', detectedMime: 'image/jpeg' };
  }
  // GIF: 47 49 46 38 (GIF8)
  if (
    buf.length >= 4 &&
    buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38
  ) {
    return { ok: lowerExt === '.gif', detectedMime: 'image/gif' };
  }
  // WEBP: 'RIFF' .... 'WEBP'
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return { ok: lowerExt === '.webp', detectedMime: 'image/webp' };
  }
  // BMP: 42 4D ('BM')
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return { ok: lowerExt === '.bmp', detectedMime: 'image/bmp' };
  }
  // HEIC / HEIF: 'ftyp' at offset 4 + brand 'heic'/'heix'/'mif1'/'msf1' at offset 8-12
  if (
    buf.length >= 12 &&
    buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70
  ) {
    const brand = buf.slice(8, 12).toString('ascii');
    if (['heic', 'heix', 'mif1', 'msf1', 'heif'].includes(brand)) {
      return {
        ok: lowerExt === '.heic' || lowerExt === '.heif',
        detectedMime: 'image/heic',
      };
    }
  }
  // 不在已知图像 magic 列表里 → 扩展名是图但实际不是
  return { ok: false, detectedMime: undefined };
}

// ─── sharp 缩放（lazy import） ────────────────────────────────────────

export class ImageResizeError extends Error {
  readonly code: 'sharp_unavailable' | 'sharp_decode_failed' | 'too_large_after_resize';

  constructor(
    code: 'sharp_unavailable' | 'sharp_decode_failed' | 'too_large_after_resize',
    message: string,
    cause?: unknown,
  ) {
    // W2.1 Review 3 fix-9：用 ES2022 标准 `Error.cause` 而非自定义实例字段，
    // 让 Sentry / Winston / pino 等 telemetry 按标准展开 cause 链路。
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ImageResizeError';
    this.code = code;
  }
}

export interface ResizedImageResult {
  /** 缩放后 base64（无 data: 前缀）。 */
  base64: string;
  /** 缩放后 mime（统一 JPEG）。 */
  mediaType: string;
  /** 缩放后字节数（base64 解码后的二进制 size，不是 base64 长度）。 */
  resizedBytes: number;
  /** 缩放前原文件字节数（用于 ToolResult 文字 + telemetry）。 */
  originalBytes: number;
  /** 原文件 mime（用于 ToolResult 文字告知 LLM "原 image/png" 之类）。 */
  originalMediaType: string;
  /** 缩放后长边像素（实测，不是配置）。 */
  longEdgePx: number;
  /** 实际耗时（用于 telemetry / 北极星验证 < 2s）。 */
  elapsedMs: number;
}

/**
 * 用 sharp 把 image buffer 缩到长边 2048px / JPEG 90% 质量。
 *
 * @throws {ImageResizeError} 缩放失败（sharp 不可用 / 解码失败 / 缩放后仍超硬上限）
 */
export async function resizeImageBuffer(
  buf: Buffer,
  originalMediaType: string,
): Promise<ResizedImageResult> {
  const startMs = Date.now();
  const originalBytes = buf.length;

  let sharp: (input?: Buffer | string, options?: unknown) => unknown;
  try {
    const mod = (await import('sharp')) as unknown as
      | { default?: unknown }
      | ((input?: Buffer | string, options?: unknown) => unknown);
    const candidate =
      typeof mod === 'function'
        ? mod
        : ((mod as { default?: unknown }).default ?? mod);
    if (typeof candidate !== 'function') {
      throw new Error('sharp module loaded but is not a callable function');
    }
    sharp = candidate as (input?: Buffer | string, options?: unknown) => unknown;
  } catch (err) {
    throw new ImageResizeError(
      'sharp_unavailable',
      `sharp module not available — image larger than ${IMAGE_RESIZE_TRIGGER_BYTES / 1024 / 1024}MB cannot be resized in this host. Install sharp or upload the file via chat for cloud parsing.`,
      err,
    );
  }

  let resized: Buffer;
  let metadata: { width?: number; height?: number };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pipeline: any = (sharp as unknown as (
      input: Buffer,
      options?: unknown,
    ) => any)(buf, { failOn: 'truncated' })
      .rotate()
      .resize({
        width: RESIZE_LONG_EDGE_PX,
        height: RESIZE_LONG_EDGE_PX,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: RESIZE_JPEG_QUALITY, mozjpeg: true });

    const result = await pipeline.toBuffer({ resolveWithObject: true });
    resized = result.data as Buffer;
    metadata = {
      width: (result.info as { width?: number }).width,
      height: (result.info as { height?: number }).height,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ImageResizeError(
      'sharp_decode_failed',
      `Failed to decode/resize image (mime=${originalMediaType}, ${(originalBytes / 1024 / 1024).toFixed(1)}MB): ${msg}. The file may be corrupted, an unsupported variant (e.g. animated WEBP), or have a wrong file extension.`,
      err,
    );
  }

  // 兜底：缩放后仍超硬上限（极罕见，理论上 2048px JPEG 最大 ~15MB）
  if (resized.length > MAX_IMAGE_FILE_BYTES_HARD) {
    throw new ImageResizeError(
      'too_large_after_resize',
      `Image still exceeds ${MAX_IMAGE_FILE_BYTES_HARD / 1024 / 1024}MB after resize (got ${(resized.length / 1024 / 1024).toFixed(1)}MB). Source image may be a giant TIFF/RAW with extreme detail.`,
    );
  }

  return {
    base64: resized.toString('base64'),
    mediaType: RESIZED_MEDIA_TYPE,
    resizedBytes: resized.length,
    originalBytes,
    originalMediaType,
    longEdgePx: Math.max(metadata.width ?? 0, metadata.height ?? 0),
    elapsedMs: Date.now() - startMs,
  };
}

/**
 * 高层封装：read 图文件 → magic 验证 → 软上限触发缩放 → 返结果。
 *
 * **W4（2026-05-13）L45 收敛**：此函数原是 image-resize 模块的"死代码"
 * （仅测试用），W4 抽 ImageParser 后**它成为 ImageParser 的核心实现**——
 * channel 与 parser 物理分离让 readAndResizeImageIfNeeded 终于上岗。
 */
export type ImageReadOutcome =
  | { kind: 'ok'; base64: string; mediaType: string; sizeBytes: number; longEdgePx?: number }
  | { kind: 'resized'; result: ResizedImageResult }
  | { kind: 'magic_mismatch'; detectedMime: string | undefined; ext: string }
  | { kind: 'too_large_hard'; sizeBytes: number; limitBytes: number }
  | { kind: 'resize_failed'; error: ImageResizeError };

const IMAGE_EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

/**
 * **W4（2026-05-13）SSoT 化**：image 扩展名集合 + mime 映射放在本模块。
 * action-tools / tabcode-adapter 旧两份独立定义改为 import 本集合，消除
 * 反思 §八 #3 SSoT 双源风险（W2.1 fix-6 局部修过同款问题）。
 */
export const IMAGE_EXTS: ReadonlySet<string> = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.heic', '.heif',
]);

export function mimeForImageExt(ext: string): string {
  return IMAGE_EXT_TO_MIME[ext.toLowerCase()] ?? 'application/octet-stream';
}

export async function readAndResizeImageIfNeeded(
  resolvedPath: string,
): Promise<ImageReadOutcome> {
  const stat = await fsPromises.stat(resolvedPath);
  const sizeBytes = stat.size;
  const ext = path.extname(resolvedPath).toLowerCase();
  const declaredMime = mimeForImageExt(ext);

  // 硬上限 50MB → 直接拒（不读 buffer 浪费内存）
  if (sizeBytes > MAX_IMAGE_FILE_BYTES_HARD) {
    return { kind: 'too_large_hard', sizeBytes, limitBytes: MAX_IMAGE_FILE_BYTES_HARD };
  }

  const buf = await fsPromises.readFile(resolvedPath);

  // SVG 不验证 magic，不缩放，直接 base64 走
  if (ext === '.svg') {
    return {
      kind: 'ok',
      base64: buf.toString('base64'),
      mediaType: 'image/svg+xml',
      sizeBytes,
    };
  }

  // magic bytes 验证（防伪图打穿 sharp）
  const magic = checkImageMagicBytes(buf, ext);
  if (magic.ok === false) {
    return { kind: 'magic_mismatch', detectedMime: magic.detectedMime, ext };
  }

  // 软上限以下 → 直接 base64（不缩放，preserve 原图 fidelity）
  if (sizeBytes <= IMAGE_RESIZE_TRIGGER_BYTES) {
    return {
      kind: 'ok',
      base64: buf.toString('base64'),
      mediaType: declaredMime,
      sizeBytes,
    };
  }

  // 软上限以上 → 缩放
  try {
    const result = await resizeImageBuffer(buf, declaredMime);
    return { kind: 'resized', result };
  } catch (err) {
    if (err instanceof ImageResizeError) return { kind: 'resize_failed', error: err };
    throw err;
  }
}

/**
 * 已在内存的 buffer 也走相同流程（memory-bytes source / adapter 已读到 base64 解回 buffer
 * 后想缩放的场景）。返同款 ImageReadOutcome。
 */
export async function resizeImageBufferIfNeeded(
  buf: Buffer,
  ext: string,
): Promise<ImageReadOutcome> {
  const sizeBytes = buf.length;
  const lowerExt = ext.toLowerCase();
  const declaredMime = mimeForImageExt(lowerExt);

  if (sizeBytes > MAX_IMAGE_FILE_BYTES_HARD) {
    return { kind: 'too_large_hard', sizeBytes, limitBytes: MAX_IMAGE_FILE_BYTES_HARD };
  }

  if (lowerExt === '.svg') {
    return {
      kind: 'ok',
      base64: buf.toString('base64'),
      mediaType: 'image/svg+xml',
      sizeBytes,
    };
  }

  const magic = checkImageMagicBytes(buf, lowerExt);
  if (magic.ok === false) {
    return { kind: 'magic_mismatch', detectedMime: magic.detectedMime, ext: lowerExt };
  }

  if (sizeBytes <= IMAGE_RESIZE_TRIGGER_BYTES) {
    return {
      kind: 'ok',
      base64: buf.toString('base64'),
      mediaType: declaredMime,
      sizeBytes,
    };
  }

  try {
    const result = await resizeImageBuffer(buf, declaredMime);
    return { kind: 'resized', result };
  } catch (err) {
    if (err instanceof ImageResizeError) return { kind: 'resize_failed', error: err };
    throw err;
  }
}
