/**
 * ImageParser — image FileSource → image ResolveResult
 *
 * **设计要点**：
 *   - local-path：调 `readAndResizeImageIfNeeded`（W4 让旧的死代码 L45 上岗）
 *   - memory-bytes：复用 `resizeImageBufferIfNeeded`（不重复 read IO）
 *   - oss-url：直接 url pass-through 返 `ImageUrlPayload`（持久通道不下载不缩放）
 *
 * **ImageParser 不需要 local + cloud 两套**（与总控指导一致）：image 没有
 * "远端解析"概念，url source 直接 pass-through，bytes source 才 base64 encode。
 *
 * **不变量 #1**：parser 不知通道——channel 决定要不要把 oss-url 路径下载到本地
 * 缩放（一般不要：图直接 url 给 LLM provider 抓最高效；缩放是临时通道 read_file
 * 的优化，与"用户拖到 chat"流程无关）。
 */

import { FilePipelineErrorCode } from '@tabtin/file-pipeline-errors';
import type {
  FileParser,
  FileSource,
  ParseDeps,
  ParserMatchSpec,
  ResolveOptions,
  ResolveResult,
} from '../types.js';
import {
  IMAGE_EXTS,
  IMAGE_RESIZE_TRIGGER_BYTES,
  MAX_IMAGE_FILE_BYTES_HARD,
  mimeForImageExt,
  type ImageReadOutcome,
} from '../image/image-resize.js';

// W4 测试可观察性：把 image-resize 整个模块暴露成一个 mutable 单例，让
// `vi.spyOn(imageResizeBindings, 'resizeImageBufferIfNeeded').mockRejectedValue(...)`
// 能在测试时挂到 ImageParser 实际调用的引用上。
//
// 设计取舍：vitest spyOn ES Module named export 在 Node ESM 模式下不可写
// （exports 是 immutable bindings）；包外用 `await import('@tabtin/file-pipeline')`
// 拿到的 namespace 也是 frozen。把绑定收到本 module 的一个可变对象里、
// 让 ImageParser 通过该对象访问，spy 就能正常替换属性。生产路径与测试
// 路径完全同一套调用——读 `imageResizeBindings.resizeImageBufferIfNeeded`，
// 测试时 vi.spyOn 修改属性即可。
import * as _imageResizeModule from '../image/image-resize.js';

/**
 * **仅供 W4 测试 vi.spyOn 用**。生产代码不要直接引用 .resizeImageBuffer 等属性，
 * 走 `import('@tabtin/file-pipeline').resizeImageBuffer` 公开 API。
 */
export const imageResizeBindings: {
  resizeImageBufferIfNeeded: typeof _imageResizeModule.resizeImageBufferIfNeeded;
  readAndResizeImageIfNeeded: typeof _imageResizeModule.readAndResizeImageIfNeeded;
} = {
  resizeImageBufferIfNeeded: _imageResizeModule.resizeImageBufferIfNeeded,
  readAndResizeImageIfNeeded: _imageResizeModule.readAndResizeImageIfNeeded,
};

export class ImageParser implements FileParser {
  readonly name = 'image';

  matches(spec: ParserMatchSpec): boolean {
    if (IMAGE_EXTS.has(spec.ext)) return true;
    // mime 兜底：image/* 但扩展名缺失 / 非标准
    if (spec.mime && /^image\//i.test(spec.mime)) return true;
    return false;
  }

  async parse(
    source: FileSource,
    _options: ResolveOptions,
    _deps: ParseDeps,
  ): Promise<ResolveResult> {
    // ── oss-url：pass-through，不下载不缩放 ─────────────────────────
    if (source.kind === 'oss-url') {
      // 持久通道：image 直接 url 给 LLM provider 抓（OpenAI image_url /
      // Anthropic image URL block 都接得住）。channel 装 `ImageBlock {source:
      // { type: 'url', url }}`，LLM provider 内部下载 + tile 分块。
      const mediaType = source.declaredMimeType ?? mimeForImageExt(
        (source.filename ?? source.url).split('.').pop()
          ? `.${(source.filename ?? source.url).split('.').pop()!.toLowerCase()}`
          : '',
      );
      return {
        kind: 'image',
        payload: { source: 'url', url: source.url, mediaType },
      };
    }

    // ── local-path：read + magic + 软上限缩放 ───────────────────────
    if (source.kind === 'local-path') {
      const outcome = await imageResizeBindings.readAndResizeImageIfNeeded(source.path);
      return imageOutcomeToResolveResult(outcome, source.path);
    }

    // ── memory-bytes：复用 resizeImageBufferIfNeeded ────────────────
    {
      const ext = source.filename
        ? (() => {
            const lastDot = source.filename!.lastIndexOf('.');
            return lastDot >= 0 ? source.filename!.slice(lastDot).toLowerCase() : '';
          })()
        : '';
      const outcome = await imageResizeBindings.resizeImageBufferIfNeeded(source.bytes, ext);
      return imageOutcomeToResolveResult(outcome, source.filename ?? '<bytes>');
    }
  }
}

function imageOutcomeToResolveResult(
  outcome: ImageReadOutcome,
  filenameOrPath: string,
): ResolveResult {
  // 仅用文件名做 raw filename（错误派发时 SSoT 取 filename 字段，与 path 区分）
  const filename = filenameOrPath.includes('/') || filenameOrPath.includes('\\')
    ? filenameOrPath.split(/[\\/]/).pop() ?? filenameOrPath
    : filenameOrPath;

  switch (outcome.kind) {
    case 'ok':
      return {
        kind: 'image',
        payload: {
          source: 'bytes',
          mediaType: outcome.mediaType,
          base64: outcome.base64,
          sizeBytes: outcome.sizeBytes,
        },
      };
    case 'resized':
      return {
        kind: 'image',
        payload: {
          source: 'bytes',
          mediaType: outcome.result.mediaType,
          base64: outcome.result.base64,
          sizeBytes: outcome.result.resizedBytes,
        },
        resize: {
          originalMediaType: outcome.result.originalMediaType,
          originalBytes: outcome.result.originalBytes,
          longEdgePx: outcome.result.longEdgePx,
          elapsedMs: outcome.result.elapsedMs,
        },
      };
    case 'magic_mismatch':
      return {
        kind: 'error',
        code: FilePipelineErrorCode.UNSUPPORTED_FORMAT,
        message:
          `File has ${outcome.ext} extension but content does not match any known image format ` +
          `(detected: ${outcome.detectedMime ?? 'unknown'}). The file may be corrupted, ` +
          `mislabeled, or actually a different binary format.`,
        ctx: {
          filename,
          format: outcome.ext,
          subject: 'image',
          // **W5 L31（2026-05-14）**：用结构化 failureMode 替代 rawMessage 字面值前缀检测
          // SSoT format.ts 派发 image magic-mismatch 专属 "重新导出" 指引
          failureMode: 'magic_mismatch',
          rawMessage: `detected: ${outcome.detectedMime ?? 'unknown'}.`,
        },
      };
    case 'too_large_hard':
      return {
        kind: 'error',
        code: FilePipelineErrorCode.FILE_TOO_LARGE,
        message: `Image ${filename} exceeds the ${MAX_IMAGE_FILE_BYTES_HARD / 1024 / 1024}MB hard limit (actual: ${(outcome.sizeBytes / 1024 / 1024).toFixed(1)}MB).`,
        ctx: {
          filename,
          subject: 'image',
          // 'oversize' 是默认隐含含义；显式 set 让 reviewer 一眼看懂这是
          // "原图超 50MB 硬上限"语义，不是 "sharp 缩放失败"语义
          failureMode: 'oversize',
          actualBytes: outcome.sizeBytes,
          limitBytes: outcome.limitBytes,
        },
      };
    case 'resize_failed':
      // **W5 L38（2026-05-14）**：sharp 缩放失败拆为独立 enum
      // `IMAGE_RESIZE_FAILED`（数字码 19），与 FILE_TOO_LARGE "原图超 50MB" 物理脱耦。
      // 不再走 rawMessage 注入跨包字符串契约（反思 §八 #13）。
      return {
        kind: 'error',
        code: FilePipelineErrorCode.IMAGE_RESIZE_FAILED,
        message: `Local image processing failed for ${filename}: ${outcome.error.message}`,
        ctx: {
          filename,
          subject: 'image',
          // 透传 sharp 失败的细分原因给 SSoT 派发"sharp_unavailable" /
          // "sharp_decode_failed" / "too_large_after_resize" 专属 cause phrase
          resizeFailureCause: outcome.error.code,
          rawMessage: outcome.error.message,
        },
      };
  }
}

void IMAGE_RESIZE_TRIGGER_BYTES; // 在 import 链路保留（dead-code-elim 防护）
