/**
 * @tabtin/file-pipeline — 抽象层类型定义
 *
 * 三大概念：
 *   1. `FileSource` —— 通道传给 FileResolver 的字节来源。local-path（read_file
 *      工具临时通道）/ oss-url（持久通道 chat 拖文件已上 OSS）/ memory-bytes
 *      （罕见，预留给后续 streaming-upload 场景）。
 *   2. `ResolveResult` —— FileResolver 给通道的输出，三态：image / text / error。
 *      通道根据 kind 装配 ImageBlock / 拼接 banner+text / 派发 SSoT envelope。
 *   3. `FileParser` —— 每种 mime 一个 Parser，实现 `matches(spec)` 路由 +
 *      `parse(source, options, deps)` 真解析。
 *
 * 设计不变量（Review 必查；与总控 §九 对齐）：
 *   - parser 不知通道：纯字节进、结果出，不写 OSS、不写 message 历史
 *   - 错误从 W1 13 类 SSoT 派发（`@tabtin/file-pipeline-errors`），不引新错误码
 *   - size 决策归通道（parser 只负责"解析字节"，channel 决定"50MB 拒还是缩放"）
 *   - mime 优先扩展名 + 关键 magic bytes 兜底（FileResolver 内部跑 magic check）
 */

import type { FilePipelineErrorCode, FilePipelineFileSubject } from '@tabtin/file-pipeline-errors';
import type {
  FilePipelineFailureMode,
} from '@tabtin/file-pipeline-errors';

// ─── FileSource：通道→parser 的字节来源 ──────────────────────────────

export type FileSource =
  | {
      kind: 'local-path';
      /** 文件系统绝对路径（FileResolver 内部读字节）。 */
      path: string;
    }
  | {
      kind: 'oss-url';
      /** 已上传到 OSS 的 presigned URL（持久通道：chat 拖文件） */
      url: string;
      /** 文件名（用于扩展名识别 + 错误文案 filename 透传）。 */
      filename?: string;
      /** 后端已知 mime（持久通道 FileRecord.mime_type 透传）。 */
      declaredMimeType?: string;
      /** 后端已知体积（避免重复 stat / head request）。 */
      sizeBytes?: number;
    }
  | {
      kind: 'memory-bytes';
      /** 已在内存的字节（预留：未来 streaming-upload / paste-bytes 场景）。 */
      bytes: Buffer;
      filename?: string;
      declaredMimeType?: string;
    };

// ─── ResolveOptions：通道→parser 传的运行时参数 ────────────────────────

export interface ResolveOptions {
  /** 用户主动取消 / 上层超时（fetch 内部传 signal）。 */
  signal?: AbortSignal;
  /** 整体解析超时（毫秒）。parser 内部按 source kind 拆出"下载/解析"两段子预算。 */
  timeoutMs?: number;
  /**
   * **通道决策的大小硬上限（字节）**：parser 拿到字节后 > limit 即返 SSoT
   * `FILE_TOO_LARGE` envelope。
   *
   * **不变量 #5（size 上限按通道分）**：parser 不持有"hard limit"，由通道传入。
   *   - 临时通道 (read_file): 50MB（@tabtin/file-pipeline-errors 的
   *     `DEFAULT_CHANNEL_HARD_LIMIT_BYTES`）
   *   - 持久通道 (chat 拖文件): 50MB（与 OSS bucket 配置对齐；超过走 SSoT
   *     envelope 让用户走分页 / 后端长任务 RAG）
   */
  channelLimitBytes?: number;
  /**
   * 图像缩放触发阈值（字节）。> 该值走 sharp 长边 2048px JPEG 90% 缩放；
   * 缺省走 SSoT 软上限（5MB）。仅 ImageParser 消费。
   */
  imageResizeTriggerBytes?: number;
  /**
   * 文档场景细分（'document' / 'presentation'），仅在错误派发到 SSoT 时填
   * `subject` ctx 字段——让中文 i18n / LLM-facing suggestion 文案更精准
   * （L53 收敛）。
   */
  documentSubject?: FilePipelineFileSubject;
  /**
   * Logger（best-effort，省略 = no-op）。parser 内 debug-level 走它。
   */
  logger?: {
    debug?: (...args: unknown[]) => void;
  };
}

// ─── ParseDeps：宿主注入的能力 ───────────────────────────────────────

import type { RunDocParserTask } from '@tabtin/local-docparse';

/**
 * `runTempPptxParse` 与 `@tabtin/agent-runtime/tools` 的同名类型保持
 * **结构等价**（duck-typing 兼容）—— FileResolver / PptxParser 不直接
 * import agent-runtime（避免循环依赖），让 host 注入时 TS 推断匹配。
 *
 * 真实定义在 `apps/tabtin-electron/src/main/services/tempPptxParse.ts`
 * 与 `apps/tabtin-daemon/src/services/tempPptxParse.ts`（W3 临时通道）。
 */
export type RunTempPptxParse = (
  filePath: string,
  mimeType: string,
  options: {
    /** 整个流程超时 ms；host 应在 fetch / put / parse-sync 三步上分配。required。 */
    timeoutMs: number;
    /** 上游 abort 信号——立即 cancel pending 请求。 */
    signal?: AbortSignal;
  },
) => Promise<TempPptxParseResultLike>;

export type TempPptxParseChunkLike = {
  page: number;
  type: 'paragraph' | 'heading' | 'note' | 'image' | 'table' | string;
  content: string;
  heading_level?: number;
};

export type TempPptxParseResultLike =
  | {
      success: true;
      pages: number;
      title?: string | null;
      chunks: TempPptxParseChunkLike[];
      fileSizeBytes: number;
      durationMs: number;
    }
  | {
      success: false;
      errorClass: FilePipelineErrorCode;
      message: string;
      /** Failure 端 durationMs（host 测量，diagnostic / telemetry 用）。 */
      durationMs: number;
    };

export interface ParseDeps {
  /**
   * PDF/DOCX/XLSX worker pool 调度（由 host 装配点注入）。FileResolver 内部
   * 的 PdfParser/DocxParser/XlsxParser 共享该 dep。
   *
   * 不注入 → parser 返 `unsupported_format` SSoT envelope（host 未启用本地
   * 解析的合法降级，与 W1 旧行为对齐）。
   */
  runDocParserTask?: RunDocParserTask;
  /**
   * PPTX 临时通道 host 实现（W3 Electron / Daemon 各自有 isomorphic copy；
   * **L48 W4 收**：FileResolver 抽象后两端实现合并为同一 factory）。
   *
   * 不注入 → PptxParser 返 SSoT `UNSUPPORTED_FORMAT` envelope，引导走 chat
   * 持久通道（mobile / 测试 / 老 host 兼容）。
   */
  runTempPptxParse?: RunTempPptxParse;
}

// ─── ResolveResult：FileResolver 返通道的三态结果 ───────────────────────

export interface ImageBytesPayload {
  /** "字节"派 —— 临时通道 read_file 读图、memory-bytes 直接进 base64。 */
  source: 'bytes';
  mediaType: string;
  /** Base64（无 data: 前缀），channel 装 ImageBlock 用。 */
  base64: string;
  /** 解码后字节数（不是 base64 长度）。 */
  sizeBytes: number;
}

export interface ImageUrlPayload {
  /**
   * "URL pass-through"派 —— 持久通道 oss-url source，不下载不缩放，
   * channel 装 `ImageBlock {source: { type: 'url', url }}` 让 LLM provider
   * 自己抓。
   */
  source: 'url';
  url: string;
  mediaType: string;
}

export interface ImageResizeMeta {
  /** 原 mime（缩放前，给 LLM 显示"原 image/png" 用）。 */
  originalMediaType: string;
  /** 原字节数。 */
  originalBytes: number;
  /** 缩放后长边像素。 */
  longEdgePx: number;
  /** 实测耗时（性能基线 < 2s）。 */
  elapsedMs: number;
}

export interface ImageResult {
  kind: 'image';
  payload: ImageBytesPayload | ImageUrlPayload;
  /** 若发生缩放则填；纯 url pass-through / 小图原样返时为 undefined。 */
  resize?: ImageResizeMeta;
}

export interface TextChunk {
  /** 所在页/slide 编号（1-based）。 */
  page: number;
  type: 'paragraph' | 'heading' | 'note' | 'image' | 'table';
  content: string;
  heading_level?: number;
}

export interface TextResult {
  kind: 'text';
  /** 已渲染的多行明文（最终给 LLM 的字符串）。 */
  text: string;
  mimeType: string;
  fileSizeBytes: number;
  durationMs: number;
  /**
   * 结构化 chunks（仅 PPTX 等结构化文档有；PDF/DOCX/XLSX 是 flat text）。
   * channel 可选择按 chunks 再渲染（W4 收 L49 / L61：渲染共享 helper）。
   */
  chunks?: TextChunk[];
  /** 文档标题（PPTX 第一页 / DOCX heading）。 */
  title?: string | null;
  /** 页数（PDF）。 */
  pages?: number;
  /** Slide 数（PPTX）。 */
  slides?: number;
  /** Sheet 数（XLSX）。 */
  sheets?: number;
  /** PDF 扫描件标记（chars/page < 100 → true）。 */
  isScanned?: boolean;
  /** PDF 文本层质量（< 0.3 算乱码）。 */
  qualityScore?: number;
  /**
   * 走临时通道（W3 temp upload + parse-sync，1h auto-cleanup）—— channel
   * 据此渲染 banner "no persistence"；持久通道 fetchCloudSummary 不进
   * FileResolver，本字段始终 undefined。
   */
  viaTempChannel?: boolean;
}

export interface ResolveErrorContext {
  filename?: string;
  format?: string;
  subject?: FilePipelineFileSubject;
  failureMode?: FilePipelineFailureMode;
  resizeFailureCause?: 'sharp_unavailable' | 'sharp_decode_failed' | 'too_large_after_resize';
  actualBytes?: number;
  limitBytes?: number;
  timeoutMs?: number;
  url?: string;
  /**
   * 透传给 SSoT `formatFilePipelineError` 的 rawMessage（"underlying technical
   * error"，让 LLM hint 给精确诊断）。
   */
  rawMessage?: string;
}

export interface ErrorResult {
  kind: 'error';
  code: FilePipelineErrorCode;
  /** Raw 失败描述（用作 SSoT 派发的 rawMessage）。 */
  message: string;
  ctx: ResolveErrorContext;
}

export type ResolveResult = ImageResult | TextResult | ErrorResult;

// ─── FileParser 接口 ─────────────────────────────────────────────────

/**
 * 通道→FileResolver 调用 `matches({ ext, mime })` 路由到对应 parser。
 *
 * **W4 (2026-05-13) L19 落实**：FileResolver 内部跑 magic bytes 兜底，扩展名
 * 命中后再校验 magic，防 .png 后缀的 .exe 打穿。本接口的 `matches` 只看
 * 扩展名 + mime；magic 校验在 FileResolver 拼装阶段做。
 */
export interface ParserMatchSpec {
  /** 扩展名（含 dot，如 '.pdf'，小写）。FileSource 推断得来。 */
  ext: string;
  /** declaredMimeType（仅 oss-url / memory-bytes 有）。 */
  mime?: string;
}

export interface FileParser {
  /** Parser 名（diagnostic / logging 用，如 'pdf' / 'image' / 'epub'）。 */
  readonly name: string;
  /**
   * 该 parser 能否处理这个 spec。FileResolver 按 parsers 数组顺序调，第一个
   * 返 true 的 parser 接管。
   */
  matches(spec: ParserMatchSpec): boolean;
  /**
   * 解析字节、返结构化 ResolveResult。
   *
   * **不要在 parser 里**：
   *   - 拼 system-reminder banner（channel 负责）
   *   - 装配 ImageBlock / newMessages（channel 负责）
   *   - 写 dedup state / messages 历史（channel 负责）
   *   - 调 OSS upload / Django backend（PptxParser 例外：临时通道 host
   *     注入 deps.runTempPptxParse，parser 调它，但不持有 OSS client）
   */
  parse(
    source: FileSource,
    options: ResolveOptions,
    deps: ParseDeps,
  ): Promise<ResolveResult>;
}
