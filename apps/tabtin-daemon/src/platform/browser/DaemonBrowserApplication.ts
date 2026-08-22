import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, basename } from 'node:path';
import { unlink } from 'node:fs/promises';
import { getHomeTabtinPath } from '@tabtin/shared/storage-paths';
import {
  parseContentTypeWhitelist,
  filterHtmlByContentTypes,
  isPrintTextFormat,
  renderPrintContent,
  type ContentType,
} from '@tabtin/action-tools/impl';
import {
  handleBrowserAction, BrowserActionError, getSharedBrowserJobManager, shutdownSharedBrowserJobManager,
  type BrowserActionResult, type BrowserContextInfo, type BrowserExecHooks,
  type BrowserExecOutcome, type BrowserObserveParams, type BrowserOrchestratorHostHooks,
  type BrowserPolicyHostHooks, type BrowserResourceStreamHooks, type BrowserSnapshotRequestParams,
  type BrowserSessionData, type BrowserSessionHooks, type BrowserJobHooks,
  type BrowserJobProgress, type SmartDownloadCandidate, selectSmartDownloadTarget,
  classifyMediaResource,
  analyzeBrowserNetworkToOpenApi,
  normalizeBrowserNetworkEntries,
  getSharedRefCache,
  mergeActEmbedObserve,
} from '@tabtin/browser-core';
import { validateUrl, validateSavePath, type DaemonBrowserService } from './DaemonBrowserService.js';
import type { M3U8Manifest } from './m3u8-parser.js';
import type { MPDManifest } from './mpd-parser.js';
import type { DownloadProgress } from './stream-downloader.js';
import { safeFetchText } from './safe-fetch.js';
import type { BrowserApplicationPort } from '../../base/browser/browser-application-port.js';
import type { Recording } from './RecordingSession.js';

export interface DaemonBrowserApplicationDependencies {
  resolveBrowser(): DaemonBrowserService | null;
  getSpaceId(): string | null;
  startRecording(runId: string, tabId?: string): Promise<Recording>;
  stopRecording(runId?: string): Promise<Recording | null>;
  getRecordingStatus(runId?: string): { recording: boolean; actionCount: number } | null;
  loadRecording(runId: string): Promise<Recording | null>;
  listRecordings(): Promise<Array<{ runId: string; startedAt: string; actionCount: number }>>;
  recordAction(runId: string, action: import('./RecordingSession.js').RecordedAction): void;
}

interface DaemonBrowserHostDependencies extends DaemonBrowserApplicationDependencies {
  executeReplayAction(actionType: string, body: Record<string, unknown>): Promise<void>;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readBoolFlag(body: any, camel: string, snake: string): boolean | undefined {
  if (typeof body?.[camel] === 'boolean') return body[camel];
  if (typeof body?.[snake] === 'boolean') return body[snake];
  return undefined;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`操作超时（${timeoutMs / 1000}s）`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createDaemonBrowserHostHooks(dependencies: DaemonBrowserHostDependencies): BrowserOrchestratorHostHooks {
const execFileAsync = promisify(execFile);

function abortError(): Error {
  const err = new Error('Operation aborted');
  err.name = 'AbortError';
  return err;
}

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

type ParsedStream =
  | { streamType: 'hls'; raw: M3U8Manifest; data: ParsedStreamData }
  | { streamType: 'dash'; raw: MPDManifest; data: ParsedStreamData };

interface ParsedStreamData {
  streamType: 'hls' | 'dash';
  isMasterPlaylist: boolean;
  variants: Array<{ bandwidth: number; resolution?: string; codecs?: string; uri: string; name?: string }>;
  segments: Array<{ uri: string; duration: number }>;
  duration: number;
  isLive: boolean;
  isEncrypted: boolean;
  encryptionMethod?: string;
  initSegmentUrl?: string;
  hasAudioTrack?: boolean;
  segmentCount: number;
  variantCount: number;
}

const STREAM_ERROR_CODES = {
  AUTH_REQUIRED: 'STREAM_AUTH_REQUIRED',
  RATE_LIMITED: 'STREAM_RATE_LIMITED',
  NOT_FOUND: 'STREAM_NOT_FOUND',
  TIMEOUT: 'STREAM_TIMEOUT',
  ENCRYPTED: 'STREAM_ENCRYPTED',
  NETWORK_ERROR: 'STREAM_NETWORK_ERROR',
  PARTIAL: 'STREAM_PARTIAL',
} as const;

/**
 * 读取布尔 flag，兼容 CLI 的 snake_case 与 FC/旧调用方的 camelCase（与 Electron
 * network.ts 同策略）。缺省返回 undefined。
 */
function shouldHideResourceSegments(body: any): boolean {
  return readBoolFlag(body, 'hideSegments', 'hide_segments') ?? true;
}

function isLikelyStreamSegment(resource: { name?: string; url?: string; type?: string; mimeType?: string }): boolean {
  const haystack = `${resource.name ?? resource.url ?? ''} ${resource.type ?? ''} ${resource.mimeType ?? ''}`.toLowerCase();
  return /\.(ts|m4s|mp4v|m4a)(\?|$)/.test(haystack) || haystack.includes('/segment') || haystack.includes('seg-');
}

function isDashManifestUrl(url: string): boolean {
  return /\.mpd(\?|#|$)/i.test(url);
}

function isHlsManifestUrl(url: string): boolean {
  return /\.m3u8(\?|#|$)/i.test(url);
}

/**
 * `requireBrowser` 的抛错版（BR-8 P3c③）：resource/stream hook 不持有 res/sendJSON，
 * 改抛 `BrowserActionError(503)` 让 Orchestrator 转错误结果。两段 503 文案与 `requireBrowser`
 * 逐字一致（零行为变更）。
 */
function requireDaemonBrowser(): DaemonBrowserService {
  const svc = dependencies.resolveBrowser();
  if (!svc) {
    throw new BrowserActionError(503, {
      code: 'INTERNAL_ERROR',
      message: 'DaemonBrowserService 尚未初始化',
      retryable: true,
      suggestions: ['确保系统已安装 Chrome/Chromium'],
    });
  }
  if (!svc.isAvailable()) {
    throw new BrowserActionError(503, {
      code: 'INTERNAL_ERROR',
      message: '未检测到 Chrome/Chromium',
      suggestions: ['安装 Google Chrome 或 Chromium', '或设置 CHROME_PATH 环境变量指向 Chrome 可执行文件'],
    });
  }
  return svc;
}

/**
 * `rejectBadUrl` 的抛错版（BR-8 P3c③）：url 非法时抛 `BrowserActionError(400)`，
 * 文案与 `rejectBadUrl` 逐字一致。
 */
function assertDaemonUrl(url: string): void {
  try {
    validateUrl(url);
  } catch (err: any) {
    throw new BrowserActionError(400, {
      code: 'VALIDATION_ERROR',
      message: err?.message || '无效的 URL',
      suggestions: ['仅允许 http:// 和 https:// 协议，且禁止访问内网地址'],
    });
  }
}

async function ensureTab(svc: DaemonBrowserService, url?: string) {
  if (!svc.getActiveTabId()) {
    return await svc.openTab({ url });
  }
  if (url) {
    await svc.navigateTo(url);
  }
  return svc.getActiveTabId()!;
}

/**
 * 把 snapshot 返回的 base64 截图落盘，回写文件路径（BR-4(B)，对齐 Electron
 * `_helpers.saveScreenshotFromBase64`）。savePath 给定则走 validateSavePath 白名单校验；
 * 否则落到 ~/.tabtin/screenshots 带时间戳。snapshot 截图为 JPEG（SnapshotService 固定 jpeg/70）。
 */
async function saveSnapshotScreenshot(
  base64: string,
  savePath: string | undefined,
  workspaceRoot: string | undefined,
): Promise<string> {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  let filePath: string;
  if (savePath) {
    validateSavePath(savePath, workspaceRoot);
    filePath = savePath;
    await mkdir(dirname(filePath), { recursive: true });
  } else {
    const dir = getHomeTabtinPath('screenshots');
    await mkdir(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
    filePath = join(dir, `snapshot-${ts}.jpg`);
  }
  await writeFile(filePath, Buffer.from(base64, 'base64'));
  return filePath;
}

function selectVariantIndex(
  variants: Array<{ bandwidth?: number; resolution?: string }>,
  quality: unknown,
): number {
  if (!variants.length) return 0;

  const normalized = typeof quality === 'string' ? quality.trim().toLowerCase() : '';
  if (normalized === 'worst' || normalized === 'lowest') {
    return variants.length - 1;
  }
  if (!normalized || normalized === 'best' || normalized === 'highest') {
    return 0;
  }

  const match = variants.findIndex((variant) =>
    (variant.resolution || '').toLowerCase().includes(normalized)
  );
  return match >= 0 ? match : 0;
}

async function extractAuthHeaders(
  manifestUrl: string,
  tabId?: string,
): Promise<Record<string, string>> {
  const svc = dependencies.resolveBrowser();
  if (!svc?.isAvailable()) return {};

  const result: Record<string, string> = {};

  try {
    const tracker = svc.getResourceTracker(tabId);
    Object.assign(result, extractTrackedAuthHeaders(tracker?.isEnabled ? tracker.findByUrl(manifestUrl)?.headers : undefined));

    if (!result['Cookie']) {
      try {
        const cookies = await svc.getCookies([manifestUrl], tabId);
        if (cookies.length > 0) {
          result['Cookie'] = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        }
      } catch { /* cookie 获取失败不阻断主流程 */ }
    }
  } catch { /* 非关键路径 */ }

  return result;
}

function extractTrackedAuthHeaders(headers?: Record<string, string>): Record<string, string> {
  if (!headers) return {};
  const result: Record<string, string> = {};
  const mappings = [['Cookie', 'cookie'], ['Referer', 'referer'], ['Authorization', 'authorization']] as const;
  for (const [canonical, lower] of mappings) {
    const value = headers[lower] || headers[canonical];
    if (value) result[canonical] = value;
  }
  return result;
}

async function detectStreamType(
  url: string,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ type: 'hls' | 'dash'; content?: string }> {
  if (isHlsManifestUrl(url)) return { type: 'hls' };
  if (isDashManifestUrl(url)) return { type: 'dash' };

  const content = await safeFetchText(url, { headers, timeout: 15_000, signal });
  const trimmed = content.trimStart();
  if (trimmed.startsWith('#EXTM3U')) return { type: 'hls', content };
  if (trimmed.startsWith('<?xml') || trimmed.includes('<MPD')) return { type: 'dash', content };

  throw new Error(
    'URL 既非 HLS (.m3u8) 也非 DASH (.mpd)，且内容头部无法识别为已知流媒体格式',
  );
}

function buildStreamData(
  streamType: 'hls' | 'dash',
  manifest: M3U8Manifest | MPDManifest,
): ParsedStreamData {
  const isHls = streamType === 'hls';
  const hlsManifest = isHls ? (manifest as M3U8Manifest) : undefined;
  const dashManifest = isHls ? undefined : (manifest as MPDManifest);

  return {
    streamType,
    isMasterPlaylist: isHls
      ? hlsManifest!.type === 'master'
      : (dashManifest!.variants.length > 1),
    variants: manifest.variants as ParsedStreamData['variants'],
    segments: manifest.segments,
    duration: isHls ? hlsManifest!.totalDuration : dashManifest!.totalDuration,
    isLive: manifest.isLive,
    isEncrypted: isHls
      ? (hlsManifest!.isEncrypted ?? false)
      : dashManifest!.isEncrypted,
    encryptionMethod: isHls ? hlsManifest!.encryptionMethod : undefined,
    initSegmentUrl: isHls ? hlsManifest!.initSegmentUrl : dashManifest!.initSegmentUrl,
    hasAudioTrack: isHls ? undefined : dashManifest!.hasAudioTrack,
    segmentCount: manifest.segments.length,
    variantCount: manifest.variants.length,
  };
}

async function parseDaemonStream(
  url: string,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<ParsedStream> {
  const detected = await detectStreamType(url, headers, signal);

  if (detected.type === 'dash') {
    const { fetchAndParseMPD, parseMPD } = await import('./mpd-parser.js');
    const manifest = detected.content
      ? parseMPD(detected.content, url)
      : await fetchAndParseMPD(url, headers, { signal });
    return {
      streamType: 'dash',
      raw: manifest,
      data: buildStreamData('dash', manifest),
    };
  }

  const { fetchAndParseM3U8, parseM3U8 } = await import('./m3u8-parser.js');
  const manifest = detected.content
    ? parseM3U8(detected.content, url)
    : await fetchAndParseM3U8(url, headers, { signal });
  return {
    streamType: 'hls',
    raw: manifest,
    data: buildStreamData('hls', manifest),
  };
}

interface DownloadDaemonStreamParams {
  url: string;
  headers?: Record<string, string>;
  quality?: unknown;
  outputPath?: string;
  concurrency?: number;
  tabId?: string;
  // BR-10 P2：异步 job 透传取消信号 + 进度回调；同步路径不传，行为与既有完全一致。
  signal?: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
}

type DownloadDaemonStreamResult = { success: boolean; error?: string; [key: string]: unknown };
type StreamDownloader = typeof import('./stream-downloader.js')['downloadStream'];
type ParsedDashStream = Extract<ParsedStream, { streamType: 'dash' }>;
type ParsedHlsStream = Extract<ParsedStream, { streamType: 'hls' }>;

function assertStreamDownloadable(parsed: ParsedStream): void {
  if (!parsed.data.isEncrypted) return;

  const detail = parsed.streamType === 'hls'
    ? `该 HLS 流已加密（${parsed.data.encryptionMethod || 'AES-128/SAMPLE-AES'}），当前无法下载解密。这可能是付费内容或受版权保护。`
    : '该 DASH 流受 DRM 保护（ContentProtection），无法下载。';
  throw Object.assign(new Error(detail), { code: STREAM_ERROR_CODES.ENCRYPTED });
}

function resolveDashDownloadSelection(parsed: ParsedDashStream, quality: unknown) {
  const manifest = parsed.raw;
  const selectedIndex = selectVariantIndex(manifest.variants, quality);
  return {
    manifest,
    selectedVariant: manifest.variants[selectedIndex] || manifest.variants[0],
    selectedSegments: manifest.variantSegments?.[selectedIndex]?.segments || manifest.segments,
    selectedInitSegmentUrl: manifest.variantSegments?.[selectedIndex]?.initSegmentUrl || manifest.initSegmentUrl,
  };
}

async function canMergeDashAudio(manifest: ParsedDashStream['raw']): Promise<boolean> {
  if (!manifest.audioSegments?.segments?.length) return false;
  return await checkFfmpegAvailable();
}

async function downloadAndMergeDashTracks(params: {
  parsed: ParsedDashStream;
  downloadParams: DownloadDaemonStreamParams;
  downloadStream: StreamDownloader;
  mergedHeaders: Record<string, string>;
  selectedVariant: ParsedDashStream['raw']['variants'][number] | undefined;
  selectedSegments: ParsedDashStream['raw']['segments'];
  selectedInitSegmentUrl?: string;
}): Promise<DownloadDaemonStreamResult> {
  const {
    parsed,
    downloadParams,
    downloadStream,
    mergedHeaders,
    selectedVariant,
    selectedSegments,
    selectedInitSegmentUrl,
  } = params;
  const audioSegments = parsed.raw.audioSegments!;
  const concurrency = downloadParams.concurrency ?? 3;
  const videoTmpPath = join(getHomeTabtinPath('tmp'), `video-${Date.now()}.mp4`);
  const audioTmpPath = join(getHomeTabtinPath('tmp'), `audio-${Date.now()}.mp4`);

  const [videoResult, audioResult] = await Promise.all([
    downloadStream(selectedSegments, {
      outputPath: videoTmpPath,
      concurrency,
      headers: mergedHeaders,
      initSegmentUrl: selectedInitSegmentUrl,
      outputExtension: 'mp4',
      signal: downloadParams.signal,
      // 进度回调只挂视频轨（音视频并行，挂两路会互相覆盖；视频轨分片代表整体进度）。
      onProgress: downloadParams.onProgress,
    }),
    downloadStream(audioSegments.segments, {
      outputPath: audioTmpPath,
      concurrency,
      headers: mergedHeaders,
      initSegmentUrl: audioSegments.initSegmentUrl,
      outputExtension: 'mp4',
      signal: downloadParams.signal,
    }),
  ]);

  if (!videoResult.path || !audioResult.path) {
    await unlink(videoTmpPath).catch(() => {});
    await unlink(audioTmpPath).catch(() => {});
    return {
      ...videoResult,
      streamType: 'dash',
      selectedVariant,
      warning: 'DASH_AUDIO_NOT_MERGED',
      warningMessage: '音轨或视频轨下载失败，无法合并。',
    };
  }

  const finalPath = downloadParams.outputPath || join(getHomeTabtinPath('downloads'), `stream-${Date.now()}.mp4`);
  try {
    await execFileAbortable('ffmpeg', [
      '-i', videoResult.path, '-i', audioResult.path,
      '-c', 'copy', '-y', finalPath,
    ], { timeout: Math.max(120_000, selectedSegments.length * 500), signal: downloadParams.signal });

    return {
      success: videoResult.success && audioResult.success,
      partial: videoResult.partial || audioResult.partial || undefined,
      failedSegments: (videoResult.failedSegments ?? 0) + (audioResult.failedSegments ?? 0) || undefined,
      path: finalPath,
      segments: videoResult.segments + audioResult.segments,
      totalSize: videoResult.totalSize + audioResult.totalSize,
      duration: Math.max(videoResult.duration, audioResult.duration),
      format: 'mp4',
      streamType: 'dash',
      selectedVariant,
      videoDuration: parsed.data.duration,
      resolution: selectedVariant?.resolution,
    };
  } finally {
    await unlink(videoTmpPath).catch(() => {});
    await unlink(audioTmpPath).catch(() => {});
  }
}

async function downloadDaemonDashStream(
  parsed: ParsedDashStream,
  params: DownloadDaemonStreamParams,
  mergedHeaders: Record<string, string>,
  downloadStream: StreamDownloader,
): Promise<DownloadDaemonStreamResult> {
  const { manifest, selectedVariant, selectedSegments, selectedInitSegmentUrl } =
    resolveDashDownloadSelection(parsed, params.quality);

  if (!selectedSegments?.length) {
    throw new Error('MPD 中无可下载分片');
  }

  if (await canMergeDashAudio(manifest)) {
    return await downloadAndMergeDashTracks({
      parsed,
      downloadParams: params,
      downloadStream,
      mergedHeaders,
      selectedVariant,
      selectedSegments,
      selectedInitSegmentUrl,
    });
  }

  const result = await downloadStream(selectedSegments, {
    outputPath: params.outputPath,
    concurrency: params.concurrency ?? 3,
    headers: mergedHeaders,
    initSegmentUrl: selectedInitSegmentUrl,
    outputExtension: 'mp4',
    signal: params.signal,
    onProgress: params.onProgress,
  });

  return {
    ...result,
    streamType: 'dash',
    selectedVariant,
    videoDuration: parsed.data.duration,
    resolution: selectedVariant?.resolution,
    ...(manifest.hasAudioTrack ? {
      warning: 'DASH_AUDIO_NOT_MERGED' as const,
      warningMessage: 'ffmpeg 不可用，当前仅下载视频轨。安装 ffmpeg 后可自动合并音视频。',
    } : {}),
  };
}

async function downloadDaemonHlsStream(
  parsed: ParsedHlsStream,
  params: DownloadDaemonStreamParams,
  mergedHeaders: Record<string, string>,
  downloadStream: StreamDownloader,
): Promise<DownloadDaemonStreamResult> {
  let manifest = parsed.raw;
  let selectedVariant: ParsedStreamData['variants'][number] | undefined;

  if (manifest.type === 'master' && manifest.variants.length > 0) {
    const selectedIndex = selectVariantIndex(manifest.variants, params.quality);
    selectedVariant = manifest.variants[selectedIndex] || manifest.variants[0];

    const { fetchAndParseM3U8 } = await import('./m3u8-parser.js');
    manifest = await fetchAndParseM3U8(selectedVariant.uri, mergedHeaders, {
      signal: params.signal,
    });

    if (manifest.type === 'master') {
      throw new Error('HLS 不支持嵌套 Master Playlist（二级 master 指向的仍是 master）');
    }
  }

  const result = await downloadStream(manifest.segments, {
    outputPath: params.outputPath,
    concurrency: params.concurrency ?? 3,
    headers: mergedHeaders,
    initSegmentUrl: manifest.initSegmentUrl,
    signal: params.signal,
    onProgress: params.onProgress,
  });

  return {
    ...result,
    streamType: 'hls',
    ...(selectedVariant ? { selectedVariant } : {}),
    videoDuration: manifest.totalDuration,
    resolution: selectedVariant?.resolution,
  };
}

async function downloadDaemonStreamUrl(
  params: DownloadDaemonStreamParams,
): Promise<DownloadDaemonStreamResult> {
  const authHeaders = await extractAuthHeaders(params.url, params.tabId);
  const mergedHeaders: Record<string, string> = { ...authHeaders, ...(params.headers ?? {}) };

  const parsed = await parseDaemonStream(params.url, mergedHeaders, params.signal);
  const { downloadStream } = await import('./stream-downloader.js');
  assertStreamDownloadable(parsed);

  return parsed.streamType === 'dash'
    ? await downloadDaemonDashStream(parsed, params, mergedHeaders, downloadStream)
    : await downloadDaemonHlsStream(parsed, params, mergedHeaders, downloadStream);
}

let _ffmpegAvailable: boolean | null = null;
async function checkFfmpegAvailable(): Promise<boolean> {
  if (_ffmpegAvailable !== null) return _ffmpegAvailable;
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 5_000 });
    _ffmpegAvailable = true;
  } catch {
    _ffmpegAvailable = false;
  }
  return _ffmpegAvailable;
}

/**
 * 从当前页面收集 smart-download 候选媒体（BR-4：让 Daemon 也能「从页面挑选」）。
 *
 * 无 Electron 资源中心，Daemon 用两路来源拼候选：
 *   1) ResourceTracker（CDP Network 捕获）——页面真实发起的媒体请求，带 requestId，
 *      可直接 tracker.download 取 body；
 *   2) DOM `<video>/<audio>` 探测——补 tracker 漏掉的 currentSrc / `<source>`，并识别
 *      blob:（MediaSource）→ 标 page_bound_blob（无头端无法捕获，交由选择器排到最后/诚实降级）。
 * 类别用共享 classifyMediaResource 推断，与 Electron 对齐；只保留 hls/dash/video/audio。
 * 同 URL 以 tracker 条目优先（带 requestId 才能下）。
 */
async function collectDaemonMediaCandidates(
  svc: DaemonBrowserService,
  tabId: string | undefined,
): Promise<SmartDownloadCandidate[]> {
  const byUrl = new Map<string, SmartDownloadCandidate>();
  const keep = new Set(['hls', 'dash', 'video', 'audio']);

  const tracker = svc.getResourceTracker(tabId);
  if (tracker?.isEnabled) {
    for (const entry of tracker.list()) {
      const category = classifyMediaResource(entry.url, entry.mimeType);
      if (!keep.has(category)) continue;
      byUrl.set(entry.url, {
        resourceId: entry.requestId,
        url: entry.url,
        category,
        mimeType: entry.mimeType,
        size: entry.contentLength,
        captureStatus: entry.captured ? 'content_cached' : 'metadata_only',
      });
    }
  }

  try {
    const page = svc.getPage(tabId);
    const domMedia = await page.evaluate(() => {
      const out: Array<{ url: string; tag: string; isBlob: boolean }> = [];
      for (const el of Array.from(document.querySelectorAll('video, audio'))) {
        const media = el as HTMLMediaElement;
        const urls = [
          media.currentSrc,
          ...Array.from(media.querySelectorAll('source')).map((s) => s.getAttribute('src') || ''),
        ];
        for (const url of urls) {
          if (url) out.push({ url, tag: media.tagName.toLowerCase(), isBlob: url.startsWith('blob:') });
        }
      }
      return out;
    });

    for (const item of domMedia) {
      if (byUrl.has(item.url)) continue;
      const inferred = classifyMediaResource(item.url);
      // blob: 无后缀/无 mime，inferred 落 other —— 按元素标签归 video/audio，标记页面内 blob。
      const category = inferred !== 'other' ? inferred : item.tag === 'audio' ? 'audio' : 'video';
      if (!keep.has(category)) continue;
      byUrl.set(item.url, {
        url: item.url,
        category,
        captureStatus: item.isBlob ? 'page_bound_blob' : 'metadata_only',
      });
    }
  } catch {
    // 页面已关闭 / evaluate 失败：仅用 tracker 候选，不致命。
  }

  return [...byUrl.values()];
}

/**
 * 直接把一个媒体 URL 落盘（非流媒体走这条）。
 *
 * 优先用 ResourceTracker 已捕获的 body（CDP，无需二次请求、自带鉴权上下文）；
 * 否则 safeFetchBuffer 服务端拉取（SSRF 白名单 + 流式大小护栏，默认 50MB）。
 * 超限/失败时如实返回，不假装成功。
 */
async function downloadDaemonDirectUrl(params: {
  svc: DaemonBrowserService;
  tabId: string | undefined;
  resourceId?: string;
  url?: string;
  headers?: Record<string, string>;
  outputPath?: string;
}): Promise<{ success: boolean; path?: string; size?: number; error?: string; source?: string }> {
  const { svc, tabId, resourceId, url, headers, outputPath } = params;
  if (outputPath) validateSavePath(outputPath, svc.getWorkspaceRoot());

  const tracker = svc.getResourceTracker(tabId);
  const trackedResult = await tryDownloadTrackedResource(tracker, resourceId, outputPath);
  if (trackedResult) return trackedResult;

  if (!url) {
    return { success: false, error: '无可用的资源 URL（未被 ResourceTracker 捕获且未提供 URL）' };
  }

  const authHeaders = await extractAuthHeaders(url, tabId).catch(() => ({} as Record<string, string>));
  const mergedHeaders = { ...authHeaders, ...(headers ?? {}) };

  let buffer: Buffer;
  try {
    const { safeFetchBuffer } = await import('./safe-fetch.js');
    buffer = await safeFetchBuffer(url, { headers: mergedHeaders });
  } catch (err: any) {
    return { success: false, error: err?.message || '直接下载失败（可能超出大小限制或网络错误）' };
  }

  const filename = filenameFromDownloadUrl(url);
  const finalPath = outputPath || join(getHomeTabtinPath('downloads'), filename);
  try {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(finalPath), { recursive: true });
    await writeFile(finalPath, buffer);
    return { success: true, path: finalPath, size: buffer.length, source: 'direct_fetch' };
  } catch (err: any) {
    return { success: false, error: err?.message || '写入文件失败' };
  }
}

async function tryDownloadTrackedResource(tracker: ReturnType<DaemonBrowserService['getResourceTracker']>, resourceId?: string, outputPath?: string) {
  if (!resourceId || !tracker?.isEnabled || !tracker.inspect(resourceId)) return null;
  return { ...await tracker.download(resourceId, outputPath), source: 'resource_tracker' };
}

function filenameFromDownloadUrl(url: string): string {
  try { return basename(new URL(url).pathname) || `download-${Date.now()}`; }
  catch { return `download-${Date.now()}`; }
}

/**
 * 把流媒体异常分类成 `BrowserActionResult`（BR-8 P3c③：原 `classifyStreamError` 的返回版，
 * 不再 sendJSON）。状态码 / 错误码 / message / suggestions 与原实现逐字一致。
 */
function classifyStreamErrorResult(err: any, fallbackMsg: string): BrowserActionResult {
  const { message: msg, code, name } = normalizeStreamError(err);

  if (name === 'AbortError') {
    return { ok: false, status: 499, error: { code: 'ABORTED', message: msg || '操作已取消', retryable: false } };
  }

  if (code === STREAM_ERROR_CODES.ENCRYPTED) {
    return { ok: false, status: 403, error: { code: STREAM_ERROR_CODES.ENCRYPTED, message: msg, suggestions: [
      '该流使用了加密保护，Daemon 当前不支持解密下载',
      '这可能是付费内容或受版权保护的视频',
    ] } };
  }

  if (includesAny(msg, ['403', 'Forbidden'])) {
    return { ok: false, status: 403, error: { code: STREAM_ERROR_CODES.AUTH_REQUIRED, message: msg, suggestions: [
      '此视频可能需要登录才能访问',
      '尝试在 Daemon 浏览器中先登录该网站，然后重试',
      '或通过 headers 参数传入认证 Cookie',
    ] } };
  }

  if (includesAny(msg, ['429', 'Too Many'])) {
    return { ok: false, status: 429, error: { code: STREAM_ERROR_CODES.RATE_LIMITED, message: msg, retryable: true,
      suggestions: ['CDN 限速，请稍后重试或降低并发数（concurrency: 1）'] } };
  }

  if (includesAny(msg, ['404', 'Not Found'])) {
    return { ok: false, status: 404, error: { code: STREAM_ERROR_CODES.NOT_FOUND, message: msg } };
  }

  if (includesAny(msg, ['AbortError', 'timeout', 'Timeout'])) {
    return { ok: false, status: 504, error: { code: STREAM_ERROR_CODES.TIMEOUT, message: msg, retryable: true,
      suggestions: ['请求超时，请检查网络或稍后重试'] } };
  }

  return { ok: false, status: 500, error: { code: 'INTERNAL_ERROR', message: msg || fallbackMsg, retryable: true } };
}

function normalizeStreamError(err: any): { message: string; code?: string; name?: string } {
  return err && typeof err === 'object'
    ? { message: typeof err.message === 'string' ? err.message : '', code: err.code, name: err.name }
    : { message: '' };
}

function includesAny(value: string, candidates: readonly string[]): boolean {
  return candidates.some(candidate => value.includes(candidate));
}

/**
 * `/parse-m3u8` / `/stream/parse` / `/stream/info` 在 Daemon 上行为一致（同一段实现）：
 * 解析 url（或从 resourceId 回解）→ 取鉴权头 → parseDaemonStream → 200。stream.parse / stream.info
 * 两个 hook 都走这里（BR-8 P3c③，零行为变更）。守卫 / 校验抛 `BrowserActionError`（Orchestrator
 * 转错误结果），引擎异常经 `classifyStreamErrorResult` 分类。
 */
async function runDaemonStreamParse(body: any): Promise<BrowserActionResult> {
  let url = normalizeOptionalString(body.url);
  if (!url && body.resourceId) {
    const svc = requireDaemonBrowser();
    const tracker = svc.getResourceTracker(body.tabId);
    const entry = tracker?.inspect(body.resourceId);
    if (entry?.url) {
      url = entry.url;
    } else {
      throw new BrowserActionError(404, { code: 'NOT_FOUND', message: `资源 ${body.resourceId} 不存在或无 URL` });
    }
  }
  if (!url) {
    throw new BrowserActionError(400, { code: 'VALIDATION_ERROR', message: '缺少 url 参数' });
  }
  assertDaemonUrl(url);

  try {
    const svcForAuth = dependencies.resolveBrowser();
    const authHeaders = svcForAuth ? await extractAuthHeaders(url, body.tabId) : {};
    const mergedHeaders = { ...authHeaders, ...(body.headers ?? {}) };
    const parsed = await parseDaemonStream(url, mergedHeaders);
    return {
      ok: true,
      status: 200,
      data: {
        ...parsed.data,
        note: parsed.streamType === 'dash'
          ? 'Daemon 模式已支持 DASH manifest 信息解析；下载仍为降级能力。'
          : 'Daemon 模式已解析 HLS 流信息。',
      },
    };
  } catch (err: any) {
    return classifyStreamErrorResult(err, '流媒体解析失败');
  }
}

// ── 自描述 Orchestrator 宿主钩子（BR-8 P1）──────────────────────────

/**
 * Daemon 端 `context` 的「最后一公里」：从 DaemonBrowserService 取活跃 tab / tabCount /
 * workspaceRoot，crawlspace 恒 null（headless 无可见工作区聚合层），space 取自 CLI 上下文。
 * `runtime` 由 Orchestrator 经 hostHooks.runtime 统一拼，这里不重复。
 *
 * 行为与迁移前 `/context` 分支逐字段一致（纯结构搬迁，零行为变更）。
 */
async function getDaemonContextInfo(): Promise<BrowserContextInfo> {
  const svc = dependencies.resolveBrowser();
  let activeTab: { id: string; url: string | null; title: string | null } | null = null;
  let tabCount = 0;
  let workspaceRoot: string | null = null;
  if (svc) {
    try { workspaceRoot = svc.getWorkspaceRoot() ?? null; } catch { /* ignore */ }
  }
  if (svc?.isAvailable()) {
    try {
      const tabs = svc.listTabs();
      tabCount = tabs.length;
      const activeId = svc.getActiveTabId();
      if (activeId) {
        const entry = tabs.find((t) => t.id === activeId);
        let title: string | null = null;
        try {
          const nav = await svc.getNavigationState();
          title = nav.title ?? null;
        } catch { /* page 可能未就绪 */ }
        activeTab = { id: activeId, url: entry?.url ?? null, title };
      }
    } catch { /* 浏览器未就绪，保持 activeTab=null */ }
  }
  return {
    source: 'daemon',
    spaceId: dependencies.getSpaceId() ?? null,
    // Daemon 无 crawlspace 概念（headless 无可见工作区聚合层）。
    crawlspaceId: null,
    workspaceRoot: workspaceRoot ?? process.cwd(),
    activeTab,
    tabCount,
  };
}

/**
 * Daemon 端 act/observe 的「最后一公里」执行原语，注入 Orchestrator。
 *
 * 行为逐字段复刻原 route：
 *  - `prepareTab`：`requireBrowser`（svc/Chrome 守卫）+ `isBrowserCoreReady` 守卫（均 503）
 *    + 可选 url 校验（400）/ `ensureTab` + 取活跃 tab；守卫失败抛 `BrowserActionError`。
 *  - `runAct`/`runObserve`：直连 `BrowserToolImpl`；现状**恒 200**（引擎 `success:false` 留在
 *    payload 里），故恒回 `success: true`；引擎抛错时抛 500 retryable（沿用原 catch 文案）。
 *  - observe `limit` 默认 100；act 拒绝空 actions 数组（`requireNonEmptyActions`）——保留现状。
 */
const daemonExecHooks: BrowserExecHooks = {
  observeLimitDefault: 100,
  requireNonEmptyActions: true,

  async prepareTab(body: any): Promise<string | undefined> {
    const svc = dependencies.resolveBrowser();
    if (!svc) {
      throw new BrowserActionError(503, {
        code: 'INTERNAL_ERROR',
        message: 'DaemonBrowserService 尚未初始化',
        retryable: true,
        suggestions: ['确保系统已安装 Chrome/Chromium'],
      });
    }
    if (!svc.isAvailable()) {
      throw new BrowserActionError(503, {
        code: 'INTERNAL_ERROR',
        message: '未检测到 Chrome/Chromium',
        suggestions: ['安装 Google Chrome 或 Chromium', '或设置 CHROME_PATH 环境变量指向 Chrome 可执行文件'],
      });
    }
    if (!svc.isBrowserCoreReady()) {
      throw new BrowserActionError(503, {
        code: 'INTERNAL_ERROR',
        message: 'browser-core 尚未初始化',
        retryable: true,
        suggestions: ['确保 DaemonBrowserService.initBrowserCore() 已完成'],
      });
    }
    if (body.url) {
      try {
        validateUrl(body.url);
      } catch (err: any) {
        throw new BrowserActionError(400, {
          code: 'VALIDATION_ERROR',
          message: err?.message || '无效的 URL',
          suggestions: ['仅允许 http:// 和 https:// 协议，且禁止访问内网地址'],
        });
      }
    }
    try {
      await ensureTab(svc, body.url);
    } catch (err: any) {
      // 引擎抛错时沿用原 act/observe catch 文案：err.message 优先（两端 catch 一致）。
      throw new BrowserActionError(500, {
        code: 'INTERNAL_ERROR',
        message: err?.message || '浏览器准备失败',
        retryable: true,
      });
    }
    return body.tabId || svc.getActiveTabId() || undefined;
  },

  async runAct(tabId: string | undefined, resolvedActions: any[], body: any): Promise<BrowserExecOutcome> {
    try {
      const { getSharedBrowserToolImpl } = await import('@tabtin/browser-core');
      const impl = getSharedBrowserToolImpl();
      const result = await impl.executeAct({
        crawlTabId: tabId,
        actions: resolvedActions,
        runId: body.runId,
        timeout: body.timeout,
        stop_on_error: body.stop_on_error ?? body.stopOnError,
      });
      // 现状：恒 200 直透引擎全量 ExecuteActOutput（含 success:false 时也 200）。
      return { success: true, raw: result };
    } catch (err: any) {
      throw new BrowserActionError(500, {
        code: 'INTERNAL_ERROR',
        message: err?.message || '浏览器操作执行失败',
        retryable: true,
      });
    }
  },

  async runObserve(tabId: string | undefined, params: BrowserObserveParams, body: any): Promise<BrowserExecOutcome> {
    try {
      const { getSharedBrowserToolImpl } = await import('@tabtin/browser-core');
      const impl = getSharedBrowserToolImpl();
      const result = await impl.executeObserve({
        crawlTabId: tabId,
        runId: body.runId,
        selector: params.selector,
        limit: params.limit,
        include_som: params.include_som,
      });
      return { success: true, raw: result };
    } catch (err: any) {
      throw new BrowserActionError(500, {
        code: 'INTERNAL_ERROR',
        message: err?.message || '页面元素观察失败',
        retryable: true,
      });
    }
  },

  async runSnapshot(body: any, params: BrowserSnapshotRequestParams): Promise<BrowserExecOutcome> {
    const svc = requireDaemonBrowserOrThrow();
    await prepareSnapshotTab(svc, body.url);

    const tabId = body.tabId || svc.getActiveTabId();

    if (!svc.isBrowserCoreReady() || !tabId) {
      const content = await svc.getPageContent(tabId ?? undefined);
      const responseData: Record<string, any> = {
        url: content.url,
        title: content.title,
        text: content.text,
      };
      if (params.include_raw_html || params.include_clean_html) {
        // 降级路径也吃内容类型白名单，与富快照口径一致。
        const include = parseContentTypeWhitelist(params.include_content_types) ?? new Set<ContentType>();
        responseData.html = filterHtmlByContentTypes(content.html ?? '', include);
      }
      return { success: true, raw: { degraded: true, data: responseData, crawlTabId: tabId } };
    }

    const { getSharedBrowserToolImpl } = await import('@tabtin/browser-core');
    const impl = getSharedBrowserToolImpl();
    const result = await impl.requestSnapshot({
      crawlTabId: tabId,
      runId: body.runId,
      ...params,
    });

    if (!result.success || !result.data) {
      return {
        success: false,
        raw: result,
        errorMessage: result.error?.message || '快照获取失败',
      };
    }

    return { success: true, raw: { data: result.data, crawlTabId: tabId } };
  },

  async persistSnapshotScreenshot(
    base64: string,
    savePath: string | undefined,
  ): Promise<string> {
    try {
      const svc = dependencies.resolveBrowser();
      return await saveSnapshotScreenshot(base64, savePath, svc?.getWorkspaceRoot());
    } catch (saveErr: any) {
      console.warn('[browser/snapshot] 截图落盘失败:', saveErr?.message);
      throw saveErr;
    }
  },

  async runEval(_tabId: string | undefined, code: string, body: any): Promise<BrowserExecOutcome> {
    const svc = dependencies.resolveBrowser();
    if (!svc) {
      throw new BrowserActionError(503, {
        code: 'INTERNAL_ERROR',
        message: 'DaemonBrowserService 尚未初始化',
        retryable: true,
        suggestions: ['确保系统已安装 Chrome/Chromium'],
      });
    }
    if (!svc.isAvailable()) {
      throw new BrowserActionError(503, {
        code: 'INTERNAL_ERROR',
        message: '未检测到 Chrome/Chromium',
        suggestions: [
          '安装 Google Chrome 或 Chromium',
          '或设置 CHROME_PATH 环境变量指向 Chrome 可执行文件',
        ],
      });
    }
    try {
      await ensureTab(svc);
      // executeScript 返回 unknown（脚本结果可为对象/原始值）；原 route 直透 okResponse(result)，
      // 经 Orchestrator 仍走 `data: outcome.raw` 原样下发，强转仅为满足 raw 的声明类型、不改值。
      const result = await svc.executeScript(code, body.tabId);
      return { success: true, raw: result as Record<string, any> };
    } catch (err: any) {
      throw new BrowserActionError(500, {
        code: 'INTERNAL_ERROR',
        message: err?.message || 'JS 执行失败',
        retryable: true,
      });
    }
  },
};

// ── record / replay 的「最后一公里」（BR-8 P3c 收尾④）──────────────────

function requireBrowserApplication() {
  return dependencies;
}

/** 复刻 `requireBrowser` 的 503 守卫，但以 `BrowserActionError` 上抛（供 session hook 用）。 */
function requireDaemonBrowserOrThrow() {
  const svc = dependencies.resolveBrowser();
  if (!svc) {
    throw new BrowserActionError(503, {
      code: 'INTERNAL_ERROR',
      message: 'DaemonBrowserService 尚未初始化',
      retryable: true,
      suggestions: ['确保系统已安装 Chrome/Chromium'],
    });
  }
  if (!svc.isAvailable()) {
    throw new BrowserActionError(503, {
      code: 'INTERNAL_ERROR',
      message: '未检测到 Chrome/Chromium',
      suggestions: ['安装 Google Chrome 或 Chromium', '或设置 CHROME_PATH 环境变量指向 Chrome 可执行文件'],
    });
  }
  return svc;
}

async function prepareSnapshotTab(svc: ReturnType<typeof requireDaemonBrowserOrThrow>, url?: string): Promise<void> {
  if (url) {
    try { validateUrl(url); }
    catch (err: any) {
      throw new BrowserActionError(400, { code: 'VALIDATION_ERROR', message: err?.message || '无效的 URL', suggestions: ['仅允许 http:// 和 https:// 协议，且禁止访问内网地址'] });
    }
  }
  try { await ensureTab(svc, url); }
  catch (err: any) {
    throw new BrowserActionError(500, { code: 'INTERNAL_ERROR', message: err?.message || '浏览器准备失败', retryable: true });
  }
}

async function runDaemonReplay(
  body: any,
  opts?: { signal?: AbortSignal; onProgress?: (p: BrowserJobProgress) => void },
): Promise<BrowserSessionData> {
  requireDaemonBrowserOrThrow();

  const runId = body.runId;
  if (!runId) {
    throw new BrowserActionError(400, { code: 'VALIDATION_ERROR', message: '缺少 runId 参数' });
  }

  try {
    const { ReplayEngine } = await import('./RecordingSession.js');
    const recording = await requireBrowserApplication().loadRecording(runId);
    if (!recording) {
      throw new BrowserActionError(404, { code: 'NOT_FOUND', message: `录制 ${runId} 不存在` });
    }

    const engine = new ReplayEngine();
    const result = await engine.run(recording, async (action) => {
      if (opts?.signal?.aborted) {
        const err = new Error('Replay aborted');
        err.name = 'AbortError';
        throw err;
      }

      const subBody = buildReplayActionBody(action, body.tabId);

      await dependencies.executeReplayAction(action.type, subBody);
    }, buildReplayOptions(body, opts));

    return result as unknown as BrowserSessionData;
  } catch (err: any) {
    // 未找到（404）原样上抛；引擎异常沿用原 catch → 500 retryable。
    if (err instanceof BrowserActionError) throw err;
    throw new BrowserActionError(500, {
      code: err?.name === 'AbortError' ? 'ABORTED' : 'INTERNAL_ERROR',
      message: err?.message || '回放失败',
      retryable: err?.name === 'AbortError' ? false : true,
    });
  }
}

function buildReplayOptions(body: any, opts?: { signal?: AbortSignal; onProgress?: (p: BrowserJobProgress) => void }) {
  return {
    speed: body.speed ?? 1,
    skipWaits: body.skipWaits ?? body.skip_waits ?? false,
    stopOnError: body.stopOnError ?? body.stop_on_error ?? true,
    signal: opts?.signal,
    onProgress: (progress: { total: number; completed: number }) => {
      const percent = progress.total > 0 ? Math.min(100, Math.round((progress.completed / progress.total) * 100)) : 0;
      opts?.onProgress?.({ phase: 'replaying', percent, completed: progress.completed, total: progress.total, detail: `已回放 ${progress.completed}/${progress.total} 个动作` });
    },
  };
}

function buildReplayActionBody(action: any, tabId: unknown): any {
  const body: any = { ...action.args, tabId };
  for (const field of ['url', 'selector', 'value', 'expression', 'direction']) {
    if (action[field]) body[field] = action[field];
  }
  return body;
}

/**
 * Daemon 端 record / replay 的「最后一公里」，注入 Orchestrator。逐字段复刻原 route：
 * 响应体为 daemon 动作脚本模型（与 Electron 形状不同，见 `BrowserSessionData` 迁移缝说明）；
 * 校验/未找到经 `BrowserActionError` 上抛。Daemon 无 `run.*`，不注入 run hook → 维持现状 404。
 */
const daemonSessionHooks: BrowserSessionHooks = {
  async recordStart(body: any): Promise<BrowserSessionData> {
    requireDaemonBrowserOrThrow();
    const runId = body.runId || `rec-${Date.now()}`;
    try {
      const recording = await requireBrowserApplication().startRecording(runId, body.tabId);
      return { runId, recording: true, startedAt: recording.startedAt };
    } catch (err: any) {
      throw new BrowserActionError(500, {
        code: 'INTERNAL_ERROR',
        message: err?.message || '启动录制失败',
        retryable: true,
      });
    }
  },

  async recordStop(body: any): Promise<BrowserSessionData> {
    requireDaemonBrowserOrThrow();
    try {
      const recording = await requireBrowserApplication().stopRecording(body.runId);
      if (!recording) {
        throw new BrowserActionError(400, { code: 'VALIDATION_ERROR', message: body.runId ? `录制 ${body.runId} 不存在` : '无活跃的录制' });
      }

      return {
        runId: recording.runId,
        actionCount: recording.actions.length,
        startedAt: recording.startedAt,
        endedAt: recording.endedAt,
      };
    } catch (err: any) {
      // 校验类（400）原样上抛；引擎异常沿用原 catch → 500 retryable。
      if (err instanceof BrowserActionError) throw err;
      throw new BrowserActionError(500, {
        code: 'INTERNAL_ERROR',
        message: err?.message || '停止录制失败',
        retryable: true,
      });
    }
  },

  async recordStatus(body: any): Promise<BrowserSessionData> {
    requireDaemonBrowserOrThrow();
    const runId = body.runId;
    if (runId) {
      const status = dependencies.getRecordingStatus(runId);
      return status || { recording: false };
    }
    return { recording: false, note: '使用 runId 查询特定录制' };
  },

  async replayRun(body: any): Promise<BrowserSessionData> {
    return runDaemonReplay(body);
  },

  async replayList(): Promise<BrowserSessionData> {
    requireDaemonBrowserOrThrow();
    try {
      const list = await requireBrowserApplication().listRecordings();
      return { recordings: list, total: list.length };
    } catch (err: any) {
      throw new BrowserActionError(500, {
        code: 'INTERNAL_ERROR',
        message: err?.message || '获取录制列表失败',
        retryable: true,
      });
    }
  },
};

/**
 * stream.download 的 daemon 实现（同步 hook 与异步 job 共用，BR-10 P2）。
 * `opts.signal` 透进 `downloadStream` → 真正停下分片下载循环；`opts.onProgress` 喂 job 进度。
 * 同步路径不传 opts，行为与既有逐字一致（零行为变更）。
 */
async function daemonStreamDownloadImpl(
  body: any,
  opts?: { signal?: AbortSignal; onProgress?: (p: DownloadProgress) => void },
): Promise<BrowserActionResult> {
  const url = resolveStreamDownloadUrl(body);
  assertDaemonUrl(url);

  try {
    const dlSvc = dependencies.resolveBrowser();
    const outputPath = firstBrowserBodyValue(body, ['output', 'outputPath', 'output_path', 'save_path', 'savePath', 'filename']);
    if (outputPath) validateSavePath(outputPath, dlSvc?.getWorkspaceRoot());
    const result = await downloadDaemonStreamUrl({
      url,
      headers: body.headers,
      quality: body.quality,
      outputPath,
      concurrency: body.concurrency,
      tabId: body.tabId,
      signal: opts?.signal,
      onProgress: opts?.onProgress,
    });

    if (result.success) {
      return { ok: true, status: 200, data: result as Record<string, unknown> };
    }
    if (result.partial) {
      return { ok: true, status: 200, data: { ...result, code: STREAM_ERROR_CODES.PARTIAL } };
    }
    return { ok: false, status: 500, error: { code: STREAM_ERROR_CODES.NETWORK_ERROR, message: (result.error as string) || '下载失败' } };
  } catch (err: any) {
    return classifyStreamErrorResult(err, '流媒体下载失败');
  }
}

function resolveStreamDownloadUrl(body: any): string {
  const explicit = normalizeOptionalString(body.url);
  if (explicit) return explicit;
  if (!body.resourceId) throw new BrowserActionError(400, { code: 'VALIDATION_ERROR', message: '缺少 url 参数' });
  const entry = requireDaemonBrowser().getResourceTracker(body.tabId)?.inspect(body.resourceId);
  if (entry?.url) return entry.url;
  throw new BrowserActionError(404, { code: 'NOT_FOUND', message: `资源 ${body.resourceId} 不存在或无 URL` });
}

function firstBrowserBodyValue(body: any, fields: readonly string[]): any {
  for (const field of fields) {
    if (body?.[field]) return body[field];
  }
  return undefined;
}

/**
 * resource.smart-download 的 daemon 实现（同步 hook 与异步 job 共用，BR-10 P2）。
 * 仅 `stream` 策略走分片下载器、可透传 signal/onProgress 真取消；`download`（直链/tracker）
 * 策略当前不接 signal（best-effort，cancel 仅标记 job、不中断直链下载）。
 */
async function daemonSmartDownloadImpl(
  body: any,
  opts?: { signal?: AbortSignal; onProgress?: (p: DownloadProgress) => void },
): Promise<BrowserActionResult> {
  const svc = requireDaemonBrowser();

  const explicitUrl = normalizeOptionalString(body.url);
  const explicitResourceId = normalizeOptionalString(body.resourceId ?? body.resource_id);
  const category = normalizeOptionalString(body.category);
  const smartOutputPath = firstBrowserBodyValue(body, ['output', 'outputPath', 'output_path', 'save_path', 'savePath', 'filename']);

  try {
    await ensureTab(svc);
    const tabId = normalizeOptionalString(body.tabId ?? body.tab_id) ?? svc.getActiveTabId() ?? undefined;

    const selection = await resolveSmartDownloadSelection(svc, tabId, explicitUrl, explicitResourceId, category);
    if ('errorResult' in selection) return selection.errorResult;
    const { target, strategy } = selection;

    // 2) page_bound_blob：无头端无法捕获 MediaSource blob —— 诚实降级（不假装成功）。
    if (strategy === 'capture-then-download') {
      return {
        ok: false,
        status: 501,
        error: {
          code: 'NOT_IMPLEMENTED',
          message: 'Daemon 模式无法捕获页面内 MediaSource blob（page_bound_blob），请在 Electron 端下载该媒体。',
          detail: { targetResource: { url: target.url, category: target.category, captureStatus: target.captureStatus } },
          suggestions: ['改用 Electron 端资源中心下载页面内 blob 媒体', '或提供该媒体的直链 / 流地址'],
        },
      };
    }

    validateOptionalSmartOutputPath(smartOutputPath, svc.getWorkspaceRoot());

    // 3) 按策略下载：stream 走分片下载器（可取消），download 走 tracker / 直链。
    let result: { success: boolean; error?: string; [k: string]: unknown };
    if (strategy === 'stream') {
      result = await downloadDaemonStreamUrl({
        url: target.url!,
        headers: body.headers,
        quality: body.quality,
        outputPath: smartOutputPath,
        concurrency: body.concurrency,
        tabId,
        signal: opts?.signal,
        onProgress: opts?.onProgress,
      });
    } else {
      result = await downloadDaemonDirectUrl({
        svc,
        tabId,
        resourceId: target.resourceId,
        url: target.url,
        headers: body.headers,
        outputPath: smartOutputPath,
      });
    }

    const targetResource = {
      resourceId: target.resourceId,
      url: target.url,
      category: target.category,
      captureStatus: target.captureStatus,
    };

    if (result.success) {
      return {
        ok: true,
        status: 200,
        data: {
          ...result,
          targetResource,
        },
      };
    }
    return {
      ok: false,
      status: 500,
      error: {
        code: STREAM_ERROR_CODES.NETWORK_ERROR,
        message: result.error || '智能下载失败',
        detail: { targetResource },
      },
    };
  } catch (err: any) {
    if (err instanceof BrowserActionError) throw err;
    return classifyStreamErrorResult(err, '智能下载失败');
  }
}

function validateOptionalSmartOutputPath(outputPath: any, workspaceRoot: string | undefined): void {
  if (outputPath) validateSavePath(outputPath, workspaceRoot);
}

async function resolveSmartDownloadSelection(
  svc: DaemonBrowserService,
  tabId: string | undefined,
  explicitUrl: string | undefined,
  resourceId: string | undefined,
  category: string | undefined,
): Promise<{ target: SmartDownloadCandidate; strategy: 'stream' | 'capture-then-download' | 'download' } | { errorResult: BrowserActionResult }> {
  if (explicitUrl) {
    assertDaemonUrl(explicitUrl);
    const mediaCategory = classifyMediaResource(explicitUrl);
    return { target: { url: explicitUrl, category: mediaCategory }, strategy: streamOrDirectStrategy(mediaCategory) };
  }
  if (resourceId) return resolveTrackedSmartDownload(svc, tabId, resourceId);
  const candidates = await collectDaemonMediaCandidates(svc, tabId);
  const selection = selectSmartDownloadTarget(candidates, { category });
  if (selection) return selection;
  return { errorResult: { ok: false, status: 404, error: { code: 'NO_MEDIA_FOUND', message: '页面上未发现可下载的媒体资源', detail: { candidateCount: candidates.length, probed: true }, suggestions: ['确保页面上有视频/音频内容（必要时先播放触发加载）', '或显式指定: tabtin browser resource smart-download --url <media-or-stream-url>'] } } };
}

function resolveTrackedSmartDownload(svc: DaemonBrowserService, tabId: string | undefined, resourceId: string) {
  const entry = svc.getResourceTracker(tabId)?.inspect(resourceId);
  if (!entry?.url) return { errorResult: { ok: false, status: 404, error: { code: 'NOT_FOUND', message: `资源 ${resourceId} 不存在或无 URL` } } } as const;
  const category = classifyMediaResource(entry.url, entry.mimeType);
  return { target: { resourceId, url: entry.url, category, mimeType: entry.mimeType }, strategy: streamOrDirectStrategy(category) } as const;
}

function streamOrDirectStrategy(category: string): 'stream' | 'download' {
  return category === 'hls' || category === 'dash' ? 'stream' : 'download';
}

/**
 * Daemon 端 resource / stream 家族的「最后一公里」（BR-8 P3c③），注入 Orchestrator 的独立
 * `resourceStream` 注入点。每个 hook 直接返回 `BrowserActionResult`，逐字复刻原 route 分支的
 * 状态码 / 形状 / 文案。守卫（requireDaemonBrowser→503 / assertDaemonUrl→400 / resourceId 回解
 * 404）抛 `BrowserActionError` 由 Orchestrator 转错误结果；引擎异常按各自原 catch 文案归一。
 * 内部 `if (err instanceof BrowserActionError) throw err` 保证守卫错误不被 500 catch 吞掉。
 */
const daemonResourceStreamHooks: BrowserResourceStreamHooks = {
  async runResourceList(body: any): Promise<BrowserActionResult> {
    const svc = requireDaemonBrowser();
    try {
      await ensureTab(svc);

      // 命令族统一 --compact：默认轻量（url/type/size）；--compact=false 加全字段。
      const compact = body.compact === true;
      const tracker = svc.getResourceTracker(body.tabId);
      if (tracker?.isEnabled) {
        // 无 --limit：缺省返回全部资源（ResourceTracker.list 对 undefined limit 即全量）。
        const entries = tracker.list({ category: body.category, limit: body.limit });
        const full = entries.map(e => ({
          name: e.url,
          type: e.resourceType.toLowerCase(),
          size: e.contentLength,
          status: e.status,
          mimeType: e.mimeType,
          resourceId: e.requestId,
        })).filter(resource => !shouldHideResourceSegments(body) || !isLikelyStreamSegment(resource));
        const resources = compact ? full.map(r => ({ name: r.name, type: r.type, size: r.size })) : full;
        return { ok: true, status: 200, data: { resources, total: resources.length, source: 'resource_tracker' } };
      }

      const page = svc.getPage(body.tabId);
      const resources = await page.evaluate(() => {
        const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
        return entries.map(e => ({
          name: e.name,
          type: e.initiatorType,
          size: e.transferSize,
          duration: Math.round(e.duration),
          protocol: e.nextHopProtocol,
        }));
      });

      const filter = body.category;
      const filtered = filter
        ? resources.filter((r: any) => r.type === filter)
        : resources;
      const visible = shouldHideResourceSegments(body)
        ? filtered.filter((resource: any) => !isLikelyStreamSegment(resource))
        : filtered;

      const shaped = body.limit ? visible.slice(0, body.limit) : visible;
      return {
        ok: true,
        status: 200,
        data: {
          resources: compact ? shaped.map((r: any) => ({ name: r.name, type: r.type, size: r.size })) : shaped,
          total: visible.length,
          source: 'performance_api',
          note: 'ResourceTracker 不可用，已降级使用 Performance API',
        },
      };
    } catch (err: any) {
      if (err instanceof BrowserActionError) throw err;
      return { ok: false, status: 500, error: { code: 'INTERNAL_ERROR', message: err?.message || '资源列表获取失败', retryable: true } };
    }
  },

  async runResourceProbe(body: any): Promise<BrowserActionResult> {
    const svc = requireDaemonBrowser();
    try {
      if (body.url) {
        assertDaemonUrl(body.url);
        await ensureTab(svc, body.url);
      } else {
        await ensureTab(svc);
      }

      const tabId = body.tabId || svc.getActiveTabId();
      const tracker = svc.getResourceTracker(tabId);
      const page = svc.getPage(tabId);
      const probe = await page.evaluate(() => {
        const startedAt = performance.now();
        const elements = Array.from(document.querySelectorAll('video, audio')).map((el) => {
          const media = el as HTMLMediaElement;
          return {
            tagName: media.tagName.toLowerCase(),
            currentSrc: media.currentSrc || '',
            sources: Array.from(media.querySelectorAll('source'))
              .map((source) => source.getAttribute('src') || '')
              .filter(Boolean),
            videoWidth: 'videoWidth' in media ? (media as HTMLVideoElement).videoWidth : undefined,
            videoHeight: 'videoHeight' in media ? (media as HTMLVideoElement).videoHeight : undefined,
            duration: Number.isFinite(media.duration) ? media.duration : undefined,
            usesMediaSource: Boolean(media.currentSrc?.startsWith('blob:')),
          };
        });
        return {
          elements,
          pageUrl: location.href,
          probeTimeMs: Math.round(performance.now() - startedAt),
        };
      });

      const resources = tracker?.isEnabled
        ? tracker.list({ limit: body.limit }).map((entry) => ({
            resourceId: entry.requestId,
            url: entry.url,
            category: entry.resourceType.toLowerCase(),
            mimeType: entry.mimeType,
            size: entry.contentLength,
            captureStatus: entry.captured ? 'content_cached' : 'metadata_only',
            statusCode: entry.status,
            method: entry.method,
          }))
        : [];

      const summary = resources.reduce(
        (acc, item: any) => {
          const category = typeof item.category === 'string' && item.category ? item.category : 'other';
          acc.total += 1;
          acc.byCategory[category] = (acc.byCategory[category] || 0) + 1;
          return acc;
        },
        { total: 0, byCategory: {} as Record<string, number> }
      );

      return {
        ok: true,
        status: 200,
        data: {
          probeResult: {
            elementCount: probe.elements.length,
            pageUrl: probe.pageUrl,
            probeTimeMs: probe.probeTimeMs,
          },
          elements: probe.elements,
          resources,
          summary,
          note: tracker?.isEnabled
            ? 'Daemon 模式使用 Playwright + CDP 做降级探测，不含 Electron WebContentsView 能力。'
            : '当前页面资源追踪未启用，已返回基础 DOM 媒体探测结果。',
        },
      };
    } catch (err: any) {
      if (err instanceof BrowserActionError) throw err;
      return { ok: false, status: 500, error: { code: 'INTERNAL_ERROR', message: err?.message || '资源探测失败', retryable: true } };
    }
  },

  async runResourceInspect(body: any): Promise<BrowserActionResult> {
    const svc = requireDaemonBrowser();
    const resourceId = body.resourceId;
    if (!resourceId) {
      return { ok: false, status: 400, error: { code: 'VALIDATION_ERROR', message: '缺少 resourceId 参数' } };
    }
    try {
      const tracker = svc.getResourceTracker(body.tabId);
      if (!tracker || !tracker.isEnabled) {
        return { ok: false, status: 503, error: { code: 'INTERNAL_ERROR', message: '资源追踪未启用，请先打开页面' } };
      }
      const entry = tracker.inspect(resourceId);
      if (!entry) {
        return { ok: false, status: 404, error: { code: 'NOT_FOUND', message: `资源 ${resourceId} 不存在` } };
      }
      return { ok: true, status: 200, data: entry as unknown as Record<string, unknown> };
    } catch (err: any) {
      if (err instanceof BrowserActionError) throw err;
      return { ok: false, status: 500, error: { code: 'INTERNAL_ERROR', message: err?.message || '资源检查失败', retryable: true } };
    }
  },

  async runResourceCapture(body: any): Promise<BrowserActionResult> {
    const svc = requireDaemonBrowser();
    const resourceId = body.resourceId;
    if (!resourceId) {
      return { ok: false, status: 400, error: { code: 'VALIDATION_ERROR', message: '缺少 resourceId 参数' } };
    }
    try {
      const tracker = svc.getResourceTracker(body.tabId);
      if (!tracker?.isEnabled) {
        return { ok: false, status: 503, error: { code: 'INTERNAL_ERROR', message: '资源追踪未启用' } };
      }
      const content = await tracker.capture(resourceId);
      if (!content) {
        return { ok: false, status: 404, error: { code: 'NOT_FOUND', message: `无法获取资源 ${resourceId} 的内容` } };
      }
      return { ok: true, status: 200, data: { resourceId, ...content } };
    } catch (err: any) {
      if (err instanceof BrowserActionError) throw err;
      return { ok: false, status: 500, error: { code: 'INTERNAL_ERROR', message: err?.message || '资源捕获失败', retryable: true } };
    }
  },

  async runResourceDownload(body: any): Promise<BrowserActionResult> {
    const svc = requireDaemonBrowser();
    const resourceId = body.resourceId;
    if (!resourceId) {
      return { ok: false, status: 400, error: { code: 'VALIDATION_ERROR', message: '缺少 resourceId 参数' } };
    }
    try {
      const tracker = svc.getResourceTracker(body.tabId);
      if (!tracker?.isEnabled) {
        return { ok: false, status: 503, error: { code: 'INTERNAL_ERROR', message: '资源追踪未启用' } };
      }
      const savePath = body.savePath || body.save_path;
      if (savePath) validateSavePath(savePath, svc?.getWorkspaceRoot());
      const result = await tracker.download(resourceId, savePath);
      if (result.success) {
        return { ok: true, status: 200, data: result as Record<string, unknown> };
      }
      return { ok: false, status: 500, error: { code: 'INTERNAL_ERROR', message: result.error || '下载失败' } };
    } catch (err: any) {
      if (err instanceof BrowserActionError) throw err;
      return { ok: false, status: 500, error: { code: 'INTERNAL_ERROR', message: err?.message || '资源下载失败', retryable: true } };
    }
  },

  async runStreamParse(body: any): Promise<BrowserActionResult> {
    return runDaemonStreamParse(body);
  },

  async runStreamInfo(body: any): Promise<BrowserActionResult> {
    return runDaemonStreamParse(body);
  },

  async runStreamDownload(body: any): Promise<BrowserActionResult> {
    // 同步路径（默认）：不传 signal/onProgress，行为与既有完全一致。异步 job 经 daemonExecuteJob
    // 调同一 impl 并透传 ctx.signal/reportProgress（BR-10 P2）。
    return daemonStreamDownloadImpl(body);
  },

  async runResourceSmartDownload(body: any): Promise<BrowserActionResult> {
    return daemonSmartDownloadImpl(body);
  },
};

/**
 * Daemon 端 BR-9 安全闸门的「处置」：confirm 类动作**默认放行（return true）+ 记一条日志**。
 *
 * 为什么放行而不是拒绝（这是已定的产品决策，零行为变更）：
 *  - Daemon 是**无头端**，没有可弹审批的人机 UI——无法做真人 confirm。
 *  - Daemon 现状 act/eval 等写操作本就**无 confirm 拦截**（见 br-9-design §1.2）；闸门挂上后若在
 *    daemon 默认拒绝，会把「现在能跑的 act」变成被 403 拒——这是回归。默认放行 = **零行为变更**。
 *  - `block` 类（受限脚本 `isBlockedScript` / 命令硬红线 `checkHardlineCommand` / 系统目录落盘
 *    `checkHardlinePath`）**不经本钩子**、由闸门直接拦——安全硬线双端都生效，daemon 同样拦。
 *
 * Daemon 的严格化（改 reject / 预授权 scope / 读 space policy 决策）是**后续独立产品决策**，不在 P1。
 */
const daemonPolicyHooks: BrowserPolicyHostHooks = {
  async resolveConfirmation(decision) {
    console.info(
      `[browser/policy] daemon 无人审批 UI，confirm 类动作默认放行（零行为变更）: ${decision.actionType} — ${decision.reason}`,
    );
    return true;
  },
};

/** 把分片下载进度映射成 job 进度快照（percent = 已完成/总分片）。 */
function downloadProgressToJobProgress(p: DownloadProgress): BrowserJobProgress {
  const percent = p.total > 0 ? Math.min(100, Math.round((p.completed / p.total) * 100)) : 0;
  return {
    phase: 'downloading',
    percent,
    completed: p.completed,
    total: p.total,
    detail: `已下载 ${p.completed}/${p.total} 分片${p.failed > 0 ? `，${p.failed} 失败` : ''}`,
  };
}

/**
 * Daemon 端长任务异步执行 + 取消的「最后一公里」（BR-10 P2）。
 *
 * `manager` 用进程级共享单例；`execute` 把 `actionId` 派到与同步路径**同一份** impl，并把
 * `ctx.signal` 透进 `downloadStream`（→ 真正中止下载循环）、`ctx.reportProgress` 喂分片进度。
 * impl 返回 `BrowserActionResult`：ok → 取 data 落 job.result；error/守卫 → 抛 `BrowserActionError`
 * 让 manager.fail 记录结构化错误。
 */
const daemonJobHooks: BrowserJobHooks = {
  // 不能在模块加载时固定住 manager：shutdownSharedBrowserJobManager() 会把共享单例置空并
  // shutdown 旧实例，同进程 dev stop/start 后必须重新取新 manager。
  get manager() {
    return getSharedBrowserJobManager();
  },
  async execute(actionId, body, ctx): Promise<unknown> {
    const opts = {
      signal: ctx.signal,
      onProgress: (p: DownloadProgress) => ctx.reportProgress(downloadProgressToJobProgress(p)),
    };
    let result: BrowserActionResult;
    if (actionId === 'stream.download') {
      result = await daemonStreamDownloadImpl(body, opts);
    } else if (actionId === 'resource.smart-download') {
      result = await daemonSmartDownloadImpl(body, opts);
    } else if (actionId === 'replay.run') {
      return runDaemonReplay(body, {
        signal: ctx.signal,
        onProgress: ctx.reportProgress,
      });
    } else {
      throw new BrowserActionError(400, { code: 'VALIDATION_ERROR', message: `job 暂不支持异步执行 action: ${actionId}` });
    }
    // daemon impl 永不产出 electron-executor 变体；真发生即契约被破坏，按 500 暴露。
    if ('kind' in result) {
      throw new BrowserActionError(500, { code: 'INTERNAL_ERROR', message: 'job 执行产出 electron-executor（不应发生）' });
    }
    if (result.ok) return result.data;
    throw new BrowserActionError(result.status, result.error);
  },
};

/** Daemon 端注入 Orchestrator 的宿主钩子。 */
const daemonHostHooks: BrowserOrchestratorHostHooks = {
  runtime: 'daemon',
  getContextInfo: getDaemonContextInfo,
  exec: daemonExecHooks,
  resourceStream: daemonResourceStreamHooks,
  session: daemonSessionHooks,
  // BR-9：confirm 默认放行（见 daemonPolicyHooks 注释）；block 类仍由闸门生效。
  policy: daemonPolicyHooks,
  jobs: daemonJobHooks,
};

/** route → session actionId 映射（Daemon 仅 record/replay；无 `run.*`，故 `/run/*` 不收录）。 */

  return daemonHostHooks;
}

export class DaemonBrowserApplication implements BrowserApplicationPort {
  private readonly hostHooks: BrowserOrchestratorHostHooks;

  constructor(private readonly dependencies: DaemonBrowserApplicationDependencies) {
    this.hostHooks = createDaemonBrowserHostHooks({
      ...dependencies,
      executeReplayAction: (actionType, body) => this.executeReplayAction(actionType, body),
    });
  }

  async execute(actionId: string, body: any): Promise<BrowserActionResult | null> {
    const result = await handleBrowserAction(actionId, body, this.hostHooks);
    if (result && 'ok' in result && result.ok) this.recordSuccessfulAction(body, actionId);
    if (actionId !== 'act' || !result || !('ok' in result) || !result.ok) return result;
    const observeRequested = body?.observe !== false;
    let observation: Record<string, unknown> | undefined;
    if (observeRequested) {
      const tabId = body?.tabId ?? body?.tab_id ?? this.dependencies.resolveBrowser()?.getActiveTabId() ?? undefined;
      if (tabId) {
        try {
          const observed = await withTimeout(
            handleBrowserAction('glance', { tabId, compact: true, ...(body?.runId ? { runId: body.runId } : {}) }, this.hostHooks),
            20_000,
          );
          if (observed && 'ok' in observed && observed.ok && Array.isArray((observed.data as any)?.observed_elements)) {
            const data = observed.data as Record<string, any>;
            observation = {
              ...(data.login_required ? { login_required: data.login_required } : {}),
              ...(typeof data.hint === 'string' && data.hint ? { hint: data.hint } : {}),
              observed_elements: data.observed_elements,
            };
          }
        } catch { /* observe is best-effort */ }
      }
    }
    return {
      ...result,
      data: mergeActEmbedObserve(result.data as Record<string, unknown>, {
        observeRequested,
        observation,
        observeFailed: observeRequested && !observation,
      }),
    };
  }

  getBrowserIfReady(): DaemonBrowserService | null {
    return this.dependencies.resolveBrowser();
  }

  startRecording(runId: string, tabId?: string) {
    return this.dependencies.startRecording(runId, tabId);
  }

  stopRecording(runId?: string) {
    return this.dependencies.stopRecording(runId);
  }

  getRecordingStatus(runId?: string) {
    return this.dependencies.getRecordingStatus(runId);
  }

  loadRecording(runId: string) {
    return this.dependencies.loadRecording(runId);
  }

  listRecordings() {
    return this.dependencies.listRecordings();
  }

  async ensureTab(url?: string): Promise<string> {
    const browser = this.dependencies.resolveBrowser();
    if (!browser) throw new Error('BrowserRuntime 尚未初始化');
    if (!browser.getActiveTabId()) {
      return browser.openTab({ url });
    }
    if (url) await browser.navigateTo(url);
    return browser.getActiveTabId()!;
  }

  async executeSessionCommand(actionId: string, body: any): Promise<BrowserActionResult> {
    try {
      const browser = this.requireBrowser();
      switch (actionId) {
        case 'session.create': {
          const name = normalizeOptionalString(body?.name);
          if (!name) return validationError('缺少 name 参数');
          return success(await browser.createSession(name));
        }
        case 'session.list':
          return success({ sessions: browser.listSessions(), active: browser.getActiveSessionName() });
        case 'session.switch': {
          const name = normalizeOptionalString(body?.name);
          if (!name) return validationError('缺少 name 参数');
          try {
            browser.switchSession(name);
            return success({ active: name });
          } catch (error: any) {
            return failure(404, 'NOT_FOUND', error?.message || `Session "${name}" 不存在`);
          }
        }
        case 'session.close': {
          const name = normalizeOptionalString(body?.name);
          if (!name) return validationError('缺少 name 参数');
          try {
            await browser.closeSession(name);
            return success({ closed: name, active: browser.getActiveSessionName() });
          } catch (error: any) {
            return failure(404, 'NOT_FOUND', error?.message || `Session "${name}" 不存在`);
          }
        }
        case 'session.close-all': {
          let closed = 0;
          for (const session of browser.listSessions()) {
            try {
              await browser.closeSession(session.name);
              closed += 1;
            } catch { /* continue closing the remaining sessions */ }
          }
          return success({ closed });
        }
        case 'session.save': {
          const name = normalizeOptionalString(body?.name);
          if (!name) return validationError('缺少 name 参数');
          return success(await browser.saveStorageState({
            name,
            tabId: normalizeOptionalString(body?.tabId ?? body?.tab_id ?? body?.crawlTabId),
          }));
        }
        case 'session.load': {
          const name = normalizeOptionalString(body?.name);
          if (!name) return validationError('缺少 name 参数');
          if (body?.state === undefined || body?.state === null) return validationError('缺少 state 参数');
          let state = body.state;
          if (typeof state === 'string') {
            try { state = JSON.parse(state); }
            catch { return validationError('state 必须是合法 JSON'); }
          }
          return success(await browser.loadStorageState(state, {
            name,
            tabId: normalizeOptionalString(body?.tabId ?? body?.tab_id ?? body?.crawlTabId),
            mode: normalizeOptionalString(body?.mode) as any,
            openMissingOrigins: Boolean(
              body?.openMissingOrigins
              ?? body?.open_missing_origins
              ?? body?.restoreSessionStorageMissingOrigins
              ?? body?.restore_session_storage_missing_origins
            ),
          }));
        }
        case 'session.info': {
          const tabs = browser.listTabs();
          let cookieCount = 0;
          try { cookieCount = (await browser.getCookies()).length; } catch { /* context may not exist */ }
          return success({ activeTabId: browser.getActiveTabId(), tabCount: tabs.length, tabs, cookieCount });
        }
        case 'session.cookies': {
          const action = body?.action || 'get';
          if (action === 'get') {
            const urls = Array.isArray(body.urls) ? body.urls : (body.url ? [body.url] : undefined);
            const cookies = await browser.getCookies(urls);
            return success({ cookies, count: cookies.length });
          }
          if (action === 'add' || action === 'set') {
            if (!Array.isArray(body.cookies) || body.cookies.length === 0) {
              return failure(400, 'VALIDATION_ERROR', '缺少 cookies 数组参数', {
                suggestions: ['body.cookies 应为 Playwright Cookie 对象数组，每项至少含 name、value、domain 或 url'],
              });
            }
            await browser.addCookies(body.cookies);
            return success({ added: body.cookies.length });
          }
          if (action === 'clear') {
            await browser.clearCookies();
            return success({ cleared: true });
          }
          return failure(400, 'VALIDATION_ERROR', `不支持的 cookies action: ${action}`, {
            suggestions: ['支持的 action: get（获取）、set（设置，等同 add）、clear（清除）'],
          });
        }
        case 'session.clear': {
          const clearCookies = body?.clearCookies ?? true;
          const clearLocalStorage = body?.clearLocalStorage ?? true;
          const clearCache = body?.clearCache ?? true;
          await browser.clearSession({ clearCookies, clearLocalStorage, clearCache });
          const items = [
            clearCookies && 'cookies',
            clearLocalStorage && 'localStorage/sessionStorage',
            clearCache && 'cache',
            'permissions',
          ].filter(Boolean);
          return success({ cleared: true, message: `已清除: ${items.join(', ')}` });
        }
        default:
          return failure(404, 'NOT_FOUND', `未知 session action: ${actionId}`);
      }
    } catch (error: any) {
      if (actionId === 'session.save' || actionId === 'session.load') {
        const mapped = mapStorageStateError(error);
        return failure(mapped.status, mapped.code, mapped.message, { retryable: mapped.retryable });
      }
      return toApplicationFailure(error, 'Session 操作失败');
    }
  }

  async executeNetworkCommand(actionId: string, body: any): Promise<BrowserActionResult> {
    try {
      const browser = this.requireBrowser();
      if (actionId === 'network.list') {
        await this.ensureTab();
        const tabId = normalizeOptionalString(body.tabId ?? body.tab_id) ?? browser.getActiveTabId();
        if (!tabId) return validationError('无活跃 Tab');
        const filter = normalizeOptionalString(body.filter);
        const invalid = validateRegexFilter(filter);
        if (invalid) return invalid;
        return success(browser.queryNetworkLog(tabId, {
          filter,
          runId: normalizeOptionalString(body.runId ?? body.run_id),
          includeRequestHeaders: readBoolFlag(body, 'includeRequestHeaders', 'include_request_headers'),
          includeRequestBody: readBoolFlag(body, 'includeRequestBody', 'include_request_body'),
          includeResponseHeaders: readBoolFlag(body, 'includeResponseHeaders', 'include_response_headers'),
          includeResponseBody: readBoolFlag(body, 'includeResponseBody', 'include_response_body'),
        }));
      }

      let entriesInput = body.input ?? body.entries ?? body.network;
      if (typeof entriesInput === 'string' && entriesInput.trim()) {
        try { entriesInput = JSON.parse(entriesInput); }
        catch {
          return failure(400, 'VALIDATION_ERROR', 'input 必须是 JSON 字符串或 network JSON 文件内容', {
            suggestions: ['示例: tabtin browser network --format json > network.json', '再运行: tabtin browser network to-api --input @network.json'],
          });
        }
      }
      if (entriesInput === undefined || entriesInput === null || entriesInput === '') {
        const tabId = normalizeOptionalString(body.tabId ?? body.tab_id) ?? browser.getActiveTabId();
        if (!tabId) {
          return failure(400, 'VALIDATION_ERROR', '无活跃 Tab，network to-api 不会隐式打开页面', {
            suggestions: ['先打开页面并产生 network 记录，或使用 --input @network.json 离线分析已有记录'],
          });
        }
        const filter = normalizeOptionalString(body.filter);
        const invalid = validateRegexFilter(filter);
        if (invalid) return invalid;
        entriesInput = browser.queryNetworkLog(tabId, {
          filter,
          runId: normalizeOptionalString(body.runId ?? body.run_id),
          includeRequestHeaders: false,
          includeResponseHeaders: false,
          includeRequestBody: true,
          includeResponseBody: true,
        });
      }
      return success(analyzeBrowserNetworkToOpenApi(normalizeBrowserNetworkEntries(entriesInput), {
        title: normalizeOptionalString(body.title),
        version: normalizeOptionalString(body.version),
      }));
    } catch (error: any) {
      return toApplicationFailure(error, '网络操作失败');
    }
  }

  async executeDownloadCommand(actionId: string, body: any): Promise<BrowserActionResult> {
    try {
      const browser = this.requireBrowser();
      if (actionId === 'download.single') {
        const targetUrl = normalizeOptionalString(body.url);
        if (!targetUrl) return validationError('缺少 url 参数');
        try { validateUrl(targetUrl); }
        catch (error: any) {
          return failure(400, 'VALIDATION_ERROR', error?.message || '无效的 URL', {
            suggestions: ['仅允许 http:// 和 https:// 协议，且禁止访问内网地址'],
          });
        }
        await this.ensureTab();
        const page = browser.getPage(body.tabId);
        const pending = page.waitForEvent('download', { timeout: 30_000 }).catch(() => null);
        await page.goto(targetUrl);
        const download = await pending;
        if (!download) {
          return success({ success: false, message: '页面未触发下载。如需导出页面内容，请使用 tabtin browser print。', url: targetUrl });
        }
        const filename = basename(body.filename || download.suggestedFilename());
        const savePath = body.save_path || body.savePath || `/tmp/tabtin-download-${filename}`;
        validateSavePath(savePath, browser.getWorkspaceRoot());
        await download.saveAs(savePath);
        return success({ success: true, path: savePath, filename, url: targetUrl });
      }

      const resourceIds = body.resourceIds as string[] | undefined;
      if (!Array.isArray(resourceIds) || resourceIds.length === 0) return validationError('需要 resourceIds 数组');
      const savePath = body.savePath || body.save_path;
      if (savePath) validateSavePath(savePath, browser.getWorkspaceRoot());
      const tracker = browser.getResourceTracker(body.tabId);
      if (!tracker?.isEnabled) return failure(503, 'INTERNAL_ERROR', '资源追踪未启用');
      const concurrency = body.concurrency ?? 3;
      if (!Number.isInteger(concurrency) || concurrency <= 0) {
        return validationError('concurrency 必须是正整数');
      }
      const results: Array<{ id: string; success: boolean; path?: string; error?: string }> = [];
      for (let index = 0; index < resourceIds.length; index += concurrency) {
        const batch = resourceIds.slice(index, index + concurrency);
        results.push(...await Promise.all(batch.map(async (id) => ({ id, ...await tracker.download(id, savePath) }))));
      }
      return success({ results, total: results.length });
    } catch (error: any) {
      return toApplicationFailure(error, '下载失败');
    }
  }

  async executePageCommand(actionId: string, body: any): Promise<BrowserActionResult> {
    try {
      const browser = this.requireBrowser();
      switch (actionId) {
        case 'page.open': {
          const url = normalizeOptionalString(body.url);
          if (!url) return failure(400, 'VALIDATION_ERROR', '缺少 url 参数', { suggestions: ['tabtin browser open https://example.com'] });
          try { validateUrl(url); }
          catch (error: any) {
            return failure(400, 'VALIDATION_ERROR', error?.message || '无效的 URL', {
              suggestions: ['仅允许 http:// 和 https:// 协议，且禁止访问内网地址'],
            });
          }
          const requestedTabId = normalizeOptionalString(body.tabId ?? body.tab_id);
          const waitSelector = normalizeOptionalString(body.waitSelector ?? body.wait_selector);
          const waitTimeout = body.waitForTimeout ?? body.wait_for_timeout ?? body.timeout;
          if (requestedTabId) {
            await browser.switchTab(requestedTabId);
            await browser.navigateTo(url, requestedTabId);
          } else if (body.session) {
            await browser.openTab({ url, session: body.session });
          } else {
            await this.ensureTab(url);
          }
          if (waitSelector) await browser.waitForSelector(waitSelector, requestedTabId, waitTimeout ?? 10_000);
          else if (waitTimeout && (body.waitForTimeout || body.wait_for_timeout)) {
            await new Promise((resolve) => setTimeout(resolve, waitTimeout));
          }
          const state = await browser.getNavigationState(requestedTabId);
          let observation: Record<string, unknown> = {};
          if (body.observe !== false) {
            try {
              const observed = await this.execute('glance', { tabId: browser.getActiveTabId(), compact: true });
              if (observed && 'ok' in observed && observed.ok && Array.isArray((observed.data as any)?.observed_elements)) {
                observation = { observed_elements: (observed.data as any).observed_elements };
              }
            } catch { /* observation is best-effort */ }
          }
          const result = success({ tabId: browser.getActiveTabId(), ...state, ...observation });
          this.recordSuccessfulAction(body, 'open');
          return result;
        }
        case 'page.tabs': {
          const tabs = browser.listTabs();
          return success({ tabs, activeTabId: browser.getActiveTabId(), count: tabs.length });
        }
        case 'page.switch': {
          const tabId = normalizeOptionalString(body.tabId ?? body.tab_id);
          if (!tabId) return validationError('缺少 tabId 参数');
          await browser.switchTab(tabId);
          return success({ activeTabId: tabId });
        }
        case 'page.close': {
          const tabId = normalizeOptionalString(body.tabId ?? body.tab_id);
          if (!tabId) return validationError('缺少 tabId 参数');
          await browser.closeTab(tabId);
          getSharedRefCache().clear(tabId);
          return success({ closed: tabId, activeTabId: browser.getActiveTabId() });
        }
        case 'page.state':
          await this.ensureTab();
          return success(await browser.getNavigationState(body.tabId, {
            includeHistory: body.includeHistory ?? body.include_history ?? false,
          }));
        case 'page.wait':
          await this.ensureTab();
          if (body.selector) {
            const result = success(await browser.waitForSelector(body.selector, body.tabId, body.timeout ?? 10_000));
            this.recordSuccessfulAction(body, 'wait');
            return result;
          }
          await new Promise((resolve) => setTimeout(resolve, body.timeout ?? 2_000));
          this.recordSuccessfulAction(body, 'wait');
          return success({ waited: true, ms: body.timeout ?? 2_000 });
        case 'page.nav': {
          const direction = body.direction;
          if (!['back', 'forward', 'reload', 'stop'].includes(direction)) {
            return validationError('direction 必须是 back/forward/reload/stop');
          }
          await this.ensureTab();
          if (direction === 'back') await browser.goBack(body.tabId);
          else if (direction === 'forward') await browser.goForward(body.tabId);
          else if (direction === 'reload') await browser.reload(body.tabId, body.ignoreCache ?? body.ignore_cache);
          else await browser.stop(body.tabId);
          const result = success({ direction, ...await browser.getNavigationState(body.tabId) });
          this.recordSuccessfulAction(body, 'nav');
          return result;
        }
        case 'page.console': {
          await this.ensureTab();
          const tabId = normalizeOptionalString(body.tabId ?? body.tab_id) ?? browser.getActiveTabId();
          if (!tabId) return validationError('无活跃 Tab');
          return success(browser.queryConsoleLog(tabId, {
            level: normalizeOptionalString(body.level),
            runId: normalizeOptionalString(body.runId ?? body.run_id),
          }));
        }
        case 'page.route': {
          const pattern = body.urlPattern ?? body.url_pattern;
          if (!pattern) return failure(400, 'VALIDATION_ERROR', '缺少 urlPattern 参数', {
            suggestions: ['示例: tabtin browser route --url-pattern "**/*.png" --status 403'],
          });
          await this.ensureTab();
          const page = browser.getPage(body.tabId ?? body.tab_id);
          await page.route(pattern, async (route: any) => {
            if (body.status || body.body || body.headers) {
              await route.fulfill({ status: body.status ?? 200, body: body.body ?? '', headers: body.headers ?? {} });
            } else {
              await route.abort();
            }
          });
          return success({ intercepted: pattern });
        }
        case 'page.unroute': {
          const pattern = body.urlPattern ?? body.url_pattern ?? body.ruleId ?? body.rule_id;
          if (!pattern) return failure(400, 'VALIDATION_ERROR', '缺少 urlPattern 或 ruleId 参数', {
            suggestions: ['Daemon 用注册时的 url-pattern 取消: tabtin browser unroute --url-pattern "**/*.png"'],
          });
          await this.ensureTab();
          await browser.getPage(body.tabId ?? body.tab_id).unroute(pattern);
          return success({ unrouted: pattern });
        }
        case 'page.route-list':
          return failure(501, 'NOT_IMPLEMENTED', 'Daemon 模式不维护可查询的拦截规则列表（page.route 为 per-page、不跨导航持久）。route / unroute 仍可用。', {
            suggestions: [
              '设置拦截: tabtin browser route --url-pattern "**/*.png" --status 403',
              '取消拦截: tabtin browser unroute --url-pattern "**/*.png"',
              '需要可查询的规则列表请使用 Electron 运行时',
            ],
          });
        case 'collect.table':
          return failure(501, 'NOT_IMPLEMENTED', 'Daemon 模式当前不支持 Browser-to-Table 直接创建 TabData 表；请在 Electron 端执行，或使用 --input fixture 验证 browser-core 采集逻辑。', {
            suggestions: [
              '在 TabTin 桌面端采集：tabtin browser open 打开页面 → tabtin browser network 取接口数据 → 写入 TabData 表',
              '复用已打开页面：tabtin browser tab list 找 tabId 后用 tabtin browser network 取接口数据',
              '需要离线分析时先导出 network JSON，再在 Electron 端导入 TabData',
            ],
          });
        case 'page.random-user-agent': {
          const platform = body.platform || 'desktop';
          const userAgents: Record<string, string[]> = {
            desktop: [
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            ],
            mobile: [
              'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
              'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
            ],
            tablet: [
              'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
            ],
          };
          const pool = userAgents[platform] ?? userAgents.desktop;
          return success({ userAgent: pool[Math.floor(Math.random() * pool.length)], platform });
        }
        default:
          return failure(404, 'NOT_FOUND', `未知 page action: ${actionId}`);
      }
    } catch (error: any) {
      return toApplicationFailure(error, '浏览器页面操作失败');
    }
  }

  async executePrintCommand(body: any): Promise<BrowserActionResult> {
    const format = body.as ?? 'markdown';
    if (format !== 'pdf' && !isPrintTextFormat(format)) {
      return failure(400, 'VALIDATION_ERROR', `不支持的产物形态: ${format}`, {
        suggestions: ['--as 取值: text / markdown / html / json / pdf'],
      });
    }
    const savePath = body.save ?? body.savePath ?? body.save_path;
    if (!savePath || typeof savePath !== 'string') {
      return failure(400, 'VALIDATION_ERROR', '缺少 --save 参数（print 始终落盘）', {
        suggestions: ['示例: tabtin browser print --save /tmp/page.md'],
      });
    }
    try {
      const browser = this.requireBrowser();
      validateSavePath(savePath, browser.getWorkspaceRoot());
      if (format === 'pdf') {
        if (body.url) {
          return failure(400, 'VALIDATION_ERROR', '--as pdf 仅支持当前 tab（先 open 再 print）', {
            suggestions: ['tabtin browser open --url <url>', '然后 tabtin browser print --as pdf --save <path>'],
          });
        }
        await this.ensureTab();
        return success({ ...await browser.generatePdf(body.tabId, {
          landscape: body.landscape ?? false,
          printBackground: body.printBackground ?? true,
          pageSize: body.pageSize || 'A4',
          savePath,
        }), format: 'pdf' });
      }

      let page;
      if (!body.url) {
        await this.ensureTab();
        page = await browser.getPageContent(body.tabId || body.tab_id);
      } else {
        try { validateUrl(body.url); }
        catch (error: any) {
          return failure(400, 'VALIDATION_ERROR', error?.message || '无效的 URL', {
            suggestions: ['仅允许 http:// 和 https:// 协议，且禁止访问内网地址'],
          });
        }
        const previous = browser.getActiveTabId();
        const temporary = await browser.openTab({ url: body.url });
        try {
          page = await browser.getPageContent(temporary);
        } finally {
          await browser.closeTab(temporary).catch(() => {});
          if (previous && browser.getActiveTabId() !== previous) await browser.switchTab(previous).catch(() => {});
        }
      }
      const rendered = await renderPrintContent(format, {
        html: page.html ?? '',
        title: page.title,
        url: page.url,
        include: body.include,
        schema: body.schema,
      });
      const { writeFile, mkdir } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await mkdir(dirname(savePath), { recursive: true });
      await writeFile(savePath, rendered.content, 'utf-8');
      const wordCount = format === 'markdown' || format === 'text'
        ? rendered.content.split(/\s+/).filter(Boolean).length
        : undefined;
      return success({
        path: savePath,
        format,
        title: page.title,
        url: page.url,
        bytes: Buffer.byteLength(rendered.content, 'utf-8'),
        ...(wordCount !== undefined ? { word_count: wordCount } : {}),
        ...(rendered.warnings?.length ? { schema_warnings: rendered.warnings } : {}),
      });
    } catch (error: any) {
      if (error instanceof BrowserActionError) return error.toResult();
      const validation = /--as json|JSON Schema|保存路径/.test(error?.message ?? '');
      return failure(
        validation ? 400 : 500,
        validation ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR',
        error?.message || '内容导出失败',
        validation ? {} : { retryable: true },
      );
    }
  }

  async executeBatchCommand(body: any): Promise<BrowserActionResult> {
    try {
      this.requireBrowser();
    } catch (error) {
      return toApplicationFailure(error, '浏览器尚未初始化');
    }
    if (!Array.isArray(body.actions) || body.actions.length === 0) {
      return failure(400, 'VALIDATION_ERROR', '缺少 actions 数组参数', {
        suggestions: ['每项须含 type（子路径名）和相应参数'],
      });
    }
    const results: Array<{ type: string; status: number; data: unknown }> = [];
    for (const action of body.actions) {
      const type = normalizeOptionalString(action?.type);
      if (!type) {
        results.push({ type: 'unknown', status: 400, data: { success: false, error: '缺少 type 字段' } });
        if (body.stopOnError !== false) break;
        continue;
      }
      const actionBody = { ...action, tabId: action.tabId || body.tabId, runId: action.runId || body.runId };
      delete actionBody.type;
      try {
        const result = await this.dispatchBatchAction(type, actionBody);
        if (!result || 'kind' in result) {
          results.push({ type, status: 404, data: { success: false, error: { code: 'NOT_FOUND', message: `不支持的 batch action: ${type}` } } });
        } else if (result.ok) {
          results.push({ type, status: result.status, data: { success: true, data: result.data } });
        } else {
          results.push({ type, status: result.status, data: { success: false, error: result.error } });
        }
      } catch (error: any) {
        results.push({ type, status: 500, data: { success: false, error: error?.message || '未知错误' } });
      }
      if (body.stopOnError !== false && results.at(-1)!.status >= 400) break;
    }
    return success({ results, total: results.length });
  }

  private dispatchBatchAction(type: string, body: any): Promise<BrowserActionResult | null> {
    const pageActions: Record<string, string> = {
      open: 'page.open', navigate: 'page.open', tabs: 'page.tabs',
      'tab-switch': 'page.switch', 'tab-close': 'page.close', 'tab-state': 'page.state',
      wait: 'page.wait', nav: 'page.nav', console: 'page.console',
      route: 'page.route', unroute: 'page.unroute',
      'random-ua': 'page.random-user-agent', 'route-list': 'page.route-list',
      'collect/table': 'collect.table',
    };
    const sessionActions: Record<string, string> = {
      'session/create': 'session.create', 'session/list': 'session.list',
      'session/switch': 'session.switch', 'session/close': 'session.close',
      'session/close-all': 'session.close-all', 'session/save': 'session.save',
      'session/load': 'session.load', session: 'session.info', cookies: 'session.cookies',
      'clear-session': 'session.clear',
    };
    if (pageActions[type]) return this.executePageCommand(pageActions[type], body);
    if (sessionActions[type]) return this.executeSessionCommand(sessionActions[type], body);
    if (type === 'network') return this.executeNetworkCommand('network.list', body);
    if (type === 'network/to-api') return this.executeNetworkCommand('network.to-api', body);
    if (type === 'download') return this.executeDownloadCommand('download.single', body);
    if (type === 'download-batch') return this.executeDownloadCommand('download.batch', body);
    if (type === 'print') return this.executePrintCommand(body);
    if (type === 'job/status') return this.execute('job.status', body);
    if (type === 'job/cancel') return this.execute('job.cancel', body);
    const resourceActions: Record<string, string> = {
      'resource/list': 'resource.list', 'resource/probe': 'resource.probe',
      'resource/inspect': 'resource.inspect', 'resource/capture': 'resource.capture',
      'resource/download': 'resource.download', 'resource/smart-download': 'resource.smart-download',
      'stream/parse': 'stream.parse', 'stream/info': 'stream.info', 'stream/download': 'stream.download',
      'record/start': 'record.start', 'record/stop': 'record.stop',
      'record/status': 'record.status', 'replay/run': 'replay.run', 'replay/list': 'replay.list',
    };
    return this.execute(resourceActions[type] ?? type, body);
  }

  private requireBrowser(): DaemonBrowserService {
    const browser = this.dependencies.resolveBrowser();
    if (!browser) throw new BrowserActionError(503, {
      code: 'INTERNAL_ERROR',
      message: 'DaemonBrowserService 尚未初始化',
      retryable: true,
    });
    return browser;
  }

  private recordSuccessfulAction(body: any, type: string): void {
    const runId = normalizeOptionalString(body?.runId ?? body?.run_id);
    if (!runId || type.startsWith('record.') || type.startsWith('replay.') || type.startsWith('job.')) return;
    this.dependencies.recordAction(runId, {
      type,
      timestamp: Date.now(),
      ...(normalizeOptionalString(body?.url) ? { url: normalizeOptionalString(body.url) } : {}),
      ...(normalizeOptionalString(body?.selector) ? { selector: normalizeOptionalString(body.selector) } : {}),
      ...(normalizeOptionalString(body?.value) ? { value: normalizeOptionalString(body.value) } : {}),
      ...(normalizeOptionalString(body?.direction) ? { direction: normalizeOptionalString(body.direction) } : {}),
      args: { ...body },
    });
  }

  private async executeReplayAction(actionType: string, body: Record<string, any>): Promise<void> {
    const result = await this.dispatchBatchAction(actionType, body);
    if (!result || 'kind' in result) {
      throw new BrowserActionError(400, {
        code: 'VALIDATION_ERROR',
        message: '录制中包含不支持的动作: ' + actionType,
      });
    }
    if (!result.ok) throw new BrowserActionError(result.status, result.error);
  }

  getActiveJobCount(): number {
    return getSharedBrowserJobManager().list().filter((job) => job.status === 'running' || job.status === 'pending').length;
  }

  shutdownJobs(): void {
    shutdownSharedBrowserJobManager();
  }
}

function success(data: unknown): BrowserActionResult {
  return { ok: true, status: 200, data: data as Record<string, unknown> };
}

function validationError(message: string): BrowserActionResult {
  return failure(400, 'VALIDATION_ERROR', message);
}

function failure(
  status: number,
  code: string,
  message: string,
  options: { retryable?: boolean; suggestions?: string[] } = {},
): BrowserActionResult {
  return { ok: false, status, error: { code, message, ...options } };
}

function toApplicationFailure(error: unknown, fallback: string): BrowserActionResult {
  if (error instanceof BrowserActionError) return error.toResult();
  return failure(500, 'INTERNAL_ERROR', error instanceof Error ? error.message : fallback, { retryable: true });
}

function validateRegexFilter(filter?: string): BrowserActionResult | null {
  if (!filter) return null;
  try {
    new RegExp(filter, 'i');
    return null;
  } catch {
    return failure(400, 'VALIDATION_ERROR', `无效的 filter 正则: ${filter}`, {
      suggestions: ['filter 是大小写不敏感正则，匹配 url/method/type/mime/status'],
    });
  }
}

function mapStorageStateError(error: any): {
  status: number;
  code: string;
  message: string;
  retryable?: boolean;
} {
  const message = error?.message || String(error) || 'session storageState 操作失败';
  if (/^Session ".+" not found/.test(message) || /^Tab .+ not found/.test(message)) {
    return { status: 404, code: 'NOT_FOUND', message };
  }
  if (
    /does not belong to session/.test(message)
    || /state 必须|legacy state 缺少|Invalid URL|无效|mode 必须|Only HTTP/.test(message)
    || /Protocol ".+" not supported/.test(message)
    || /not allowed|not permitted|blocked|private|localhost|credentials|username|password/i.test(message)
    || /协议|内网|用户信息|凭据|不允许|禁止|阻止/.test(message)
  ) {
    return { status: 400, code: 'VALIDATION_ERROR', message };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message, retryable: true };
}
