/**
 * tempPptxParse — Daemon host 端 W3 PPTX 临时通道实现
 *
 * 与 Electron `apps/tabtin-electron/src/main/services/tempPptxParse.ts` 同构，
 * 仅在 token / API base 注入方式上差异：
 *   - Electron 走 `TokenManager.getAccessToken()`（全局单例）
 *   - Daemon 走 `apiAuthToken` + `apiBaseUrl` 闭包注入（factory 模式与
 *     `DaemonToolProvider` 已有 web/data tools 同款）
 *
 * 共享 `RunTempPptxParse` 接口（`@tabtin/agent-host/tools` SSoT）。
 */
import { promises as fsPromises, createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

// 用 `@tabtin/local-docparse` re-exported SSoT（与 DaemonAgentHost
// `fetchCloudSummary` 同源）—— Daemon package.json 已声明 local-docparse
// dependency，不需要新增 `@tabtin/file-pipeline-errors` 直接依赖。
import {
  FilePipelineErrorCode,
  isFilePipelineErrorCode,
} from '@tabtin/local-docparse';
import type {
  RunTempPptxParse,
  TempPptxParseChunk,
  TempPptxParseResult,
} from '@tabtin/agent-host/tools';
import { joinApiPath } from '@tabtin/config';

interface PresignResponseBody {
  success: boolean;
  message?: string;
  presigned_url?: string;
  temp_object_key?: string;
  expires_in?: number;
  error_code?: string;
}

interface ParseSyncResponseBody {
  success: boolean;
  message?: string;
  failure_code?: string;
  chunks?: TempPptxParseChunk[];
  duration_ms?: number;
  pages?: number;
  title?: string;
}

export interface CreateRunTempPptxParseOptions {
  apiBaseUrl: string;
  /** 取当前有效 token 的 callable —— 不持久化引用避免 token 旋转后 stale。 */
  getAuthToken: () => string | undefined | Promise<string | undefined>;
}

type Failure = Extract<TempPptxParseResult, { success: false }>;

async function readPptxFile(filePath: string, elapsed: () => number): Promise<{ fileSize: number; filename: string } | Failure> {
  try {
    const stat = await fsPromises.stat(filePath);
    if (stat.size <= 0) return { success: false, errorClass: FilePipelineErrorCode.FILE_NOT_FOUND, message: `Empty file: ${filePath}`, durationMs: elapsed() };
    return { fileSize: stat.size, filename: filePath.split(/[\\/]/).pop() ?? 'file.pptx' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, errorClass: FilePipelineErrorCode.FILE_NOT_FOUND, message: `Failed to read local file: ${message}`, durationMs: elapsed() };
  }
}

function failed(result: object): result is Failure { return 'success' in result && result.success === false; }

async function presignPptx(apiBaseUrl: string, token: string, filename: string, fileSize: number, mimeType: string, signal: AbortSignal | undefined, remaining: () => number, elapsed: () => number): Promise<PresignResponseBody | Failure> {
  const url = joinApiPath(apiBaseUrl, '/services/oss/temp-parse-presign');
  const request = () => fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ file_name: filename, file_size_bytes: fileSize, mime_type: mimeType }), signal: composeSignal(signal, Math.min(8_000, remaining())) });
  try {
    let response = await request();
    if (response.status >= 500 && response.status < 600 && remaining() > 1_500) { await new Promise(resolve => setTimeout(resolve, 100)); response = await request(); }
    if (!response.ok) return { success: false, errorClass: FilePipelineErrorCode.NETWORK_ERROR, message: `presign HTTP ${response.status}: ${await safeReadText(response)}`, durationMs: elapsed() };
    const body = await response.json() as PresignResponseBody;
    if (body.success && body.presigned_url && body.temp_object_key) return body;
    return { success: false, errorClass: isFilePipelineErrorCode(body.error_code) ? body.error_code : FilePipelineErrorCode.UNKNOWN_ERROR, message: body.message ?? 'presign failed (empty response)', durationMs: elapsed() };
  } catch (error) { return classifyFetchError(error, elapsed(), 'presign') as Failure; }
}

async function putPptx(url: string, filePath: string, fileSize: number, mimeType: string, signal: AbortSignal | undefined, remaining: () => number, elapsed: () => number): Promise<Failure | null> {
  const request = () => fetch(url, { method: 'PUT', headers: { 'Content-Type': mimeType, 'Content-Length': String(fileSize) }, body: Readable.toWeb(createReadStream(filePath)) as unknown as BodyInit, duplex: 'half', signal: composeSignal(signal, remaining()) } as RequestInit & { duplex: 'half' });
  try {
    let response = await request();
    if (response.status >= 500 && response.status < 600 && remaining() > 1_500) { await new Promise(resolve => setTimeout(resolve, 100)); response = await request(); }
    return response.ok ? null : { success: false, errorClass: FilePipelineErrorCode.NETWORK_ERROR, message: `OSS PUT HTTP ${response.status}: ${await safeReadText(response)}`, durationMs: elapsed() };
  } catch (error) { return classifyFetchError(error, elapsed(), 'oss-put') as Failure; }
}

async function parsePptx(apiBaseUrl: string, token: string, objectKey: string, mimeType: string, signal: AbortSignal | undefined, remaining: () => number, elapsed: () => number): Promise<ParseSyncResponseBody | Failure> {
  try {
    const response = await fetch(joinApiPath(apiBaseUrl, '/services/docparse/parse-sync-temp'), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ temp_object_key: objectKey, mime_type: mimeType }), signal: composeSignal(signal, remaining()) });
    if (!response.ok) return { success: false, errorClass: FilePipelineErrorCode.NETWORK_ERROR, message: `parse-sync HTTP ${response.status}: ${await safeReadText(response)}`, durationMs: elapsed() };
    const body = await response.json() as ParseSyncResponseBody;
    if (body.success && body.chunks) return body;
    return { success: false, errorClass: isFilePipelineErrorCode(body.failure_code) ? body.failure_code : FilePipelineErrorCode.UNKNOWN_ERROR, message: body.message ?? 'parse-sync failed (empty response)', durationMs: elapsed() };
  } catch (error) { return classifyFetchError(error, elapsed(), 'parse-sync') as Failure; }
}

/**
 * 创建 Daemon 端的 `runTempPptxParse` 实现（factory 模式让 caller 注入
 * token / apiBase）。
 */
export function createRunTempPptxParse(
  opts: CreateRunTempPptxParseOptions,
): RunTempPptxParse {
  const { apiBaseUrl, getAuthToken } = opts;

  return async (filePath, mimeType, options): Promise<TempPptxParseResult> => {
    const startedAt = Date.now();
    const elapsedMs = () => Date.now() - startedAt;
    const remainingMs = () => Math.max(1_000, options.timeoutMs - elapsedMs());

    // ── 0. fs.stat（W5 L60：不再 readFile 全文到内存——OOM 防御）─────
    //
    // 与 Electron `tempPptxParse.ts` 同款修复——50MB PPTX 全文 readFile +
    // fetch BodyInit 复制 → 内存峰值 ~100MB；改走 `createReadStream` +
    // `Readable.toWeb` 流式 PUT body，内存峰值 < 1MB（与文件大小解耦）。
    const file = await readPptxFile(filePath, elapsedMs);
    if (failed(file)) return file;
    const { fileSize, filename } = file;

    // ── 1. 拿 token（L51 收：per-fetch re-await，token rotation 不被闭包锁死）─
    const ensureToken = async (): Promise<string | null> => {
      const t = await getAuthToken();
      return t ? t : null;
    };
    const tokenForPresign = await ensureToken();
    if (!tokenForPresign) {
      return {
        success: false,
        errorClass: FilePipelineErrorCode.NETWORK_ERROR,
        message: 'No access token available — daemon not authenticated.',
        durationMs: elapsedMs(),
      };
    }

    // ── 2. POST presign (L52: 5xx 一次 retry 100ms backoff) ──────
    const presign = await presignPptx(apiBaseUrl, tokenForPresign, filename, fileSize, mimeType, options.signal, remainingMs, elapsedMs);
    if (failed(presign)) return presign;

    const presignedUrl = presign.presigned_url!;
    const tempObjectKey = presign.temp_object_key!;

    // ── 3. PUT to OSS（L52：5xx 一次 retry；W5 L60：流式 body 消 OOM）─
    //
    // 每次 retry 必须重开 stream（消耗型，重试不能复用第一次的 stream）。
    // duplex='half' 是 Undici 流式 body 的硬性要求；TS DOM lib 还没声明
    // 该字段，用 cast 让 TS 放行。
    const putFailure = await putPptx(presignedUrl, filePath, fileSize, mimeType, options.signal, remainingMs, elapsedMs);
    if (putFailure) return putFailure;

    // ── 4. POST parse-sync（L51：再 re-await token，避免长流程内 token 过期）─
    const tokenForParseSync = await ensureToken();
    if (!tokenForParseSync) {
      return {
        success: false,
        errorClass: FilePipelineErrorCode.NETWORK_ERROR,
        message: 'Access token expired mid-flow (between OSS PUT and parse-sync).',
        durationMs: elapsedMs(),
      };
    }
    const parseSync = await parsePptx(apiBaseUrl, tokenForParseSync, tempObjectKey, mimeType, options.signal, remainingMs, elapsedMs);
    if (failed(parseSync)) return parseSync;

    return {
      success: true,
      chunks: parseSync.chunks!,
      durationMs: parseSync.duration_ms ?? elapsedMs(),
      pages: parseSync.pages ?? 0,
      title: parseSync.title ?? '',
      fileSizeBytes: fileSize,
    };
  };
}

// ─── helpers (copy of Electron-side; intentionally not extracted to a shared
// package — see DaemonToolProvider header comment about isomorphic tool source
// files; W4 抽 FileResolver 时一并合入共享层) ────────────────────────────

function composeSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const localTimeout = AbortSignal.timeout(Math.max(1_000, timeoutMs));
  if (!callerSignal) return localTimeout;
  return AbortSignal.any([localTimeout, callerSignal]);
}

async function safeReadText(resp: Response): Promise<string> {
  try {
    const text = await resp.text();
    return text.slice(0, 500);
  } catch {
    return '<unreadable body>';
  }
}

function classifyFetchError(
  err: unknown,
  durationMs: number,
  stage: string,
): TempPptxParseResult {
  const msg = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';
  const isAbort = name === 'AbortError' || /abort/i.test(msg);
  const isTimeout = name === 'TimeoutError' || /time(d? ?out|out)/i.test(msg);
  if (isAbort && !isTimeout) {
    return {
      success: false,
      errorClass: FilePipelineErrorCode.USER_ABORTED,
      message: `${stage}: aborted by user`,
      durationMs,
    };
  }
  if (isTimeout) {
    return {
      success: false,
      errorClass: FilePipelineErrorCode.PARSE_TIMEOUT,
      message: `${stage}: ${msg}`,
      durationMs,
    };
  }
  return {
    success: false,
    errorClass: FilePipelineErrorCode.NETWORK_ERROR,
    message: `${stage}: ${msg}`,
    durationMs,
  };
}
