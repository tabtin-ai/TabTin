/**
 * TabCode tools — file operations, code search, diagnostics
 *
 * These tools run in the Electron main process and provide
 * file system access for the LLM agent (供 LLM agent 使用的文件系统工具).
 *
 * All tools accept an optional `_workspace_root` field (auto-injected
 * by the backend from agent state). When a user-provided path is
 * relative, it is resolved against `_workspace_root` instead of
 * `process.cwd()`.
 */

import type { AgentTool } from '../../types';
import { standardizeLegacyResult } from '../../utils/tool-output';
import { ToolErrorCode } from '../../types/errors';
// 文件并发安全 Wave 2（2026-05-13）：TOCTOU 二次校验 hook 协议 —— adapter 在
// enrichWithWorkspaceRoot 注入 input 内部协议字段 `_validate_before_write`，
// fileEditTool / fileWriteTool 写盘前最后一刻同步调用，撞 stale 时 hook throw
// ToolStaleReadError → catch 后构造跟入口校验「字节一致」的 envelope return。
// Wave 3 整体收尾 L-32：导入 ValidateBeforeWriteHook 类型契约，跟 agent-runtime
// 一侧注入用同款类型签名 —— 未来 hook signature 改动时 TS 双侧报错强制对齐。
import {
  ToolStaleReadError,
  type ValidateBeforeWriteHook,
} from '../../utils/tool-stale-read-error';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import jschardet from 'jschardet';
import iconv from 'iconv-lite';
import { atomicWriteFile } from '@tabtin/terminal-core';
// **2026-05-13**：原引用 `getHomeTabtinPath` 用于 trash 备份目录，trash 退役后
// 本文件无其他消费方，直接删除导入避免 lint dead-import 告警。其他模块用
// trash 子目录的请直接 import `@tabtin/shared/storage-paths`，本工具不再持有。
import { matchSensitivePath } from '@tabtin/terminal-core';
import {
  checkHardlinePath,
  checkSensitivePath,
  isPathInAllowedRoots,
} from '@tabtin/security-policy';
import { findActualString } from './edit-fuzzy';
import {
  convertToLineEnding,
  detectLineEnding,
  hasBOM,
  normalizeLineEndings,
  restoreBOM,
  stripBOM,
} from './edit-line-ending';
import { getSnippetForPatch } from './edit-snippet';

/** Electron packaged：asar 内路径不能 spawn，须映射到 asarUnpack 目录。 */
const APP_ASAR_SEGMENT_RE = /app\.asar(?=[\\/])/;
const requireFromThisModule = createRequire(import.meta.url);

// ── ripgrep safety constants (RP-014/015/016/017/019) ──
const MAX_RIPGREP_CONCURRENT = 4;
const MAX_CONTEXT_LINES = 20;
const MAX_RESULTS_DEFAULT = 500;
const MAX_RESULTS_CEILING = 2000;
/** grep_search 真实支持的 output_mode；与 schema.enum / execute 分支同源。 */
export const GREP_OUTPUT_MODES = ['content', 'files_with_matches', 'count'] as const;
const VCS_DIRECTORIES_TO_EXCLUDE = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'];
const GLOB_DIRECTORIES_TO_EXCLUDE = ['node_modules', ...VCS_DIRECTORIES_TO_EXCLUDE];
const GLOB_FILES_TO_EXCLUDE = ['.DS_Store', 'Thumbs.db'];
// T2-C8 (2026-05-12)：原 `MAX_OUTPUT_CHARS = 100_000` 已废弃。
// grep 输出截断职责完全收敛到 adapter 层 `applyHeadLimit`（带显式分页提示），
// 跟行业 grep 工具共识对齐。删常量避免 dead code。

// ── read_file 大文件保护 ──
const MAX_TEXT_FILE_BYTES = 10 * 1024 * 1024;   // 10MB

/**
 * **W2（2026-05-13）image 硬上限 = 50MB**（与 file-pipeline-errors SSoT
 * `MAX_IMAGE_FILE_BYTES_HARD` + `image-resize.ts` 对齐）。
 *
 * **历史变更**：旧版本是 20MB 硬拒（既是软也是硬，撞上就拒）。W2 改造为
 * 软上限 5MB 的旧自动缩放路径已退役；非文本文件不再由 read_file 内联
 * bytes。当前只保留 50MB 硬上限，命中图片扩展名时 action-tools 返回
 * `non_text_file` 元数据，adapter 再交给 host fileMaterializer。
 *
 * **D1 不留兼容**：旧 `MAX_IMAGE_FILE_BYTES = 20MB` 常量整体重命名 + 数值
 * 改 50MB；不留 alias、不写 fallback。所有调用方（test / lint / dogfood
 * 脚本）按新名 + 新值同步刷新。
 */
const MAX_IMAGE_FILE_BYTES_HARD = 50 * 1024 * 1024;  // 50MB（W2 硬上限）

const BLOCKED_DEVICE_PATHS = new Set([
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/full',
  '/dev/stdin',
  '/dev/tty',
  '/dev/console',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/fd/0',
  '/dev/fd/1',
  '/dev/fd/2',
]);

const REJECT_BINARY_EXTS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.wasm', '.class', '.pyc', '.pyd',
  '.o', '.obj', '.a', '.lib', '.bin',
]);

const CONVERTIBLE_BINARY_EXTS = new Set([
  '.pdf', '.docx', '.xlsx', '.pptx',
  // W4 (2026-05-13)：.epub 加入 —— 验证 file-pipeline 抽象层的"加新格式 0
  // 改 channel"成本。这里加一行声明 .epub 是"可转换二进制（非真二进制 / 非
  // 媒体）"，让 action-tools 返 unsupported_operation 让 adapter 委托
  // FileResolver → EpubParser 解析。**这一行不算 channel 改动**——它是
  // mime 类型登记（action-tools 内部白名单），未来加 .markdown / .numbers
  // 也要在这里加。真正的 channel（tabcode-adapter / Host.resolveOneAttachment）
  // 已经统一委托 FileResolver，不再 case-by-case 路由。
  '.epub',
]);

const MEDIA_BINARY_EXTS = new Set([
  '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.flac', '.wav',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.sqlite', '.db', '.mdb', '.ico',
  '.zip', '.tar', '.gz', '.7z', '.rar',
]);

function hasBinaryContent(buf: Buffer): boolean {
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return false;
  if (buf.length >= 2 && ((buf[0] === 0xFF && buf[1] === 0xFE) || (buf[0] === 0xFE && buf[1] === 0xFF))) return false;
  const checkLen = Math.min(8000, buf.length);
  for (let i = 0; i < checkLen; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function decodedTextLooksPrintable(text: string): boolean {
  if (!text) return false;
  let printable = 0;
  let controls = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\t' || ch === '\n' || ch === '\r' || code >= 0x20) {
      printable++;
    } else {
      controls++;
    }
  }
  return printable > 0 && controls / (printable + controls) < 0.05;
}

function isLikelyEncodedText(sample: Buffer, encoding: string): boolean {
  try {
    return decodedTextLooksPrintable(iconv.decode(sample, encoding));
  } catch {
    return false;
  }
}

// ── 编码识别 ──
//
// **A1 (2026-05-12)**：原 `hasBinaryContent` 用 null byte 启发式拒绝二进制
// 文件，但 UTF-16 文本里 ASCII 字符高位是 0x00 会被误判，GBK / Big5 / Shift-JIS
// 等无 BOM 编码也被强制 utf8 解析后乱码。新增 `sniffEncodingOrBinary` 在 binary
// 检测之前先尝试编码识别——已知编码（含支持解码）就跳过 null byte 检测，未识
// 别才走 binary 启发式。BOM 优先级最高，没 BOM 才用 jschardet 概率推断。
//
// jschardet 的 confidence 阈值取 0.85：太低（如 0.5）会把短英文文本误判成
// windows-1252 / TIS-620 等小语种编码导致乱码；太高（如 0.95）UTF-8 中文常
// 见 confidence 0.85-0.99 容易漏判。0.85 是抓住典型 GBK / Big5 / UTF-16 同时
// 不污染 ASCII / UTF-8 的甜区。
const ENCODING_CONFIDENCE_THRESHOLD = 0.85;

// **iconv-lite 别名归一化映射**：jschardet 给出的 encoding name 跟 iconv-lite
// 期望的 alias 不完全一致，加一层映射统一。键全用小写。值是 iconv-lite 接受
// 的标准 alias（参考 iconv-lite/encodings/index.js）。
const JSCHARDET_TO_ICONV_ENCODING: Record<string, string> = {
  'utf-8': 'utf-8',
  'utf-16le': 'utf-16le',
  'utf-16be': 'utf-16be',
  'utf16le': 'utf-16le',
  'utf16be': 'utf-16be',
  'gb2312': 'gbk',          // GB2312 是 GBK 子集，统一用 GBK 解
  'gbk': 'gbk',
  'gb18030': 'gb18030',
  'big5': 'big5',
  'shift_jis': 'shift_jis',
  'shift-jis': 'shift_jis',
  'sjis': 'shift_jis',
  'euc-jp': 'euc-jp',
  'euc-kr': 'euc-kr',
  'koi8-r': 'koi8-r',
  'koi8-u': 'koi8-u',
  'iso-8859-1': 'iso-8859-1',
  'iso-8859-2': 'iso-8859-2',
  'iso-8859-5': 'iso-8859-5',
  'iso-8859-7': 'iso-8859-7',
  'iso-8859-8': 'iso-8859-8',
  'iso-8859-9': 'iso-8859-9',
  'windows-1250': 'windows-1250',
  'windows-1251': 'windows-1251',
  'windows-1252': 'windows-1252',
  'windows-1253': 'windows-1253',
  'windows-1254': 'windows-1254',
  'windows-1255': 'windows-1255',
  'windows-1256': 'windows-1256',
  'tis-620': 'tis-620',
  'ascii': 'utf-8',         // ASCII 是 UTF-8 子集，统一用 UTF-8 路径
};

/**
 * 嗅探文件头判断编码或二进制状态。
 *
 * 返回值有四种：
 * - `{ kind: 'binary' }`：嗅不出编码且含 null byte → 真二进制
 * - `{ kind: 'utf8' }`：含 UTF-8 BOM 或 jschardet 识别到 UTF-8 / ASCII，
 *   或嗅不出编码且无 null byte（默认按 UTF-8 处理）
 * - `{ kind: 'encoded', encoding: '<iconv name>' }`：已知非 UTF-8 编码
 * - `{ kind: 'unknown' }`：嗅探到编码但 iconv 不支持（极少见，按 UTF-8 兜底）
 *
 * BOM 优先级最高（直接信，不查 jschardet）；没 BOM 才用 jschardet 概率推断。
 */
function sniffEncodingOrBinary(
  buf: Buffer,
): { kind: 'binary' } | { kind: 'utf8' } | { kind: 'encoded'; encoding: string } {
  // BOM 检测
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return { kind: 'utf8' };
  }
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    return { kind: 'encoded', encoding: 'utf-16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    return { kind: 'encoded', encoding: 'utf-16be' };
  }

  // 没 BOM → jschardet 嗅探
  // 取前 4KB 即可，jschardet 自身有内部采样，更大的 buffer 不提升精度
  const sampleSize = Math.min(4096, buf.length);
  const sample = sampleSize === buf.length ? buf : buf.subarray(0, sampleSize);

  let detected: { encoding: string; confidence: number } | null = null;
  try {
    const result = jschardet.detect(sample);
    if (result && typeof result.encoding === 'string' && typeof result.confidence === 'number') {
      detected = { encoding: result.encoding, confidence: result.confidence };
    }
  } catch {
    // jschardet 抛错（极少见），按未识别处理
  }

  if (detected && detected.confidence >= ENCODING_CONFIDENCE_THRESHOLD) {
    const normalized = detected.encoding.toLowerCase();
    const iconvName = resolveJschardetEncoding(normalized);
    if (iconvName === 'utf-8') {
      if (hasBinaryContent(sample)) {
        return { kind: 'binary' };
      }
      return { kind: 'utf8' };
    }
    if (iconvName) {
      if (hasBinaryContent(sample) && !isLikelyEncodedText(sample, iconvName)) {
        return { kind: 'binary' };
      }
      return { kind: 'encoded', encoding: iconvName };
    }
  }

  // 没识别出已知编码 → 跑 binary 检测
  if (hasBinaryContent(buf)) {
    return { kind: 'binary' };
  }
  return { kind: 'utf8' };
}

function resolveJschardetEncoding(name: string): string | null {
  const direct = JSCHARDET_TO_ICONV_ENCODING[name];
  if (direct) return direct;
  const lower = name.toLowerCase().replace(/_/g, '-');
  return JSCHARDET_TO_ICONV_ENCODING[lower] ?? null;
}

function isBlockedDevicePath(filePath: string): boolean {
  if (BLOCKED_DEVICE_PATHS.has(filePath)) return true;
  return filePath.startsWith('/proc/') && (
    filePath.endsWith('/fd/0') ||
    filePath.endsWith('/fd/1') ||
    filePath.endsWith('/fd/2')
  );
}

function normalizeReadText(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

async function findSimilarFile(filePath: string): Promise<string | undefined> {
  try {
    const dir = path.dirname(filePath);
    const fileBaseName = path.basename(filePath, path.extname(filePath));
    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
    const match = entries.find((entry) => (
      entry.isFile() &&
      path.basename(entry.name, path.extname(entry.name)) === fileBaseName &&
      path.join(dir, entry.name) !== filePath
    ));
    return match?.name;
  } catch {
    return undefined;
  }
}

/**
 * **B1 (2026-05-12)** macOS 截图 thin-space 兼容：
 *
 * macOS 截图文件名 AM/PM 前的空格在不同系统版本可能是普通空格 (U+0020)
 * 或 NARROW NO-BREAK SPACE (U+202F)。LLM 看到一种格式抄进 `read_file` 时
 * 实际盘上是另一种 → ENOENT。这里在两者间互换重试一次，让"截图 at 3.45.12 PM.png"
 * 和"截图 at 3.45.12\u202FPM.png"互通。
 *
 * 文件名不含 `\u202F` 和 `(\d{1,2}\.\d{1,2}\.\d{1,2})` 同时出现的特征
 * 时返回 undefined，避免误重试普通文件。
 */
function getAlternateScreenshotPath(filePath: string): string | undefined {
  const NARROW_NBSP = '\u202F';
  const REGULAR_SPACE = ' ';
  // 必须含 H.MM.SS 这种时间戳模式才认是截图
  if (!/\d{1,2}\.\d{1,2}\.\d{1,2}/.test(filePath)) return undefined;
  if (filePath.includes(NARROW_NBSP)) {
    return filePath.replace(new RegExp(NARROW_NBSP, 'g'), REGULAR_SPACE);
  }
  // 普通空格 → narrow nbsp 仅替换 AM/PM 前的那一个空格（避免误改路径里其它空格）
  if (/\s(AM|PM)\b/.test(filePath)) {
    return filePath.replace(/(\s)(AM|PM)\b/, `${NARROW_NBSP}$2`);
  }
  return undefined;
}

async function suggestPathUnderWorkspace(filePath: string, workspaceRoot: string): Promise<string | undefined> {
  const cwdParent = path.dirname(workspaceRoot);
  const cwdParentPrefix = cwdParent === path.sep ? path.sep : cwdParent + path.sep;
  let resolvedPath = filePath;
  try {
    const resolvedDir = await fsPromises.realpath(path.dirname(filePath));
    resolvedPath = path.join(resolvedDir, path.basename(filePath));
  } catch {
    // Parent may not exist; compare the requested path as-is.
  }
  if (
    !resolvedPath.startsWith(cwdParentPrefix) ||
    resolvedPath.startsWith(workspaceRoot + path.sep) ||
    resolvedPath === workspaceRoot
  ) {
    return undefined;
  }
  const relFromParent = path.relative(cwdParent, resolvedPath);
  const correctedPath = path.join(workspaceRoot, relFromParent);
  try {
    await fsPromises.stat(correctedPath);
    return correctedPath;
  } catch {
    return undefined;
  }
}

async function formatFileNotFoundMessage(filePath: string, workspaceRoot: string): Promise<string> {
  const cwdSuggestion = await suggestPathUnderWorkspace(filePath, workspaceRoot);
  const similarFilename = cwdSuggestion ? undefined : await findSimilarFile(filePath);
  let message = `File does not exist. Note: your current working directory is ${workspaceRoot}.`;
  if (cwdSuggestion) {
    message += ` Did you mean ${cwdSuggestion}?`;
  } else if (similarFilename) {
    message += ` Did you mean ${similarFilename}?`;
  }
  return message;
}

/**
 * W4 Lane F：search 工具（glob_search / grep_search）的 path / target_directory
 * 校验。
 *
 *   - 路径不存在 → fail with `Path does not exist: {path}. Note: your current
 *     working directory is {cwd}. Did you mean {sugg}?`
 *   - 路径存在但不是目录（仅 glob 检查）→ fail with
 *     `Path is not a directory: {path}`
 *
 * **为什么 action-tools 层而不是 adapter 层做**：action-tools 已经有 stat
 * 调用基础设施 + workspaceRoot 解析；adapter 层做会重复一次 stat。修复后
 * **silent 0 results success** 这个 hallucination 入口
 * 关闭——LLM 看到 fail 才能知道是路径错而不是没匹配。
 *
 * @param userPath - LLM 传入的原始路径字符串（未 resolve）
 * @param resolvedPath - resolveInWorkspace 后的绝对路径
 * @param workspaceRoot - 用于错误文案里的 cwd 提示
 * @param mustBeDirectory - true 时不是目录也 fail（glob_search 用）；false 时
 *   只检查存在（grep_search 接受 file 也接受 directory）
 */
async function checkSearchPathExists(
  userPath: string,
  resolvedPath: string,
  workspaceRoot: string,
  mustBeDirectory: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // T2-C9 (2026-05-12) SECURITY：跳过 UNC 路径的 stat 调用。
  //
  // **背景**：Windows UNC 路径 `\\server\share\path` 触发 stat 时会发起 SMB /
  // NTLM 协商 —— 攻击者可以通过 prompt injection 让 LLM 传入恶意 UNC 路径
  // 诱导本机发起对外 NTLM 认证（凭据泄漏 / NTLM relay 攻击）。
  //
  // **处理方式**：grep / glob 入口直接放行（返回 ok），让后续 ripgrep / walkDir
  // 自己处理（它们对 UNC 路径要么 fail-closed 要么 ENOENT，都不会发起 SMB 协商）。
  //
  // **检查 userPath 而非 resolvedPath**：
  //   - macOS / Linux 的 `path.isAbsolute('\\\\server')` 返回 false → resolveInWorkspace
  //     会把 UNC 路径当相对路径拼到 workspaceRoot 后面（如 `/tmp/wt/\\server\share`），
  //     resolvedPath 不再以 `\\\\` 开头
  //   - 所以 check userPath 是更可靠的"用户原始意图"识别
  if (userPath.startsWith('\\\\') || userPath.startsWith('//')) {
    return { ok: true };
  }

  let stat;
  try {
    stat = await fsPromises.stat(resolvedPath);
  } catch (e: any) {
    if (e?.code !== 'ENOENT') {
      return { ok: false, error: e?.message || String(e) };
    }
    const cwdSuggestion = await suggestPathUnderWorkspace(resolvedPath, workspaceRoot);
    const similarFilename = cwdSuggestion
      ? undefined
      : await findSimilarFile(resolvedPath);
    let message = `Path does not exist: ${userPath}. Note: your current working directory is ${workspaceRoot}.`;
    if (cwdSuggestion) {
      message += ` Did you mean ${cwdSuggestion}?`;
    } else if (similarFilename) {
      message += ` Did you mean ${similarFilename}?`;
    }
    return { ok: false, error: message };
  }
  if (mustBeDirectory && !stat.isDirectory()) {
    return { ok: false, error: `Path is not a directory: ${userPath}` };
  }
  return { ok: true };
}

function isUncPath(userPath: string | null | undefined): boolean {
  return typeof userPath === 'string' && (userPath.startsWith('\\\\') || userPath.startsWith('//'));
}

// **A4 (2026-05-12)**：单行字符上限——超长行（minified JS / 巨型日志）
// 截断到 2000 字符 + 标记。单行截断避免 50 万字符单行
// 把 LLM 上下文打满。CRLF 已先归一所以这里看到的是干净行。
const MAX_LINE_CHARS = 2000;
const LINE_TRUNCATED_SUFFIX = ` ... (line truncated to ${MAX_LINE_CHARS} chars)`;

function truncateLongLines(lines: string[]): string[] {
  let mutated = false;
  const out: string[] = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > MAX_LINE_CHARS) {
      out[i] = line.substring(0, MAX_LINE_CHARS) + LINE_TRUNCATED_SUFFIX;
      mutated = true;
    } else {
      out[i] = line;
    }
  }
  return mutated ? out : lines;
}

async function readTextRange(
  filePath: string,
  input: Pick<FileReadInput, 'offset' | 'limit'>,
  statSize: number,
  encoding: string = 'utf-8',
): Promise<{ raw: string; startLine: number; totalLines?: number; numLines: number }> {
  if (statSize <= MAX_TEXT_FILE_BYTES) {
    let decoded: string;
    if (encoding === 'utf-8' || encoding === 'utf8') {
      decoded = await fsPromises.readFile(filePath, 'utf8');
    } else {
      // **A1**：非 UTF-8 编码（UTF-16/GBK/Big5 等）走 iconv-lite 解码。
      // 全文读到 buffer 再解码——10MB 上限保证内存安全。
      const buf = await fsPromises.readFile(filePath);
      decoded = iconv.decode(buf, encoding);
    }
    const raw = normalizeReadText(decoded);
    const lines = raw ? raw.split('\n') : [];
    const startIdx = resolveStartIndex(lines.length, input.offset);
    const endIdx = resolveEndIndex(lines.length, startIdx, input.limit);
    const slice = truncateLongLines(lines.slice(startIdx, endIdx));
    return {
      raw: slice.join('\n'),
      startLine: startIdx + 1,
      totalLines: lines.length,
      numLines: slice.length,
    };
  }

  if (input.offset == null || input.offset < 0 || input.limit == null || input.limit <= 0) {
    throw new Error(
      `File too large: ${(statSize / (1024 * 1024)).toFixed(1)}MB ` +
      `(limit ${MAX_TEXT_FILE_BYTES / (1024 * 1024)}MB for full text reads). ` +
      `Use a positive offset and limit to read a specific portion, or use grep_search ` +
      `to locate the content you need instead of reading the whole file.`,
    );
  }

  // **A1**：流式路径只支持 UTF-8——iconv-lite 的 decodeStream 接 createReadStream
  // 复杂度高，且大文件场景下非 UTF-8 编码极少（>10MB 的 GBK/Big5 文档罕见）。
  // 真要读这种文件，先 `iconv -f gbk -t utf-8` 转码或 split 分段。
  if (encoding !== 'utf-8' && encoding !== 'utf8') {
    throw new Error(
      `File too large for non-UTF-8 encoding (${encoding}): ${(statSize / (1024 * 1024)).toFixed(1)}MB. ` +
      `Streaming read for non-UTF-8 encodings is not supported above ${MAX_TEXT_FILE_BYTES / (1024 * 1024)}MB. ` +
      `Convert the file to UTF-8 first (e.g. iconv -f ${encoding} -t utf-8 <file>), ` +
      `or read smaller sections with grep_search.`,
    );
  }

  const targetStartLine = Math.max(1, input.offset);
  const targetEndLine = targetStartLine + input.limit - 1;
  const lines: string[] = [];
  let lineNo = 1;
  let carry = '';

  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    stream.on('data', (chunk) => {
      const text = normalizeReadText(carry + String(chunk));
      const parts = text.split('\n');
      carry = parts.pop() ?? '';
      for (const line of parts) {
        if (lineNo >= targetStartLine && lineNo <= targetEndLine) {
          lines.push(line);
        }
        lineNo++;
        if (lineNo > targetEndLine) {
          stream.destroy();
          resolve();
          return;
        }
      }
    });
    stream.on('error', reject);
    stream.on('close', resolve);
    stream.on('end', () => {
      const finalLine = carry.replace(/^\uFEFF/, '');
      if (lineNo >= targetStartLine && lineNo <= targetEndLine) {
        lines.push(finalLine);
      }
      resolve();
    });
  });

  return {
    raw: truncateLongLines(lines).join('\n'),
    startLine: targetStartLine,
    totalLines: undefined,
    numLines: lines.length,
  };
}

function resolveStartIndex(totalLines: number, offset?: number | null): number {
  if (offset == null) return 0;
  if (offset < 0) return Math.max(0, totalLines + offset);
  return Math.max(0, offset - 1);
}

function resolveEndIndex(totalLines: number, startIdx: number, limit?: number | null): number {
  if (limit != null && limit > 0) {
    return Math.min(totalLines, startIdx + limit);
  }
  return totalLines;
}

class RipgrepSemaphore {
  private queue: (() => void)[] = [];
  private running = 0;
  constructor(private max: number) {}
  async acquire(): Promise<void> {
    if (this.running < this.max) { this.running++; return; }
    await new Promise<void>(resolve => this.queue.push(resolve));
  }
  release(): void {
    this.running--;
    if (this.queue.length > 0) { this.running++; this.queue.shift()!(); }
  }
}

const ripgrepSemaphore = new RipgrepSemaphore(MAX_RIPGREP_CONCURRENT);

/**
 * 路径权限治理 Wave 1：file 工具的最终安全闸门（红线 → 敏感路径 → 工作区）。
 *
 * 三道检查的**优先级与跳过语义**（深度防御 + 性能 + 一致性的折中）：
 *
 *   1. **红线**（`matchSensitivePath` + `checkHardlinePath`）：
 *      纯字面量黑名单，无论 `alreadyJudged` 都执行。这是 CT-001 安全
 *      硬约束，任何路径权限管线都不能放行（典型如 `/etc/shadow`）。
 *
 *   2. **敏感路径四态**（`checkSensitivePath`）：
 *      ~/.ssh / ~/.aws / Keychains 等 — `inWorkspace` 真值参与判决，
 *      允许"工作区内的敏感路径只 ask、工作区外的写直接 deny"差异化
 *      行为（旧实现把 `inWorkspace` 硬编码 false，废掉了一半设计）。
 *      `alreadyJudged === true` 时仍执行此检查——judge 已通过仅意味
 *      着"工作区/yolo/memo 决策放行"，不等于"敏感路径解锁"。
 *
 *   3. **工作区 boundary**（多目录 `allowedPaths` 命中检查）：
 *      `alreadyJudged === true` 时**跳过**——本次调用已经过 v3
 *      `judge()` 管线决策（含 workspace_in / yolo_allow / memo_allow /
 *      用户 once allow 等）；adapter 层透传 `_already_judged: true`，
 *      action-tools 信任 judge 决策不再二次拦截。`alreadyJudged` 缺省
 *      或 false 时：写操作必须命中 allowedPaths 之一才放行（headless 直
 *      调链路 / 测试桩 / 未接 v3 的旧调用方的兜底防线）。
 *
 * **签名变更**（与"D3 不留兼容"决策一致）：
 *   - 旧 `workspaceRoot?: string`（单字符串 startsWith 比较）
 *     已删除，参见 v3 设计哲学：唯一权威边界 = `WorkspaceSnapshot.allowedPaths`。
 *   - 新 `workspaceRoots?: readonly string[]`（v3 SSoT 多目录数组）
 *     由 tabcode-adapter 从 `ctx.workspaceSnapshot.allowedPaths` 透传。
 *   - 新 `alreadyJudged?: boolean` 由 tabcode-adapter 从
 *     `ctx.permissionContext?.judgedDecision === 'allow'` 透传。
 *
 * 返回错误字符串则操作被拒；返回 null 则放行。
 */
function checkFilePathSecurity(
  actionType: 'read_file' | 'write_file' | 'edit_file' | 'delete_file' | 'mkdir' | 'move_file',
  resolvedPath: string,
  workspaceRoots: readonly string[] = [],
  alreadyJudged: boolean = false,
  /**
   * **W4 (2026-05-12)**：当前 session 的 tool-results 目录绝对路径。仅
   * `actionType === 'read_file'` 时生效——LLM 拿到 `summarizeToolOutput` /
   * `enforceToolOutputBudget` 持久化引用文件路径后，沿着 banner 用 read_file
   * 读回。该目录通常在 `<userDataDir>/conversations/sessions/<id>/tool-results`
   * 之类的位置，不在 workspace 内，**没有此豁免** read_file 会被 boundary
   * 拦下来；持久化机制就只剩单向（写得进、读不回）废了一半。
   *
   * 由 tabcode-adapter 通过 `_tool_results_dir` input 字段透传到本函数；
   * adapter 强制覆盖该字段（`enrichWithWorkspaceRoot` 先 delete 再注入），
   * LLM 不能伪造。
   */
  toolResultsDir?: string,
): string | null {
  // 1) 红线：永远执行
  const sensitiveHit = matchSensitivePath(resolvedPath);
  if (sensitiveHit) {
    return `Access to sensitive path '${sensitiveHit}' is blocked for security reasons.`;
  }

  const pathHit = checkHardlinePath(resolvedPath, 'file');
  if (pathHit.hit) {
    return pathHit.description ?? `Operation blocked by security policy.`;
  }

  // 2) 敏感路径四态：用真值的 inWorkspace 算（修旧实现 inWorkspace=false 硬编码 bug）
  // 用 v3 SSoT 的 isPathInAllowedRoots 判定，跟 judge step 4 同源同语义。
  const inWorkspace = workspaceRoots.length > 0
    ? isPathInAllowedRoots(resolvedPath, workspaceRoots)
    : false;

  // W2a：mkdir / move_file 是写类操作（建目录 / 改变文件系统结构），
  // 沿用 write_file 同款 workspace boundary 语义——目标路径必须落在
  // allowedPaths 之一，红线/敏感路径检查同样适用。
  const isWrite =
    actionType === 'write_file' ||
    actionType === 'edit_file' ||
    actionType === 'delete_file' ||
    actionType === 'mkdir' ||
    actionType === 'move_file';
  const sensHit = checkSensitivePath(resolvedPath, 'file', inWorkspace, isWrite);
  if (sensHit.hit && sensHit.action === 'deny') {
    return sensHit.description ?? `Operation blocked: sensitive path.`;
  }

  // 2.5) **W4 (2026-05-12)** tool-results 豁免：read_file 走完红线 + 敏感路径
  // 检查后，如果路径在当前 session 的 tool-results 目录内，直接放行（跳过
  // workspace boundary 检查）。
  //
  // **为什么放在 sensitive 检查之后**：tool-results 目录里的文件名是
  // sanitize 过的 toolUseId（`[^a-zA-Z0-9_-]/g → _`），不可能命中 sensitive
  // 列表（`.ssh` / `.aws` / `Keychains`）；但红线 + 敏感路径的检查仍要跑过，
  // 万一未来 storage dir 配置错误指向敏感目录（如用户手动改 sessionDir 到
  // `~/.ssh`）能被红线兜底拦下来。
  //
  // **匹配规则**：精确路径前缀（不用 glob/regex），且 toolResultsDir 必须
  // 是非空字符串。两边都用 path.resolve 归一化避免 `..` / 重复 `/` 绕过。
  // 仅放行 read_file —— write/edit/delete 不豁免（避免 LLM 把恶意内容写入
  // session 目录后再用持久化机制传播）。
  if (
    actionType === 'read_file' &&
    typeof toolResultsDir === 'string' &&
    toolResultsDir.length > 0
  ) {
    const normalizedDir = path.resolve(toolResultsDir);
    const normalizedPath = path.resolve(resolvedPath);
    // path.relative 返回的字符串不以 `..` 开头且不是绝对路径 → 在目录内
    const rel = path.relative(normalizedDir, normalizedPath);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return null;
    }
  }

  // 3) workspace boundary：alreadyJudged 时跳过（信任 v3 judge 决策）
  if (alreadyJudged) return null;

  // 写操作必须落在 allowedPaths 之一；空数组 = 调用方未提供工作区，
  // 不做 boundary 检查（headless / 测试桩兜底——红线 + 敏感路径已是防线）。
  if (isWrite && workspaceRoots.length > 0 && !inWorkspace) {
    // **2026-05-13 重构**：错误文案是给 LLM 看的，去除用户层产品名
    // ("TabFolder/TabCode" / "Super Permissions" / "Agent Security settings")。
    //
    // 旧实现把 UI 文案塞在工具协议里：LLM 拿到错误后只能照本宣科转述给用户，
    // 但这些产品名一旦 UI 改名就漂移；且 LLM 不一定理解 TabTin 的 i18n
    // 上下文（多语种 / 多端 / 移动 vs 桌面 UI 不同）。
    //
    // 新策略：工具协议给 LLM 一个 actionable 的简洁信号——"路径在工作区外"
    // + "需要用户授权或加入工作区"。具体怎么呈现给用户、用什么按钮、走什么
    // 设置项，归 UI 层（前端基于 error_code=PERMISSION_DENIED + context.reason
    // 走自己的 i18n 链路渲染）。
    //
    // **W1（2026-05-13）保留 path 在 message 里**：调用方走 standardizeLegacyResult
    // 把 message 包成 envelope，adapter 层再转 ToolResult；context 结构化字段
    // 在 adapter 端的 errorResultEnvelope 才进 metadata。底层 message 不能丢
    // path（LLM 拿不到 context 时 fallback 仍能识别哪个路径）。
    return (
      `Path is outside the allowed workspace: '${resolvedPath}'. ` +
      `The user must grant access to this directory before the operation can proceed.`
    );
  }

  return null;
}

/**
 * 路径权限治理 Wave 1：从 action-tool input 提取 `_allowed_paths` /
 * `_already_judged` / `_tool_results_dir` 字段（由 tabcode-adapter 注入）。
 *
 * 缺省时返回空数组 + false + undefined——headless 直调 / 老测试桩走这条
 * 退化路径。入口归一在此，避免每个工具体内 5 处重复读字段（read/write/
 * edit/delete + 双 symlink 复检）。
 *
 * **W4 (2026-05-12)**：新增 `toolResultsDir` 透传——`checkFilePathSecurity`
 * 在 read_file 路径下用它做 tool-results 引用文件豁免（见 §2.5 分支）。
 */
function getWorkspaceAccessFromInput(
  input: Record<string, any>,
): { workspaceRoots: readonly string[]; alreadyJudged: boolean; toolResultsDir?: string } {
  const rawPaths = input._allowed_paths;
  const workspaceRoots: readonly string[] = Array.isArray(rawPaths)
    ? rawPaths.filter((p: unknown): p is string => typeof p === 'string' && p.length > 0)
    : [];
  const alreadyJudged = input._already_judged === true;
  const rawToolResultsDir = input._tool_results_dir;
  const toolResultsDir = typeof rawToolResultsDir === 'string' && rawToolResultsDir.length > 0
    ? rawToolResultsDir
    : undefined;
  return { workspaceRoots, alreadyJudged, toolResultsDir };
}

/**
 * Resolve a user-supplied path relative to the workspace root.
 * - Absolute paths are returned as-is (security boundary check is enforced separately).
 * - Relative paths are resolved against `workspaceRoot` (or cwd as last resort).
 */
function stripShellPathQuotes(input: string): string {
  let s = input.trim();
  if (
    s.length >= 2
    && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    s = s.slice(1, -1).trim();
  }
  while (s.startsWith('"') || s.startsWith("'")) s = s.slice(1);
  while (s.endsWith('"') || s.endsWith("'")) s = s.slice(0, -1);
  return s.trim();
}

function resolveInWorkspace(userPath: string, workspaceRoot?: string): string {
  const cleaned = stripShellPathQuotes(userPath);
  const expanded = cleaned.startsWith('~/')
    ? path.join(os.homedir(), cleaned.slice(2))
    : cleaned === '~' ? os.homedir() : cleaned;
  if (path.isAbsolute(expanded)) {
    const abs = path.resolve(expanded);
    try { return fs.realpathSync(abs); } catch { return abs; }
  }
  const base = workspaceRoot || process.cwd();
  const logical = path.resolve(base, expanded);
  try {
    return fs.realpathSync(logical);
  } catch {
    // 文件不存在（write_file 新建场景），对父目录做 realpath
    try {
      const parent = fs.realpathSync(path.dirname(logical));
      return path.join(parent, path.basename(logical));
    } catch {
      return logical;
    }
  }
}

/** Extract workspace root from backend-injected `_workspace_root` field, fallback to cwd. */
function getWorkspaceRoot(input: Record<string, any>): string {
  return (input._workspace_root as string)?.trim() || process.cwd();
}

/**
 * ：执行根被 Finder 改名/删除后，禁止 mkdir -p 在旧绝对路径上「复活」空目录，
 * 否则 Agent 以为写入成功、预览却找不到（用户已在新路径上）。
 *
 * 只校验「声明的根」本身是否仍是目录；根存在时中间子目录缺失仍允许创建。
 */
async function assertWorkspaceRootsPresent(
  wsRoot: string,
  workspaceRoots: readonly string[],
  resolvedTarget: string,
): Promise<string | null> {
  const roots = new Set<string>();
  const normalizedTarget = path.resolve(resolvedTarget);
  if (wsRoot) roots.add(path.resolve(wsRoot));
  for (const root of workspaceRoots) {
    const resolvedRoot = path.resolve(root);
    if (
      normalizedTarget === resolvedRoot
      || normalizedTarget.startsWith(resolvedRoot + path.sep)
    ) {
      roots.add(resolvedRoot);
    }
  }
  for (const root of roots) {
    try {
      const st = await fsPromises.stat(root);
      if (!st.isDirectory()) {
        return (
          `Workspace root is not a directory: ${root}. ` +
          `Re-bind the working directory in Workspace settings.`
        );
      }
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        return (
          `Workspace root no longer exists: ${root}. ` +
          `It may have been moved or renamed. ` +
          `Re-bind the working directory in Workspace settings.`
        );
      }
      throw err;
    }
  }
  return null;
}

// ──────────────────────── read_file ────────────────────────

export interface FileReadInput {
  path: string;
  offset?: number | null;
  limit?: number | null;
}

export interface FileReadOutput {
  success: boolean;
  data?: Record<string, any>;
  error?: any;
}

export const fileReadTool: AgentTool<FileReadInput, FileReadOutput> = {
  name: 'read_file',
  riskLevel: 'safe' as const,
  description: '按绝对路径或相对工作目录根的路径读本地文件。源代码 / 纯文本（txt、md、json、csv、yaml、ts、py 等）返回带行号的文本内容。大文本文件支持可选的 offset 和 limit。',
  parameters: {
    type: 'object',
    properties: {
      // 阶段 6.6 议题 3 翻译：read_file inputSchema 字段中文化。
      path: { type: 'string', description: '文件路径（绝对路径或相对工作目录根的路径；不要加 workspace/ 前缀）。' },
      offset: { type: 'number', description: '起始行（从 1 开始；负数 = 从末尾倒数）。' },
      limit: { type: 'number', description: '最多读多少行。' },
    },
    required: ['path'],
  },
  async execute(input: FileReadInput): Promise<FileReadOutput> {
    const filePath = input.path?.trim();
    if (!filePath) {
      return standardizeLegacyResult({ success: false, error: 'path is required', error_code: ToolErrorCode.INVALID_PARAMETER });
    }

    try {
      const wsRoot = getWorkspaceRoot(input as any);
      const { workspaceRoots, alreadyJudged, toolResultsDir } = getWorkspaceAccessFromInput(input as any);
      let resolved = resolveInWorkspace(filePath, wsRoot);

      if (isBlockedDevicePath(resolved)) {
        return standardizeLegacyResult({
          success: false,
          error: `Cannot read '${filePath}': this device file would block or produce infinite output.`,
          error_code: ToolErrorCode.UNSUPPORTED_OPERATION,
        });
      }

      // **B1 (2026-05-12)** macOS 截图 thin-space 兼容：
      // 截图文件名 AM/PM 前的空格在不同 macOS 版本可能是普通空格 (U+0020)
      // 或 NARROW NO-BREAK SPACE (U+202F)。LLM 抄一种格式时盘上是另一种 →
      // ENOENT。这里在 stat 前先尝试 alternate 路径，存在则替换 resolved
      // 走 alternate 路径走完整读流程（含安全检查），LLM 不必多一轮往返。
      try {
        await fsPromises.access(resolved, fs.constants.F_OK);
      } catch (accessErr: any) {
        if (accessErr?.code === 'ENOENT') {
          const alternate = getAlternateScreenshotPath(resolved);
          if (alternate) {
            try {
              await fsPromises.access(alternate, fs.constants.F_OK);
              resolved = alternate;
            } catch {
              // alternate 也不存在 → 让后续 stat 走标准 ENOENT 分支
            }
          }
        }
      }

      // CT-002: Block reads of sensitive credential/system files
      // **W4 (2026-05-12)**：透传 toolResultsDir，让 LLM 能 read_file 持久化的引用文件
      const secError = checkFilePathSecurity('read_file', resolved, workspaceRoots, alreadyJudged, toolResultsDir);
      if (secError) {
        return standardizeLegacyResult({ success: false, error: secError, error_code: ToolErrorCode.PERMISSION_DENIED });
      }

      const stat = await fsPromises.stat(resolved);
      if (stat.isDirectory()) {
        const entries = await fsPromises.readdir(resolved, { withFileTypes: true });
        // **A3 (2026-05-12)**：目录条目上限——超过 200 项时只返前 200 + 标记
        // truncated:true。读 node_modules 这种几万 entries 的目录会把 LLM 上下文
        // 直接打满，而 maxResultSizeChars: Infinity 让 budget enforcer 也跳过。
        // 200 这个阈值约为常见 read 默认 limit 的 1/10——目录条目
        // 信息密度高于行号文本，200 已经够 LLM 看清整体形状。
        const MAX_DIR_ENTRIES = 200;
        const totalCount = entries.length;
        const truncated = totalCount > MAX_DIR_ENTRIES;
        // localeCompare 排序，保证 `a` 在 `B` 前面，可读性 > 默认 fs 顺序
        const sorted = entries.slice().sort((a, b) => a.name.localeCompare(b.name));
        const visibleEntries = (truncated ? sorted.slice(0, MAX_DIR_ENTRIES) : sorted).map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
        }));
        return standardizeLegacyResult({
          success: true,
          data: {
            is_directory: true,
            path: resolved,
            entries: visibleEntries,
            ...(truncated ? { truncated: true, total_count: totalCount } : {}),
          },
        });
      }
      if (!stat.isFile()) {
        return standardizeLegacyResult({
          success: false,
          error: `Cannot read '${filePath}': this is not a regular file and may block or produce infinite output.`,
          error_code: ToolErrorCode.UNSUPPORTED_OPERATION,
        });
      }

      const ext = path.extname(resolved).toLowerCase();
      // **W2.1 Review 3 fix-6（2026-05-13）**：IMAGE_EXTS 必须与
      // `packages/agent-runtime/src/tools/tabcode-adapter.ts::IMAGE_EXTS` 同款
      // （否则 adapter 早 dedup 检查命中但 action-tools 不识别为 image，HEIC
      // 走 unsupported_operation 错误链路 → adapter 失败分支既不命中 LOCAL_DOC_PARSE_EXTS
      // 也不是 .pptx → 沿用 action-tools 原 envelope 报"格式不支持"）。补 .heic/.heif
      // 让 sharp 缩放路径接得住手机照片高频格式。sharp 0.34 prebuild 自带 libheif
      // 解码（macOS / Linux / Windows 验证过）。
      const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.heic', '.heif']);
      const MEDIA_TYPE_MAP: Record<string, string> = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
        '.heic': 'image/heic', '.heif': 'image/heif',
      };

      const isImage = IMAGE_EXTS.has(ext);

      // 非文本文件不再由 read_file 把字节塞进工具结果。图片也只返回元数据，
      // 由 agent-runtime/host 层的 fileMaterializer 负责上传并给 LLM 一个
      // 稳定文件引用，避免 base64 直接进入上下文。
      if (isImage) {
        if (stat.size > MAX_IMAGE_FILE_BYTES_HARD) {
          const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
          const limitMB = MAX_IMAGE_FILE_BYTES_HARD / (1024 * 1024);
          return standardizeLegacyResult({
            success: false,
            error:
              `Image exceeds the ${limitMB}MB read_file hard size limit (actual: ${sizeMB}MB). ` +
              `read_file does not inline image bytes; ask the host/user to upload or materialize the file.`,
            error_code: ToolErrorCode.FILE_TOO_LARGE,
          });
        }
        const mediaType = MEDIA_TYPE_MAP[ext] || 'application/octet-stream';
        return standardizeLegacyResult({
          success: true,
          data: {
            type: 'non_text_file',
            category: 'image',
            media_type: mediaType,
            size_bytes: stat.size,
            path: resolved,
          },
        });
      }

      // P0-1（plan §14.2）：扩展名分流必须早于文本 size check。
      // 否则 12MB PDF 会先撞 10MB 文本上限并丢失 UNSUPPORTED_OPERATION 信号，
      // adapter 拿不到该信号就不会切到 host fileMaterializer。
      // 安全拒绝的可执行文件保留 unsupported_operation；允许读取的文档、媒体、
      // 压缩包与普通二进制只返回非文本元数据，由 host 统一材料化文件引用。
      if (REJECT_BINARY_EXTS.has(ext)) {
        return standardizeLegacyResult({
          success: false,
          error: `Cannot read binary executable file (${ext}). Binary files of this type cannot be processed as text.`,
          error_code: ToolErrorCode.UNSUPPORTED_OPERATION,
        });
      }
      if (CONVERTIBLE_BINARY_EXTS.has(ext)) {
        return standardizeLegacyResult({
          success: true,
          data: {
            type: 'non_text_file',
            category: 'document',
            size_bytes: stat.size,
            path: resolved,
          },
        });
      }
      if (MEDIA_BINARY_EXTS.has(ext)) {
        return standardizeLegacyResult({
          success: true,
          data: {
            type: 'non_text_file',
            category: ['.zip', '.tar', '.gz', '.7z', '.rar'].includes(ext) ? 'archive' : 'media',
            size_bytes: stat.size,
            path: resolved,
          },
        });
      }

      // **A1 (2026-05-12)** 编码识别 + 二进制嗅探：
      // 在 binary 检测之前先尝试编码识别——已知编码（含 UTF-8 / UTF-16 /
      // GBK / Big5 / Shift-JIS 等）跳过 null byte 检测；未识别才走 binary
      // 启发式。BOM 优先级最高。识别到的编码传给 readTextRange 让它走
      // iconv-lite 解码，避免原 fs.readFile(path, 'utf8') 强制 utf8 解析
      // 导致 UTF-16/GBK 文件乱码。
      let detectedEncoding = 'utf-8';
      if (stat.size > 0) {
        const fd = await fsPromises.open(resolved, 'r');
        let headBuf: Buffer;
        try {
          headBuf = Buffer.alloc(Math.min(8000, stat.size));
          await fd.read(headBuf, 0, headBuf.length, 0);
        } finally {
          await fd.close();
        }
        const sniff = sniffEncodingOrBinary(headBuf);
        if (sniff.kind === 'binary') {
          return standardizeLegacyResult({
            success: true,
            data: {
              type: 'non_text_file',
              category: 'binary',
              size_bytes: stat.size,
              path: resolved,
            },
          });
        }
        if (sniff.kind === 'encoded') {
          detectedEncoding = sniff.encoding;
        }
      }

      let range;
      try {
        range = await readTextRange(resolved, input, stat.size, detectedEncoding);
      } catch (rangeErr) {
        const msg = rangeErr instanceof Error ? rangeErr.message : String(rangeErr);
        return standardizeLegacyResult({ success: false, error: msg });
      }
      const raw = range.raw;
      if (!raw) {
        return standardizeLegacyResult({
          success: true,
          data: {
            content: '',
            contentRaw: '',
            empty: true,
            path: resolved,
            start_line: range.startLine,
            ...(range.totalLines !== undefined ? { total_lines: range.totalLines } : {}),
            num_lines: 0,
          },
        });
      }

      const lines = raw.split('\n');
      const numbered = lines.map((line, i) => {
        const lineNum = String(range.startLine + i);
        return `${lineNum}\t${line}`;
      });

      return standardizeLegacyResult({
        success: true,
        data: {
          content: numbered.join('\n'),
          contentRaw: raw,
          path: resolved,
          start_line: range.startLine,
          ...(range.totalLines !== undefined ? { total_lines: range.totalLines } : {}),
          num_lines: range.numLines,
        },
      });
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        const wsRoot = getWorkspaceRoot(input as any);
        const resolved = resolveInWorkspace(filePath, wsRoot);
        return standardizeLegacyResult({
          success: false,
          error: await formatFileNotFoundMessage(resolved, wsRoot),
          error_code: ToolErrorCode.INVALID_PARAMETER,
        });
      }
      const msg = err instanceof Error ? err.message : String(err);
      return standardizeLegacyResult({ success: false, error: msg });
    }
  },
};

// ──────────────────────── write_file ────────────────────────

export interface FileWriteInput {
  path: string;
  contents: string;
  /** 为 true 时在文件末尾追加（UTF-8），否则覆盖写入 */
  append?: boolean;
}

export interface FileWriteOutput {
  success: boolean;
  data?: Record<string, any>;
  error?: any;
}

export const fileWriteTool: AgentTool<FileWriteInput, FileWriteOutput> = {
  name: 'write_file',
  riskLevel: 'review' as const,
  // adapter 层（packages/agent-runtime/src/tools/tabcode-adapter.ts）会 override
  // 成更详细版本带 read-before-write 提示——这层是 LLM 看不到的 fallback，仅
  // 保持核心语义不漂移。
  description:
    '把文件写入本地文件系统。文件不存在则创建（包括父目录）。已存在则覆盖。修改已有文件优先用 edit_file。本工具只用于创建新文件或整文件重写。',
  parameters: {
    type: 'object',
    properties: {
      // 阶段 6.6 议题 3 翻译。
      path: { type: 'string', description: '文件路径。' },
      contents: { type: 'string', description: '要写入的内容。' },
      append: { type: 'boolean', description: '追加到文件末尾，而不是覆盖。' },
    },
    required: ['path', 'contents'],
  },
  async execute(input: FileWriteInput): Promise<FileWriteOutput> {
    const filePath = input.path?.trim();
    if (!filePath) {
      return standardizeLegacyResult({ success: false, error: 'path is required', error_code: ToolErrorCode.INVALID_PARAMETER });
    }

    try {
      const wsRoot = getWorkspaceRoot(input as any);
      const { workspaceRoots, alreadyJudged } = getWorkspaceAccessFromInput(input as any);
      const resolved = resolveInWorkspace(filePath, wsRoot);

      // CT-001 + CT-004: Enforce workspace boundary and security policy for writes
      const secError = checkFilePathSecurity('write_file', resolved, workspaceRoots, alreadyJudged);
      if (secError) {
        return standardizeLegacyResult({ success: false, error: secError, error_code: ToolErrorCode.PERMISSION_DENIED });
      }

      // : 根已丢时禁止 mkdir -p 复活旧路径
      const rootMissingError = await assertWorkspaceRootsPresent(wsRoot, workspaceRoots, resolved);
      if (rootMissingError) {
        return standardizeLegacyResult({
          success: false,
          error: rootMissingError,
          error_code: ToolErrorCode.INVALID_PARAMETER,
        });
      }

      const contentBytes = Buffer.byteLength(input.contents ?? '', 'utf8');
      if (contentBytes > MAX_TEXT_FILE_BYTES) {
        return standardizeLegacyResult({
          success: false,
          error: `Content too large: ${(contentBytes / 1024 / 1024).toFixed(1)}MB (limit ${MAX_TEXT_FILE_BYTES / 1024 / 1024}MB).`,
          error_code: ToolErrorCode.INVALID_PARAMETER,
        });
      }

      const append = Boolean(input.append);
      if (append) {
        await fsPromises.mkdir(path.dirname(resolved), { recursive: true });
        let appendFileExists = false;
        try {
          const lstats = await fsPromises.lstat(resolved);
          appendFileExists = true;
          if (lstats.isSymbolicLink()) {
            const realTarget = await fsPromises.readlink(resolved);
            const absTarget = path.isAbsolute(realTarget) ? realTarget : path.resolve(path.dirname(resolved), realTarget);
            const symlinkSecErr = checkFilePathSecurity('write_file', absTarget, workspaceRoots, alreadyJudged);
            if (symlinkSecErr) {
              return standardizeLegacyResult({ success: false, error: `Symlink target blocked: ${symlinkSecErr}` });
            }
          }
        } catch (e: any) {
          if (e?.code !== 'ENOENT') throw e;
        }

        if (appendFileExists) {
          const appendExt = path.extname(resolved).toLowerCase();
          if (REJECT_BINARY_EXTS.has(appendExt) || CONVERTIBLE_BINARY_EXTS.has(appendExt) || MEDIA_BINARY_EXTS.has(appendExt)) {
            return standardizeLegacyResult({
              success: false,
              error: `Cannot append to binary file (${appendExt}). Binary files cannot be reliably modified as text.`,
              error_code: ToolErrorCode.UNSUPPORTED_OPERATION,
            });
          }
          const appendStat = await fsPromises.stat(resolved);
          if (appendStat.size > 0) {
            const appendFd = await fsPromises.open(resolved, 'r');
            try {
              const appendHeadBuf = Buffer.alloc(Math.min(8000, appendStat.size));
              await appendFd.read(appendHeadBuf, 0, appendHeadBuf.length, 0);
              if (hasBinaryContent(appendHeadBuf)) {
                return standardizeLegacyResult({
                  success: false,
                  error: 'Target file appears to be binary (contains null bytes). Cannot append text to binary files.',
                  error_code: ToolErrorCode.UNSUPPORTED_OPERATION,
                });
              }
            } finally {
              await appendFd.close();
            }
          }
        }

        await fsPromises.appendFile(resolved, input.contents ?? '', 'utf8');
      } else {
        // CRITICAL: no async ops between here and atomicWriteFile — 写盘临界区禁 await
        // **文件并发安全 Wave 2 TOCTOU 二次校验**（2026-05-13 字节对照基线
        // A2-1 ~ A2-5）：覆写分支必须校验（append 模式见上方分支跳过，A2-3 决策）。
        // **A2-2 文件不存在跳过**：`meta !== null` 兜底 ENOENT。
        // **A2-4 OR 不变量**：partial read 任何变化都 throw（字面
        // `!isFullRead || meta.content !== lastRead.content`，OR 不是 AND）—
        // 本工具不直接判定 isFullRead，交给 validateReadBeforeWriteSync 内部
        // 处理（同款 OR 语义：isFullRead && content 相等 → 放行，任一不满足
        // → throw）。
        // **A2-5 content normalize 形态**：fileWriteTool 不像 fileEditTool 有
        // 行 1401 的 normalize，所以这里必须现场对当前磁盘文件做
        // normalizeLineEndings + stripBOM 跟 readFileState entry 内的形态对齐
        // —— record 路径写入时已经 normalize（read-file-state.ts:recordReadFileState）。
        let currentContent: string | undefined;
        let currentMtimeMs: number | undefined;
        try {
          const stat = fs.statSync(resolved);
          currentMtimeMs = Math.floor(stat.mtimeMs);
          const rawCurrent = fs.readFileSync(resolved, 'utf8');
          // normalize 形态跟 readFileState entry 对齐：剥 BOM + CRLF→LF。
          // 跟 recordReadFileState 内部 `normalizeLineEndings(content)` + 入口
          // 校验 `normalizeLineEndings(currentContent)` 全链路统一。
          currentContent = rawCurrent
            .replace(/^\uFEFF/, '')
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n');
        } catch (err: any) {
          if (err?.code !== 'ENOENT') throw err;
          // 文件不存在 → 跳过校验（A2-2 同款语义）：新建场景不涉及覆盖外部
          // 修改。currentContent / currentMtimeMs 保持 undefined，下面 if 不
          // 进 validate。
        }
        if (currentMtimeMs !== undefined && currentContent !== undefined) {
          // **Wave 3 整体收尾 L-32 修复**：用 ValidateBeforeWriteHook 类型断言。
          const validate = (input as any)._validate_before_write as ValidateBeforeWriteHook | undefined;
          if (typeof validate === 'function') {
            try {
              validate({
                filePath: resolved,
                currentMtimeMs,
                currentContent,
              });
            } catch (err) {
              if (err instanceof ToolStaleReadError) {
                // Round 1 technical reviewer M-1 修复：透传 err.path 让上游
                // adapter `actionResultToToolResult` 提取传给 envelope，跟
                // 入口校验 errorResultEnvelope.path 字节对齐（基线 B5-1）。
                return standardizeLegacyResult({
                  success: false,
                  error: err.message,
                  error_code: ToolErrorCode.STALE_READ,
                  path: err.path,
                });
              }
              throw err;
            }
          }
        }

        // CT-006: Use atomic write to prevent partial-write corruption on crash
        await atomicWriteFile(resolved, input.contents ?? '', { encoding: 'utf8', mkdirSync: true });
      }
      return standardizeLegacyResult({ success: true, data: { path: resolved } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return standardizeLegacyResult({ success: false, error: msg });
    }
  },
};

// ──────────────────────── edit_file ────────────────────────

export interface FileEditInput {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface FileEditOutput {
  success: boolean;
  data?: Record<string, any>;
  error?: any;
}

/**
 * Two-tier matching strategy — aligned with common agent file-edit match semantics (`findActualString`).
 *
 *   1. Exact match — character-level indexOf
 *   2. Line-trimmed match — ignore leading/trailing whitespace per line
 *
 * **Why no Tier 3 (block-anchor)**: TabTin originally had a "first-line + last-line anchored,
 * middle content unverified" tier here. Dogfood (2026-05-09) hit a hallucination case where
 * Kimi produced an old_string whose first/last lines matched a real `.button { … }` block
 * but the middle was hallucinated CSS classes that don't exist in the file. block-anchor
 * returned a false-positive `success` and the LLM happily proceeded down a wrong path.
 *
 * 回顾 `findActualString` 设计: every tier does whole-string `indexOf` after
 * normalization (quote / whitespace) — never "match the boundaries and skip the middle".
 * That's the philosophy we fall back to: **a tier may normalize, but it must always verify
 * the whole search string against the file content**. Anything else manufactures
 * false-positive successes that LLMs cannot diagnose without re-reading.
 *
 * For LLMs (especially non-native-training-distribution models like Kimi/GLM), the cost of a false-positive
 * "success" is much higher than the cost of an honest "not found": the latter feeds back
 * a clear self-correction signal (`String to replace not found in file.\nString: …`),
 * the former silently corrupts state. We choose honesty.
 */

/**
 * `MatchResult.strategy` 字段语义对照表：
 *
 * | strategy        | 解释                                                          |
 * |----------------|---------------------------------------------------------------|
 * | `exact`         | 精确 indexOf 命中                                             |
 * | `curly_quote`   | **W5**：仅 curly → straight 引号 normalize 后命中             |
 * | `whitespace`    | **W5**：仅 tab → 4 spaces normalize 后命中                    |
 * | `curly_quote_whitespace` | **W5**：curly + tab/space 组合 normalize 后命中     |
 * | `line_trimmed`  | 整行 trim 后命中（TabTin 特有兜底，多一层）    |
 */
type MatchResult = {
  start: number;
  end: number;
  strategy:
    | 'exact'
    | 'curly_quote'
    | 'whitespace'
    | 'curly_quote_whitespace'
    | 'line_trimmed';
};

/**
 * `findMatch` 返回首处 match + line_trimmed 全文件命中次数。
 *
 * **为什么需要 lineTrimmedMatchCount**：line_trimmed 命中位置的 matchedText
 * 是从原文件 substring 出来的（含原始缩进），跟 LLM 给的 old_string 不字面相等
 * —— 上层 `countOccurrences(content, input.old_string)` 算的是 exact occurrences，
 * 对 line_trimmed 多匹配视而不见。结果：line_trimmed 多匹配 + replace_all=false
 * 时 execute 静默替换第一处而不报错（与 exact 多匹配不一致），LLM 看到 "成功"
 * 反馈但实际只改了 1/N 处——这跟"首尾锚定中间不校验"假阳性 success 是同款
 * hallucination 隐藏路径。
 *
 * 扫描全文件统计 line_trimmed 命中次数让 execute 可以做和 exact 一致的多匹配
 * uniqueness 检查（同款待遇）。
 *
 * **W5 (2026-05-12) 4 级 fuzzy 升级**：在 exact 失败之后、line_trimmed 之前插入
 * `findActualString` 4 级精准 fuzzy（curly quotes / tab-space / 组合）。命中时
 * `actualString` 是从原文件 substring 出来的真实片段——上层 substitute 直接用
 * 这个值做 indexOf + replace 保留文件原本字符规范（curly quotes / tabs 等）。
 *
 * **fuzzy 不允许"相似度阈值"判定**：本模块每一级都是"语义无损 normalize 后整体
 * indexOf"，不做 BlockAnchor / WhitespaceNormalized / Indentation
 * Flexible / ContextAware（「首末锚定中间不校验」，TabTin Wave 1
 * dogfood 已验证会假阳性命中）。
 */
interface FindMatchResult {
  /** 首处命中 match，无命中则为 null */
  match: MatchResult | null;
  /** 仅当 strategy === 'line_trimmed' 时有意义；exact 多匹配由 countOccurrences 统计 */
  lineTrimmedMatchCount: number;
  /**
   * **W5**：当 strategy 是 `curly_quote` / `whitespace` / `curly_quote_whitespace`
   * / `line_trimmed` 时，记录原文件里的真实子串（已通过 normalize 反向映射）。
   * exact 命中时此字段是 search 本身。上层 substitute 用这个值做 indexOf + replace。
   */
  actualString: string;
}

function findMatch(content: string, search: string): FindMatchResult {
  // Level 0: exact match
  const exactIdx = content.indexOf(search);
  if (exactIdx !== -1) {
    return {
      match: { start: exactIdx, end: exactIdx + search.length, strategy: 'exact' },
      lineTrimmedMatchCount: 0,
      actualString: search,
    };
  }

  // **W5 4 级 fuzzy**：插在 exact 之后、line_trimmed 之前。
  //
  // findActualString 内部按顺序走：curly_quote → whitespace → curly_quote_whitespace。
  // 命中后我们仍要 indexOf 一次确定 (start, end) —— actualString 已经是原文件
  // 真实子串，indexOf 命中就是首处位置。
  const actualString = findActualString(content, search);
  if (actualString !== null) {
    const fuzzyIdx = content.indexOf(actualString);
    if (fuzzyIdx !== -1) {
      // 决定 strategy 字段：跟 actualString 跟 search 的差异类型对应
      // - 仅 quote 差异 → curly_quote
      // - 仅 tab/space 差异 → whitespace
      // - 都有 → curly_quote_whitespace
      const hasQuoteDiff =
        actualString.includes('\u2018') ||
        actualString.includes('\u2019') ||
        actualString.includes('\u201C') ||
        actualString.includes('\u201D') ||
        search.includes('\u2018') ||
        search.includes('\u2019') ||
        search.includes('\u201C') ||
        search.includes('\u201D');
      const hasWhitespaceDiff =
        actualString.includes('\t') !== search.includes('\t') ||
        actualString.length !== search.length;
      const strategy: MatchResult['strategy'] =
        hasQuoteDiff && hasWhitespaceDiff
          ? 'curly_quote_whitespace'
          : hasQuoteDiff
            ? 'curly_quote'
            : 'whitespace';
      return {
        match: {
          start: fuzzyIdx,
          end: fuzzyIdx + actualString.length,
          strategy,
        },
        lineTrimmedMatchCount: 0,
        actualString,
      };
    }
  }

  const origLines = content.split('\n');
  const searchLines = search.split('\n');
  if (searchLines[searchLines.length - 1] === '') searchLines.pop();
  if (searchLines.length === 0) {
    return { match: null, lineTrimmedMatchCount: 0, actualString: search };
  }

  let firstMatch: MatchResult | null = null;
  let firstMatchActualString = '';
  let count = 0;

  for (let i = 0; i <= origLines.length - searchLines.length; i++) {
    let ok = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (origLines[i + j].trim() !== searchLines[j].trim()) { ok = false; break; }
    }
    if (ok) {
      count++;
      if (!firstMatch) {
        let startChar = 0;
        for (let k = 0; k < i; k++) startChar += origLines[k].length + 1;
        let endChar = startChar;
        for (let k = 0; k < searchLines.length; k++) endChar += origLines[i + k].length + 1;
        firstMatch = { start: startChar, end: endChar, strategy: 'line_trimmed' };
        // line_trimmed actualString = 原文件命中区间的真实子串
        firstMatchActualString = content.substring(startChar, endChar);
      }
    }
  }

  return {
    match: firstMatch,
    lineTrimmedMatchCount: count,
    actualString: firstMatch ? firstMatchActualString : search,
  };
}

/** Count exact occurrences of `search` in `content`. */
function countOccurrences(content: string, search: string): number {
  return content.split(search).length - 1;
}

export const fileEditTool: AgentTool<FileEditInput, FileEditOutput> = {
  name: 'edit_file',
  riskLevel: 'review' as const,
  // Description 为 adapter 未装配时的 fallback。
  // adapter 层（packages/agent-runtime/src/tools/tabcode-adapter.ts）会 override 成
  // 完整 LLM-facing 版本（含 read-before-edit / line number prefix 提示等）——这层
  // 是 adapter 未装配时的 fallback，仅保持核心语义不漂移。
  //
  // 不含 "NEVER write new files" 之类的 write_file 语义——edit_file 的语义边界
  // 仅为"修改现有文件"，写新文件是另一工具的职责，混进 description 会让 LLM
  // 在工具间联想错位。
  description:
    '在已有文件里做精确字符串替换。如果 old_string 找不到或在文件里不唯一，编辑会失败（提供更多上下文让它唯一，或用 replace_all=true）。',
  parameters: {
    type: 'object',
    properties: {
      // 阶段 6.6 议题 3 翻译。
      path: { type: 'string', description: '文件路径。' },
      old_string: { type: 'string', description: '要查找的文本。' },
      new_string: { type: 'string', description: '替换后的文本。' },
      replace_all: { type: 'boolean', description: '替换所有出现位置。', default: false },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async execute(input: FileEditInput): Promise<FileEditOutput> {
    const filePath = input.path?.trim();
    if (!filePath) {
      return standardizeLegacyResult({ success: false, error: 'path is required', error_code: ToolErrorCode.INVALID_PARAMETER });
    }
    if (input.old_string === input.new_string) {
      return standardizeLegacyResult({ success: false, error: 'old_string and new_string must be different' });
    }

    try {
      const wsRoot = getWorkspaceRoot(input as any);
      const { workspaceRoots, alreadyJudged } = getWorkspaceAccessFromInput(input as any);
      const resolved = resolveInWorkspace(filePath, wsRoot);

      // CT-001 + CT-004: Enforce workspace boundary and security policy for edits
      const secError = checkFilePathSecurity('edit_file', resolved, workspaceRoots, alreadyJudged);
      if (secError) {
        return standardizeLegacyResult({ success: false, error: secError, error_code: ToolErrorCode.PERMISSION_DENIED });
      }

      try {
        const lstats = await fsPromises.lstat(resolved);
        if (lstats.isSymbolicLink()) {
          const realTarget = await fsPromises.readlink(resolved);
          const absTarget = path.isAbsolute(realTarget) ? realTarget : path.resolve(path.dirname(resolved), realTarget);
          const symlinkSecErr = checkFilePathSecurity('edit_file', absTarget, workspaceRoots, alreadyJudged);
          if (symlinkSecErr) {
            return standardizeLegacyResult({ success: false, error: `Symlink target blocked: ${symlinkSecErr}` });
          }
        }
      } catch (e: any) {
        if (e?.code !== 'ENOENT') throw e;
      }

      const editStat = await fsPromises.stat(resolved);
      if (editStat.size > MAX_TEXT_FILE_BYTES) {
        const sizeMB = (editStat.size / (1024 * 1024)).toFixed(1);
        return standardizeLegacyResult({
          success: false,
          error: `File too large for editing: ${sizeMB}MB (limit ${MAX_TEXT_FILE_BYTES / (1024 * 1024)}MB). Consider using terminal commands for large file modifications.`,
        });
      }

      const editExt = path.extname(resolved).toLowerCase();
      if (REJECT_BINARY_EXTS.has(editExt) || CONVERTIBLE_BINARY_EXTS.has(editExt) || MEDIA_BINARY_EXTS.has(editExt)) {
        return standardizeLegacyResult({
          success: false,
          error: `Cannot edit binary file (${editExt}). Binary files cannot be reliably modified as text.`,
          error_code: ToolErrorCode.UNSUPPORTED_OPERATION,
        });
      }
      if (editStat.size > 0) {
        const editFd = await fsPromises.open(resolved, 'r');
        try {
          const editHeadBuf = Buffer.alloc(Math.min(8000, editStat.size));
          await editFd.read(editHeadBuf, 0, editHeadBuf.length, 0);
          if (hasBinaryContent(editHeadBuf)) {
            return standardizeLegacyResult({
              success: false,
              error: 'File appears to be binary (contains null bytes). Binary files cannot be reliably modified as text.',
              error_code: ToolErrorCode.UNSUPPORTED_OPERATION,
            });
          }
        } finally {
          await editFd.close();
        }
      }

      const rawDiskContent = await fsPromises.readFile(resolved, 'utf8');

      // **W5 (2026-05-12) BOM + CRLF detect/preserve**：
      //
      // 两类磁盘格式差异让 LLM 给的 oldString 几乎必 miss：
      //   1. **UTF-8 BOM**：read_file 路径 `normalizeReadText` 已经剥 BOM 给
      //      LLM 看干净文本；edit 路径如果原样读盘，content 首字符是 `\uFEFF`，
      //      LLM 抄 read 输出写 old_string 不含 BOM → indexOf / fuzzy 都不命中。
      //   2. **CRLF / LF**：Windows 文件大多 CRLF，LLM 给 LF（训练数据 LF 占
      //      绝大多数）→ 同款 miss。
      //
      // 修法：read 后 detect BOM + line ending、strip 后用于匹配，写盘前还原。
      //   1. detect BOM / line ending → 保存到 originalHadBOM / originalEnding
      //   2. content 经 stripBOM + normalizeLineEndings → 干净 LF 形态
      //   3. oldString / newString 经 normalizeLineEndings → LF 形态（不会含
      //      BOM，因为 LLM 没机会看到它）
      //   4. 所有 indexOf / fuzzy / substitute 在 normalized 形态跑
      //   5. 写盘前 convertToLineEnding + restoreBOM 还原原文件协议
      //
      // 错误回显（"String: ${input.old_string}"）仍用 input 原始形态，让 LLM
      // 看到自己原话——LLM 可能给 CRLF / LF / mixed，错误回显原话能让它检查
      // 自己的输入而不是看 normalize 后的 LF 形态懵逼。
      const originalHadBOM = hasBOM(rawDiskContent);
      const originalEnding = detectLineEnding(rawDiskContent);
      const content = normalizeLineEndings(stripBOM(rawDiskContent));
      const oldStringNormalized = normalizeLineEndings(input.old_string);
      const newStringNormalized = normalizeLineEndings(input.new_string);

      // 关键：失败时**回显 LLM 给的 old_string**，让 LLM 看到自己写的字符串就能比对原文
      // 自纠错——这是非原生训练分布模型（Kimi/GLM 等）能从 hallucination 循环里出来的最强信号。
      //
      // **replace_all=true 路径只接受 Tier 1 exact 命中**（2026-05-09 W1 复核 P0-1 修订）：
      //   - line_trimmed 命中时 matchedText 含原文件缩进（含 trailing \n），用 matchedText
      //     做 split-join 时 new_string 不带缩进/\n 会让两段拼接处单词粘连（实测 case：
      //     `'  hello\n  world\n  hello\n  world\n'` + `old='hello\nworld'` + `new='hi\nthere'`
      //     + replace_all=true → 旧 F4 实现产出 `'hi\ntherehi\nthere'`，行结构破坏）。
      //   - 解决方案：让 replace_all=true 撞 line_trimmed 时直接报 "String to replace not
      //     found in file"——LLM 拿到回显的 old_string 后会重读文件、写带正确缩进的版本，
      //     走 exact 路径。
      //   - LLM 想"全替换不同缩进的版本"时必须分多次 edit_file 调用——这是诚实的取舍。
      if (input.replace_all) {
        if (!content.includes(oldStringNormalized)) {
          // W1-LL-8/9 R1（2026-05-10）：显式 set error_code 让 adapter 不靠
          // phrase 检测反推。phrase 检测在 read-file-state.ts 仍保留作老 entry /
          // 自创工具的兜底，但新 entry 优先吃精准 code → 更精准的 LLM
          // self-correction 信号。
          return standardizeLegacyResult({
            success: false,
            error: `String to replace not found in file.\nString: ${input.old_string}`,
            error_code: ToolErrorCode.OLD_STRING_NOT_FOUND,
          });
        }
        const parts = content.split(oldStringNormalized);
        const replacements = parts.length - 1;
        const newContent = parts.join(newStringNormalized);

        // 写入前最后保险栓——内容未变则失败。
        // 用 OLD_STRING_NOT_FOUND code：根因与"找不到"等价（LLM 给的 new_string
        // 跟文件 matched 区域字面相等），LLM 拿到的 self-correction 路径相同
        // （重读文件 + 重新生成有差异的 new_string）。
        if (newContent === content) {
          return standardizeLegacyResult({
            success: false,
            error: 'Original and edited file match exactly. Failed to apply edit.',
            error_code: ToolErrorCode.OLD_STRING_NOT_FOUND,
          });
        }

        // CRITICAL: no async ops between here and atomicWriteFile — 写盘临界区禁 await（FileEdit 同款不变量）
        // **文件并发安全 Wave 2 TOCTOU 二次校验**（2026-05-13 字节对照基线
        // A1-1 ~ A1-10）：在 atomicWriteFile 之前最后一刻同步校验 readFileState
        // 跟磁盘 mtime/content 一致 —— 防止「读盘 → match → 写盘」窗口期外部
        // 进程改文件被静默覆盖。复用已读盘的 normalized `content`（行 1401）
        // 做内容兜底比对；同步 stat 拿 floored mtime（A1-4 + B3-1）。
        //
        // **A1-3 同步 API**：必须用 `fs.statSync`（不能 `fsPromises.stat`）—
        // 违反「校验跟 atomicWriteFile 之间不能有 await」就让 Wave 2 校验失
        // 去意义（外部 await 期间真撞 stale 跑了校验也是滞后判断）。
        //
        // **A1-10 错误透传**：撞 stale → hook throw ToolStaleReadError →
        // catch 后用 ToolErrorCode.STALE_READ 显式构造 envelope return，
        // adapter 一侧 `mapActionErrorToRuntimeKind` 通过 `code === 'stale_read'`
        // 短路映射到 'tool_stale_read' + 同款 hint 字节级一致。
        //
        // **L-22 (Round 1 自修)**：statSync ENOENT 兜底跟 fileWriteTool（行
        // ~1095-1113）对称 —— `await fsPromises.readFile`（行 1436）成功到
        // `fs.statSync` 之间的极窄窗口内文件被删的边界场景。命中时跳过校验，
        // 沿用 await atomicWriteFile 走原 ENOENT 路径（外层 catch 转 unknown_error
        // 或者 atomicWriteFile 自己重新创建文件目录）。
        // **Wave 3 整体收尾 L-32 修复**：用 ValidateBeforeWriteHook 类型断言。
        const validate = (input as any)._validate_before_write as ValidateBeforeWriteHook | undefined;
        if (typeof validate === 'function') {
          let currentMtimeMs: number | undefined;
          try {
            currentMtimeMs = Math.floor(fs.statSync(resolved).mtimeMs);
          } catch (err: any) {
            if (err?.code !== 'ENOENT') throw err;
            // ENOENT：跳过校验，让 atomicWriteFile 沿用原 ENOENT 错误路径
          }
          if (currentMtimeMs !== undefined) {
            try {
              validate({
                filePath: resolved,
                currentMtimeMs,
                currentContent: content,
              });
            } catch (err) {
              if (err instanceof ToolStaleReadError) {
                // Round 1 technical reviewer M-1 修复：透传 err.path（基线 B5-1）
                return standardizeLegacyResult({
                  success: false,
                  error: err.message,
                  error_code: ToolErrorCode.STALE_READ,
                  path: err.path,
                });
              }
              throw err;
            }
          }
        }

        // CT-006: Atomic write to prevent partial-write corruption
        // **W5**：写盘前还原 line ending + BOM（如果文件原本是 CRLF / 含 BOM）。
        await atomicWriteFile(
          resolved,
          restoreBOM(convertToLineEnding(newContent, originalEnding), originalHadBOM),
          { encoding: 'utf8' },
        );

        const firstIdx = content.indexOf(oldStringNormalized);
        const startLine = content.substring(0, firstIdx).split('\n').length;
        // **W5**：返 ±4 行 context 的 unified diff snippet，让 Agent 看清改动整体
        // 形态。replace_all 多处改动只展示首处 hunk（其他靠 replacements 计数表
        // 达），避免 snippet 长度爆炸超 maxResultSizeChars。
        const snippet = getSnippetForPatch(content, newContent);
        return standardizeLegacyResult({
          success: true,
          data: {
            replacements,
            match_strategy: 'exact',
            file: resolved,
            start_line: startLine,
            end_line: startLine + oldStringNormalized.split('\n').length - 1,
            old_lines: oldStringNormalized.split('\n'),
            new_lines: newStringNormalized.split('\n'),
            snippet,
          },
        });
      }

      // 单次替换路径：先做 exact 多匹配检查，再走 findMatch（含 line_trimmed fallback）。
      // **W5**：用 normalized 形态（CRLF/LF 不影响 occurrence 计数）。
      const exactCount = countOccurrences(content, oldStringNormalized);
      if (exactCount > 1) {
        //   - 完整列出两个解决路径（replace_all=true / 加 context）
        //   - 回显 old_string，LLM 不必再 read_file 比对就能调整
        // W1-LL-8/9 R1：显式 set error_code（见 replace_all 分支注释）。
        return standardizeLegacyResult({
          success: false,
          error: `Found ${exactCount} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${input.old_string}`,
          error_code: ToolErrorCode.OLD_STRING_NOT_UNIQUE,
        });
      }

      const { match, lineTrimmedMatchCount, actualString } = findMatch(content, oldStringNormalized);
      if (!match) {
        return standardizeLegacyResult({
          success: false,
          error: `String to replace not found in file.\nString: ${input.old_string}`,
          error_code: ToolErrorCode.OLD_STRING_NOT_FOUND,
        });
      }

      // P1（Wave 1 复核修订）：line_trimmed 命中也要做 multi-match uniqueness 检查。
      // 否则 LLM 给无缩进 old_string、文件多处同样行结构 → 静默替换第一处，跟 exact 多
      // 匹配的待遇不一致，是另一种"假阳性 success"的隐藏路径。
      //
      // **W5 收尾轮 reviewer 修订 (2026-05-12)**：旧文案"set replace_all=true"对
      // line_trimmed / fuzzy 多匹配场景是**误导**——replace_all 路径只接受 exact
      // 命中（见上面 only-exact 分支注释），LLM 按文案 set replace_all=true 后会再
      // 次撞 OLD_STRING_NOT_FOUND 陷入死循环（reviewer S2 命中）。改成明确
      // 引导："提供更多上下文让 old_string 唯一"——避免 replace_all 误用。
      if (match.strategy === 'line_trimmed' && lineTrimmedMatchCount > 1) {
        return standardizeLegacyResult({
          success: false,
          error: `Found ${lineTrimmedMatchCount} matches of the string to replace (matched after whitespace normalization). Please provide more surrounding context (e.g. include adjacent unchanged lines verbatim from read_file output) to uniquely identify the target. Note: replace_all=true requires byte-exact old_string and won't accept fuzzy matches.\nString: ${input.old_string}`,
          error_code: ToolErrorCode.OLD_STRING_NOT_UNIQUE,
        });
      }

      // **W5 (2026-05-12) fuzzy 多匹配检查**：curly_quote / whitespace /
      // curly_quote_whitespace 命中后，actualString 已经是原文件真实存在的子串。
      // countOccurrences(content, actualString) 跟 exact 同一比较口径——能精确
      // 区分"文件里只有 1 处真实形态"vs"多处"，比 line_trimmed 的全文件扫描
      // 更准。
      //
      // **文案同 line_trimmed 修订**：明确告诉 LLM "replace_all 只接受 exact"，
      // 不要给死循环引导。
      if (
        match.strategy !== 'exact' &&
        match.strategy !== 'line_trimmed' &&
        countOccurrences(content, actualString) > 1
      ) {
        return standardizeLegacyResult({
          success: false,
          error: `Found ${countOccurrences(content, actualString)} matches of the string to replace (matched after ${match.strategy} normalization). Please provide more surrounding context to uniquely identify the target, or copy old_string byte-exactly from the file. Note: replace_all=true requires byte-exact old_string and won't accept fuzzy matches.\nString: ${input.old_string}`,
          error_code: ToolErrorCode.OLD_STRING_NOT_UNIQUE,
        });
      }

      const matchedText = content.substring(match.start, match.end);
      const newContent = content.substring(0, match.start) + newStringNormalized + content.substring(match.end);
      const startLine = content.substring(0, match.start).split('\n').length;

      // 写入前最后保险栓——内容未变则失败。
      //
      // 触发场景（**非**罕见 edge case）：
      // line_trimmed 命中时 matchedText 包含原文件的真实缩进；如果 LLM 复制原文输出
      // 来构造 new_string（很常见，例如 LLM 重读 file 后把整段 paste 当 new_string），
      // new_string 可能恰好等于 matchedText —— 整体替换出的内容跟原文件一字不差，
      // 表面 "成功" 实际 noop。本保险栓让这种 case 走显式 fail + 让 LLM 自纠错。
      // R1 复核（W1-LL-8/9 维度 3）：与 replace_all 路径同款保险栓 (line 1004)
      // 对称 set OLD_STRING_NOT_FOUND code。LLM 拿到的 self-correction 路径
      // 与"找不到"等价（重读文件 + 写有差异的 new_string），不依赖 phrase 兜底。
      if (newContent === content) {
        return standardizeLegacyResult({
          success: false,
          error: 'Original and edited file match exactly. Failed to apply edit.',
          error_code: ToolErrorCode.OLD_STRING_NOT_FOUND,
        });
      }

      // CRITICAL: no async ops between here and atomicWriteFile — 写盘临界区禁 await（FileEdit 同款不变量）
      // **文件并发安全 Wave 2 TOCTOU 二次校验** —— 见 replace_all 分支同款注释（行 ~1450）。
      // 两条写盘路径必须用**完全一致**的校验逻辑（基线 A1-1 ~ A1-10），任一漏掉
      // 就让其中一条路径裸奔。**L-22 (Round 1 自修)**：statSync ENOENT 兜底
      // 跟 replace_all 分支 + fileWriteTool 对称。
      // **Wave 3 整体收尾 L-32 修复**：用 ValidateBeforeWriteHook 类型断言。
      const validate2 = (input as any)._validate_before_write as ValidateBeforeWriteHook | undefined;
      if (typeof validate2 === 'function') {
        let currentMtimeMs2: number | undefined;
        try {
          currentMtimeMs2 = Math.floor(fs.statSync(resolved).mtimeMs);
        } catch (err: any) {
          if (err?.code !== 'ENOENT') throw err;
        }
        if (currentMtimeMs2 !== undefined) {
          try {
            validate2({
              filePath: resolved,
              currentMtimeMs: currentMtimeMs2,
              currentContent: content,
            });
          } catch (err) {
            if (err instanceof ToolStaleReadError) {
              // Round 1 technical reviewer M-1 修复：透传 err.path（基线 B5-1）
              return standardizeLegacyResult({
                success: false,
                error: err.message,
                error_code: ToolErrorCode.STALE_READ,
                path: err.path,
              });
            }
            throw err;
          }
        }
      }

      // CT-006: Atomic write to prevent partial-write corruption
      // **W5**：写盘前还原 line ending + BOM（如果文件原本是 CRLF / 含 BOM）。
      await atomicWriteFile(
        resolved,
        restoreBOM(convertToLineEnding(newContent, originalEnding), originalHadBOM),
        { encoding: 'utf8' },
      );
      // **W5**：返 ±4 行 context 的 unified diff snippet。
      const snippet = getSnippetForPatch(content, newContent);
      return standardizeLegacyResult({
        success: true,
        data: {
          replacements: 1,
          match_strategy: match.strategy,
          file: resolved,
          start_line: startLine,
          end_line: startLine + matchedText.split('\n').length - 1,
          old_lines: matchedText.split('\n'),
          new_lines: newStringNormalized.split('\n'),
          snippet,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return standardizeLegacyResult({ success: false, error: msg });
    }
  },
};

// ──────────────────────── delete_file ────────────────────────

export interface FileDeleteInput {
  path: string;
}

export interface FileDeleteOutput {
  success: boolean;
  error?: any;
}

export const FILE_DELETE_DESCRIPTION =
  '删除指定路径的单个文件。\n\n' +
  '用法：\n' +
  '- 仅支持删除文件；目录路径会被拒绝。\n' +
  '- 文件不存在时优雅失败（视为已删除，不报错）。\n' +
  '- 删除是不可恢复的，但本次对话的所有文件变更会被自动 checkpoint，可通过"撤销这次 AI 操作"回退。';

export const fileDeleteTool: AgentTool<FileDeleteInput, FileDeleteOutput> = {
  name: 'delete_file',
  riskLevel: 'strict' as const,
  // **2026-05-13 重写**：`Delete` 工具风格——简短中文 + graceful
  // failure 三条原因，明确"仅单文件"边界。
  //
  // 设计原则（CLI-first）：
  //   - 文件读写删是 LLM 跟磁盘交互的底层通道，description 越短越好
  //   - 不暴露内部实现（hardline / sandbox / Checkpoint）—— 工具协议给 LLM 看
  //   - 撤销心智不在工具里，在 Checkpoint 体系（Shadow Git per-turn commit）
  //
  // **退役的设计**：
  //   - 旧版有 `~/.tabtin/trash/<timestamp>_<basename>` 本地备份机制——无元
  //     数据 / 无 sessionId 关联 / 无过期清理 / 无 UI 入口。Checkpoint 已经
  //     兜住所有 fs 变更（包括 delete），trash 永久没人会用 = 冗余。
  //   - 备份失败的 console.warn 同步退役（没备份就没 warn 噪音）。
  description: FILE_DELETE_DESCRIPTION,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要删除的文件绝对路径或相对工作目录根的路径。' },
    },
    required: ['path'],
  },
  async execute(input: FileDeleteInput): Promise<FileDeleteOutput> {
    const filePath = input.path?.trim();
    if (!filePath) {
      return standardizeLegacyResult({ success: false, error: 'path is required', error_code: ToolErrorCode.INVALID_PARAMETER });
    }

    try {
      const wsRoot = getWorkspaceRoot(input as any);
      const { workspaceRoots, alreadyJudged } = getWorkspaceAccessFromInput(input as any);
      const resolved = resolveInWorkspace(filePath, wsRoot);

      // CT-001 + CT-004: Enforce workspace boundary and security policy for deletes
      const secError = checkFilePathSecurity('delete_file', resolved, workspaceRoots, alreadyJudged);
      if (secError) {
        return standardizeLegacyResult({ success: false, error: secError, error_code: ToolErrorCode.PERMISSION_DENIED });
      }

      try {
        const lstats = await fsPromises.lstat(resolved);
        // **2026-05-13 重做 "仅单文件" 边界**：
        // 命中目录时显式拒绝；不在错误结果里教授绕过单文件边界的递归删除命令。
        // 旧实现走 fs.unlink(dir) 必失败为 EISDIR / EPERM，错误从底层 fs error
        // 透出去 LLM 难诊断（macOS 上 unlink 目录返 EPERM 而不是 EISDIR）。
        // 提前显式判断 + 明确文案让 LLM 直接走对的工具，少一轮往返。
        if (lstats.isDirectory()) {
          return standardizeLegacyResult({
            success: false,
            error: `Path is a directory, not a file: '${resolved}'. Directory deletion is not supported by this tool.`,
            error_code: ToolErrorCode.UNSUPPORTED_OPERATION,
          });
        }
        if (lstats.isSymbolicLink()) {
          const realTarget = await fsPromises.readlink(resolved);
          const absTarget = path.isAbsolute(realTarget) ? realTarget : path.resolve(path.dirname(resolved), realTarget);
          const symlinkSecErr = checkFilePathSecurity('delete_file', absTarget, workspaceRoots, alreadyJudged);
          if (symlinkSecErr) {
            return standardizeLegacyResult({ success: false, error: `Symlink target blocked: ${symlinkSecErr}` });
          }
        }
      } catch (e: any) {
        if (e?.code !== 'ENOENT') throw e;
      }

      // **2026-05-13 退役 trash 备份**：删除直接走 unlink，撤销靠 Checkpoint
      // 体系（Shadow Git per-turn commit + ChatMessage.checkpoint_hash 三层
      // 聚合）—— 比 trash 强大得多，且对用户可见（"撤销这次 AI 操作"面板）。
      // 旧 trash 路径：`~/.tabtin/trash/<timestamp>_<basename>`，存在但无人使
      // 用，磁盘累积。getHomeTabtinPath('trash') import 同步保留——其他模块
      // 可能也用 trash 子目录，本工具内不再消费即可。
      await fsPromises.unlink(resolved);
      return standardizeLegacyResult({ success: true, data: { path: resolved } });
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        return standardizeLegacyResult({ success: true, data: { already_deleted: true } });
      }
      const msg = err instanceof Error ? err.message : String(err);
      return standardizeLegacyResult({ success: false, error: msg });
    }
  },
};

// ──────────────────────── mkdir ────────────────────────
// W2a：`tabtin code mkdir` 落地。语义对齐 `mkdir -p`——递归创建、
// 目标已是目录时幂等成功；目标已存在但不是目录（撞文件）时拒绝（默认不覆盖，
// `--force` 覆盖语义留作 follow-up，见  W2a 范围备注）。

export interface CodeMkdirInput {
  path: string;
}

export interface CodeMkdirOutput {
  success: boolean;
  data?: Record<string, any>;
  error?: any;
}

export const codeMkdirTool: AgentTool<CodeMkdirInput, CodeMkdirOutput> = {
  name: 'mkdir',
  riskLevel: 'review' as const,
  description:
    '创建目录（递归创建缺失的父目录，类似 `mkdir -p`）。目标已是目录时视为成功（幂等）；' +
    '目标已存在但是文件时报错。不支持覆盖已有文件。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要创建的目录路径。' },
    },
    required: ['path'],
  },
  async execute(input: CodeMkdirInput): Promise<CodeMkdirOutput> {
    const dirPath = input.path?.trim();
    if (!dirPath) {
      return standardizeLegacyResult({ success: false, error: 'path is required', error_code: ToolErrorCode.INVALID_PARAMETER });
    }

    try {
      const wsRoot = getWorkspaceRoot(input as any);
      const { workspaceRoots, alreadyJudged } = getWorkspaceAccessFromInput(input as any);
      const resolved = resolveInWorkspace(dirPath, wsRoot);

      const secError = checkFilePathSecurity('mkdir', resolved, workspaceRoots, alreadyJudged);
      if (secError) {
        return standardizeLegacyResult({ success: false, error: secError, error_code: ToolErrorCode.PERMISSION_DENIED });
      }

      //  同款兜底：执行根被改名/删除后不允许在旧路径上"复活"目录。
      const rootMissingError = await assertWorkspaceRootsPresent(wsRoot, workspaceRoots, resolved);
      if (rootMissingError) {
        return standardizeLegacyResult({
          success: false,
          error: rootMissingError,
          error_code: ToolErrorCode.INVALID_PARAMETER,
        });
      }

      try {
        const st = await fsPromises.lstat(resolved);
        if (st.isDirectory()) {
          return standardizeLegacyResult({ success: true, data: { path: resolved, already_exists: true } });
        }
        return standardizeLegacyResult({
          success: false,
          error: `Path already exists and is not a directory: '${resolved}'`,
          error_code: ToolErrorCode.INVALID_PARAMETER,
        });
      } catch (e: any) {
        if (e?.code !== 'ENOENT') throw e;
      }

      await fsPromises.mkdir(resolved, { recursive: true });
      return standardizeLegacyResult({ success: true, data: { path: resolved } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return standardizeLegacyResult({ success: false, error: msg });
    }
  },
};

// ──────────────────────── move_file ────────────────────────
// W2a：`tabtin code mv|rename` 落地为同一工具 `move_file`
// （rename 是 mv 的别名：CLI/route 层都映射到本工具，语义完全相同——
// 唯一区别是用户心智："rename" 强调同目录改名，"mv" 强调跨目录搬移，
// 底层都是 fs.rename）。

export interface CodeMoveFileInput {
  from: string;
  to: string;
}

export interface CodeMoveFileOutput {
  success: boolean;
  data?: Record<string, any>;
  error?: any;
}

export const codeMoveFileTool: AgentTool<CodeMoveFileInput, CodeMoveFileOutput> = {
  name: 'move_file',
  riskLevel: 'review' as const,
  description:
    '移动或重命名文件/目录（`from` → `to`）。目标存在时报错（默认不覆盖，' +
    '不支持 --force）。不允许把路径移动到自身子树内。目标的父目录不存在时会自动创建。',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: '源路径。' },
      to: { type: 'string', description: '目标路径。' },
    },
    required: ['from', 'to'],
  },
  async execute(input: CodeMoveFileInput): Promise<CodeMoveFileOutput> {
    const fromPath = input.from?.trim();
    const toPath = input.to?.trim();
    if (!fromPath || !toPath) {
      return standardizeLegacyResult({
        success: false,
        error: 'from and to are both required',
        error_code: ToolErrorCode.INVALID_PARAMETER,
      });
    }

    try {
      const wsRoot = getWorkspaceRoot(input as any);
      const { workspaceRoots, alreadyJudged } = getWorkspaceAccessFromInput(input as any);
      const resolvedFrom = resolveInWorkspace(fromPath, wsRoot);
      const resolvedTo = resolveInWorkspace(toPath, wsRoot);

      const secErrorFrom = checkFilePathSecurity('move_file', resolvedFrom, workspaceRoots, alreadyJudged);
      if (secErrorFrom) {
        return standardizeLegacyResult({ success: false, error: secErrorFrom, error_code: ToolErrorCode.PERMISSION_DENIED });
      }
      const secErrorTo = checkFilePathSecurity('move_file', resolvedTo, workspaceRoots, alreadyJudged);
      if (secErrorTo) {
        return standardizeLegacyResult({ success: false, error: secErrorTo, error_code: ToolErrorCode.PERMISSION_DENIED });
      }

      const rootMissingError =
        (await assertWorkspaceRootsPresent(wsRoot, workspaceRoots, resolvedFrom)) ??
        (await assertWorkspaceRootsPresent(wsRoot, workspaceRoots, resolvedTo));
      if (rootMissingError) {
        return standardizeLegacyResult({
          success: false,
          error: rootMissingError,
          error_code: ToolErrorCode.INVALID_PARAMETER,
        });
      }

      // 禁移入自身子树：`to` 等于或落在 `from` 的子树内（`from` 是目录时才可能命中）。
      const normalizedFrom = path.resolve(resolvedFrom);
      const normalizedTo = path.resolve(resolvedTo);
      if (normalizedTo === normalizedFrom || normalizedTo.startsWith(normalizedFrom + path.sep)) {
        return standardizeLegacyResult({
          success: false,
          error: `Cannot move '${normalizedFrom}' into its own subtree ('${normalizedTo}').`,
          error_code: ToolErrorCode.INVALID_PARAMETER,
        });
      }

      try {
        await fsPromises.lstat(resolvedFrom);
      } catch (e: any) {
        if (e?.code === 'ENOENT') {
          return standardizeLegacyResult({
            success: false,
            error: `Source path does not exist: '${resolvedFrom}'`,
            error_code: ToolErrorCode.FILE_NOT_FOUND,
          });
        }
        throw e;
      }

      // 默认不覆盖：目标已存在（文件或目录）直接拒绝，引导 Agent 先手动处理冲突。
      try {
        await fsPromises.lstat(resolvedTo);
        return standardizeLegacyResult({
          success: false,
          error: `Destination already exists: '${resolvedTo}'. Move does not overwrite by default.`,
          error_code: ToolErrorCode.INVALID_PARAMETER,
        });
      } catch (e: any) {
        if (e?.code !== 'ENOENT') throw e;
      }

      await fsPromises.mkdir(path.dirname(resolvedTo), { recursive: true });
      try {
        await fsPromises.rename(resolvedFrom, resolvedTo);
      } catch (err: any) {
        // EXDEV：跨文件系统/跨盘符（Windows 常见）rename 直接失败，需要
        // copy+delete 兜底。目录场景用 cp -r 语义太重（且 Node 12 起才有
        // fs.cp），这里只兜底文件场景；目录跨盘移动报错引导用户走
        // run_terminal_command。
        if (err?.code === 'EXDEV') {
          const st = await fsPromises.lstat(resolvedFrom);
          if (st.isDirectory()) {
            return standardizeLegacyResult({
              success: false,
              error:
                `Cannot move directory across filesystems/drives: '${resolvedFrom}' -> '${resolvedTo}'. ` +
                `Use run_terminal_command to move directories across drives.`,
              error_code: ToolErrorCode.UNSUPPORTED_OPERATION,
            });
          }
          // Quality review 修复：上面的 lstat(resolvedTo) TOCTOU 窗口到这里可能已被
          // 另一进程抢先创建 `to`。`COPYFILE_EXCL` 让 copyFile 本身原子地拒绝覆盖
          // （而不是先 lstat 判断再 copy——那样中间仍有竞态），命中时映射成跟入口
          // 校验一致的"目标已存在"错误，不静默覆盖。
          try {
            await fsPromises.copyFile(resolvedFrom, resolvedTo, fs.constants.COPYFILE_EXCL);
          } catch (copyErr: any) {
            if (copyErr?.code === 'EEXIST') {
              return standardizeLegacyResult({
                success: false,
                error: `Destination already exists: '${resolvedTo}'. Move does not overwrite by default.`,
                error_code: ToolErrorCode.INVALID_PARAMETER,
              });
            }
            // copy 中途失败（磁盘满/权限/IO 错误等）可能已在目标位置留下部分写入的
            // 文件——清理掉避免留下损坏的半成品，源文件此时仍完好未删。
            try {
              await fsPromises.unlink(resolvedTo);
            } catch {
              // 清理失败不掩盖原始错误——忽略即可，下面照常 rethrow copyErr。
            }
            throw copyErr;
          }
          await fsPromises.unlink(resolvedFrom);
        } else {
          throw err;
        }
      }

      return standardizeLegacyResult({ success: true, data: { from: resolvedFrom, to: resolvedTo } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return standardizeLegacyResult({ success: false, error: msg });
    }
  },
};

// ──────────────────────── glob_search ────────────────────────

export interface CodeGlobInput {
  glob_pattern: string;
  target_directory?: string | null;
  include_ignored?: boolean | null;
}

export interface CodeGlobOutput {
  success: boolean;
  data?: Record<string, any>;
  error?: any;
}

function isFalsyEnv(value: string | undefined): boolean {
  const normalized = (value ?? '').toLowerCase();
  return normalized === 'false' || normalized === '0' || normalized === 'no';
}

function isTruthyEnv(value: string | undefined): boolean {
  const normalized = (value ?? '').toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

// T2-B1 (2026-05-12)：按 ripgrep `--files` 思路拆
// 绝对 glob pattern。ripgrep `--glob` 只接受相对 pattern；用户/LLM 传绝对路径
// glob 时必须拆成 searchDir + relative pattern。这里避免 JSDoc：`**/` 会形成 `*/`。
function extractGlobBaseDirectory(pattern: string): { baseDir: string; relativePattern: string } {
  const globChars = /[*?[{]/;
  const match = pattern.match(globChars);
  if (!match || match.index === undefined) {
    return { baseDir: path.dirname(pattern), relativePattern: path.basename(pattern) };
  }

  const staticPrefix = pattern.slice(0, match.index);
  const lastSepIndex = Math.max(
    staticPrefix.lastIndexOf('/'),
    staticPrefix.lastIndexOf(path.sep),
  );

  if (lastSepIndex === -1) {
    return { baseDir: '', relativePattern: pattern };
  }

  let baseDir = staticPrefix.slice(0, lastSepIndex);
  const relativePattern = pattern.slice(lastSepIndex + 1);
  if (baseDir === '' && lastSepIndex === 0) baseDir = '/';
  if (process.platform === 'win32' && /^[A-Za-z]:$/.test(baseDir)) {
    baseDir = baseDir + path.sep;
  }
  return { baseDir, relativePattern };
}

function normalizeGlobPatternForRipgrep(pattern: string): string {
  return pattern.startsWith('**/') ? pattern : `**/${pattern}`;
}

// T2-B1 final reviewer 修正：不能把正向 pattern 传给 `rg --glob`，因为 ripgrep 的
// 正向 `--glob` 会把 `.gitignore` 忽略的文件重新 whitelist 出来。默认尊重 ignore
// 的实现必须是：`rg --files` 负责高性能遍历 + 本地 matcher 过滤 pattern。
// 这里恢复原轻量 matcher（只用于过滤 rg 输出，不再用于 walkDir）。
function globToRegex(pattern: string): RegExp {
  let src = pattern;
  src = src.replace(/\{([^}]+)\}/g, (_m, inner: string) => {
    const alts = inner.split(',').map((s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\*/g, '*').replace(/\\\?/g, '?'));
    return `(${alts.join('|')})`;
  });
  let result = '';
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '*' && src[i + 1] === '*') {
      if (src[i + 2] === '/') { result += '(.+/)?'; i += 2; }
      else { result += '.*'; i += 1; }
    } else if (src[i] === '*') {
      result += '[^/]*';
    } else if (src[i] === '?') {
      result += '[^/]';
    } else if ('()'.includes(src[i])) {
      result += src[i];
    } else if (src[i] === '|' && result.includes('(')) {
      result += '|';
    } else if (/[.+^${}[\]\\|]/.test(src[i])) {
      result += '\\' + src[i];
    } else {
      result += src[i];
    }
  }
  return new RegExp(`^${result}$`);
}

// T2-B1 (2026-05-12)：glob_search 底层从手写 `walkDir + globToRegex` 换成
// ripgrep `--files`，ripgrep `--files` 遍历底座。
//
// 保留 TabTin 既有外部语义：
// - `*.ts` 自动递归匹配 workspace 下所有 ts 文件
// - 默认排除 node_modules / VCS 元数据 / 系统文件
// - 返回相对 base cwd 的路径，按 `/` 分隔
//
// glob 底层语义：
// - 默认尊重 `.gitignore`，避免 dist/build/open-source 等产物淹没前 100 条；需要时可显式 include_ignored
// - 默认 `--hidden`，让 `.vscode/.cursor/.github/.env*` 可搜（可 `TABTIN_GLOB_HIDDEN=false` 关闭）
// - 生产用 `--sortr=modified` 保持 TabTin 既有"最新在前"承诺；测试环境用 `--sort=path` 稳定排序
async function globSearch(pattern: string, cwd: string, includeIgnored = false): Promise<string[]> {
  let searchDir = cwd;
  let searchPattern = pattern;

  if (isUncPath(pattern)) {
    throw new Error('UNC paths are not supported for glob_pattern (security: avoids SMB/NTLM access).');
  }

  if (path.isAbsolute(pattern)) {
    const { baseDir, relativePattern } = extractGlobBaseDirectory(pattern);
    if (baseDir) {
      searchDir = resolveInWorkspace(baseDir, cwd);
      searchPattern = relativePattern;
    }
  }

  const relSearchDir = path.relative(cwd, searchDir);
  if (relSearchDir.startsWith('..') || path.isAbsolute(relSearchDir)) {
    throw new Error(`Glob pattern base directory is outside the search directory: ${pattern}`);
  }

  const normalizedPattern = normalizeGlobPatternForRipgrep(searchPattern);
  const regex = globToRegex(normalizedPattern);
  const args = [
    '--files',
    // 部分实现用 `--sort=modified`，但 ripgrep 该方向是旧文件在前；TabTin
    // description/旧实现一直承诺"最新的在前"，所以生产用 reverse sort。
    process.env.NODE_ENV === 'test' ? '--sort=path' : '--sortr=modified',
  ];

  if (includeIgnored || isTruthyEnv(process.env.TABTIN_GLOB_INCLUDE_IGNORED)) {
    args.push('--no-ignore');
  }
  if (!isFalsyEnv(process.env.TABTIN_GLOB_HIDDEN)) {
    args.push('--hidden');
  }

  for (const dir of GLOB_DIRECTORIES_TO_EXCLUDE) {
    args.push('--glob', `!${dir}`);
  }
  for (const file of GLOB_FILES_TO_EXCLUDE) {
    args.push('--glob', `!${file}`);
  }

  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      _rgBinary,
      args,
      { cwd: searchDir, maxBuffer: 10 * 1024 * 1024, timeout: 15000 },
      (err, stdout, stderr) => {
        if (!err) {
          resolve(stdout);
          return;
        }
        const execErr = err as any;
        if (execErr.code === 1 || execErr.status === 1) {
          resolve(stdout || '');
          return;
        }
        reject(new Error(stderr || err.message));
      },
    );
  });

  return output
    .trim()
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter(Boolean)
    .map((line) => {
      const abs = path.resolve(searchDir, line);
      return path.relative(cwd, abs).replace(/\\/g, '/');
    })
    .filter((rel) => regex.test(rel));
}

export const codeGlobTool: AgentTool<CodeGlobInput, CodeGlobOutput> = {
  name: 'glob_search',
  riskLevel: 'safe' as const,
  description: '在工作目录内按 glob 模式搜文件。按修改时间排序返回匹配的文件路径。按文件名模式找文件时用本工具。',
  parameters: {
    type: 'object',
    properties: {
      // 阶段 6.6 议题 3 翻译。保留 rg --no-ignore / .gitignore 等术语。
      glob_pattern: { type: 'string', description: 'glob 模式。' },
      target_directory: { type: 'string', description: '搜索目录。' },
      include_ignored: { type: 'boolean', description: '包含被 .gitignore 忽略的文件（rg --no-ignore）。' },
    },
    required: ['glob_pattern'],
  },
  async execute(input: CodeGlobInput): Promise<CodeGlobOutput> {
    const pattern = input.glob_pattern?.trim();
    if (!pattern) {
      return standardizeLegacyResult({ success: false, error: 'glob_pattern is required', error_code: ToolErrorCode.INVALID_PARAMETER });
    }

    const rgError = ensureRipgrepAvailable();
    if (rgError) {
      return standardizeLegacyResult({ success: false, error: rgError });
    }

    // T2-B1：换 ripgrep 后不再需要旧 `globToRegex` 的 wildcard 防 ReDoS 上限；
    // pattern 只保留宽松长度保护，避免 LLM 误传整段文件内容当 glob。
    const MAX_GLOB_LEN = 2048;
    if (pattern.length > MAX_GLOB_LEN) {
      return standardizeLegacyResult({ success: false, error: `Glob pattern too long: ${pattern.length} chars (max ${MAX_GLOB_LEN})` });
    }

    try {
      const wsRoot = getWorkspaceRoot(input as any);

      if (isUncPath(input.target_directory)) {
        return standardizeLegacyResult({
          success: false,
          error: 'UNC paths are not supported for glob_search target_directory (security: avoids SMB/NTLM access).',
          error_code: ToolErrorCode.PERMISSION_DENIED,
        });
      }
      if (isUncPath(pattern)) {
        return standardizeLegacyResult({
          success: false,
          error: 'UNC paths are not supported for glob_search glob_pattern (security: avoids SMB/NTLM access).',
          error_code: ToolErrorCode.PERMISSION_DENIED,
        });
      }

      const cwd = input.target_directory ? resolveInWorkspace(input.target_directory, wsRoot) : wsRoot;

      // W4 Lane F：target_directory 不存在 / 不是目录 → fail（不再 silent
      // 0 results success）。
      if (input.target_directory) {
        const check = await checkSearchPathExists(
          input.target_directory,
          cwd,
          wsRoot,
          /* mustBeDirectory */ true,
        );
        if (!check.ok) {
          return standardizeLegacyResult({
            success: false,
            error: check.error,
            error_code: ToolErrorCode.INVALID_PARAMETER,
          });
        }
      }

      const files = await globSearch(pattern, cwd, Boolean(input.include_ignored));
      return standardizeLegacyResult({ success: true, data: { files } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return standardizeLegacyResult({ success: false, error: msg });
    }
  },
};

// ──────────────────────── grep_search ────────────────────────

let _rgAvailable: boolean | null = null;
let _rgBinary: string = 'rg';

/**
 * 把 Electron `app.asar/...` 路径改成 `app.asar.unpacked/...`。
 * `child_process` 不能执行 asar 内二进制（典型错误 `spawn ENOTDIR`）；
 * Electron 的 `fs.existsSync` 还会对 asar 路径撒谎返回 true。
 */
export function mapAppAsarPathToUnpacked(filePath: string): string {
  if (!APP_ASAR_SEGMENT_RE.test(filePath)) return filePath;
  return filePath.replace(APP_ASAR_SEGMENT_RE, 'app.asar.unpacked');
}

function ripgrepBinaryName(): string {
  return process.platform === 'win32' ? 'rg.exe' : 'rg';
}

function ripgrepPlatformPackageName(): string {
  return `@vscode/ripgrep-${process.platform}-${process.arch}`;
}

function collectRipgrepPathCandidates(): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | null | undefined) => {
    if (typeof value !== 'string' || value.length === 0) return;
    const mapped = mapAppAsarPathToUnpacked(value);
    if (seen.has(mapped)) return;
    seen.add(mapped);
    candidates.push(mapped);
  };

  // 1) 打包态优先：resourcesPath 下已 asarUnpack 的真实文件（不依赖 asar 虚路径）
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (typeof resourcesPath === 'string' && resourcesPath.length > 0) {
    const binaryName = ripgrepBinaryName();
    const platformPkg = ripgrepPlatformPackageName();
    push(path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', platformPkg, 'bin', binaryName));
    // 旧 @vscode/ripgrep 把二进制放在自身 bin/ 下（1.18 前）
    push(path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', '@vscode', 'ripgrep', 'bin', binaryName));
  }

  // 2) @vscode/ripgrep 官方入口（开发态 / 部分打包态）
  // createRequire(import.meta.url) 不依赖 esbuild 的破 __require polyfill（tsup banner /
  // Electron 主进程 ESM 打包后全局 require 可能不存在）。
  try {
    const mod = requireFromThisModule('@vscode/ripgrep') as { rgPath?: string };
    push(mod?.rgPath);
  } catch {
    // optional / unresolved — try next strategy
  }
  try {
    push(requireFromThisModule.resolve(`${ripgrepPlatformPackageName()}/bin/${ripgrepBinaryName()}`));
  } catch {
    // platform optionalDependency missing
  }

  return candidates;
}

/**
 * 解析可实际 spawn 的 bundled rg 路径。导出供单测钉死 asar 映射与候选顺序。
 */
export function resolveBundledRipgrepPath(): string | null {
  for (const candidate of collectRipgrepPathCandidates()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore transient fs errors and keep trying
    }
  }
  return null;
}

function ensureRipgrepAvailable(): string | null {
  if (_rgAvailable === true) return null;

  const installHint = 'ripgrep (rg) is not installed. '
    + (process.platform === 'win32'
      ? 'Install via: winget install BurntSushi.ripgrep.MSVC  or  choco install ripgrep'
      : process.platform === 'darwin'
        ? 'Install via: brew install ripgrep'
        : 'Install via your package manager, e.g. apt install ripgrep');

  if (_rgAvailable === false) {
    return installHint;
  }

  const bundled = resolveBundledRipgrepPath();
  if (bundled) {
    _rgBinary = bundled;
    _rgAvailable = true;
    return null;
  }

  try {
    const { execFileSync } = requireFromThisModule('node:child_process') as typeof import('node:child_process');
    execFileSync(process.platform === 'win32' ? 'where' : 'which', ['rg'], { timeout: 3000, stdio: 'pipe' });
    _rgBinary = 'rg';
    _rgAvailable = true;
    return null;
  } catch {
    _rgAvailable = false;
    return installHint;
  }
}

/** 单测重置模块级 rg 缓存，避免用例互相污染。 */
export function __resetRipgrepStateForTests(): void {
  _rgAvailable = null;
  _rgBinary = 'rg';
}

export interface CodeGrepInput {
  pattern: string;
  path?: string | null;
  glob?: string | null;
  type?: string | null;
  case_insensitive?: boolean;
  context_lines?: number | null;
  after_context?: number | null;
  before_context?: number | null;
  multiline?: boolean;
  output_mode?: string;
  max_results?: number | null;
}

export interface CodeGrepOutput {
  success: boolean;
  data?: Record<string, any>;
  error?: any;
}

const GREP_OUTPUT_MODE_DESCRIPTION =
  '输出模式。默认 `files_with_matches`，只返回命中文件路径；' +
  '`content` 返回文件路径、行号和命中行内容；' +
  '`count` 只返回每个文件的匹配次数。需要查看命中行文本时必须传 `content`。';

export const codeGrepTool: AgentTool<CodeGrepInput, CodeGrepOutput> = {
  name: 'grep_search',
  riskLevel: 'safe' as const,
  description: '用 ripgrep 搜文件内容，支持完整 regex 语法。可用 glob 参数过滤文件或限定子目录。输出模式：「content」（匹配行）/「files_with_matches」（仅路径）/「count」（匹配次数）。',
  parameters: {
    type: 'object',
    properties: {
      // 阶段 6.6 议题 3 翻译。保留 rg flag / glob 字面量 / output_mode 枚举。
      pattern: { type: 'string', description: '要搜索的 regex 模式。' },
      path: { type: 'string', description: '搜索路径（文件或目录）。' },
      glob: { type: 'string', description: '文件过滤 glob，譬如 `*.ts` / `*.{ts,tsx}`。' },
      type: { type: 'string', description: '文件类型过滤（rg --type），譬如 `js` / `py` / `rust`。' },
      case_insensitive: { type: 'boolean', description: '大小写不敏感搜索（rg -i）。', default: false },
      context_lines: { type: 'number', description: '每个匹配前后的上下文行数（rg -C）。' },
      after_context: { type: 'number', description: '每个匹配后的行数（rg -A）。' },
      before_context: { type: 'number', description: '每个匹配前的行数（rg -B）。' },
      multiline: { type: 'boolean', description: '启用多行匹配（rg -U，让 `.` 也匹配换行）。', default: false },
      output_mode: {
        type: 'string',
        enum: [...GREP_OUTPUT_MODES],
        description: GREP_OUTPUT_MODE_DESCRIPTION,
      },
      max_results: { type: 'number', description: '每个文件最多返回多少匹配。' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  async execute(input: CodeGrepInput): Promise<CodeGrepOutput> {
    const searchPattern = input.pattern?.trim();
    if (!searchPattern) {
      return standardizeLegacyResult({ success: false, error: 'pattern is required', error_code: ToolErrorCode.INVALID_PARAMETER });
    }
    if (
      input.output_mode !== undefined &&
      !GREP_OUTPUT_MODES.includes(input.output_mode as (typeof GREP_OUTPUT_MODES)[number])
    ) {
      return standardizeLegacyResult({
        success: false,
        error: `Invalid output_mode '${String(input.output_mode)}'. Expected one of: ${GREP_OUTPUT_MODES.join(', ')}.`,
        error_code: ToolErrorCode.INVALID_PARAMETER,
      });
    }

    const rgError = ensureRipgrepAvailable();
    if (rgError) {
      return standardizeLegacyResult({ success: false, error: rgError });
    }

    try {
      const args: string[] = ['--no-heading', '--line-number', '--color', 'never'];

      if (input.case_insensitive) args.push('-i');
      if (input.multiline) args.push('-U', '--multiline-dotall');

      // RP-019: cap context lines to prevent excessive output
      if (input.context_lines != null && input.context_lines > 0) {
        args.push('-C', String(Math.min(input.context_lines, MAX_CONTEXT_LINES)));
      } else {
        if (input.after_context != null && input.after_context > 0) {
          args.push('-A', String(Math.min(input.after_context, MAX_CONTEXT_LINES)));
        }
        if (input.before_context != null && input.before_context > 0) {
          args.push('-B', String(Math.min(input.before_context, MAX_CONTEXT_LINES)));
        }
      }

      if (input.output_mode === 'files_with_matches') {
        args.push('-l');
      } else if (input.output_mode === 'count') {
        args.push('-c');
      }

      // RP-014: enforce max_results with upper bound (always set -m)
      const effectiveMaxResults = Math.min(
        Math.max(1, input.max_results ?? MAX_RESULTS_DEFAULT),
        MAX_RESULTS_CEILING,
      );
      args.push('-m', String(effectiveMaxResults));

      if (input.glob) {
        // T2-C7 (2026-05-12)：智能 split glob 参数。
        //
        // **场景**：LLM 习惯传 `glob: "*.ts *.tsx"`（空格）或 `glob: "*.ts,*.tsx"`
        // （逗号）想表达"同时匹配多种扩展名"。
        // 原实现一次只传一个 `--glob` flag → ripgrep 把整串当单个 pattern fail。
        //
        // **算法**：先按空格 split，每段如果含花括号（如 `*.{ts,tsx}`）整段保留，
        // 否则再按逗号 split。每个非空 pattern 独立 push 一次 `--glob`。
        const globPatterns: string[] = [];
        const rawPatterns = input.glob.split(/\s+/);
        for (const rawPattern of rawPatterns) {
          if (rawPattern.includes('{') && rawPattern.includes('}')) {
            globPatterns.push(rawPattern);
          } else {
            // T2 final R2 (L4)：split 后 trim，避免 LLM 用 "*.ts, *.tsx" 留下 " *.tsx" 前导空格
            // 让 ripgrep 收到 ` *.tsx` 这种带空格无效 pattern 直接 0 匹配
            globPatterns.push(
              ...rawPattern.split(',').map((s) => s.trim()).filter(Boolean),
            );
          }
        }
        for (const globPattern of globPatterns.filter(Boolean)) {
          args.push('--glob', globPattern);
        }
      }
      if (input.type) {
        args.push('--type', input.type);
      }

      // RP-015: skip large binary files
      args.push('--max-filesize', '1M');
      // RP-016: limit per-line output length
      args.push('--max-columns', '500', '--max-columns-preview');

      // T2 follow-up B2 (2026-05-12)：默认开 `--hidden`。
      //
      // **场景**：LLM 跑 grep 找 `.vscode/settings.json` / `.cursor/rules/*` /
      // `.github/workflows/*` / `.env*` 等隐藏目录的配置——TabTin 之前不传 `--hidden`
      // ripgrep 默认跳过隐藏路径 → LLM 看到 0 匹配误判"不存在"，转去 read_file 兜底
      // 多花一轮上下文。VCS 元数据噪音由上面的 `VCS_DIRECTORIES_TO_EXCLUDE` 显式排除
      // 已经处理掉，所以 `--hidden` 默认开不会重新引入 `.git/objects/...` 噪音。
      //
      // **env 兜底**：dogfood / CI 场景如果意外撞到隐藏目录扫描慢，可以
      // `TABTIN_GREP_HIDDEN=false` 关掉。
      const grepHiddenEnv = (process.env.TABTIN_GREP_HIDDEN ?? '').toLowerCase();
      const grepHiddenDisabled =
        grepHiddenEnv === 'false' || grepHiddenEnv === '0' || grepHiddenEnv === 'no';
      if (!grepHiddenDisabled) {
        args.push('--hidden');
      }

      // T2-C2 (2026-05-12)：显式排除 VCS 目录。
      //
      // **为什么必须显式排**：ripgrep 默认尊重 `.gitignore`，但 `.git` 目录本身
      // 不在 `.gitignore` 里——除非用户主动添加。LLM 搜 `function` 命中 `.git/
      // objects/pack` 二进制 / hex pack 是高频噪音源（W4 调研复现）。
      //
      // **顺序：必须放在用户 glob 之后**（M1 reviewer 反馈修正）：
      //   ripgrep 的多 `--glob` 规则是 **last match wins**，**不是** "negative
      //   glob 优先"。如果 VCS 排除放在用户 glob **之前**：用户传 `glob: "**/*"`
      //   会"重新匹中" `.git/...` 文件（last match wins），破坏 VCS 排除！
      //   实测验证：`rg --glob '!.git' --glob '**/*'` 会扫到 `.git/objects/...`。
      //   见 `code-grep-safety.test.ts` "VCS 排除必须在用户 glob 之后"
      //   测试钉死该不变量。
      for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) {
        args.push('--glob', `!${dir}`);
      }

      // T2-C3 (2026-05-12)：pattern 以 `-` 开头时用 `-e` flag 显式声明。
      //
      // **背景**：ripgrep 的 `--` 分隔符在 1.x 上**会**正确把 `-foo` 当 pattern，
      // 但用 `-e` 是更显式的"这是 pattern"声明：
      //   1. 规避未来 ripgrep 行为变化（如果 `--` 解析逻辑改了我们就坏）
      //   2. LLM 想搜 `-flag` / `-rf` 这种字面量时不会因 ripgrep 错误信息困惑
      if (searchPattern.startsWith('-')) {
        args.push('-e', searchPattern);
      } else {
        args.push('--', searchPattern);
      }

      const wsRoot = getWorkspaceRoot(input as any);

      // CT-005: Check raw input path for traversal BEFORE resolution (resolveInWorkspace normalises '..')
      if (input.path && input.path.replace(/\\/g, '/').split('/').includes('..')) {
        return standardizeLegacyResult({
          success: false,
          error: `Path traversal ('..') detected in search path '${input.path}'.`,
          error_code: ToolErrorCode.PERMISSION_DENIED,
        });
      }
      if (isUncPath(input.path)) {
        return standardizeLegacyResult({
          success: false,
          error: 'UNC paths are not supported for grep_search path (security: avoids SMB/NTLM access).',
          error_code: ToolErrorCode.PERMISSION_DENIED,
        });
      }

      const searchPath = input.path ? resolveInWorkspace(input.path, wsRoot) : wsRoot;

      const searchPathHit = checkHardlinePath(searchPath, 'file');
      if (searchPathHit.hit) {
        return standardizeLegacyResult({
          success: false,
          error: searchPathHit.description ?? 'Search path blocked by security policy.',
          error_code: ToolErrorCode.PERMISSION_DENIED,
        });
      }

      // W4 Lane F：path 不存在 → fail
      // （不再让 ripgrep stderr 的 "No such file or directory" 直接拍给 LLM）。
      // 注：grep_search 接受 file 也接受 directory，故 mustBeDirectory=false。
      if (input.path) {
        const check = await checkSearchPathExists(
          input.path,
          searchPath,
          wsRoot,
          /* mustBeDirectory */ false,
        );
        if (!check.ok) {
          return standardizeLegacyResult({
            success: false,
            error: check.error,
            error_code: ToolErrorCode.INVALID_PARAMETER,
          });
        }
      }

      args.push(searchPath);

      // RP-017: concurrency control
      await ripgrepSemaphore.acquire();
      let output: string;
      try {
        output = await new Promise<string>((resolve, reject) => {
          execFile(_rgBinary, args, { maxBuffer: 10 * 1024 * 1024, timeout: 15000 }, (err, stdout, stderr) => {
            if (!err) {
              resolve(stdout);
              return;
            }
            const execErr = err as any;
            if (execErr.code === 1 || execErr.status === 1) {
              resolve(stdout || '');
              return;
            }
            // RP-013: recover partial stdout on maxBuffer overflow
            if (execErr.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
              resolve(stdout || '');
              return;
            }
            reject(new Error(stderr || err.message));
          });
        });
      } finally {
        ripgrepSemaphore.release();
      }

      // T2-C8 (2026-05-12)：移除原 `output.slice(0, MAX_OUTPUT_CHARS=100_000)` 二级
      // 截断。常见 grep 工具都没有这层
      // 二级截断，靠 `--max-columns 500` + `-m max_results` + adapter `head_limit`
      // 三件套兜底；运行时再有 `enforceToolOutputBudget`（per-tool maxResultSizeChars
      // = 20K）+ persist+reference（W4）兜底。
      //
      // **为什么必须删**：原二级截断**不告知**（直接 slice 100KB），如果 head_limit
      // 内的匹配但每行很长（minified bundle 单行几 KB），会先被 action 层无声截
      // 掉，让 adapter 层的 `... truncated (showing X of at least Y, offset=N)` 精确
      // 提示失效——LLM 拿到一段断头的 ripgrep 输出不知道是 head_limit 还是 100KB
      // 截断的，分页 offset 也算不准。删掉这层，把"截断信号"完全收敛在 adapter 的
      // applyHeadLimit 里，跟行业共识对齐。
      return standardizeLegacyResult({
        success: true,
        data: { output },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return standardizeLegacyResult({ success: false, error: msg });
    }
  },
};

// ──────────────────────── semantic_search ────────────────────────

export interface CodeSemanticSearchInput {
  query: string;
  target_directory?: string | null;
  target_directories?: string[] | null;
  num_results?: number;
}

export interface CodeSemanticSearchOutput {
  success: boolean;
  data?: Record<string, any>;
  error?: any;
}

/**
 * @deprecated TabCode semantic indexing has been removed. This is now a no-op.
 */
export function invalidateIndexerCache(_projectRoot?: string): void {
  // Compatibility export for one release; there is no indexer to invalidate.
}

/** @deprecated TabCode semantic search has been retired. */
export const codeSemanticSearchTool: AgentTool<CodeSemanticSearchInput, CodeSemanticSearchOutput> = {
  name: 'semantic_search',
  riskLevel: 'safe' as const,
  description: '已退役的代码语义搜索兼容入口。请使用 grep_search 或 glob_search。',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '已退役兼容字段；不会再发起代码语义检索。',
      },
      target_directory: {
        type: 'string',
        description: '已退役兼容字段。',
      },
      target_directories: {
        type: 'array',
        items: { type: 'string' },
        description: '已退役兼容字段。',
      },
      num_results: {
        type: 'number',
        description: '已退役兼容字段。',
      },
    },
    required: ['query'],
  },
  async execute(_input: CodeSemanticSearchInput): Promise<CodeSemanticSearchOutput> {
    return standardizeLegacyResult({
      success: false,
      error: 'TabCode semantic search has been retired. Use grep_search or glob_search instead.',
      error_code: ToolErrorCode.CAPABILITY_UNAVAILABLE,
    });
  },
};

// ──────────────────────── read_lints (internal fallback only) ────────────────────────

export interface ReadDiagnosticsInput {
  paths?: string[] | null;
}

export interface DiagnosticItem {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  source: string;
}

export interface ReadDiagnosticsOutput {
  success: boolean;
  data?: Record<string, any>;
  error?: any;
}

interface LinterResult {
  diagnostics: DiagnosticItem[];
  source: string;
  /**
   * W4 Lane F：当 linter binary 不存在或调用失败时，显式声明"跳过了"。
   * 让 LLM 看到 `linters_skipped: [...]` 而不是把空 diagnostics 误读为
   * "代码没问题"——这是 calculator 同款 silent success 协议门禁要求的
   * "empty result 治理 type 1 真空 vs type 3 没跑"区分。
   */
  skipped?: boolean;
  /** 跳过原因（机读：'binary_not_found' / 'parse_failure'）。 */
  reason?: string;
}

const IS_WIN = process.platform === 'win32';
const WHICH_CMD = IS_WIN ? 'where' : 'which';

function whichSync(cmd: string): boolean {
  try {
    const { execFileSync } = require('node:child_process');
    execFileSync(WHICH_CMD, [cmd], { timeout: 3000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

async function runEslint(files: string[], cwd: string): Promise<LinterResult> {
  const diagnostics: DiagnosticItem[] = [];
  const localBin = path.join(cwd, 'node_modules', '.bin', 'eslint');
  // W4 Lane F：先做存在性检查，避免 "binary 不存在 → execFile ENOENT → JSON.parse('') 走 catch"
  // 一路静默退化的链路。eslint 找不到就直接 skipped + reason。
  const eslintBin = fs.existsSync(localBin)
    ? localBin
    : (whichSync('eslint') ? 'eslint' : null);
  if (!eslintBin) {
    return { diagnostics, source: 'eslint', skipped: true, reason: 'binary_not_found' };
  }

  return new Promise(resolve => {
    const args = ['--format', 'json', '--no-error-on-unmatched-pattern', ...files];
    execFile(eslintBin, args, { cwd, maxBuffer: 5 * 1024 * 1024, timeout: 30000 }, (err, stdout) => {
      try {
        const results = JSON.parse(stdout || '[]');
        for (const result of results) {
          for (const msg of result.messages || []) {
            diagnostics.push({
              file: result.filePath || '',
              line: msg.line || 1,
              column: msg.column || 1,
              severity: msg.severity === 2 ? 'error' : 'warning',
              message: msg.message || '',
              source: 'eslint',
            });
          }
        }
        resolve({ diagnostics, source: 'eslint' });
      } catch {
        // 解析失败仍然显式声明跳过——别让 LLM 把空 diagnostics 当
        // "代码没问题"读。
        resolve({ diagnostics, source: 'eslint', skipped: true, reason: 'parse_failure' });
      }
    });
  });
}

async function runTsc(files: string[], cwd: string): Promise<LinterResult> {
  const diagnostics: DiagnosticItem[] = [];
  const localBin = path.join(cwd, 'node_modules', '.bin', 'tsc');
  // W4 Lane F：tsc 不存在则显式 skipped。注意：tsc 通常在 node_modules，
  // 极少装到 system PATH——whichSync 多半也找不到，但保留 fallback 一致。
  const tscBin = fs.existsSync(localBin)
    ? localBin
    : (whichSync('tsc') ? 'tsc' : null);
  if (!tscBin) {
    return { diagnostics, source: 'tsc', skipped: true, reason: 'binary_not_found' };
  }

  const hasTsconfig = fs.existsSync(path.join(cwd, 'tsconfig.json'));
  const args = hasTsconfig
    ? ['-p', 'tsconfig.json', '--noEmit', '--pretty', 'false']
    : ['--noEmit', '--pretty', 'false', ...files];

  const targetSet = hasTsconfig
    ? new Set(files.map(f => path.isAbsolute(f) ? f : path.resolve(cwd, f)))
    : null;

  return new Promise(resolve => {
    execFile(tscBin, args, { cwd, maxBuffer: 5 * 1024 * 1024, timeout: 30000 }, (err, stdout, stderr) => {
      const output = stdout || stderr || '';
      const lineRe = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS\d+:\s+(.+)$/gm;
      let match: RegExpExecArray | null;
      while ((match = lineRe.exec(output)) !== null) {
        const absFile = path.isAbsolute(match[1]) ? match[1] : path.resolve(cwd, match[1]);
        if (targetSet && !targetSet.has(absFile)) continue;
        diagnostics.push({
          file: absFile,
          line: parseInt(match[2], 10),
          column: parseInt(match[3], 10),
          severity: match[4] as 'error' | 'warning',
          message: match[5].trim(),
          source: 'tsc',
        });
      }
      resolve({ diagnostics, source: 'tsc' });
    });
  });
}

async function runPythonLinter(files: string[], cwd: string): Promise<LinterResult> {
  const diagnostics: DiagnosticItem[] = [];
  const linterBin = whichSync('ruff') ? 'ruff' : whichSync('flake8') ? 'flake8' : null;
  // W4 Lane F：ruff / flake8 都不存在则显式 skipped。
  if (!linterBin) {
    return { diagnostics, source: 'python', skipped: true, reason: 'binary_not_found' };
  }

  const isRuff = linterBin === 'ruff';
  const args = isRuff ? ['check', '--output-format', 'json', ...files] : [...files];

  return new Promise(resolve => {
    execFile(linterBin, args, { cwd, maxBuffer: 5 * 1024 * 1024, timeout: 30000 }, (err, stdout) => {
      try {
        if (isRuff) {
          const results = JSON.parse(stdout || '[]');
          for (const r of results) {
            diagnostics.push({
              file: r.filename || '',
              line: r.location?.row || 1,
              column: r.location?.column || 1,
              severity: 'warning',
              message: `${r.code}: ${r.message}`,
              source: 'ruff',
            });
          }
        } else {
          const lineRe = /^(.+?):(\d+):(\d+):\s+([A-Z]\d+)\s+(.+)$/gm;
          let match: RegExpExecArray | null;
          while ((match = lineRe.exec(stdout || '')) !== null) {
            diagnostics.push({
              file: path.isAbsolute(match[1]) ? match[1] : path.resolve(cwd, match[1]),
              line: parseInt(match[2], 10),
              column: parseInt(match[3], 10),
              severity: 'warning',
              message: `${match[4]}: ${match[5].trim()}`,
              source: 'flake8',
            });
          }
        }
      } catch {
        // linter not available or parse failure
      }
      resolve({ diagnostics, source: linterBin });
    });
  });
}

export const readDiagnosticsTool: AgentTool<ReadDiagnosticsInput, ReadDiagnosticsOutput> = {
  name: 'read_lints',
  riskLevel: 'safe' as const,
  description: '读工作目录文件的 linter 和诊断错误。**只在**你编辑过或将要编辑的文件上调；不要用太大的 scope。',
  parameters: {
    type: 'object',
    properties: {
      paths: { type: 'array', items: { type: 'string' }, description: 'File paths to check' },
    },
    required: [],
  },
  async execute(input: ReadDiagnosticsInput): Promise<ReadDiagnosticsOutput> {
    try {
      const wsRoot = getWorkspaceRoot(input as any);
      const rawPaths = input.paths?.filter(Boolean).map(p => resolveInWorkspace(p.trim(), wsRoot)) || [];

      if (rawPaths.length === 0) {
        return standardizeLegacyResult({ success: true, data: { diagnostics: [] } });
      }

      const jsTs = rawPaths.filter(p => /\.(js|jsx|ts|tsx|mjs|cjs)$/i.test(p));
      const py = rawPaths.filter(p => /\.py$/i.test(p));

      const tasks: Promise<LinterResult>[] = [];
      if (jsTs.length > 0) {
        tasks.push(runEslint(jsTs, wsRoot));
        if (jsTs.some(p => /\.tsx?$/i.test(p))) {
          tasks.push(runTsc(jsTs.filter(p => /\.tsx?$/i.test(p)), wsRoot));
        }
      }
      if (py.length > 0) {
        tasks.push(runPythonLinter(py, wsRoot));
      }

      const results = await Promise.all(tasks);
      const allDiagnostics = results.flatMap(r => r.diagnostics);

      // Filter to only requested files
      const requestedSet = new Set(rawPaths.map(p => path.resolve(p)));
      const filtered = allDiagnostics.filter(d => requestedSet.has(path.resolve(d.file)));

      // W4 Lane F：把跳过的 linter 显式汇总到 envelope，避免 0 lint 当
      // silent success（calculator 同款 empty-result 治理）。LLM 看到
      // `linters_skipped: [{ source: 'ruff', reason: 'binary_not_found' }]`
      // 才知道"诊断为空"是因为 linter 没装，而不是"代码没问题"。
      const lintersSkipped = results
        .filter(r => r.skipped)
        .map(r => ({ source: r.source, reason: r.reason ?? 'unknown' }));
      const lintersRun = results
        .filter(r => !r.skipped)
        .map(r => r.source);

      return standardizeLegacyResult({
        success: true,
        data: {
          diagnostics: filtered,
          linters_run: lintersRun,
          ...(lintersSkipped.length > 0 ? { linters_skipped: lintersSkipped } : {}),
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return standardizeLegacyResult({ success: false, error: msg });
    }
  },
};

// ──────────────────────── exports (by group) ────────────────────────

export const fileOpsTools: AgentTool<any, any>[] = [
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  fileDeleteTool,
  codeMkdirTool,
  codeMoveFileTool,
];

export const searchTools: AgentTool<any, any>[] = [
  codeGlobTool,
  codeGrepTool,
];

export const tabcodeTools: AgentTool<any, any>[] = [
  ...fileOpsTools,
  ...searchTools,
];
