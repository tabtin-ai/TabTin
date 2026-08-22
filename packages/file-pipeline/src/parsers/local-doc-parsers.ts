/**
 * Pdf/Docx/XlsxParser — 共享 `@tabtin/local-docparse` worker pool 调度
 *
 * **设计取舍**：这三种 parser 实现高度同构（都是"FileSource → mime →
 * parseLocalAttachment（worker dispatch）→ ResolveResult"），共用一个 helper
 * 函数。各自的 Parser class 只暴露 mime 路由 + subject 默认值。
 *
 * **不变量 #1 守住**：parser 内部调 `parseLocalAttachment`（W4 后已是
 * file-pipeline 的内部依赖，不再被 4 个胶水点直接 import）。channel 只调
 * `FileResolver.resolve`，不直接 import `parseLocalAttachment`。
 *
 * **W4 L42 收敛**：localDoc dedup 入口与 runDocParserTask 解耦——本 parser
 * 在 deps.runDocParserTask 缺省时返 SSoT `UNSUPPORTED_FORMAT` envelope，让
 * channel dedup 始终启用（channel 拿到 ResolveResult.kind === 'text' 才进
 * dedup，error / image 不进；解耦达成）。
 */

import {
  FilePipelineErrorCode,
} from '@tabtin/file-pipeline-errors';
import type {
  LocalDocParseResult,
  RunDocParserTask,
} from '@tabtin/local-docparse';
import type {
  FileParser,
  FileSource,
  ParseDeps,
  ParserMatchSpec,
  ResolveOptions,
  ResolveResult,
  TextResult,
  ErrorResult,
} from '../types.js';

// W4 测试可观察性：用 dynamic import 让 vitest `vi.mock('@tabtin/local-docparse')`
// 在 mock-hoist 时刻能跨包拦截到（顶层 static import 在 pnpm workspace symlink
// 路径下不被 vitest module graph hook 命中，hoist 失效——dynamic import 走
// require-on-call 路径，每次都过 hook，mock 100% 生效）。
async function getParseLocalAttachment(): Promise<
  typeof import('@tabtin/local-docparse').parseLocalAttachment
> {
  const mod = await import('@tabtin/local-docparse');
  return mod.parseLocalAttachment;
}

// mime → ext 映射（PDF / DOCX / XLSX 三类，对齐 local-docparse 内部）
const PDF_MIMES = new Set(['application/pdf', 'application/x-pdf']);
const DOCX_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const XLSX_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const PDF_EXT_TO_MIME = 'application/pdf';
const DOCX_EXT_TO_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_EXT_TO_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

interface LocalDocParserCfg {
  ext: string;
  mimeForSource: string;
  matchExts: ReadonlySet<string>;
  matchMimes: ReadonlySet<string>;
  parserName: 'pdf' | 'docx' | 'xlsx';
}

const PDF_CFG: LocalDocParserCfg = {
  ext: '.pdf',
  mimeForSource: PDF_EXT_TO_MIME,
  matchExts: new Set(['.pdf']),
  matchMimes: PDF_MIMES,
  parserName: 'pdf',
};
const DOCX_CFG: LocalDocParserCfg = {
  ext: '.docx',
  mimeForSource: DOCX_EXT_TO_MIME,
  matchExts: new Set(['.docx']),
  matchMimes: DOCX_MIMES,
  parserName: 'docx',
};
const XLSX_CFG: LocalDocParserCfg = {
  ext: '.xlsx',
  mimeForSource: XLSX_EXT_TO_MIME,
  matchExts: new Set(['.xlsx']),
  matchMimes: XLSX_MIMES,
  parserName: 'xlsx',
};

function sourceFilename(source: FileSource): string | undefined {
  if (source.kind === 'local-path') {
    const lastDot = source.path.lastIndexOf('/');
    return lastDot >= 0 ? source.path.slice(lastDot + 1) : source.path;
  }
  if (source.kind === 'oss-url') {
    return (
      source.filename ??
      (() => {
        try {
          return new URL(source.url).pathname.split('/').pop();
        } catch {
          return undefined;
        }
      })()
    );
  }
  return source.filename;
}

async function runLocalDocParser(
  source: FileSource,
  options: ResolveOptions,
  deps: ParseDeps,
  cfg: LocalDocParserCfg,
): Promise<ResolveResult> {
  // host 未注入 worker pool → 返 SSoT UNSUPPORTED_FORMAT envelope（与 W1 旧行为
  // 对齐）。让 channel 决定要不要走云端 fallback。
  const runDocParserTask: RunDocParserTask | undefined = deps.runDocParserTask;
  if (!runDocParserTask) {
    const filename = sourceFilename(source);
    return {
      kind: 'error',
      code: FilePipelineErrorCode.UNSUPPORTED_FORMAT,
      message: `Host did not provide a local doc parser (runDocParserTask) — cannot parse ${cfg.ext} files in this environment.`,
      ctx: {
        filename,
        format: cfg.ext,
        subject: options.documentSubject ?? 'document',
      },
    };
  }

  // memory-bytes：local-docparse 当前不支持 in-memory source，落到 tmp 后再走 path
  // mode。本期实现：先抛 unsupported（极少触发；future-work 加 memory-bytes 支持）。
  if (source.kind === 'memory-bytes') {
    const filename = sourceFilename(source);
    return {
      kind: 'error',
      code: FilePipelineErrorCode.INVALID_PARAMETER,
      message: `${cfg.parserName} parser does not currently accept memory-bytes source. Provide a local-path or oss-url.`,
      ctx: { filename, format: cfg.ext, subject: options.documentSubject ?? 'document' },
    };
  }

  // local-docparse 的 ParseLocalAttachmentInput 入参：path / url
  const parseSource =
    source.kind === 'local-path'
      ? { kind: 'path' as const, path: source.path }
      : { kind: 'url' as const, url: source.url };

  const filename = sourceFilename(source);
  const mimeToUse =
    source.kind === 'oss-url' && source.declaredMimeType
      ? source.declaredMimeType
      : cfg.mimeForSource;

  let result: LocalDocParseResult;
  try {
    const parseLocalAttachment = await getParseLocalAttachment();
    result = await parseLocalAttachment(
      {
        source: parseSource,
        mimeType: mimeToUse,
        filename,
        fileSizeBytes:
          source.kind === 'oss-url' ? source.sizeBytes : undefined,
      },
      {
        timeoutMs: options.timeoutMs,
        // size 上限由 channel 决定（不变量 #5）；channel 给 channelLimitBytes，
        // 这里换算成 MB 给 local-docparse；缺省（channel 未传）走 local-docparse
        // 的默认 50MB。
        maxFileSizeMb:
          typeof options.channelLimitBytes === 'number'
            ? Math.max(1, Math.floor(options.channelLimitBytes / (1024 * 1024)))
            : undefined,
        signal: options.signal,
      },
      { runDocParserTask, logger: options.logger },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      kind: 'error',
      code: FilePipelineErrorCode.UNKNOWN_ERROR,
      message: `Local parser '${cfg.parserName}' threw: ${msg}`,
      ctx: {
        filename,
        format: cfg.ext,
        subject: options.documentSubject ?? 'document',
        rawMessage: msg,
      },
    };
  }

  if (!result.success) {
    const errResult: ErrorResult = {
      kind: 'error',
      code: result.errorClass,
      message: result.message,
      ctx: {
        filename,
        format: cfg.ext,
        subject: options.documentSubject ?? 'document',
        rawMessage: result.message,
        timeoutMs: options.timeoutMs,
        limitBytes: options.channelLimitBytes,
      },
    };
    return errResult;
  }

  const text: TextResult = {
    kind: 'text',
    text: result.text,
    // result.mimeType 在历史 worker 实现里可能 undefined（如 mock 测试场景 +
    // 旧 worker 不填该字段）；回退到 cfg.mimeForSource（确定性的 mime 字面值，
    // 与 cfg.matchMimes 同源），让下游消费方拿到稳定字段（W4 SSoT 化）。
    mimeType: result.mimeType ?? cfg.mimeForSource,
    fileSizeBytes: result.fileSizeBytes,
    durationMs: result.durationMs,
    pages: result.pages,
    isScanned: result.isScanned,
    qualityScore: result.qualityScore,
  };
  return text;
}

export class PdfParser implements FileParser {
  readonly name = 'pdf';
  matches(spec: ParserMatchSpec): boolean {
    return PDF_CFG.matchExts.has(spec.ext) || (!!spec.mime && PDF_CFG.matchMimes.has(spec.mime.toLowerCase()));
  }
  parse(source: FileSource, options: ResolveOptions, deps: ParseDeps): Promise<ResolveResult> {
    return runLocalDocParser(source, options, deps, PDF_CFG);
  }
}

export class DocxParser implements FileParser {
  readonly name = 'docx';
  matches(spec: ParserMatchSpec): boolean {
    return DOCX_CFG.matchExts.has(spec.ext) || (!!spec.mime && DOCX_CFG.matchMimes.has(spec.mime.toLowerCase()));
  }
  parse(source: FileSource, options: ResolveOptions, deps: ParseDeps): Promise<ResolveResult> {
    return runLocalDocParser(source, options, deps, DOCX_CFG);
  }
}

export class XlsxParser implements FileParser {
  readonly name = 'xlsx';
  matches(spec: ParserMatchSpec): boolean {
    return XLSX_CFG.matchExts.has(spec.ext) || (!!spec.mime && XLSX_CFG.matchMimes.has(spec.mime.toLowerCase()));
  }
  parse(source: FileSource, options: ResolveOptions, deps: ParseDeps): Promise<ResolveResult> {
    return runLocalDocParser(source, options, deps, XLSX_CFG);
  }
}
