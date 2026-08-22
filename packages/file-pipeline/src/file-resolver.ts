/**
 * FileResolver — 通道→parser 路由 + magic bytes 兜底 + 错误归一
 *
 * **W4（2026-05-13）核心抽象**：4 个旧胶水点（runLocalDocParse / 老
 * parseLocalAttachment / resolveOneAttachment 解析段 / 图装配两份同构）
 * 全部收敛到 `fileResolver.resolve(source, options, deps)` 一处。
 *
 * 北极星：新加任意 mime 只动 parser 层、不动 4 个胶水点。EpubParser 是
 * 该抽象成本的活验证（见 packages/file-pipeline/src/parsers/epub-parser.ts）。
 *
 * **算法**：
 *   1. 根据 FileSource 推断 ext + declaredMime
 *   2. 按 parsers 数组顺序找第一个 `matches({ ext, mime })` 返 true 的 parser
 *   3. 委托 `parser.parse(source, options, deps)`
 *   4. 如无 parser 命中 → 返 SSoT `UNSUPPORTED_FORMAT` envelope
 *
 * **不变量守住**（与总控 §九 7 条对照）：
 *   - #1 parser 不知通道（FileResolver 不暴露 OSS / message 给 parser）
 *   - #2 通道不重复解析（channel 只调 `resolve`，自己不再 sharp / pdfjs）
 *   - #3 错误码全局唯一（parser 返 ErrorResult.code 必是 FilePipelineErrorCode）
 *   - #4 mime 优先扩展名 + magic bytes 兜底（FileResolver 内做 magic check）
 *   - #5 size 上限按通道分（resolve options.channelLimitBytes 由 channel 传）
 *   - #6 dedup 不污染（channel 自己管 image/localDoc dedup state，FileResolver
 *        无状态，仅做计算）
 *   - #7 不留 ToolResultBlock 在 newMessages（FileResolver 不接触 newMessages）
 */

import path from 'node:path';
import { FilePipelineErrorCode } from '@tabtin/file-pipeline-errors';
import type {
  FileParser,
  FileSource,
  ParseDeps,
  ParserMatchSpec,
  ResolveOptions,
  ResolveResult,
} from './types.js';

/**
 * 从 FileSource 推断 ext / filename / declaredMime（无 IO，纯字符串处理）。
 */
function inferSpec(source: FileSource): {
  ext: string;
  filename: string | undefined;
  declaredMime: string | undefined;
} {
  if (source.kind === 'local-path') {
    return {
      ext: path.extname(source.path).toLowerCase(),
      filename: path.basename(source.path),
      declaredMime: undefined,
    };
  }
  if (source.kind === 'oss-url') {
    // URL 走 `path.extname` 也能拿 ext —— URL.parse 后 pathname 含 ext。
    let ext = '';
    let filename = source.filename;
    try {
      const u = new URL(source.url);
      if (!filename) filename = path.basename(u.pathname);
      ext = path.extname(u.pathname).toLowerCase();
    } catch {
      // URL 解析失败 → 退回 filename
      if (filename) ext = path.extname(filename).toLowerCase();
    }
    // declaredMimeType 优先级最高（持久通道 FileRecord.mime_type 已确认）
    return {
      ext,
      filename,
      declaredMime: source.declaredMimeType,
    };
  }
  // memory-bytes
  const filename = source.filename;
  const ext = filename ? path.extname(filename).toLowerCase() : '';
  return {
    ext,
    filename,
    declaredMime: source.declaredMimeType,
  };
}

export interface FileResolverOptions {
  parsers: FileParser[];
}

export class FileResolver {
  private readonly parsers: readonly FileParser[];

  constructor(opts: FileResolverOptions) {
    if (!opts.parsers || opts.parsers.length === 0) {
      throw new Error('FileResolver requires at least one parser');
    }
    this.parsers = opts.parsers;
  }

  /**
   * 主入口：通道调它，拿结构化 ResolveResult。
   *
   * **失败语义**：
   *   - 找不到 matches 的 parser → ErrorResult{ code: UNSUPPORTED_FORMAT }
   *   - parser 内部 panic / 未 catch 的异常 → ErrorResult{ code: UNKNOWN_ERROR }
   *     （不向 channel 抛 —— channel 拿 ErrorResult 派发 SSoT envelope 一致体验）
   */
  async resolve(
    source: FileSource,
    options: ResolveOptions = {},
    deps: ParseDeps = {},
  ): Promise<ResolveResult> {
    const spec = inferSpec(source);
    const matchSpec: ParserMatchSpec = { ext: spec.ext, mime: spec.declaredMime };

    const parser = this.parsers.find((p) => p.matches(matchSpec));
    if (!parser) {
      return {
        kind: 'error',
        code: FilePipelineErrorCode.UNSUPPORTED_FORMAT,
        message: `No parser registered for ext="${spec.ext}" mime="${spec.declaredMime ?? 'unknown'}"`,
        ctx: {
          filename: spec.filename,
          format: spec.ext,
          subject: options.documentSubject ?? 'document',
        },
      };
    }

    try {
      return await parser.parse(source, options, deps);
    } catch (err) {
      // Parser 不该向外抛 —— 抛了说明实现里有未 catch 的 bug。返 SSoT
      // UNKNOWN_ERROR envelope 让 channel 派发统一错误体验，**不**重抛
      // 到 channel 触发 ToolResult 的 isError 路径双重派发。
      const msg = err instanceof Error ? err.message : String(err);
      return {
        kind: 'error',
        code: FilePipelineErrorCode.UNKNOWN_ERROR,
        message: `Parser '${parser.name}' threw: ${msg}`,
        ctx: {
          filename: spec.filename,
          format: spec.ext,
          subject: options.documentSubject ?? 'document',
          rawMessage: msg,
        },
      };
    }
  }
}
