/**
 * Daemon storage application module.
 *
 * 执行 RFC §四 4.4 / §五 W2.3 定义的 storage 用例。Transport 只负责把
 * HTTP-over-socket 请求解析为 command/input，再映射本模块的 outcome。
 *
 *   POST /storage/list                 → 列出所有 daemon bucket descriptor
 *   POST /storage/size                 → 单个或全部 bucket 容量度量
 *   POST /storage/list-items           → 列出某 bucket 子项
 *   POST /storage/clear                → 清单个 bucket / 清整类（admin 路径）
 *   POST /storage/export               → 导出 bucket 为 JSON / Blob
 *   POST /storage/vacuum               → agent-sync archive 老化清理
 *   POST /storage/drain                → 等 outbox / agent-sync / table-kernel-db flush
 *   POST /storage/purge                → 物理删 ~/.tabtin-daemon + ~/.tabtin（uninstall 后）
 *
 * 设计要点：
 *   - 严格按 RFC 命令名，不自创
 *   - bucket descriptor / size / clear 报告全部走 `@tabtin/storage-manager`
 *     的 ui-protocol DTO，与主进程 daemon-bridge 共享类型，避免漂移（R4 风险）
 *   - admin 类操作（clear --category / vacuum / drain / purge）独立路径，
 *     不走 storage-manager bridge——bridge 仅覆盖单 bucket 主线（W2.1 F-6 边界声明）
 *   - 不依赖 HTTP request/response，也不生成 CLI response envelope
 */

import path from 'node:path';
import {
  bucketToDescriptor,
  clearBucket,
  exportBucket,
  getBucket,
  getBucketSize,
  listBucketItems,
  listBuckets,
  type BucketCategory,
  type BucketGroup,
  type BucketSource,
  type ClearOptions,
} from '@tabtin/storage-manager';
import { getDaemonHomePath, getHomeTabtinPath } from '@tabtin/shared/storage-paths';
import type { StorageFileSystemPort } from '../../base/storage/storage-file-system.js'


export type StorageApplicationPayload =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } }

export interface StorageApplicationOutcome {
  status: number
  payload: StorageApplicationPayload
}

function ok(data: unknown): StorageApplicationOutcome {
  return { status: 200, payload: { ok: true, data } }
}

function failure(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): StorageApplicationOutcome {
  return { status, payload: { ok: false, error: { code, message, ...(details ? { details } : {}) } } }
}


/**
 * 获取调用方传入的 daemon home 目录——优先 body.daemon_home，
 * 否则用 SSoT 默认值。这让支持 `--config-dir` 覆盖的调用方
 * （主进程 DaemonStorageBridgeService）能跟 daemon 自己看到的路径对齐。
 *
 * **R3 P0 修复（安全）**：daemon_home 必须通过白名单校验——
 * 仅允许：(a) SSoT 默认 daemon home，或 (b) 必须落在 `os.homedir()` 子树下、
 * 且最末段是合理的 daemon-home 命名（包含 `tabtin` 字样）。
 *
 * 旧版本接受任意 path.resolve 后的路径 → token 鉴权后调用方传
 * `{ daemon_home: '/Users/me/Documents' }` + `confirm: 'yes-i-am-sure'` →
 * **远程可触发 rm -rf 任意同用户目录**（R3 Finding #2）。
 *
 * 注意：当本路由跑在 daemon 进程内时（HTTP-over-socket 接进），
 * 调用方通常是 Electron 主进程 — Electron 不知道 daemon 用了什么 --config-dir，
 * 所以默认会读 SSoT。如果需要 cross-check，调用方可以先 GET /health 拿
 * daemon 的 spaceId/version，再附加 daemon_home 参数。
 */
function resolveDaemonHome(fileSystem: StorageFileSystemPort, body?: any): string {
  const defaultHome = getDaemonHomePath();
  if (!body || typeof body.daemon_home !== 'string' || !body.daemon_home.trim()) {
    return defaultHome;
  }
  const requested = path.resolve(body.daemon_home);
  // 允许情形 1：与 SSoT 默认值完全一致
  if (requested === defaultHome) return requested;
  // **R3 Round 2 P1 修复**：白名单 regex 收紧——
  //   - 必须在用户 home 子树下
  //   - 必须严格匹配 `.tabtin-daemon` 或 `.tabtin-daemon-<test-suffix>`
  //   - **显式拒绝** `~/.tabtin`（共享根，purge 时 `deleteHomeDir=true`
  //     会绕过 `deleteSharedRoot=false` 把 Electron 数据 / mcp-server.json
  //     / checkpoints 全清）
  const userHome = fileSystem.homeDirectory();
  const inUserHome = requested === userHome
    ? false
    : requested.startsWith(userHome + path.sep);
  if (!inUserHome) {
    throw new Error(
      `[storage] 拒绝可疑 daemon_home 路径 ${requested}: 必须位于用户 home 子树下`,
    );
  }
  // 显式拒绝共享根 ~/.tabtin
  if (requested === path.join(userHome, '.tabtin')) {
    throw new Error(
      `[storage] 拒绝 daemon_home 指向共享根 ~/.tabtin：该目录是 Daemon + Electron 共享，不允许通过 daemon_home 参数清理（避免误删 Electron 数据）`,
    );
  }
  // 严格匹配 .tabtin-daemon 或 .tabtin-daemon-<suffix>（最末段）
  const lastSegment = path.basename(requested);
  const looksLikeDaemonHome =
    /^\.tabtin-daemon(-[\w.-]+)?$/.test(lastSegment);
  if (!looksLikeDaemonHome) {
    throw new Error(
      `[storage] 拒绝可疑 daemon_home 路径 ${requested}: 路径最末段必须严格匹配 ".tabtin-daemon" 或 ".tabtin-daemon-<suffix>"`,
    );
  }
  return requested;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

function parseFilter(body: any): {
  group?: BucketGroup;
  category?: BucketCategory;
  includeHidden?: boolean;
} | undefined {
  if (!isObject(body?.filter)) return undefined;
  const f = body.filter;
  const out: { group?: BucketGroup; category?: BucketCategory; includeHidden?: boolean } = {};
  if (typeof f.group === 'string') out.group = f.group as BucketGroup;
  if (typeof f.category === 'string') out.category = f.category as BucketCategory;
  if (typeof f.includeHidden === 'boolean') out.includeHidden = f.includeHidden;
  return out;
}

function parseClearOptions(body: any): ClearOptions | undefined {
  if (!isObject(body?.options)) return undefined;
  const o = body.options;
  const out: ClearOptions = {};
  if (Array.isArray(o.itemIds)) {
    out.itemIds = o.itemIds.filter((x: unknown) => typeof x === 'string');
  }
  if (typeof o.dryRun === 'boolean') out.dryRun = o.dryRun;
  return out;
}

// ── 9 个子命令的具体处理 ────────────────────────────────────────

/**
 * POST /storage/list
 * Body: { filter?: { group?, category?, includeHidden? } }
 * 返回：BucketDescriptor[]，source 一律打成 'daemon'。
 */
async function handleList(
  body: any,
): Promise<StorageApplicationOutcome> {
  const filter = parseFilter(body);
  const buckets = listBuckets(filter);
  const source: BucketSource = 'daemon';
  const descriptors = buckets.map((b) => bucketToDescriptor(b, source));
  return ok({ buckets: descriptors, count: descriptors.length });
}

/**
 * POST /storage/size
 * Body: { bucket?: string }
 *   - 传 bucket id：单个度量
 *   - 不传：全部 bucket（顺序探测，单个失败不影响其他）
 */
async function handleSize(
  body: any,
): Promise<StorageApplicationOutcome> {
  const bucketId = typeof body?.bucket === 'string' ? body.bucket : null;
  if (bucketId) {
    const bucket = getBucket(bucketId);
    if (!bucket) {
      return failure(404, 'NOT_FOUND', `bucket ${bucketId} 未注册`);
    }
    try {
      const size = await getBucketSize(bucketId);
      return ok({
          id: bucketId,
          bytes: size.bytes,
          itemCount: size.itemCount,
          measuredAt: Date.now(),
        });
    } catch (err) {
      return failure(500, 'INTERNAL_ERROR', `度量 ${bucketId} 容量失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 全量
  const buckets = listBuckets({ includeHidden: true });
  const results: Array<{
    id: string;
    bytes: number;
    itemCount?: number;
    measuredAt: number;
    error?: string;
  }> = [];
  let totalBytes = 0;
  let totalItems = 0;

  await Promise.all(
    buckets.map(async (b) => {
      try {
        const sz = await b.sizeFn();
        results.push({
          id: b.id,
          bytes: sz.bytes,
          itemCount: sz.itemCount,
          measuredAt: Date.now(),
        });
        totalBytes += sz.bytes;
        totalItems += sz.itemCount ?? 0;
      } catch (err) {
        results.push({
          id: b.id,
          bytes: 0,
          measuredAt: Date.now(),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );

  // 排序：按 id 字典序，输出可预期
  results.sort((a, b) => a.id.localeCompare(b.id));
  return ok({ sizes: results, totalBytes, totalItems });
}

/**
 * POST /storage/list-items
 * Body: { bucket: string }
 */
async function handleListItems(
  body: any,
): Promise<StorageApplicationOutcome> {
  const bucketId = typeof body?.bucket === 'string' ? body.bucket : null;
  if (!bucketId) {
    return failure(400, 'VALIDATION_ERROR', '缺少 bucket 参数');
  }
  const bucket = getBucket(bucketId);
  if (!bucket) {
    return failure(404, 'NOT_FOUND', `bucket ${bucketId} 未注册`);
  }
  if (!bucket.listFn) {
    return failure(400, 'NOT_IMPLEMENTED', `bucket ${bucketId} 未实现 listFn`);
  }
  try {
    const items = await listBucketItems(bucketId);
    return ok({ id: bucketId, items, measuredAt: Date.now() });
  } catch (err) {
    return failure(500, 'INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
  }
}

/**
 * POST /storage/clear
 * Body: { bucket?: string, category?: BucketCategory, options?: ClearOptions }
 *   - bucket 优先：单 bucket 清理
 *   - category：清整类（admin 路径，主进程不通过 storage-manager bridge 调）
 */
async function handleClear(
  body: any,
): Promise<StorageApplicationOutcome> {
  const bucketId = typeof body?.bucket === 'string' ? body.bucket : null;
  const category = typeof body?.category === 'string' ? (body.category as BucketCategory) : null;

  if (!bucketId && !category) {
    return failure(400, 'VALIDATION_ERROR', '需要 bucket 或 category 参数');
  }
  if (bucketId && category) {
    return failure(400, 'VALIDATION_ERROR', 'bucket 与 category 不能同时传');
  }

  const options = parseClearOptions(body);

  if (bucketId) {
    return clearSingleBucket(bucketId, options);
  }

  // 整类
  const validCats: BucketCategory[] = ['cache', 'semi-cache', 'data'];
  if (!validCats.includes(category as BucketCategory)) {
    return failure(400, 'VALIDATION_ERROR', `category 必须是 ${validCats.join(' | ')}`);
  }
  const reports = await clearBucketCategory(category as BucketCategory, options);
  return ok({ category, dryRun: options?.dryRun === true, reports, totalBuckets: reports.length, clearedBuckets: reports.filter((r) => r.cleared).length });
}

async function clearSingleBucket(bucketId: string, options: ClearOptions | undefined): Promise<StorageApplicationOutcome> {
  const bucket = getBucket(bucketId);
  if (!bucket) return failure(404, 'NOT_FOUND', `bucket ${bucketId} 未注册`);
  if (!bucket.clearFn) return failure(400, 'NOT_IMPLEMENTED', `bucket ${bucketId} 不支持清理`);
  try {
    const result = await clearBucket(bucketId, options);
    return ok({ id: bucketId, dryRun: options?.dryRun === true, ...result });
  } catch (err) {
    return failure(400, 'VALIDATION_ERROR', err instanceof Error ? err.message : String(err));
  }
}

async function clearBucketCategory(category: BucketCategory, options?: ClearOptions): Promise<Array<{ id: string; cleared: boolean; bytes?: number; items?: number; error?: string; skipped?: 'no-clear-fn' }>> {
  const buckets = listBuckets({ category, includeHidden: true });
  const reports: Array<{
    id: string;
    cleared: boolean;
    bytes?: number;
    items?: number;
    error?: string;
    skipped?: 'no-clear-fn';
  }> = [];
  for (const b of buckets) {
    if (!b.clearFn) {
      reports.push({ id: b.id, cleared: false, skipped: 'no-clear-fn' });
      continue;
    }
    try {
      const r = await b.clearFn(options);
      reports.push({
        id: b.id,
        cleared: true,
        bytes: r.freedBytes,
        items: r.clearedItemCount,
      });
    } catch (err) {
      reports.push({
        id: b.id,
        cleared: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return reports;
}

/**
 * POST /storage/export
 * Body: { bucket: string }
 * 返回 ExportPayload（data 是 string，二进制走 base64）。
 */
async function handleExport(
  body: any,
): Promise<StorageApplicationOutcome> {
  const bucketId = typeof body?.bucket === 'string' ? body.bucket : null;
  if (!bucketId) {
    return failure(400, 'VALIDATION_ERROR', '缺少 bucket 参数');
  }
  const bucket = getBucket(bucketId);
  if (!bucket) {
    return failure(404, 'NOT_FOUND', `bucket ${bucketId} 未注册`);
  }
  if (!bucket.exportFn) {
    return failure(400, 'NOT_IMPLEMENTED', `bucket ${bucketId} 未实现 exportFn`);
  }
  try {
    const result = await exportBucket(bucketId);
    let dataStr: string;
    let encoding: 'utf-8' | 'base64' = 'utf-8';
    if (typeof result.data === 'string') {
      dataStr = result.data;
    } else if (result.data instanceof Uint8Array) {
      dataStr = Buffer.from(
        result.data.buffer.slice(
          result.data.byteOffset,
          result.data.byteOffset + result.data.byteLength,
        ),
      ).toString('base64');
      encoding = 'base64';
    } else {
      // Blob — daemon 端通常用不到，兜底当 string 处理
      return failure(
          500,
          'INTERNAL_ERROR',
          `bucket ${bucketId} exportFn 返回 Blob — daemon 端不支持序列化`,
      );
    }
    return ok({
        id: bucketId,
        filename: result.filename,
        data: dataStr,
        encoding,
        mimeType: result.mimeType,
      });
  } catch (err) {
    return failure(500, 'INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
  }
}

// ── admin 类操作（不走 storage-manager bridge） ────────────────

/**
 * POST /storage/vacuum
 * Body: { agentSync?: boolean, retainDays?: number }
 *   - agentSync = true（默认）：清 ~/.tabtin-daemon/agent-sync/<uid>/<wid>/archive.jsonl
 *     里超过 retainDays 天的行（默认 90 天 rolling）
 *
 * 实现策略：
 *   - 读 archive.jsonl 每行（NDJSON），按 timestamp 字段过滤
 *   - 把保留行写到 archive.jsonl.tmp，atomic rename 替换
 *   - dryRun 时只统计不写
 */
async function handleVacuum(
  fileSystem: StorageFileSystemPort,
  body: any,
): Promise<StorageApplicationOutcome> {
  const agentSync = body?.agentSync !== false; // 默认 true
  const retainDays = Number(body?.retainDays ?? 90);
  if (!Number.isFinite(retainDays) || retainDays < 0) {
    return failure(400, 'VALIDATION_ERROR', 'retainDays 必须是非负数');
  }
  const dryRun = body?.dryRun === true;
  let daemonHome: string;
  try {
    daemonHome = resolveDaemonHome(fileSystem, body);
  } catch (err) {
    return failure(400, 'VALIDATION_ERROR', err instanceof Error ? err.message : String(err));
  }

  if (!agentSync) {
    return failure(400, 'VALIDATION_ERROR', '当前仅支持 --agent-sync 模式');
  }

  const agentSyncRoot = path.join(daemonHome, 'agent-sync');
  const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000;
  const archivePaths = await collectAgentSyncArchives(fileSystem, agentSyncRoot);

  let scannedFiles = 0;
  let totalLines = 0;
  let removedLines = 0;
  let freedBytes = 0;
  const errors: string[] = [];

  for (const filePath of archivePaths) {
    scannedFiles += 1;
    try {
      const stats = await vacuumArchive(fileSystem, filePath, cutoff, dryRun);
      totalLines += stats.totalLines;
      removedLines += stats.removedLines;
      freedBytes += stats.freedBytes;
    } catch (err) {
      errors.push(
        `${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return ok({
      mode: 'agent-sync',
      retainDays,
      dryRun,
      scannedFiles,
      totalLines,
      removedLines,
      freedBytes,
      ...(errors.length > 0 ? { errors } : {}),
    });
}

async function vacuumArchive(fileSystem: StorageFileSystemPort, filePath: string, cutoff: number, dryRun: boolean): Promise<{ totalLines: number; removedLines: number; freedBytes: number }> {
  const lines = (await fileSystem.readText(filePath)).split('\n').filter(line => line.length > 0);
  const kept: string[] = [];
  let removedLines = 0;
  let freedBytes = 0;
  for (const line of lines) {
    const timestamp = parseArchiveTimestamp(line);
    if (timestamp === null || timestamp >= cutoff) kept.push(line);
    else { removedLines += 1; freedBytes += Buffer.byteLength(line, 'utf-8') + 1; }
  }
  if (!dryRun && removedLines > 0) {
    const tmp = `${filePath}.vacuum.tmp`;
    await fileSystem.writePrivateText(tmp, kept.length > 0 ? kept.join('\n') + '\n' : '');
    await fileSystem.rename(tmp, filePath);
  }
  return { totalLines: lines.length, removedLines, freedBytes };
}

function parseArchiveTimestamp(line: string): number | null {
  try {
    const obj = JSON.parse(line);
    const timestamp = Number(obj?.__archived_at__ ?? obj?.archived_at ?? obj?.ts ?? obj?.timestamp ?? 0);
    return timestamp > 0 ? timestamp : null;
  } catch { return null; }
}

/**
 * 递归找 agent-sync 下所有 archive.jsonl 文件。
 */
async function collectAgentSyncArchives(fileSystem: StorageFileSystemPort, rootDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      entries = await fileSystem.readDirectory(dir);
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else if (ent.isFile() && ent.name === 'archive.jsonl') {
        out.push(full);
      }
    }
  }
  await walk(rootDir);
  return out;
}

/**
 * POST /storage/drain
 * Body: { timeoutMs?: number, observeOnly?: boolean }
 *
 * **R2 P0 修复**：诚实化语义边界——
 *   - 本路由**仅**观测 `state.json` 的 `active_actions` + `offline_buffer_pending`
 *   - daemon.ts 当前的 `incrementActions/decrementActions` 接线不完整（pre-existing
 *     问题，归 G1/G2/G3 工作面）：active_actions 实际可能恒为 0 → 本路由可能
 *     立即返 `complete: true`，但 **不代表 outbox / agent-sync 真的已 flush**
 *   - **调用方必须**：清 `daemon:table-kernel-db` 的唯一安全路径是
 *     `tabtin-daemon stop --drain`（SIGUSR2 触发 daemon.ts:drain()）走完后再清——
 *     bucket clearFn 已经主动抛错强制走该流程
 *   - 主进程 DaemonStorageBridgeService **不应**用本路由判断"何时可以清"
 *
 * 返回 DrainStatus，含 `_warning` 字段提醒调用方上述局限。
 *
 * 注意：本接口**不主动触发 drain**——drain 必须由 SIGUSR2 触发。
 */
async function handleDrain(
  fileSystem: StorageFileSystemPort,
  body: any,
): Promise<StorageApplicationOutcome> {
  const timeoutMs = Number(body?.timeoutMs ?? 30_000);
  const dryRun = body?.observeOnly === true || timeoutMs <= 0;
  let daemonHome: string;
  try {
    daemonHome = resolveDaemonHome(fileSystem, body);
  } catch (err) {
    return failure(400, 'VALIDATION_ERROR', err instanceof Error ? err.message : String(err));
  }

  // 用 stateWriter 写盘的 state.json 来观测——避免本路由对 daemon 进程内
  // 状态有强耦合；任何外部进程也能读 state.json 了解当前 drain 进度。
  const statePath = path.join(daemonHome, 'state.json');

  async function readState(): Promise<{
    activeActions: number;
    offlineBufferPending: number;
    isDraining: boolean;
  } | null> {
    try {
      const raw = await fileSystem.readText(statePath);
      const st = JSON.parse(raw);
      return {
        activeActions: Number(st?.active_actions ?? 0),
        offlineBufferPending: Number(st?.offline_buffer_pending ?? 0),
        isDraining: !!st?.drain_started_at,
      };
    } catch {
      return null;
    }
  }

  const initial = await readState();
  if (!initial) {
    return failure(
        503,
        'INTERNAL_ERROR',
        'daemon state.json 不存在或不可读 — daemon 可能未运行',
        {
          suggestions: [
            '运行 `tabtin-daemon status` 检查 daemon 是否在线',
            '正常 drain 流程请走 `tabtin-daemon stop --drain`（发送 SIGUSR2）',
          ],
        },
    );
  }

  const DRAIN_WARNING =
    'active_actions / offline_buffer_pending 不覆盖 table-kernel-db outbox / agent-sync flush；' +
    '清 daemon:table-kernel-db 必须走 `tabtin-daemon stop --drain` 而非依赖本路由。';

  // dryRun 模式：只返回当前状态
  if (dryRun) {
    return ok({
        complete: initial.activeActions === 0 && initial.offlineBufferPending === 0,
        activeActions: initial.activeActions,
        offlineBufferPending: initial.offlineBufferPending,
        isDraining: initial.isDraining,
        observeOnly: true,
        _warning: DRAIN_WARNING,
      });
  }

  // 阻塞等待：每秒 poll，直到 active=0 + offline_pending=0 或超时
  const deadline = Date.now() + timeoutMs;
  let last = initial;
  while (Date.now() < deadline) {
    if (last.activeActions === 0 && last.offlineBufferPending === 0) {
      return ok({
          complete: true,
          activeActions: 0,
          offlineBufferPending: 0,
          isDraining: last.isDraining,
          _warning: DRAIN_WARNING,
        });
    }
    await new Promise((r) => setTimeout(r, 1000));
    const next = await readState();
    if (!next) break;
    last = next;
  }

  return ok({
      complete: last.activeActions === 0 && last.offlineBufferPending === 0,
      activeActions: last.activeActions,
      offlineBufferPending: last.offlineBufferPending,
      isDraining: last.isDraining,
      timeout: true,
      _warning: DRAIN_WARNING,
    });
}

/**
 * POST /storage/purge
 * Body: { confirm: 'yes-i-am-sure', deleteHomeDir?: boolean }
 *
 * 物理删 daemon 数据目录。多重防呆：
 *   1. 必须传 confirm === 'yes-i-am-sure'（避免误调）
 *   2. 检测 daemon 进程是否在跑（通过 daemon-server.json + process.kill(pid, 0)），
 *      若在跑则拒绝（请先 stop）
 *   3. deleteHomeDir 默认 true 时删整个 ~/.tabtin-daemon/，
 *      false 时只删数据子目录（保留 config.json 用于二次激活）
 *
 * **共享目录（~/.tabtin/）默认不动**——里面有 Electron 数据；
 * 调用方需显式传 deleteSharedRoot=true 才会清。
 */
async function handlePurge(
  fileSystem: StorageFileSystemPort,
  body: any,
): Promise<StorageApplicationOutcome> {
  if (body?.confirm !== 'yes-i-am-sure') {
    return failure(
        400,
        'VALIDATION_ERROR',
        'purge 需要 confirm=yes-i-am-sure 才能执行',
        {
          suggestions: [
            '物理删除是不可逆操作，请先确认已退出登录 / 备份重要数据',
            'CLI 等价命令: `tabtin-daemon storage purge --confirm`',
          ],
        },
    );
  }

  let daemonHome: string;
  try {
    daemonHome = resolveDaemonHome(fileSystem, body);
  } catch (err) {
    return failure(400, 'VALIDATION_ERROR', err instanceof Error ? err.message : String(err));
  }
  const deleteHomeDir = body?.deleteHomeDir !== false; // 默认 true
  const deleteSharedRoot = body?.deleteSharedRoot === true; // 默认 false

  // daemon 在跑时拒绝
  const serverDiscoveryPath = path.join(getHomeTabtinPath(), 'daemon-server.json');
  try {
    const raw = await fileSystem.readText(serverDiscoveryPath);
    const data = JSON.parse(raw);
    if (data?.pid && data.pid !== process.pid) {
      try {
        if (!fileSystem.isProcessRunning(data.pid)) throw new Error('process not running');
        return failure(
            409,
            'CONFLICT',
            `daemon 正在运行（PID ${data.pid}），purge 拒绝执行`,
            {
              suggestions: [
                '请先 `tabtin-daemon stop` 或 `tabtin-daemon stop --drain`',
              ],
            },
        );
      } catch {
        // 进程不在了，过
      }
    }
  } catch {
    // 没有 discovery 文件 → daemon 未运行，过
  }

  const removed = await removePurgeTargets(fileSystem, daemonHome, deleteHomeDir, deleteSharedRoot);

  const succeeded = removed.filter((r) => r.success).length;
  return ok({
      removed,
      totalTargets: removed.length,
      succeeded,
      failed: removed.length - succeeded,
    });
}

async function removePurgeTargets(fileSystem: StorageFileSystemPort, daemonHome: string, deleteHomeDir: boolean, deleteSharedRoot: boolean): Promise<Array<{ path: string; success: boolean; error?: string }>> {
  const daemonTargets = deleteHomeDir
    ? [daemonHome]
    : ['agent-sync', 'offline-buffer', 'table-kernel-db'].map(sub => path.join(daemonHome, sub));
  const sharedTargets = deleteSharedRoot
    ? ['screenshots', 'recordings', 'downloads', 'tmp', 'mcp-server.json', 'daemon-server.json', 'daemon-cli.sock', 'daemon-table.json', 'daemon'].map(sub => getHomeTabtinPath(sub))
    : [];
  const removed = [];
  for (const target of [...daemonTargets, ...sharedTargets]) {
    const result = await rmrfSafe(fileSystem, target);
    removed.push({ path: target, success: result.removed, error: result.error });
  }
  return removed;
}

async function rmrfSafe(fileSystem: StorageFileSystemPort, target: string): Promise<{ removed: boolean; error?: string }> {
  try {
    await fileSystem.removeTree(target);
    return { removed: true };
  } catch (err) {
    return {
      removed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Application interface ───────────────────────────────────────

export type StorageCommand =
  | 'list' | 'size' | 'list-items' | 'clear' | 'export' | 'vacuum' | 'drain' | 'purge'

export interface DaemonStorageApplication {
  execute(command: StorageCommand, input: unknown): Promise<StorageApplicationOutcome>
}

export function createDaemonStorageApplication(fileSystem: StorageFileSystemPort): DaemonStorageApplication {
  return { execute(command: StorageCommand, input: unknown): Promise<StorageApplicationOutcome> {
    const body = input as any
    switch (command) {
      case 'list': return handleList(body)
      case 'size': return handleSize(body)
      case 'list-items': return handleListItems(body)
      case 'clear': return handleClear(body)
      case 'export': return handleExport(body)
      case 'vacuum': return handleVacuum(fileSystem, body)
      case 'drain': return handleDrain(fileSystem, body)
      case 'purge': return handlePurge(fileSystem, body)
    }
  } }
}
