/**
 * binary-dedup-state — image / localDoc 反复 read dedup 状态
 *
 * **Wave 2 北极星之一**：AI 在长会话里反复看同一份图 / PDF，messages history
 * 不再重复堆 base64 / 全文。
 *
 * **跨 Wave 不变量 #6**（参见总控 §九）：
 *   - **绝不**扩 `ReadFileStateEntry` 接口 —— 那是文本 read-before-edit 用的
 *     5 字段 schema（content/timestamp/readAt/offset/limit），25MB byte budget
 *     文本独占。本模块为 image / localDoc 各自维护一份独立 Map + 独立 byte
 *     budget，与文本 LRU 物理隔离。
 *   - **不与文本共享 25MB 文本 budget**：典型 image base64 1-4MB，10 张就到 25MB
 *     满；典型 PDF 解析全文也 1-5MB；这两路独占 25MB 文本 budget 会让"反复读
 *     同图"撑爆文本 LRU，反过来"读完代码后想 edit"被 stale-read 误拒。
 *
 * **判等元组**（设计取舍）：
 *   - 快路径：mtime + sizeBytes 一致 → 直接命中，不再触摸文件 I/O
 *   - 慢路径兜底：mtime 漂移但 sizeBytes 一致 → 算当前文件 sha256 跟 entry 比对
 *     （覆盖 macOS iCloud / Windows AV 改 mtime 但内容相同；git checkout 写入
 *     新 mtime 但内容不变 等场景）
 *   - sizeBytes 不一致 → 立即 bail（不算 sha256 浪费 I/O）
 *
 * **stub 设计**（参见总控 §四 T2）：
 *   - 让 LLM 知道"读过了在 history 哪里"——文案明示 "earlier tool_result"
 *     + path + 判等签名（mtime+size），帮 LLM 主动引用而不是再 read
 *   - 同款 system-reminder 包装，与 W2 文本 dedup 的 `FILE_UNCHANGED_STUB`
 *     视觉对齐
 */

import { promises as fsPromises, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import type {
  ToolContext,
  ImageDedupEntry,
  LocalDocDedupEntry,
  ImageReadFileState,
  LocalDocReadFileState,
} from '@tabtin/agent-runtime';
import { canonicalizePath } from './read-file-state.js';

// ─── 独立 byte budget（与 25MB 文本 budget 物理隔离） ─────────────────

/**
 * image / localDoc 各自独立的 entry 数量 + 字节体积上限。
 *
 * **数值依据**：
 *   - image 50MB：典型 base64 1-4MB（缩放后 < 5MB），10 张 ≈ 25MB 满；50MB
 *     给"看 10-15 张设计图"留 headroom。
 *   - localDoc 50MB：PDF 全文通常更小（数百 KB），但 PDF 文件本身可能 30-50MB；
 *     entry 存的是解析后的文本（小），50MB 足以撑长会话反复"翻阅"几十份文档。
 *   - 不复用 25MB 文本 budget：避免"反复读同图"撑爆文本 LRU 让 stale-read
 *     校验失效（dedup 状态被驱逐 → 下一次 edit 走"无快照放行"分支 → 真 stale
 *     时不会被 7 拦截）。
 */
const IMAGE_DEDUP_MAX_BYTES = 50 * 1024 * 1024;
const LOCAL_DOC_DEDUP_MAX_BYTES = 50 * 1024 * 1024;

/** 单条 entry 固定 overhead 估算（与 read-file-state.ts 同款 256B 上界）。 */
const DEDUP_ENTRY_OVERHEAD_BYTES = 256;

/**
 * 数量层兜底（防止"成千上万张 1KB 缩略图"在字节层未触发但数量爆 Map）。
 * image 200 / localDoc 200 双侧足够长会话。
 */
const IMAGE_DEDUP_MAX_ENTRIES = 200;
const LOCAL_DOC_DEDUP_MAX_ENTRIES = 200;

// ─── Entry / Map 类型（契约在 @tabtin/agent-runtime，此处 re-export） ──

export type {
  ImageDedupEntry,
  LocalDocDedupEntry,
  ImageReadFileState,
  LocalDocReadFileState,
} from '@tabtin/agent-runtime';


// ─── Sidecar 字节统计（与 read-file-state.ts 同款 WeakMap 模式） ──────

interface SizeStats {
  totalBytes: number;
  bytesByKey: Map<string, number>;
}

const imageStatsByState = new WeakMap<ImageReadFileState, SizeStats>();
const localDocStatsByState = new WeakMap<LocalDocReadFileState, SizeStats>();

function getOrInitImageStats(state: ImageReadFileState): SizeStats {
  let stats = imageStatsByState.get(state);
  if (!stats) {
    stats = { totalBytes: 0, bytesByKey: new Map() };
    imageStatsByState.set(state, stats);
  }
  return stats;
}

function getOrInitLocalDocStats(state: LocalDocReadFileState): SizeStats {
  let stats = localDocStatsByState.get(state);
  if (!stats) {
    stats = { totalBytes: 0, bytesByKey: new Map() };
    localDocStatsByState.set(state, stats);
  }
  return stats;
}

function estimateImageEntryBytes(entry: ImageDedupEntry): number {
  // 不算 base64 全文（不存 entry 里）；仅算判等元组 + 元信息字节估算
  return DEDUP_ENTRY_OVERHEAD_BYTES + entry.sha256.length + entry.mediaType.length;
}

function estimateLocalDocEntryBytes(entry: LocalDocDedupEntry): number {
  return DEDUP_ENTRY_OVERHEAD_BYTES + entry.sha256.length + entry.mimeType.length;
}

// ─── helpers ──────────────────────────────────────────────────────────

async function safeStat(absPath: string): Promise<{ mtimeMs: number; sizeBytes: number } | undefined> {
  try {
    const st = await fsPromises.stat(absPath);
    return { mtimeMs: Math.floor(st.mtimeMs), sizeBytes: st.size };
  } catch {
    return undefined;
  }
}

/** 流式 sha256，避免 30MB 文件全读到内存只为 hash。 */
async function fileSha256(absPath: string): Promise<string | undefined> {
  try {
    const hash = createHash('sha256');
    const stream = createReadStream(absPath);
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest('hex');
  } catch {
    return undefined;
  }
}

/** 缓冲区直接 sha256（base64 / 文本已在内存时复用）。 */
export function bufferSha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

// ─── image dedup API ──────────────────────────────────────────────────

/**
 * 在 image 分支正式 read 之前调用。命中返 stub（含 system-reminder 引导 LLM
 * 引用 history 已塞的 ImageBlock）；不命中返 null（继续正常 read）。
 *
 * **不更新 readAt**：dedup 命中算"再次访问"但语义上 LLM 看不到新图，给 readAt
 * 续命会让"真没在用"的图被无限保活。保留原 readAt 让 LRU 自然驱逐。
 *
 * @param state - host 注入的 imageReadFileState；undefined 时不启用 dedup
 * @param resolvedPath - canonical 绝对路径（caller 已 canonicalizePath 过）
 */
export async function maybeReturnUnchangedImageReadStub(
  state: ImageReadFileState | undefined,
  resolvedPath: string,
): Promise<{ content: string } | null> {
  if (!state) return null;
  const entry = state.get(resolvedPath);
  if (!entry) return null;

  const stat = await safeStat(resolvedPath);
  if (!stat) return null; // 文件刚被删 → 让真 read 走 file_not_found 错误链路

  // 快路径：mtime + size 都一致 → 命中
  if (stat.mtimeMs === entry.mtimeMs && stat.sizeBytes === entry.sizeBytes) {
    return { content: buildImageDedupStub(resolvedPath, entry, 'mtime+size match') };
  }

  // size 不一致 → 内容必然不同，bail
  if (stat.sizeBytes !== entry.sizeBytes) return null;

  // mtime 漂移 + size 一致 → 慢路径 sha256 兜底
  const currentSha = await fileSha256(resolvedPath);
  if (currentSha && currentSha === entry.sha256) {
    return { content: buildImageDedupStub(resolvedPath, entry, 'sha256 match') };
  }
  return null;
}

/**
 * image 分支 read 成功（包括缩放成功）后写 dedup snapshot。
 *
 * **sha256 一致性约束**：record 与 maybeReturnUnchangedImageReadStub 必须算
 * **同一份字节流**的 sha256，否则慢路径永远不命中（mtime 漂移场景退化为
 * "无 dedup"）。
 *
 * 设计：record **必须流式 sha256 原文件**（不是 base64 / 缩放后 buffer）——
 * 文件层判等才能跨"是否被缩放"统一。慢路径 fileSha256(path) 算同款文件
 * sha256，两者 source 一致。
 *
 * 异步成本：read 后 record 时多一次流式 sha（30MB 文件 < 100ms）；dedup
 * hit 路径只算 stat + sha 一次（文件 mtime 漂移才走慢路径）。
 *
 * @param base64 - 仅用于 stub 文案的 base64Bytes 字段（不参与判等）。
 */
export async function recordImageReadSnapshot(
  state: ImageReadFileState | undefined,
  resolvedPath: string,
  meta: {
    mtimeMs: number;
    sizeBytes: number;
    base64: string;
    mediaType: string;
    wasResized: boolean;
  },
): Promise<void> {
  if (!state) return;
  // 流式算原文件 sha256（与 dedup 慢路径 fileSha256 同 source 同算法）
  const sha256 = (await fileSha256(resolvedPath)) ?? '';
  const entry: ImageDedupEntry = {
    mtimeMs: meta.mtimeMs,
    sizeBytes: meta.sizeBytes,
    sha256,
    readAt: Date.now(),
    mediaType: meta.mediaType,
    base64Bytes: meta.base64.length,
    wasResized: meta.wasResized,
  };

  const stats = getOrInitImageStats(state);
  const oldBytes = stats.bytesByKey.get(resolvedPath);
  if (oldBytes !== undefined) stats.totalBytes -= oldBytes;
  const newBytes = estimateImageEntryBytes(entry);
  stats.bytesByKey.set(resolvedPath, newBytes);
  stats.totalBytes += newBytes;
  state.set(resolvedPath, entry);

  evictImageLRU(state);
}

function buildImageDedupStub(
  resolvedPath: string,
  entry: ImageDedupEntry,
  reason: 'mtime+size match' | 'sha256 match',
): string {
  const filename = path.basename(resolvedPath);
  const sizeKb = (entry.base64Bytes / 1024).toFixed(0);
  // 文案目标（参见任务 §四 T2）：
  //   - 让 LLM 知道"已读过这张图"
  //   - 让 LLM 知道"图还在 earlier message 里" → 引导引用而不是再 read
  //   - 让 LLM 知道"判等签名是什么" → 在用户疑问"为什么没看新图"时能解释
  const resizedNote = entry.wasResized
    ? ' (note: that image was resized to fit local read constraints; the original is unchanged on disk)'
    : '';
  return (
    `<system-reminder>` +
    `Image unchanged since last read: ${filename}. ` +
    `The image data from the earlier Read tool_result is still attached to your context — ` +
    `refer to that image instead of re-reading. ` +
    `(path=${resolvedPath}, mediaType=${entry.mediaType}, base64=${sizeKb}KB, dedup=${reason})${resizedNote}` +
    `</system-reminder>`
  );
}

function evictImageLRU(state: ImageReadFileState): void {
  const stats = getOrInitImageStats(state);
  if (
    state.size <= IMAGE_DEDUP_MAX_ENTRIES &&
    stats.totalBytes <= IMAGE_DEDUP_MAX_BYTES
  ) {
    return;
  }
  const entries = [...state.entries()].sort((a, b) => a[1].readAt - b[1].readAt);
  let i = 0;
  while (
    i < entries.length &&
    (state.size > IMAGE_DEDUP_MAX_ENTRIES || stats.totalBytes > IMAGE_DEDUP_MAX_BYTES)
  ) {
    const [key] = entries[i]!;
    const removed = stats.bytesByKey.get(key);
    if (removed !== undefined) {
      stats.totalBytes -= removed;
      stats.bytesByKey.delete(key);
    }
    state.delete(key);
    i++;
  }
}

// ─── localDoc dedup API ───────────────────────────────────────────────

export async function maybeReturnUnchangedLocalDocReadStub(
  state: LocalDocReadFileState | undefined,
  resolvedPath: string,
): Promise<{ content: string } | null> {
  if (!state) return null;
  const entry = state.get(resolvedPath);
  if (!entry) return null;

  const stat = await safeStat(resolvedPath);
  if (!stat) return null;

  if (stat.mtimeMs === entry.mtimeMs && stat.sizeBytes === entry.sizeBytes) {
    return { content: buildLocalDocDedupStub(resolvedPath, entry, 'mtime+size match') };
  }
  if (stat.sizeBytes !== entry.sizeBytes) return null;

  const currentSha = await fileSha256(resolvedPath);
  if (currentSha && currentSha === entry.sha256) {
    return { content: buildLocalDocDedupStub(resolvedPath, entry, 'sha256 match') };
  }
  return null;
}

export async function recordLocalDocReadSnapshot(
  state: LocalDocReadFileState | undefined,
  resolvedPath: string,
  meta: {
    mtimeMs: number;
    sizeBytes: number;
    text: string;
    mimeType: string;
    pages?: number;
  },
): Promise<void> {
  if (!state) return;
  // **sha256 一致性约束**：与 maybeReturnUnchangedLocalDocReadStub 同源 ——
  // 算原 PDF / DOCX / XLSX 文件字节的 sha256（不是解析后 text 的 sha）。
  // 这样：
  //   - 文件未变（同 mtime+size+sha256）→ 命中 stub，LLM 引用 history 解析全文
  //   - 文件 mtime 漂移但内容相同 → sha256 仍命中
  //   - 文件被改 → sha256 不同 → 不命中，重新解析
  const sha256 = (await fileSha256(resolvedPath)) ?? '';
  const entry: LocalDocDedupEntry = {
    mtimeMs: meta.mtimeMs,
    sizeBytes: meta.sizeBytes,
    sha256,
    readAt: Date.now(),
    mimeType: meta.mimeType,
    textBytes: meta.text.length,
    pages: meta.pages,
  };

  const stats = getOrInitLocalDocStats(state);
  const oldBytes = stats.bytesByKey.get(resolvedPath);
  if (oldBytes !== undefined) stats.totalBytes -= oldBytes;
  const newBytes = estimateLocalDocEntryBytes(entry);
  stats.bytesByKey.set(resolvedPath, newBytes);
  stats.totalBytes += newBytes;
  state.set(resolvedPath, entry);

  evictLocalDocLRU(state);
}

function buildLocalDocDedupStub(
  resolvedPath: string,
  entry: LocalDocDedupEntry,
  reason: 'mtime+size match' | 'sha256 match',
): string {
  const filename = path.basename(resolvedPath);
  const textKb = (entry.textBytes / 1024).toFixed(0);
  const pageInfo = entry.pages != null ? ` ${entry.pages} pages,` : '';
  return (
    `<system-reminder>` +
    `Document unchanged since last read: ${filename}.${pageInfo} ` +
    `The full text from the earlier Read tool_result in this conversation is still current — ` +
    `refer to that text instead of re-reading. ` +
    `(path=${resolvedPath}, mime=${entry.mimeType}, text=${textKb}KB, dedup=${reason})` +
    `</system-reminder>`
  );
}

function evictLocalDocLRU(state: LocalDocReadFileState): void {
  const stats = getOrInitLocalDocStats(state);
  if (
    state.size <= LOCAL_DOC_DEDUP_MAX_ENTRIES &&
    stats.totalBytes <= LOCAL_DOC_DEDUP_MAX_BYTES
  ) {
    return;
  }
  const entries = [...state.entries()].sort((a, b) => a[1].readAt - b[1].readAt);
  let i = 0;
  while (
    i < entries.length &&
    (state.size > LOCAL_DOC_DEDUP_MAX_ENTRIES || stats.totalBytes > LOCAL_DOC_DEDUP_MAX_BYTES)
  ) {
    const [key] = entries[i]!;
    const removed = stats.bytesByKey.get(key);
    if (removed !== undefined) {
      stats.totalBytes -= removed;
      stats.bytesByKey.delete(key);
    }
    state.delete(key);
    i++;
  }
}

// ─── 测试与诊断用 stats 暴露 ──────────────────────────────────────────

export function _internalGetImageDedupStats(
  state: ImageReadFileState,
): { totalBytes: number; entryCount: number } {
  const stats = imageStatsByState.get(state);
  return { totalBytes: stats?.totalBytes ?? 0, entryCount: state.size };
}

export function _internalGetLocalDocDedupStats(
  state: LocalDocReadFileState,
): { totalBytes: number; entryCount: number } {
  const stats = localDocStatsByState.get(state);
  return { totalBytes: stats?.totalBytes ?? 0, entryCount: state.size };
}

/** 测试钩子：从 ToolContext 取出 image / localDoc state（adapter 内部用）。 */
export function getImageReadFileState(ctx: ToolContext): ImageReadFileState | undefined {
  return (ctx as { imageReadFileState?: ImageReadFileState }).imageReadFileState;
}

export function getLocalDocReadFileState(ctx: ToolContext): LocalDocReadFileState | undefined {
  return (ctx as { localDocReadFileState?: LocalDocReadFileState }).localDocReadFileState;
}

/** 暴露常量给测试 / 诊断（非生产代码请勿依赖）。 */
export const _internalConstants = {
  IMAGE_DEDUP_MAX_BYTES,
  IMAGE_DEDUP_MAX_ENTRIES,
  LOCAL_DOC_DEDUP_MAX_BYTES,
  LOCAL_DOC_DEDUP_MAX_ENTRIES,
} as const;

/**
 * 把 canonical 路径解析委托给 read-file-state 的同款实现，避免双源。
 * adapter 内部已 canonicalize 一次（resolvedForOSError），多数调用方传 canonical
 * 进来；保留这层封装是为了让 `localDoc` 解析路径（runLocalDocParse）也能简洁
 * 地走"任意路径 → canonical key"。
 */
export function canonicalKeyForBinaryDedup(filePath: string, baseDir?: string): string {
  return canonicalizePath(filePath, baseDir);
}
