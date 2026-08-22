/**
 * @tabtin/file-pipeline — File pipeline 抽象层入口
 *
 * **W4（2026-05-13）业务目标**：未来 TabTin 加新文件格式（.epub / .markdown /
 * .numbers）时，工程师只动 parser 层，不动 4 个胶水点（临时通道 read_file /
 * 持久通道 Host / 图装配 / cloud_first 死配置）。
 *
 * **典型用法**：
 *
 * ```ts
 * import { createDefaultFileResolver } from '@tabtin/file-pipeline'
 *
 * const fileResolver = createDefaultFileResolver()
 * const result = await fileResolver.resolve(
 *   { kind: 'local-path', path: '/Users/me/foo.pdf' },
 *   { channelLimitBytes: 50 * 1024 * 1024, signal: abortSignal },
 *   { runDocParserTask, runTempPptxParse },
 * )
 * if (result.kind === 'error') { ... }
 * if (result.kind === 'image') { ... // base64 / url payload }
 * if (result.kind === 'text') { ... // text + chunks }
 * ```
 *
 * **加新格式**：在 `parsers/` 加一个 `XxxParser` class（实现 `FileParser`
 * 接口）+ 在 `createDefaultFileResolver` 注册。channel 0 行改动。
 */

export { FileResolver, type FileResolverOptions } from './file-resolver.js';

export type {
  FileSource,
  ResolveOptions,
  ParseDeps,
  ResolveResult,
  ImageResult,
  ImageBytesPayload,
  ImageUrlPayload,
  ImageResizeMeta,
  TextResult,
  TextChunk,
  ErrorResult,
  ResolveErrorContext,
  FileParser,
  ParserMatchSpec,
  RunTempPptxParse,
  TempPptxParseChunkLike,
  TempPptxParseResultLike,
} from './types.js';

export { ImageParser, imageResizeBindings } from './parsers/image-parser.js';
export { PdfParser, DocxParser, XlsxParser } from './parsers/local-doc-parsers.js';
export { PptxParser, renderPptxChunksAsText } from './parsers/pptx-parser.js';
export { EpubParser } from './parsers/epub-parser.js';

// image-resize 公开子模块（channel 仍然要用 IMAGE_EXTS / magic 检测做早 dedup
// gate，所以暴露出来；ImageParser 内部已自动用，不重复）
export {
  IMAGE_EXTS,
  IMAGE_RESIZE_TRIGGER_BYTES,
  MAX_IMAGE_FILE_BYTES_HARD,
  RESIZE_LONG_EDGE_PX,
  RESIZE_JPEG_QUALITY,
  RESIZED_MEDIA_TYPE,
  ImageResizeError,
  checkImageMagicBytes,
  mimeForImageExt,
  resizeImageBuffer,
  resizeImageBufferIfNeeded,
  readAndResizeImageIfNeeded,
  type ImageMagicCheck,
  type ResizedImageResult,
  type ImageReadOutcome,
} from './image/image-resize.js';

// 重新导出 SSoT 错误码，让 channel 不必同时 import 两个包
export {
  FilePipelineErrorCode,
  isFilePipelineErrorCode,
  formatFilePipelineError,
  formatFilePipelineErrorChinesePrompt,
  FILE_PIPELINE_ERROR_KINDS,
  MAX_DOC_FILE_BYTES_HARD,
  type FilePipelineFileSubject,
  type FilePipelineErrorContext,
  type FilePipelineErrorOutput,
} from '@tabtin/file-pipeline-errors';

import { FileResolver } from './file-resolver.js';
import { ImageParser } from './parsers/image-parser.js';
import { PdfParser, DocxParser, XlsxParser } from './parsers/local-doc-parsers.js';
import { PptxParser } from './parsers/pptx-parser.js';
import { EpubParser } from './parsers/epub-parser.js';

/**
 * 默认 FileResolver：注册 6 个 parser（image / pdf / docx / xlsx / pptx / epub）。
 *
 * **加新格式**：在本函数返回的 parsers 数组里 push 一个新 Parser 实例即可。
 * 没有 4 个胶水点改动；W4 北极星之一。
 */
export function createDefaultFileResolver(): FileResolver {
  return new FileResolver({
    parsers: [
      new ImageParser(),
      new PdfParser(),
      new DocxParser(),
      new XlsxParser(),
      new PptxParser(),
      new EpubParser(),
    ],
  });
}
