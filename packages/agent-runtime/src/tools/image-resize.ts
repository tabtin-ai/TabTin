/**
 * image-resize — 大图自动缩放 + magic bytes 验证
 *
 * **Wave 2 北极星之一**：用户给 AI 看 25MB 设计图不再撞 20MB 墙——客户端
 * 自动缩放到 < 5MB 后塞进 history，LLM 能看清。
 *
 * **设计取舍**：
 *   1. 软上限 `IMAGE_RESIZE_TRIGGER_BYTES = 5MB`：>5MB 走 sharp 长边 2048px
 *      JPEG 90% 质量缩放（覆盖 PNG/JPG/GIF/WEBP/BMP/HEIC）。
 *   2. 硬上限 `MAX_IMAGE_FILE_BYTES_HARD = 50MB`：>50MB 才硬拒，走 W1 的
 *      `FILE_TOO_LARGE` envelope —— 缩放再大的图也无意义（GPT-4V / Claude
 *      input 单图实际只能用到 1568x1568 / 2048x768 tile，原图越大缩放收益
 *      边际越低，反而拖慢解码）。
 *   3. SVG 不缩放：SVG 是矢量文本，base64 直接走（W4 P1-C3 切文本路径独立处理）。
 *   4. magic bytes 验证（不变量 #4 局部落实）：扩展名 + magic bytes 双重判定，
 *      防止 .png 后缀的 .exe / .zip 伪图被 sharp 解出 segfault 类异常。本期
 *      只补 image 这一条（PNG / JPEG / WEBP / GIF / BMP / HEIC magic）；
 *      其余 mime 验证留 W4 抽 FileResolver 时统一补全（L19）。
 *   5. 缩放在 main 进程（Electron）/ Node 进程（Daemon）做：sharp 是 native
 *      binary，跑在 main / daemon 都行；renderer 不该用 sharp（Electron
 *      renderer 是浏览器 V8，sharp ABI 不匹配）。
 *   6. 缩放失败兜底：抛 ImageResizeError 让 caller 走 SSoT FILE_TOO_LARGE
 *      envelope 拒绝（不悄悄降级保留硬拒——告诉 LLM 缩放失败的具体原因）。
 *
 * **不在 packages/agent-runtime 硬依赖 sharp**：
 *   - sharp 是 native binary，安装慢且 ABI 平台相关；packages/agent-runtime
 *     被多个非图像场景的包消费，硬依赖会拖慢所有 install 链路
 *   - 改用 dynamic `import('sharp')` + try/catch；缺 sharp 时退化为"按软上限
 *     直接走 SSoT FILE_TOO_LARGE envelope"（hint 告诉用户上传 chat 走云端）
 *   - host 侧（Electron / Daemon）显式装 sharp 让缩放生效——dogfood 级别
 *     Electron 已装（main 进程截图用），Daemon 在 W2 顺手补 dependency
 */

import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

// ─── 常量（与 file-pipeline-errors SSoT + tabcode-adapter 对齐） ──────

/**
 * **软上限**：>该值触发自动缩放（不是硬拒）。
 * 5MB 是 GPT-4V / Claude 单图 token 估算的甜区——再大也是浪费 base64 体积，
 * tile/pixel 计算本来就有 cap（OpenAI 2048×2048 / Anthropic 1568×1568）。
 *
 * **D1 不留兼容**：W2 把旧 `MAX_IMAGE_FILE_BYTES = 20MB`（硬上限）整体替换
 * 为本常量（软上限）+ 下方硬上限。原"硬拒 20MB"逻辑直接删除，不留 fallback。
 */
export const IMAGE_RESIZE_TRIGGER_BYTES = 5 * 1024 * 1024;

/**
 * **硬上限**：>该值无论缩放都拒。
 * 50MB 给"用户拍的高分辨率手机照片 / RAW 转 PNG"留 headroom，再大就强烈建议
 * 走 chat 上传走云端 OSS（无大小限制）。
 */
export const MAX_IMAGE_FILE_BYTES_HARD = 50 * 1024 * 1024;

/** 缩放后长边像素（保比例）。2048 是 OpenAI tile 切割的天然分界。 */
export const RESIZE_LONG_EDGE_PX = 2048;

/** 缩放输出 JPEG 质量（90 平衡画质 + 体积；96+ 收益边际，80- 文字模糊）。 */
export const RESIZE_JPEG_QUALITY = 90;

/** 缩放后输出 mime（统一 JPEG —— 减少历史里 mime 多样性 + 体积最优）。 */
export const RESIZED_MEDIA_TYPE = 'image/jpeg';

// ─── magic bytes 验证 ────────────────────────────────────────────────

/**
 * 已知图像 magic bytes（不变量 #4 局部落实）。
 *
 * **不要扩散到 W4 全 mime 验证范围**：本期只补 image 这一条，让 W2 缩放路径
 * 不会被伪图打穿。其余 mime 验证（PDF / DOCX / XLSX magic bytes）留 W4 抽
 * FileResolver 时统一处理（L19）。
 */
export interface ImageMagicCheck {
  /** true = magic bytes 与扩展名一致；false = 不一致（伪图）；undefined = 扩展名我们不验证（如 .svg）。 */
  ok: boolean | undefined;
  /** 实际探测到的 mime（unknown 时 undefined）。 */
  detectedMime?: string;
}

interface ImageMagicMatcher {
  detectedMime: string;
  extensions: readonly string[];
  matches: (buf: Buffer) => boolean;
}

const IMAGE_MAGIC_MATCHERS: ImageMagicMatcher[] = [
  {
    detectedMime: 'image/png',
    extensions: ['.png'],
    matches: (buf) => startsWithBytes(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  {
    detectedMime: 'image/jpeg',
    extensions: ['.jpg', '.jpeg'],
    matches: (buf) => startsWithBytes(buf, [0xff, 0xd8, 0xff]),
  },
  {
    detectedMime: 'image/gif',
    extensions: ['.gif'],
    matches: (buf) => startsWithBytes(buf, [0x47, 0x49, 0x46, 0x38]),
  },
  {
    detectedMime: 'image/webp',
    extensions: ['.webp'],
    matches: (buf) => (
      startsWithBytes(buf, [0x52, 0x49, 0x46, 0x46]) &&
      hasBytesAt(buf, 8, [0x57, 0x45, 0x42, 0x50])
    ),
  },
  {
    detectedMime: 'image/bmp',
    extensions: ['.bmp'],
    matches: (buf) => startsWithBytes(buf, [0x42, 0x4d]),
  },
  {
    detectedMime: 'image/heic',
    extensions: ['.heic', '.heif'],
    matches: (buf) => hasFtypBrand(buf, ['heic', 'heix', 'mif1', 'msf1', 'heif']),
  },
];

function startsWithBytes(buf: Buffer, bytes: readonly number[]): boolean {
  return hasBytesAt(buf, 0, bytes);
}

function hasBytesAt(buf: Buffer, offset: number, bytes: readonly number[]): boolean {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((byte, index) => buf[offset + index] === byte);
}

function hasFtypBrand(buf: Buffer, brands: readonly string[]): boolean {
  if (!hasBytesAt(buf, 4, [0x66, 0x74, 0x79, 0x70])) return false;
  return brands.includes(buf.slice(8, 12).toString('ascii'));
}

export function checkImageMagicBytes(buf: Buffer, ext: string): ImageMagicCheck {
  const lowerExt = ext.toLowerCase();
  // SVG 是文本格式（XML），跳过 magic 验证
  if (lowerExt === '.svg') return { ok: undefined };

  const matched = IMAGE_MAGIC_MATCHERS.find((matcher) => matcher.matches(buf));
  if (matched) {
    return {
      ok: matched.extensions.includes(lowerExt),
      detectedMime: matched.detectedMime,
    };
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
    // **W2.1 Review 3 fix-9**：用 ES2022 标准 `Error.cause` 而非自定义实例字段
    // —— Sentry / Winston / pino 等 telemetry 都按 `Error.prototype.cause`
    // 标准展开 cause 链路；自定义字段被忽略。
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

  // **Lazy import sharp**：避免 packages/agent-runtime 硬依赖 native binary。
  // monorepo 里 apps/tabtin-electron 已装 sharp 0.34.5；apps/tabtin-daemon 在
  // W2 顺手补 dependency。production 路径都装得上；缺 sharp 仅在"裸跑 packages
  // 单测且没 hoist sharp"会出现，此时拒绝缩放走 SSoT FILE_TOO_LARGE envelope。
  //
  // sharp 用 `export = sharp` (CJS module.exports = sharp)，ESM `import('sharp')`
  // 后整个 namespace 是 callable 函数本体；某些 bundler / Node ESM 兼容层会把
  // 它包成 `{ default: sharp }`——双重解包做兼容。
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
    // 用 any 桥接：sharp 的链式 API 类型从 dynamic import 拿不到——避免
    // `export = sharp` 命名空间在 ESM 下只能拿 namespace 的限制；运行时
    // 行为完全等价于直接 `import sharp from 'sharp'`。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pipeline: any = (sharp as unknown as (
      input: Buffer,
      options?: unknown,
    ) => any)(buf, { failOn: 'truncated' })
      .rotate() // 自动 EXIF 旋转校正（手机照片常见）
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
 * 调用方拿到 result 后自行装 ImageBlock + 写 dedup snapshot。
 *
 * @returns
 *   - `{ kind: 'ok', ... }`：原图未触发缩放，直接 base64 返
 *   - `{ kind: 'resized', result }`：缩放成功
 *   - `{ kind: 'magic_mismatch', detectedMime }`：扩展名是图但 magic 不是
 *   - `{ kind: 'too_large_hard', sizeBytes }`：> 50MB 硬拒（caller 走 SSoT envelope）
 *   - `{ kind: 'resize_failed', error }`：缩放抛错（caller 走 SSoT envelope，
 *     hint 告诉 LLM 失败原因）
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
