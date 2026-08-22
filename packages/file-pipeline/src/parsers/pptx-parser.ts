/**
 * PptxParser — PPTX 走临时通道（W3 cloud temp parse）
 *
 * **设计要点**：
 *   - 本地不支持（python-pptx 是 Python lib，不在 Node host）
 *   - cloud 走 W3 的 temp-upload + parse-sync（临时通道，1h auto-cleanup）
 *   - magic bytes 校验在 parser 内做（PPTX ZIP magic / OLE Compound 加密）
 *
 * **不变量 #1**：parser 内部调 `deps.runTempPptxParse`（host 注入），不直接持
 * OSS client。
 *
 * **不变量 #4**：扩展名 .pptx 命中后，先 read 文件 head 8 字节做 magic bytes
 * 二次校验，防 OLE 加密 PPTX 误归 UNSUPPORTED_FORMAT（W3 Review 1 H1）。
 *
 * **L58 改名**：旧 `runTempPptxParseWrapper` → 新 `PptxParser.parse`，与
 * `Pdf/Docx/XlsxParser` 风格对齐。
 *
 * **L63 收**：magic head 改用 `Buffer.alloc(8)`（旧 `Buffer.alloc(16)` 浪费）。
 */

import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { FilePipelineErrorCode } from '@tabtin/file-pipeline-errors';
import type {
  FileParser,
  FileSource,
  ParseDeps,
  ParserMatchSpec,
  ResolveOptions,
  ResolveResult,
  TextResult,
  TextChunk,
} from '../types.js';

// W3 magic bytes：
//   - 50 4B 03 04 (PK\x03\x04) → 真 PPTX (ZIP 容器)
//   - D0 CF 11 E0 (Compound Document) → 加密 PPTX 或老 .ppt OLE 容器
const PPTX_MAGIC_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_COMPOUND_MAGIC_BYTES = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);

const PPTX_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);
const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

type PptxMagicKind = 'pptx_zip' | 'ole_compound' | 'unknown';

function detectPptxMagicKind(buf: Buffer): PptxMagicKind {
  if (buf.length < 4) return 'unknown';
  const head = buf.subarray(0, 4);
  if (head.equals(PPTX_MAGIC_BYTES)) return 'pptx_zip';
  if (head.equals(OLE_COMPOUND_MAGIC_BYTES)) return 'ole_compound';
  return 'unknown';
}

export class PptxParser implements FileParser {
  readonly name = 'pptx';

  matches(spec: ParserMatchSpec): boolean {
    if (spec.ext === '.pptx') return true;
    if (spec.mime && PPTX_MIMES.has(spec.mime.toLowerCase())) return true;
    return false;
  }

  async parse(
    source: FileSource,
    options: ResolveOptions,
    deps: ParseDeps,
  ): Promise<ResolveResult> {
    // PptxParser 当前只支持 local-path（W3 临时通道是 host 把本地文件 PUT 到 OSS
    // → parse-sync）。oss-url 走持久通道由 Host.fetchCloudSummary 处理（不进
    // FileResolver；那是 backend DocParse 入库后的 summary endpoint）。
    if (source.kind !== 'local-path') {
      const filename =
        source.kind === 'oss-url'
          ? source.filename ?? source.url
          : source.filename ?? '<bytes>';
      return {
        kind: 'error',
        code: FilePipelineErrorCode.INVALID_PARAMETER,
        message: `PptxParser only supports local-path source (got: ${source.kind}). Persistent-channel PPT uploads should go through Host.fetchCloudSummary instead.`,
        ctx: {
          filename,
          format: '.pptx',
          subject: 'presentation',
        },
      };
    }

    const filename = path.basename(source.path);

    // host 未注入临时通道实现 → 返 UNSUPPORTED_FORMAT（mobile / 测试 / 老 host
    // 兼容）。mobile 用户走持久通道（chat 拖文件）拿到更深 RAG 解析。
    if (!deps.runTempPptxParse) {
      return {
        kind: 'error',
        code: FilePipelineErrorCode.UNSUPPORTED_FORMAT,
        message: `Host did not inject runTempPptxParse — PPTX cannot be parsed via the temporary channel in this environment.`,
        ctx: {
          filename,
          format: '.pptx',
          subject: 'presentation',
        },
      };
    }

    // ── 1. magic bytes 校验（L63 用 Buffer.alloc(8)）─────────────────
    let headBuf: Buffer;
    try {
      const handle = await fsPromises.open(source.path, 'r');
      try {
        headBuf = Buffer.alloc(8);
        await handle.read(headBuf, 0, 8, 0);
      } finally {
        await handle.close();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        kind: 'error',
        code: FilePipelineErrorCode.FILE_NOT_FOUND,
        message: msg,
        ctx: { filename, format: '.pptx', subject: 'presentation', rawMessage: msg },
      };
    }

    const magicKind = detectPptxMagicKind(headBuf);
    if (magicKind === 'ole_compound') {
      // W3 Review 1 H1：D0 CF 11 E0 = OLE Compound File（加密 PPTX 或老 .ppt）
      return {
        kind: 'error',
        code: FilePipelineErrorCode.ENCRYPTED,
        message:
          `File has .pptx extension but content uses OLE Compound File container ` +
          `(D0 CF 11 E0). This typically means the PPTX is password-encrypted, ` +
          `or it is a legacy .ppt format saved with .pptx extension.`,
        ctx: {
          filename,
          format: '.pptx',
          subject: 'presentation',
          rawMessage:
            `File has .pptx extension but content uses OLE Compound File container ` +
            `(D0 CF 11 E0). This typically means the PPTX is password-encrypted, ` +
            `or it is a legacy .ppt format saved with .pptx extension. ` +
            `Re-exporting the file will not bypass encryption.`,
        },
      };
    }
    if (magicKind === 'unknown') {
      return {
        kind: 'error',
        code: FilePipelineErrorCode.UNSUPPORTED_FORMAT,
        message: `File has .pptx extension but content does not start with PPTX magic bytes (50 4B 03 04) nor OLE Compound File header (D0 CF 11 E0).`,
        ctx: {
          filename,
          format: '.pptx',
          subject: 'presentation',
          // **W5 L31（2026-05-14）**：用结构化 failureMode='magic_mismatch' +
          // subject='presentation' 替代 SSoT format.ts rawMessage 字面值前缀检测
          // （历史："does not start with PPTX magic bytes" 字面值跨包字符串契约）
          failureMode: 'magic_mismatch',
          rawMessage:
            `Detected magic bytes do not match ZIP container (50 4B 03 04) nor OLE Compound File ` +
            `header (D0 CF 11 E0). The file may be corrupted, truncated, mislabeled, or actually ` +
            `a different binary format.`,
        },
      };
    }

    // ── 2. 调 host 注入的临时通道（presign + PUT + parse-sync 三段）──
    let result;
    try {
      result = await deps.runTempPptxParse(source.path, PPTX_MIME, {
        timeoutMs: options.timeoutMs ?? 30_000, // PPTX 临时通道默认 30s（W3）
        signal: options.signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isAbort = options.signal?.aborted === true || /abort/i.test(msg);
      const code = isAbort
        ? FilePipelineErrorCode.USER_ABORTED
        : FilePipelineErrorCode.UNKNOWN_ERROR;
      return {
        kind: 'error',
        code,
        message: msg,
        ctx: { filename, format: '.pptx', subject: 'presentation', rawMessage: msg },
      };
    }

    if (!result.success) {
      return {
        kind: 'error',
        code: result.errorClass,
        message: result.message,
        ctx: {
          filename,
          format: '.pptx',
          subject: 'presentation',
          rawMessage: result.message,
          timeoutMs: options.timeoutMs,
          limitBytes: options.channelLimitBytes,
        },
      };
    }

    // ── 3. 成功路径：返结构化 TextResult（含 chunks） ────────────────
    const chunks: TextChunk[] = result.chunks.map((c) => ({
      page: c.page,
      type: (c.type as TextChunk['type']) ?? 'paragraph',
      content: c.content,
      heading_level: c.heading_level,
    }));
    const text = renderPptxChunksAsText(chunks);
    const textResult: TextResult = {
      kind: 'text',
      text,
      mimeType: PPTX_MIME,
      fileSizeBytes: result.fileSizeBytes,
      durationMs: result.durationMs,
      chunks,
      title: result.title ?? null,
      slides: result.pages,
      viaTempChannel: true,
    };
    return textResult;
  }
}

/**
 * 把 `TextChunk[]` 渲染成多行明文（按 page 分组 + slide 分隔符 + markdown
 * heading + table + note quote）。
 *
 * **L49 / L61 收**：本函数现在是 channel 渲染层的共享 helper（channel 端
 * adapter 不再各自维护 renderPptxChunksAsText 重复实现）。
 */
export function renderPptxChunksAsText(chunks: TextChunk[]): string {
  if (chunks.length === 0) {
    return '(no extractable text — presentation may contain only images, or all slides are blank)';
  }
  const out: string[] = [];
  let currentPage = -1;
  for (const c of chunks) {
    if (c.page !== currentPage) {
      currentPage = c.page;
      if (out.length > 0) out.push('');
      out.push(`--- Slide ${currentPage} ---`);
      out.push('');
    }
    const content = c.content ?? '';
    if (c.type === 'heading') {
      const level = Math.max(1, Math.min(6, c.heading_level ?? 1));
      out.push(`${'#'.repeat(level)} ${content}`);
      out.push('');
    } else if (c.type === 'note') {
      const quoted = content
        .split('\n')
        .map((line) => (line.length > 0 ? `> ${line}` : '>'))
        .join('\n');
      out.push(quoted);
      out.push('');
    } else if (c.type === 'table') {
      out.push(content);
      out.push('');
    } else {
      out.push(content);
      out.push('');
    }
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}
