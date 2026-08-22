/**
 * Daemon 端存储 bucket 统一注册。
 *
 * 在 Daemon 启动期（各 service 初始化完成后）调用一次 `registerDaemonStorageBuckets`，
 * 把 14 个 daemon bucket 全部注册到 `@tabtin/storage-manager` 注册中心
 * （RFC §五 W2.3 表 13 个 + R1 P0 修复补的 `daemon:browser-exports`）。
 * CLI 路由 `cli/routes/storage.ts` 直接通过 `listBuckets` / `getBucketSize`
 * 等公开 API 访问注册结果——CLI 路由不重复维护 bucket 元信息。
 *
 * 设计要点：
 *   1. **路径来源**：所有 `~/.tabtin-daemon/` 路径走 `ConfigManager.getConfigDir()`，
 *      支持 `--config-dir` 覆盖；所有 `~/.tabtin/` 路径走
 *      `getHomeTabtinPath` SSoT。
 *   2. **category 与 RFC §五 表格严格对齐**：data / semi-cache / cache 决定
 *      UI Affordance；clearFn 是否实现决定 UI 是否给清理按钮。
 *   3. **drain 前置约束**：`daemon:table-kernel-db` 注册时让 clearFn 抛错
 *      指引调用方先 `tabtin-daemon storage drain`，避免误清未同步 outbox。
 *   4. **不可清的 bucket**：`config.json` / `fingerprint` / `persistent-approvals.json`
 *      不实现 clearFn——UI 卡片只显示容量，操作灰掉。
 *   5. **共享目录注释**：`~/.tabtin/screenshots` 等是与 Electron 共享的目录，
 *      bucket id 加 `daemon:` 前缀避免和 Electron 端注册冲突；description 里
 *      明示用户"该桶展示的是 Daemon 写入的文件"。
 */

import fs from 'node:fs';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { rm } from 'node:fs/promises';
import {
  registerStorageBucket,
  type BucketSize,
  type ClearOptions,
  type ClearResult,
  type StorageBucket,
} from '@tabtin/storage-manager';
import { getHomeTabtinPath } from '@tabtin/shared/storage-paths';
import type { Logger } from '../observability/logging/logger.js';

/**
 * 计算单文件大小（不存在返回 0）。
 */
async function fileSize(filePath: string): Promise<number> {
  try {
    const st = await fsp.stat(filePath);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

/**
 * 递归统计目录大小。
 *
 * 注意点：
 *   - 不跟随符号链接（避免循环）
 *   - 失败的子项目静默跳过（best-effort 度量，UI 不应因为单个文件读不到而炸）
 *   - 同时返回 itemCount，便于 UI 展示"X 个文件 Y MB"
 */
async function dirSize(
  dir: string,
  filter?: (entryPath: string) => boolean,
): Promise<{ bytes: number; itemCount: number }> {
  let bytes = 0;
  let itemCount = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return { bytes: 0, itemCount: 0 };
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    try {
      if (ent.isDirectory()) {
        const sub = await dirSize(full, filter);
        bytes += sub.bytes;
        itemCount += sub.itemCount;
      } else if (ent.isFile()) {
        if (filter && !filter(full)) continue;
        const st = await fsp.stat(full);
        bytes += st.size;
        itemCount += 1;
      }
    } catch {
      // best-effort：跳过单个失败项
    }
  }
  return { bytes, itemCount };
}

/**
 * 删除目录（递归）；不存在视为成功。
 */
async function rmrf(target: string): Promise<{ removed: boolean; error?: string }> {
  try {
    await rm(target, { recursive: true, force: true });
    return { removed: true };
  } catch (err) {
    return {
      removed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 删除单文件；不存在视为成功。
 */
async function unlinkSafe(target: string): Promise<{ removed: boolean; error?: string }> {
  try {
    await fsp.unlink(target);
    return { removed: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { removed: true };
    }
    return {
      removed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 通用 sizeFn：单文件桶。
 */
function singleFileSizeFn(getPath: () => string): () => Promise<BucketSize> {
  return async () => {
    const p = getPath();
    const bytes = await fileSize(p);
    return { bytes, itemCount: bytes > 0 ? 1 : 0 };
  };
}

/**
 * 通用 sizeFn：目录桶。
 */
function dirSizeFn(
  getPath: () => string,
  filter?: (full: string) => boolean,
): () => Promise<BucketSize> {
  return async () => {
    const p = getPath();
    return dirSize(p, filter);
  };
}

/**
 * 通用 clearFn：递归遍历目录 + 文件粒度精准删除。
 *
 * **R1/R2 P0 修复**：旧版本对子目录直接 `rmrf(子目录)`，filter 在子目录上失效——
 * 清 `daemon:agent-sync-pending` 时会顺手删 archive.jsonl，永久丢未同步数据。
 * 新实现：
 *   - 递归 walk，filter 应用于**每个文件**（保持与 dirSize 语义一致）
 *   - 命中文件 unlink；目录树空了再回收（避免 user/organization 子目录残留）
 *   - 不带 filter 时仍走 `rmrf(顶层条目)`，保持 cache/tmp 类桶的高效语义
 *
 * data 桶用此函数时必须有 warnings + requiresConfirmation。
 * dryRun=true 时不实际删，只算容量。
 */
function dirClearFn(
  getPath: () => string,
  filter?: (full: string) => boolean,
): (options?: ClearOptions) => Promise<ClearResult> {
  return async (options) => {
    const p = getPath();
    const { bytes, itemCount } = await dirSize(p, filter);
    if (options?.dryRun) {
      return { clearedItemCount: itemCount, freedBytes: bytes };
    }
    const errors: string[] = [];

    if (filter) {
      // 文件粒度递归 unlink + 后续清空目录
      await unlinkFilesMatching(p, filter, errors);
      await pruneEmptyDirs(p, errors);
    } else {
      // 无 filter 时直接 rmrf 顶层条目（cache/tmp 类的高效语义）
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(p, { withFileTypes: true });
      } catch {
        return { clearedItemCount: 0, freedBytes: 0 };
      }
      for (const ent of entries) {
        const r = await rmrf(path.join(p, ent.name));
        if (!r.removed && r.error) errors.push(`${ent.name}: ${r.error}`);
      }
    }

    return {
      clearedItemCount: itemCount,
      freedBytes: bytes,
      ...(errors.length > 0 ? { errors } : {}),
    };
  };
}

/**
 * 递归 walk 目录，把所有命中 filter 的文件 unlink。
 * 不删目录（由 pruneEmptyDirs 后续负责）。
 */
async function unlinkFilesMatching(
  dir: string,
  filter: (full: string) => boolean,
  errors: string[],
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    try {
      if (ent.isDirectory()) {
        await unlinkFilesMatching(full, filter, errors);
      } else if (ent.isFile()) {
        if (!filter(full)) continue;
        const r = await unlinkSafe(full);
        if (!r.removed && r.error) errors.push(`${full}: ${r.error}`);
      }
    } catch (err) {
      errors.push(`${full}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * 递归回收空目录（unlinkFilesMatching 之后调）。保留根 dir 本身，
 * 只删它下面已空的子目录。
 */
async function pruneEmptyDirs(rootDir: string, errors: string[]): Promise<void> {
  async function walk(dir: string): Promise<boolean> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    let hasContent = false;
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        const subHas = await walk(full);
        if (subHas) hasContent = true;
      } else {
        hasContent = true;
      }
    }
    if (!hasContent && dir !== rootDir) {
      try {
        await fsp.rmdir(dir);
        return false;
      } catch (err) {
        errors.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`);
        return true;
      }
    }
    return hasContent;
  }
  await walk(rootDir);
}

/**
 * 通用 clearFn：日志归档清理。
 *
 * 覆盖以下文件：
 *   - winston rotation 归档：`daemon.log.1` ~ `daemon.log.5`（unlink，安全）
 *   - launchd stdout/stderr：`daemon-stdout.log` / `daemon-stderr.log`
 *     **R1 P2 修复**：launchd 持有这两个 FD，unlink 不会回收空间——必须 truncate 到 0
 *
 * 当前活跃的 `daemon.log` 不动（避免 winston 写盘失败）。
 */
function rotatedLogClearFn(
  configDir: string,
  baseName = 'daemon.log',
): (options?: ClearOptions) => Promise<ClearResult> {
  return async (options) => {
    const dir = configDir;
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      return { clearedItemCount: 0, freedBytes: 0 };
    }
    const archives = entries.filter(
      (n) => n.startsWith(`${baseName}.`) && /\.\d+$/.test(n),
    );
    const launchdLogs = entries.filter(
      (n) => n === 'daemon-stdout.log' || n === 'daemon-stderr.log',
    );
    let bytes = 0;
    let count = 0;
    for (const name of [...archives, ...launchdLogs]) {
      const p = path.join(dir, name);
      bytes += await fileSize(p);
      count += 1;
    }
    if (options?.dryRun) {
      return { clearedItemCount: count, freedBytes: bytes };
    }
    const errors: string[] = [];
    // 归档份直接 unlink
    for (const name of archives) {
      const r = await unlinkSafe(path.join(dir, name));
      if (!r.removed && r.error) errors.push(`${name}: ${r.error}`);
    }
    // launchd 持有的 FD：truncate 到 0 而不是 unlink
    for (const name of launchdLogs) {
      try {
        await fsp.truncate(path.join(dir, name), 0);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // ENOENT 视为成功（文件本就不存在）
        if (!/ENOENT/.test(msg)) errors.push(`${name}: ${msg}`);
      }
    }
    return {
      clearedItemCount: count,
      freedBytes: bytes,
      ...(errors.length > 0 ? { errors } : {}),
    };
  };
}

// ── BucketSpec helper ──────────────────────────────────────────

/**
 * 构造 bucket 时使用的 helper，确保字段命名风格统一。
 * StorageBucket 的字段都是必填/可选明确的，这里只是把"分组+前缀"约定收口。
 */
function bucket(spec: StorageBucket): StorageBucket {
  return spec;
}

// ── 注册函数 ────────────────────────────────────────────────────

export interface DaemonStorageRegistrationOptions {
  /** Daemon home 目录（来自 ConfigManager.getConfigDir()，支持 --config-dir 覆盖）。 */
  daemonHomeDir: string;
  /** 注入 logger 用于注册日志（debug 级，不阻塞启动）。 */
  logger?: Pick<Logger, 'info' | 'warn'>;
}

/**
 * 已注册的 bucket id 列表（按 RFC §五 W2.3 顺序）。
 * 给单元测试和 smoke test 校验用。
 *
 * **R1 P0 修复**：补充 `daemon:browser-exports`（A5 §二 #22 PDF 导出，data 类，
 * 原 RFC §五 W2.3 文本 "Daemon screenshots/exports/recordings/downloads" 已提及但
 * 初版漏注册）。共 14 个 bucket。
 */
export const DAEMON_BUCKET_IDS = [
  'daemon:config',
  'daemon:fingerprint',
  'daemon:logs',
  'daemon:agent-sync-pending',
  'daemon:agent-sync-archive',
  'daemon:offline-buffer',
  'daemon:table-kernel-db',
  'daemon:persistent-approvals',
  'daemon:browser-screenshots',
  'daemon:browser-exports',
  'daemon:browser-recordings',
  'daemon:browser-downloads',
  'daemon:tmp',
  'daemon:transcript',
] as const;

export type DaemonBucketId = (typeof DAEMON_BUCKET_IDS)[number];

/**
 * 注册 14 个 Daemon bucket 到全局 registry。返回 unregister 数组（测试 cleanup 用 +
 * R1 #6 修复：CLI 也用 unregister handles 实现幂等）。
 *
 * 调用约束：每个进程内只调一次。重复调会因为 BucketAlreadyRegisteredError 抛错——
 * 这是设计意图（防止启动序列重复 wire）。CLI 用 unregister handles 复用同一进程时
 * 应先 unregister 再 register。
 */
export function registerDaemonStorageBuckets(
  opts: DaemonStorageRegistrationOptions,
): Array<() => void> {
  const { daemonHomeDir, logger } = opts;
  const home = (...sub: string[]): string => path.join(daemonHomeDir, ...sub);
  const tabtin = (...sub: string[]): string => getHomeTabtinPath(...sub);

  const offs: Array<() => void> = [];

  // 1. daemon:config — 不可清，仅展示
  offs.push(
    registerStorageBucket(
      bucket({
        id: 'daemon:config',
        category: 'data',
        group: 'system',
        displayName: 'Daemon 配置',
        description:
          '凭据、设备指纹、organization_id 等。删除等同于退出登录，需重新 init。',
        warnings: [
          '清理后 Daemon 立即不可用，需 `tabtin-daemon init --token` 重新激活',
        ],
        sizeFn: singleFileSizeFn(() => home('config.json')),
        // 故意不实现 clearFn——UI 卡片"清理"按钮灰掉
      }),
    ),
  );

  // 2. daemon:fingerprint — 不可清，仅展示
  offs.push(
    registerStorageBucket(
      bucket({
        id: 'daemon:fingerprint',
        category: 'data',
        group: 'system',
        displayName: '设备指纹',
        description: 'Daemon 设备指纹 (daemon-<uuid>)，与后端 device 实例绑定。',
        warnings: ['清理会触发 fingerprint 冲突，需后端配合清理'],
        sizeFn: singleFileSizeFn(() => home('fingerprint')),
      }),
    ),
  );

  // 3. daemon:logs — semi-cache，可清归档份
  offs.push(
    registerStorageBucket(
      bucket({
        id: 'daemon:logs',
        category: 'semi-cache',
        group: 'system',
        displayName: 'Daemon 日志归档',
        description:
          '50MB rotate，保留 5 份。清理只删归档份（daemon.log.1~.5），不删活跃的 daemon.log。',
        sizeFn: async () => {
          let bytes = 0;
          let itemCount = 0;
          let entries: string[];
          try {
            entries = await fsp.readdir(daemonHomeDir);
          } catch {
            return { bytes: 0, itemCount: 0 };
          }
          for (const name of entries) {
            // 匹配 daemon.log / daemon.log.1 ~ .5 / launchd 的 stdout/stderr.log
            if (
              name === 'daemon.log' ||
              /^daemon\.log\.\d+$/.test(name) ||
              name === 'daemon-stdout.log' ||
              name === 'daemon-stderr.log'
            ) {
              bytes += await fileSize(path.join(daemonHomeDir, name));
              itemCount += 1;
            }
          }
          return { bytes, itemCount };
        },
        clearFn: rotatedLogClearFn(daemonHomeDir, 'daemon.log'),
      }),
    ),
  );

  // 4. daemon:agent-sync-pending — data，清前需确认（hard）
  offs.push(
    registerStorageBucket(
      bucket({
        id: 'daemon:agent-sync-pending',
        category: 'data',
        group: 'conversation',
        displayName: 'Agent 同步队列（待发送）',
        description:
          'Phase 6 Runtime transcript 同步队列：本地暂存等待上传到云端的 pending.jsonl。',
        warnings: [
          '清理会丢失尚未同步的 transcript，可能导致跨设备记忆缺失',
          '建议先确认 Daemon 在线 + 队列已 flush（`tabtin-daemon storage drain` 后再清）',
        ],
        sizeFn: dirSizeFn(
          () => home('agent-sync'),
          (full) => /pending\.jsonl(\.\d+)?$/.test(full),
        ),
        clearFn: dirClearFn(
          () => home('agent-sync'),
          (full) => /pending\.jsonl(\.\d+)?$/.test(full),
        ),
      }),
    ),
  );

  // 5. daemon:agent-sync-archive — semi-cache，vacuum 清老归档
  offs.push(
    registerStorageBucket(
      bucket({
        id: 'daemon:agent-sync-archive',
        category: 'semi-cache',
        group: 'conversation',
        displayName: 'Agent 同步归档',
        description:
          'Phase 6 同步队列归档（TTL/失败超限的 archive.jsonl）。可通过 vacuum 命令清老条目。',
        sizeFn: dirSizeFn(
          () => home('agent-sync'),
          (full) => /archive\.jsonl(\.\d+)?$/.test(full),
        ),
        clearFn: dirClearFn(
          () => home('agent-sync'),
          (full) => /archive\.jsonl(\.\d+)?$/.test(full),
        ),
      }),
    ),
  );

  // 6. daemon:offline-buffer — semi-cache
  offs.push(
    registerStorageBucket(
      bucket({
        id: 'daemon:offline-buffer',
        category: 'semi-cache',
        group: 'conversation',
        displayName: '离线消息缓冲',
        description:
          '离线时 Agent → Gateway 消息缓冲，30 分钟 TTL；重连后自动 replay 并删除。',
        sizeFn: dirSizeFn(() => home('offline-buffer')),
        clearFn: dirClearFn(() => home('offline-buffer')),
      }),
    ),
  );

  // 7. daemon:table-kernel-db — data，clear 必须先 drain
  // R2 Round 2 must-fix：warnings 增加"storage drain 当前不可信"提示，
  // 让 UI 在 L4 二次确认弹窗里直接看到这条关键警告
  offs.push(
    registerStorageBucket(
      bucket({
        id: 'daemon:table-kernel-db',
        category: 'data',
        group: 'business-app',
        displayName: 'Table 本地数据库',
        description:
          'PGlite 本地表格副本 + outbox（待同步写）。删除会永久丢失未同步的本地写。',
        warnings: [
          '该数据库含未同步到云端的 outbox 写操作，直接清理会永久丢数据',
          '⚠️ **不要相信** `tabtin-daemon storage drain` 的 active_actions 数字——它当前不追踪 outbox flush 状态',
          '安全清理路径：先 `tabtin-daemon stop --drain`（SIGUSR2 完整 drain）确认 daemon 完全停止后，再清此桶',
        ],
        sizeFn: dirSizeFn(() => home('table-kernel-db')),
        clearFn: async () => {
          // 强制走 drain CLI 流程——这里直接抛错是产品决策：
          // 不允许通过 storage-manager bridge 静默清掉含 outbox 的目录。
          // UI 端可在 Advanced tab 实现"先 drain 再 clear"的两步流程，
          // 但必须显式调 cli-server-core 的 drain 路由。
          throw new Error(
            '[storage-manager] daemon:table-kernel-db 不允许直接清理：含未同步的 outbox。请先调 `tabtin-daemon storage drain` 完成 flush。',
          );
        },
      }),
    ),
  );

  // 8. daemon:persistent-approvals — data，仅展示（业务上很少有"全清"需求）
  offs.push(
    registerStorageBucket(
      bucket({
        id: 'daemon:persistent-approvals',
        category: 'data',
        group: 'system',
        displayName: '持久审批白名单',
        description:
          '用户在 HITL 选 "Always allow" 的命令白名单。清理会让所有命令重新走审批。',
        warnings: ['清理后所有"始终允许"的命令需要重新审批'],
        sizeFn: singleFileSizeFn(() => home('persistent-approvals.json')),
        clearFn: async (options) => {
          const p = home('persistent-approvals.json');
          const bytes = await fileSize(p);
          if (options?.dryRun) {
            return { clearedItemCount: bytes > 0 ? 1 : 0, freedBytes: bytes };
          }
          const r = await unlinkSafe(p);
          return {
            clearedItemCount: r.removed && bytes > 0 ? 1 : 0,
            freedBytes: r.removed ? bytes : 0,
            ...(r.error ? { errors: [r.error] } : {}),
          };
        },
      }),
    ),
  );

  // ── 共享目录 filename filter ──────────────────────────────────
  // **R1 Round 2 N-1 修复**：与 G3 的 media:* bucket 同目录注册时，
  // 通过文件名 filter 对齐两端清理粒度，避免 daemon 端无 filter 走 rmrf
  // 顶层条目，把非媒体文件（如用户手动放入的备注 / Electron 自定义文件）
  // 一并清掉。filter 与 Electron 端 MediaStorageBucketRegistration 一致。
  const isImageFile = (full: string) =>
    /\.(png|jpe?g|gif|webp|bmp)$/i.test(path.basename(full));
  const isPdfFile = (full: string) =>
    /\.pdf$/i.test(path.basename(full));
  // downloads 目录类型最杂——Electron 端的 download bucket 不带 filter，
  // 但 daemon 仍精准化：只清 daemon 知道自己写入的常见 web 资源类型，
  // 把"用户主动从 ~/.tabtin/downloads/ 拷出去后又拷回来"等手动文件留下。
  // 这是保守语义；完美的 owner 隔离留 W4 / v2。
  const isDaemonDownloadFile = (full: string) =>
    /\.(mp4|mp3|webm|mkv|avi|mov|m4a|flv|ts|m4s|m3u8|mpd|jpg|jpeg|png|gif|pdf|zip|rar|7z|tar|gz)$/i.test(
      path.basename(full),
    );

  // 9. daemon:browser-screenshots — semi-cache（与 Electron 共享，但加 filename filter）
  offs.push(
    registerStorageBucket(
      bucket({
        id: 'daemon:browser-screenshots',
        category: 'semi-cache',
        group: 'media',
        displayName: '浏览器截图',
        description:
          'browser_screenshot 工具产物（与 Electron 共享 ~/.tabtin/screenshots/ 目录，仅清 .png/.jpg/.webp 等图片文件）。',
        warnings: [
          '⚠️ 与 Electron 客户端共享同一目录——清理会同时删除 Electron 截图',
          '已通过文件名后缀过滤，仅清图片文件；若仍想限定 owner，请等 v2 owner 隔离上线',
        ],
        sizeFn: dirSizeFn(() => tabtin('screenshots'), isImageFile),
        clearFn: dirClearFn(() => tabtin('screenshots'), isImageFile),
      }),
    ),
  );

  // 10. daemon:browser-exports — data（PDF 导出，与 Electron 共享，filter 仅 .pdf）
  offs.push(
    registerStorageBucket(
      bucket({
        id: 'daemon:browser-exports',
        category: 'data',
        group: 'media',
        displayName: '浏览器 PDF 导出',
        description:
          'browser_pdf 工具产物（与 Electron 共享 ~/.tabtin/exports/ 目录，仅清 .pdf 文件）。',
        warnings: [
          '清理会永久丢失历史 PDF 导出，无法恢复',
          '⚠️ 与 Electron 客户端共享同一目录——清理会同时删除 Electron 导出',
          '已通过文件名后缀过滤，仅清 .pdf 文件',
        ],
        sizeFn: dirSizeFn(() => tabtin('exports'), isPdfFile),
        clearFn: dirClearFn(() => tabtin('exports'), isPdfFile),
      }),
    ),
  );

  // 11. daemon:browser-recordings — data（仅 daemon 写）
  offs.push(
    registerStorageBucket(
      bucket({
        id: 'daemon:browser-recordings',
        category: 'data',
        group: 'browser',
        displayName: '浏览器动作录制',
        description:
          'RecordingSession 的 CLI-level actions 录制（不是视频，是动作流 JSON）。',
        warnings: ['清理后历史录制不可见，无法用于回放或导出'],
        sizeFn: dirSizeFn(() => tabtin('recordings')),
        clearFn: dirClearFn(() => tabtin('recordings')),
      }),
    ),
  );

  // 12. daemon:browser-downloads — data（与 Electron 共享，filter 限常见 web 资源）
  offs.push(
    registerStorageBucket(
      bucket({
        id: 'daemon:browser-downloads',
        category: 'data',
        group: 'media',
        displayName: 'Web 下载',
        description:
          'Daemon 浏览器/流下载产物（与 Electron 共享 ~/.tabtin/downloads/ 目录，仅清常见 web 资源后缀）。',
        warnings: [
          '清理后 daemon 浏览器/流下载的文件丢失，无法恢复',
          '⚠️ 与 Electron 客户端共享同一目录——清理会**同时删除 Electron 端同后缀下载文件**',
          '已通过文件名后缀过滤（mp4/mp3/zip/pdf 等），用户手动放入的其他类型文件不动',
        ],
        sizeFn: dirSizeFn(() => tabtin('downloads'), isDaemonDownloadFile),
        clearFn: dirClearFn(() => tabtin('downloads'), isDaemonDownloadFile),
      }),
    ),
  );

  // 13. daemon:tmp — cache
  offs.push(
    registerStorageBucket(
      bucket({
        id: 'daemon:tmp',
        category: 'cache',
        group: 'cache',
        displayName: '流分片临时区',
        description:
          'HLS / DASH 流分片下载与合并临时目录。崩溃时可能遗留孤儿，可放心清。',
        sizeFn: dirSizeFn(() => tabtin('tmp')),
        clearFn: dirClearFn(() => tabtin('tmp')),
      }),
    ),
  );

  // 14. daemon:transcript — semi-cache（A5 §二 #20 标 data，但产品上 Django 是 SoT
  // 可重拉，所以降级 semi-cache + 在 description 里明示恢复路径）
  offs.push(
    registerStorageBucket(
      bucket({
        id: 'daemon:transcript',
        category: 'semi-cache',
        group: 'conversation',
        displayName: 'Daemon 对话备份',
        description:
          'runtime done 后从 Django 拉回的 transcript（~/.tabtin/daemon/conversations/<sid>.jsonl），用于本地搜索。清理后失去离线搜索能力，但下次 done 时会重新拉回；Django 不可达时无法恢复。',
        sizeFn: dirSizeFn(() => tabtin('daemon', 'conversations')),
        clearFn: dirClearFn(() => tabtin('daemon', 'conversations')),
      }),
    ),
  );

  logger?.info(
    `[StorageBuckets] Registered ${offs.length} daemon storage bucket(s): ${DAEMON_BUCKET_IDS.join(', ')}`,
  );

  return offs;
}
