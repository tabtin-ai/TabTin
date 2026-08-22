/**
 * Stream Downloader — download HLS/DASH segments and concatenate.
 *
 * Downloads segments via a sliding-window worker pool, concatenates with
 * streaming I/O, and optionally remuxes to MP4 via ffmpeg.
 */

import { writeFile, mkdir, rm, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { getHomeTabtinPath } from '@tabtin/shared/storage-paths';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { M3U8Segment } from './m3u8-parser.js';
import { safeFetchBuffer } from './safe-fetch.js';

const execFileAsync = promisify(execFile);

function execFileAbortable(
  file: string,
  args: string[],
  opts: { timeout: number; signal?: AbortSignal },
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(abortError());
      return;
    }
    const child = execFile(file, args, { timeout: opts.timeout }, (error) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
    const onAbort = () => {
      try { child.kill('SIGTERM'); } catch { /* child may have exited */ }
      reject(abortError());
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const MAX_RETRIES = 2;
const RETRY_DELAY_BASE = 1_000;
const CONSECUTIVE_FAIL_LIMIT = 5;
const PROGRESS_INTERVAL_MS = 3_000;

let ffmpegAvailable: boolean | null = null;

/**
 * 构造一个 `name === 'AbortError'` 的错误（BR-10 P1 取消用）。
 * 沿用 daemon 既有约定（如 DaemonPtyManagerBridge）以 name 判定 abort；
 * `browser.ts` 的错误归类也按 `AbortError` 命名识别。
 */
function abortError(): Error {
  const err = new Error('Stream download aborted');
  err.name = 'AbortError';
  return err;
}

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface DownloadProgress {
  total: number;
  completed: number;
  failed: number;
  bytes: number;
}

export interface DownloadResult {
  success: boolean;
  partial?: boolean;
  failedSegments?: number;
  path?: string;
  segments: number;
  totalSize: number;
  duration: number;
  format: string;
  error?: string;
}

type DownloadableSegment = Pick<M3U8Segment, 'uri'> & Partial<Pick<M3U8Segment, 'duration'>>;
type DownloadOptions = NonNullable<Parameters<typeof downloadStream>[1]>;

// ---------------------------------------------------------------------------
// Single-segment download with retry
// ---------------------------------------------------------------------------

async function downloadSegment(
  seg: DownloadableSegment,
  idx: number,
  tempDir: string,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ path: string; size: number }> {
  const segPath = join(tempDir, `seg-${String(idx).padStart(5, '0')}.bin`);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw abortError();
    if (attempt > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, RETRY_DELAY_BASE * 2 ** (attempt - 1));
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(abortError());
        }, { once: true });
      });
    }
    try {
      const buffer = await safeFetchBuffer(seg.uri, { headers, timeout: 60_000, signal });
      if (signal?.aborted) throw abortError();
      await writeFile(segPath, buffer);
      return { path: segPath, size: buffer.length };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError!;
}

// ---------------------------------------------------------------------------
// Sliding-window worker pool
// ---------------------------------------------------------------------------

async function downloadSegmentsPool(
  segments: DownloadableSegment[],
  concurrency: number,
  tempDir: string,
  headers?: Record<string, string>,
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<{ paths: (string | null)[]; bytes: number; failed: number; completed: number }> {
  const resultPaths: (string | null)[] = new Array(segments.length).fill(null);
  let bytes = 0;
  let failed = 0;
  let completed = 0;
  let consecutiveFailures = 0;
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < segments.length) {
      // 取消信号：BR-10 P1 把 signal 通到下载循环里——每段开抓前查一次，
      // 已 abort 就抛 AbortError 让所有 worker 一并退出（不传 signal 时此分支恒不触发，零行为变更）。
      if (signal?.aborted) throw abortError();
      if (consecutiveFailures >= CONSECUTIVE_FAIL_LIMIT) break;
      const idx = nextIdx++;
      try {
        const r = await downloadSegment(segments[idx], idx, tempDir, headers, signal);
        resultPaths[idx] = r.path;
        bytes += r.size;
        completed++;
        consecutiveFailures = 0;
      } catch {
        failed++;
        consecutiveFailures++;
      }
      onProgress?.({ total: segments.length, completed, failed, bytes });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, segments.length) }, () => worker()),
  );

  return { paths: resultPaths, bytes, failed, completed };
}

// ---------------------------------------------------------------------------
// Streaming file concatenation
// ---------------------------------------------------------------------------

async function concatFiles(paths: string[], output: string, signal?: AbortSignal): Promise<void> {
  const fh = await open(output, 'w');
  try {
    for (const p of paths) {
      if (signal?.aborted) throw abortError();
      for await (const chunk of createReadStream(p)) {
        if (signal?.aborted) throw abortError();
        await fh.write(chunk);
      }
    }
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------------------
// ffmpeg helpers
// ---------------------------------------------------------------------------

async function checkFfmpeg(): Promise<boolean> {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 5_000 });
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
  }
  return ffmpegAvailable;
}

// ---------------------------------------------------------------------------
// Disk-space pre-check
// ---------------------------------------------------------------------------

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

async function checkDiskSpace(dir: string, estimatedBytes: number): Promise<void> {
  try {
    const { statfs } = await import('node:fs/promises');
    const stats = await statfs(dir);
    const available = stats.bfree * stats.bsize;
    if (available < estimatedBytes * 2) {
      throw new Error(
        `磁盘空间不足：需要约 ${formatBytes(estimatedBytes * 2)}，可用 ${formatBytes(available)}`,
      );
    }
  } catch (err: any) {
    if (err?.message?.includes('磁盘空间不足')) throw err;
  }
}

async function downloadInitSegment(tempDir: string, opts: DownloadOptions): Promise<string[]> {
  if (!opts.initSegmentUrl) return [];
  if (opts.signal?.aborted) throw abortError();
  const initPath = join(tempDir, 'seg-00000-init.bin');
  const buf = await safeFetchBuffer(opts.initSegmentUrl, { headers: opts.headers, signal: opts.signal });
  if (opts.signal?.aborted) throw abortError();
  await writeFile(initPath, buf);
  return [initPath];
}

function failureResult(error: string, startTime: number, format: string, values?: Partial<DownloadResult>): DownloadResult {
  return { success: false, segments: 0, totalSize: 0, duration: Date.now() - startTime, format, error, ...values };
}

interface ProgressState { bytes: number; completed: number; failed: number }

function startProgressTicker(state: ProgressState, total: number, startTime: number): NodeJS.Timeout {
  return setInterval(() => {
    const elapsed = (Date.now() - startTime) / 1000;
    const speed = elapsed > 0 ? state.bytes / elapsed : 0;
    const eta = state.completed > 0 ? Math.round((total - state.completed) / (state.completed / elapsed)) : 0;
    process.stderr.write(`${JSON.stringify({ type: 'progress', completed: state.completed, total, failed: state.failed, bytes: state.bytes, speed: Math.round(speed), eta })}\n`);
  }, PROGRESS_INTERVAL_MS);
}

async function finalizeDownload(segments: DownloadableSegment[], initPaths: string[], result: Awaited<ReturnType<typeof downloadSegmentsPool>>, tempDir: string, startTime: number, ext: 'ts' | 'mp4', opts: DownloadOptions): Promise<DownloadResult> {
  const paths = [...initPaths, ...result.paths.filter((path): path is string => path !== null)];
  if (paths.length === 0 || paths.length === initPaths.length) return failureResult('没有成功下载任何分片', startTime, ext, { partial: false, failedSegments: result.failed });
  const failed = result.failed;
  const partial = failed > 0 && failed <= Math.max(3, Math.floor(segments.length * 0.01));
  if (failed > 0 && !partial) return failureResult(`${failed}/${segments.length} 分片下载失败，超出容忍阈值`, startTime, ext, { partial: false, failedSegments: failed, segments: result.completed, totalSize: result.bytes });
  const outputDir = dirname(opts.outputPath || join(getHomeTabtinPath('downloads'), `stream.${ext}`));
  if (opts.signal?.aborted) throw abortError();
  await mkdir(outputDir, { recursive: true });
  const { outputPath, format } = await mergeSegments(paths, tempDir, segments.length, ext, opts);
  return { success: failed === 0, partial: partial || undefined, failedSegments: failed > 0 ? failed : undefined, path: outputPath, segments: result.completed, totalSize: result.bytes, duration: Date.now() - startTime, format, error: failed > 0 ? `${failed}/${segments.length} 分片下载失败，视频可能不完整` : undefined };
}

async function mergeSegments(paths: string[], tempDir: string, segmentsCount: number, ext: 'ts' | 'mp4', opts: DownloadOptions): Promise<{ outputPath: string; format: string }> {
  const downloads = getHomeTabtinPath('downloads');
  const hasFfmpeg = await checkFfmpeg();
  const requestedMp4 = ext === 'mp4' || (hasFfmpeg && !opts.outputPath?.endsWith('.ts'));
  let outputPath = opts.outputPath || join(downloads, `stream-${Date.now()}.${requestedMp4 ? 'mp4' : 'ts'}`);
  if (!requestedMp4) { await concatFiles(paths, outputPath, opts.signal); return { outputPath, format: 'ts' }; }
  if (ext === 'mp4' && !hasFfmpeg) { await concatFiles(paths, outputPath, opts.signal); return { outputPath, format: 'mp4' }; }
  const concatFile = join(tempDir, 'concat.txt');
  await writeFile(concatFile, paths.map(p => `file '${p}'`).join('\n'));
  try {
    await execFileAbortable('ffmpeg', ['-f', 'concat', '-safe', '0', '-i', concatFile, '-c', 'copy', '-y', outputPath], { timeout: Math.max(120_000, segmentsCount * 500), signal: opts.signal });
    return { outputPath, format: 'mp4' };
  } catch {
    if (opts.signal?.aborted) throw abortError();
    if (ext === 'mp4') { await concatFiles(paths, outputPath, opts.signal); return { outputPath, format: 'mp4' }; }
    outputPath = opts.outputPath || join(downloads, `stream-${Date.now()}.ts`);
    await concatFiles(paths, outputPath, opts.signal);
    return { outputPath, format: 'ts' };
  }
}

// ---------------------------------------------------------------------------
// Main entry — downloadStream
// ---------------------------------------------------------------------------

export async function downloadStream(
  segments: DownloadableSegment[],
  opts?: {
    outputPath?: string;
    concurrency?: number;
    headers?: Record<string, string>;
    onProgress?: (progress: DownloadProgress) => void;
    initSegmentUrl?: string;
    outputExtension?: 'ts' | 'mp4';
    // BR-10 P1：可选取消信号，aborted 时中止下载循环。不传则行为与既有完全一致。
    signal?: AbortSignal;
  },
): Promise<DownloadResult> {
  const concurrency = opts?.concurrency ?? 3;
  const tempDir = getHomeTabtinPath(
    'tmp',
    `stream-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  await mkdir(tempDir, { recursive: true });

  const startTime = Date.now();
  const defaultExt = opts?.outputExtension || 'ts';

  await checkDiskSpace(tempDir, segments.length * 2 * 1024 * 1024);

  try {
    // -- init segment -------------------------------------------------------
    let initPaths: string[];
    try { initPaths = await downloadInitSegment(tempDir, opts ?? {}); }
    catch (err) { return failureResult(`Init segment failed: ${err instanceof Error ? err.message : String(err)}`, startTime, defaultExt); }

    // -- stderr progress ticker ---------------------------------------------
    const progress = { bytes: 0, completed: 0, failed: 0 };
    const progressInterval = startProgressTicker(progress, segments.length, startTime);

    try {
      // -- download segments --------------------------------------------------
      const dlResult = await downloadSegmentsPool(
        segments,
        concurrency,
        tempDir,
        opts?.headers,
        (p) => {
          progress.completed = p.completed;
          progress.failed = p.failed;
          progress.bytes = p.bytes;
          opts?.onProgress?.(p);
        },
        opts?.signal,
      );

      return finalizeDownload(segments, initPaths, dlResult, tempDir, startTime, defaultExt, opts ?? {});
    } finally {
      clearInterval(progressInterval);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
