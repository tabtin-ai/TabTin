/**
 * EpubParser — EPUB 电子书解析（验证 W4 抽象成本 < 100 行）
 *
 * **W4 北极星**：新加任意 mime 只动 parser 层、4 个胶水点 0 改动。EpubParser
 * 是该抽象成本的活验证——本文件 + EpubParser 注册行 = 加入新 mime 的全部成本。
 *
 * **简化实现**：EPUB 是 ZIP + META-INF/container.xml + OPF + XHTML/HTML 章节。
 * 本期实现走"轻量纯 JS 路径"（Node 原生 `node:zlib` + 手工 XML strip）：
 *   - magic bytes：PK\x03\x04（与 PPTX 同款 ZIP 容器，但 mimetype 文件区分）
 *   - 解 ZIP：用 Node 自带 `zlib.inflateRaw` + 手工 Central Directory 解析
 *     （避免引入 fflate / unzipper 等额外依赖）
 *   - 文本提取：strip XHTML tags 为纯文本，按 spine 顺序拼接
 *
 * **设计取舍**：
 *   - 不引 epub lib 依赖：W4 的目的是验证抽象，不是产品级 EPUB 支持
 *   - 不验 OPF / spine 顺序的复杂度：按 ZIP entry 顺序读 .xhtml/.html/.htm
 *     （足够 LLM 抓全文；真正的产品级 EPUB 支持留 W5+）
 *
 * **抽象成本验证**：本文件含注释 < 200 行（unzip 加密复杂度高占大头），核心
 * parse 逻辑 < 80 行。channel（tabcode-adapter / Host.resolveOneAttachment）
 * 与 FileResolver 注册：0 行改动。
 */

import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { inflateRaw } from 'node:zlib';
import { FilePipelineErrorCode } from '@tabtin/file-pipeline-errors';
import type {
  FileParser,
  FileSource,
  ParseDeps,
  ParserMatchSpec,
  ResolveOptions,
  ResolveResult,
  TextResult,
} from '../types.js';

const EPUB_MIME = 'application/epub+zip';
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function inflateAsync(buf: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    inflateRaw(buf, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

/**
 * 读 ZIP Central Directory，返 entries{ name, offset, size, compressedSize, method }
 *
 * ZIP 格式参考：https://en.wikipedia.org/wiki/ZIP_(file_format)
 * 这里只支持 method=0 (stored) 和 method=8 (deflate) —— 99% EPUB 文件用这两种。
 */
interface ZipEntry {
  name: string;
  offset: number;
  size: number;
  compressedSize: number;
  method: number;
}

function parseZipCentralDirectory(buf: Buffer): ZipEntry[] {
  // 找 EOCD（End of Central Directory）：signature 0x06054b50，最后 22-65557 字节
  let eocdOffset = -1;
  const minStart = Math.max(0, buf.length - 65557 - 22);
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('EPUB ZIP: EOCD record not found');

  const cdEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < cdEntries; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) {
      throw new Error(`EPUB ZIP: central directory entry ${i} signature mismatch`);
    }
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({
      name,
      offset: localHeaderOffset,
      size: uncompressedSize,
      compressedSize,
      method,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readZipEntry(buf: Buffer, entry: ZipEntry): Promise<Buffer> {
  // 跳过 local file header：signature(4) + 26 bytes + name + extra
  if (buf.readUInt32LE(entry.offset) !== 0x04034b50) {
    throw new Error(`EPUB ZIP: local header signature mismatch at offset ${entry.offset}`);
  }
  const nameLen = buf.readUInt16LE(entry.offset + 26);
  const extraLen = buf.readUInt16LE(entry.offset + 28);
  const dataStart = entry.offset + 30 + nameLen + extraLen;
  const compressed = buf.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(compressed); // stored
  if (entry.method === 8) return inflateAsync(compressed); // deflate
  throw new Error(`EPUB ZIP: unsupported compression method ${entry.method} for entry "${entry.name}"`);
}

/** 极简 XHTML strip：去 <script>/<style> 块 + 其它标签，保留文本 + 段落换行 */
function stripXhtml(xhtml: string): string {
  return xhtml
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(?:p|div|h[1-6]|li|br|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export class EpubParser implements FileParser {
  readonly name = 'epub';

  matches(spec: ParserMatchSpec): boolean {
    if (spec.ext === '.epub') return true;
    if (spec.mime && spec.mime.toLowerCase() === EPUB_MIME) return true;
    return false;
  }

  async parse(
    source: FileSource,
    options: ResolveOptions,
    _deps: ParseDeps,
  ): Promise<ResolveResult> {
    if (source.kind !== 'local-path') {
      return {
        kind: 'error',
        code: FilePipelineErrorCode.INVALID_PARAMETER,
        message: `EpubParser only supports local-path source (got: ${source.kind}).`,
        ctx: {
          filename: source.kind === 'oss-url' ? source.filename : source.filename,
          format: '.epub',
          subject: options.documentSubject ?? 'document',
        },
      };
    }
    const filename = path.basename(source.path);
    const startMs = Date.now();

    let buf: Buffer;
    try {
      buf = await fsPromises.readFile(source.path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        kind: 'error',
        code: FilePipelineErrorCode.FILE_NOT_FOUND,
        message: msg,
        ctx: { filename, format: '.epub', subject: 'document', rawMessage: msg },
      };
    }

    // channel-level size check（不变量 #5）
    if (typeof options.channelLimitBytes === 'number' && buf.length > options.channelLimitBytes) {
      return {
        kind: 'error',
        code: FilePipelineErrorCode.FILE_TOO_LARGE,
        message: `EPUB exceeds channel hard size limit.`,
        ctx: {
          filename,
          format: '.epub',
          subject: 'document',
          actualBytes: buf.length,
          limitBytes: options.channelLimitBytes,
        },
      };
    }

    // magic
    if (buf.length < 4 || !buf.subarray(0, 4).equals(ZIP_MAGIC)) {
      return {
        kind: 'error',
        code: FilePipelineErrorCode.UNSUPPORTED_FORMAT,
        message: `File has .epub extension but content does not start with ZIP magic bytes (50 4B 03 04).`,
        ctx: {
          filename,
          format: '.epub',
          subject: 'document',
          rawMessage: `EPUB file content does not start with ZIP magic bytes — file may be corrupted or mislabeled.`,
        },
      };
    }

    try {
      const entries = parseZipCentralDirectory(buf);
      const contentEntries = entries.filter((e) =>
        /\.(xhtml|html|htm)$/i.test(e.name),
      );
      // 简单按 entry name 字典序读（多数 EPUB chapter 文件名 chap01.xhtml 等已排序）
      contentEntries.sort((a, b) => a.name.localeCompare(b.name));

      const parts: string[] = [];
      for (const entry of contentEntries) {
        const data = await readZipEntry(buf, entry);
        const xhtml = data.toString('utf8');
        const stripped = stripXhtml(xhtml);
        if (stripped.length > 0) {
          parts.push(`--- ${entry.name} ---\n${stripped}`);
        }
      }
      const text = parts.join('\n\n');
      const textResult: TextResult = {
        kind: 'text',
        text:
          text.length > 0
            ? text
            : '(no extractable text — EPUB may contain only images or unsupported chapter formats)',
        mimeType: EPUB_MIME,
        fileSizeBytes: buf.length,
        durationMs: Date.now() - startMs,
        pages: contentEntries.length,
      };
      return textResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        kind: 'error',
        code: FilePipelineErrorCode.CORRUPTED,
        message: msg,
        ctx: { filename, format: '.epub', subject: 'document', rawMessage: msg },
      };
    }
  }
}
