/**
 * MediaStorageBucketRegistration — 把"媒体与下载"类本地存储登记到 storage-manager。
 *
 * 背景（W2.2 G3，media / download 分组）：
 *   媒体类有 3 大来源 + 2 类下载目的地：
 *     - media render tmp: widget / audio / docparse 临时目录
 *       tabvideo-mg-* / tabtin-mg-*（work_dir 依赖调用方主动清，容易泄漏）
 *     - StreamDownloadService: app.getPath('temp')/tabtin-stream/<id>/（HLS/DASH
 *       分片中转，进程崩溃时泄漏）
 *     - VideoRecorder / ScreenshotService / cdp-actions.setupPdfAPI:
 *       userData/recordings / ~/.tabtin/screenshots / ~/.tabtin/exports（永久增长）
 *     - DownloadManager + ResourceDownloadService + StreamDownloadService:
 *       ~/Downloads / ~/Downloads/TabTin（聚合显示）
 *     - Agent 沙箱下载：sandbox/agent-spaces/<spaceId>/downloads/
 *
 * ## 设计约束
 *
 * 1. **路径决议**：
 *    - `~/.tabtin/...` 走 `getHomeTabtinPath` SSoT
 *    - Electron userData 走 `getUserDataPath` SSoT（W1.2 决策）
 *    - sandbox root 走 `@tabtin/terminal-core` 的 `resolveSpacesRoot`（内部已
 *      接 `getPlatformDataRoot` SSoT）
 *    - `app.getPath('temp')` 用于 Chromium 自身管理的临时目录（tabtin-stream 分片
 *      中转）—— Electron 内置路径，由 OS / Chromium 决定，目前无对应 SSoT helper
 *
 * 2. **download:user-downloads 只清历史，不碰磁盘文件**：
 *    `~/Downloads` 是系统目录，里面有非 TabTin 下载的文件，**严禁直接 rm**。
 *    clearFn 只清 ConfigService 下的 `download.history` 记录；warnings 明确
 *    告诉用户"下载目录里的文件不会被删"。
 *
 *    **sizeFn 的产品决策**（R2 第一轮 blocker 修复后）：**只算 history 条目
 *    自身容量**（每条约 600 B），**不聚合磁盘文件大小**——避免 UI 上显示
 *    "占 5GB"但清完 freedBytes=0 的严重误导。listFn 把磁盘文件真实大小放到
 *    `metadata.actualFileBytes`，UI 可在子项里独立展示"这条记录指向的文件
 *    X MB"但不算进 bucket 容量。
 *
 * 3. **Agent sandbox downloads 可整目录清**：
 *    sandbox/agent-spaces/<spaceId>/downloads/ 是 Agent 工作产物，用户有
 *    完整的控制权。clearFn 递归删除目录内容。
 *
 * 4. **录屏 / 截图 / PDF 导出是 data 类（soft）**：
 *    用户可能把这些当成资产保存。clearFn 实现为"默认全清"+ 支持按
 *    itemIds 子项清（itemIds 是文件名，用户可在 UI 勾选部分）。
 *
 * 5. **tabvideo-render / stream tmp 是 cache 类（none）**：
 *    进程崩溃残留的垃圾，L1 一键清即可。sizeFn 扫前缀目录，clearFn 按
 *    mtime > 24h 的阈值安全清掉老旧 tmp（新的还在跑的任务不误清）。
 *
 * 6. **幂等**：startup-services 启动期调一次；HMR / 单测通过
 *    `__resetForTesting` 先清 registry 再调。
 */

import { app } from 'electron'
import {
  existsSync,
  rmSync,
  unlinkSync,
} from 'node:fs'
import { stat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  registerStorageBucket,
  type BucketSize,
  type ClearOptions,
  type ClearResult,
  type StorageBucket,
} from '@tabtin/storage-manager'
import { getHomeTabtinPath, getUserDataPath } from '@tabtin/shared/storage-paths'
import {
  resolveDataRoot,
  resolveWorkspaceDownloadsDir,
} from '@tabtin/terminal-core'

import { configService } from './ConfigService'
import { logger } from '../utils/logger'

const TAG = 'MediaStorageBucketRegistration'

// ── 通用 helper ──────────────────────────────────────────────

async function dirSize(dir: string): Promise<{ bytes: number; itemCount: number }> {
  let bytes = 0
  let itemCount = 0
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return { bytes: 0, itemCount: 0 }
  }
  for (const ent of entries) {
    const full = join(dir, ent.name)
    try {
      if (ent.isDirectory()) {
        const sub = await dirSize(full)
        bytes += sub.bytes
        itemCount += sub.itemCount
      } else if (ent.isFile()) {
        const st = await stat(full)
        bytes += st.size
        itemCount += 1
      }
    } catch {
      /* best-effort */
    }
  }
  return { bytes, itemCount }
}

async function fileSize(p: string): Promise<number> {
  try {
    const st = await stat(p)
    return st.isFile() ? st.size : 0
  } catch {
    return 0
  }
}

/**
 * 扫 os.tmpdir() 下匹配 prefix 的子目录。可选 mtime 阈值（毫秒，相对当前）。
 * 返回 [{ name, fullPath, bytes, mtime }, ...]。
 */
async function listTmpByPrefix(
  prefixes: readonly string[],
  opts?: { minAgeMs?: number; root?: string },
): Promise<Array<{ name: string; fullPath: string; bytes: number; mtimeMs: number }>> {
  const root = opts?.root ?? tmpdir()
  let entries: Array<{
    name: string
    isDirectory: () => boolean
    isFile: () => boolean
  }>
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }

  const out: Array<{ name: string; fullPath: string; bytes: number; mtimeMs: number }> = []
  const now = Date.now()
  for (const ent of entries) {
    if (!prefixes.some((p) => ent.name.startsWith(p))) continue
    const full = join(root, ent.name)
    let st: Awaited<ReturnType<typeof stat>>
    try {
      st = await stat(full)
    } catch {
      continue
    }
    const mtimeMs = st.mtimeMs
    if (opts?.minAgeMs !== undefined && now - mtimeMs < opts.minAgeMs) continue

    let bytes = 0
    if (st.isDirectory()) {
      const sub = await dirSize(full)
      bytes = sub.bytes
    } else if (st.isFile()) {
      bytes = st.size
    } else {
      continue
    }
    out.push({ name: ent.name, fullPath: full, bytes, mtimeMs })
  }
  return out
}

function rmSafe(target: string): { removed: boolean; error?: string } {
  try {
    rmSync(target, { recursive: true, force: true })
    return { removed: true }
  } catch (err) {
    return { removed: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ── bucket 构造器 ────────────────────────────────────────────

const TABVIDEO_TMP_PREFIXES = [
  'tabtin-mg-',
  'widget-render-',
  'widget-upload-',
  'tabtin-audio-',
  'tabtin-docparse-',
] as const

/**
 * media:tabvideo-render-tmp（cache）—— 扫 os.tmpdir 下 8 种媒体相关前缀目录。
 *
 * 产品决策：只清 mtime > 24h 的残留，避免误清正在运行的任务。用户看到的
 * sizeFn 是"可清残留"的容量，不是全部 TabVideo tmp 的容量。
 */
function buildTabVideoRenderTmpBucket(): StorageBucket {
  const MIN_AGE_MS = 24 * 60 * 60 * 1000
  return {
    id: 'media:tabvideo-render-tmp',
    category: 'cache',
    group: 'cache',
    displayName: '视频 / Widget 渲染残留',
    description:
      '视频渲染、导出、Widget 烤图、音频抽取、附件解析等功能产生的临时文件。只显示超过 24 小时的残留，避免误清正在运行的任务。',
    requiresConfirmation: 'none',
    sizeFn: async () => {
      const hits = await listTmpByPrefix(TABVIDEO_TMP_PREFIXES, { minAgeMs: MIN_AGE_MS })
      return {
        bytes: hits.reduce((s, h) => s + h.bytes, 0),
        itemCount: hits.length,
      }
    },
    listFn: async () => {
      const hits = await listTmpByPrefix(TABVIDEO_TMP_PREFIXES, { minAgeMs: MIN_AGE_MS })
      return hits.map((h) => ({
        id: h.name,
        label: h.name,
        bytes: h.bytes,
        metadata: { fullPath: h.fullPath, mtimeMs: h.mtimeMs },
      }))
    },
    clearFn: async (options) => {
      const hits = await listTmpByPrefix(TABVIDEO_TMP_PREFIXES, { minAgeMs: MIN_AGE_MS })
      const target =
        options?.itemIds && options.itemIds.length > 0
          ? hits.filter((h) => options.itemIds!.includes(h.name))
          : hits
      if (options?.dryRun) {
        return {
          clearedItemCount: target.length,
          freedBytes: target.reduce((s, h) => s + h.bytes, 0),
        }
      }
      const errors: string[] = []
      let cleared = 0
      let freed = 0
      for (const h of target) {
        const r = rmSafe(h.fullPath)
        if (r.removed) {
          cleared += 1
          freed += h.bytes
        } else if (r.error) {
          errors.push(`${h.name}: ${r.error}`)
        }
      }
      return {
        clearedItemCount: cleared,
        freedBytes: freed,
        ...(errors.length ? { errors } : {}),
      }
    },
  }
}

/**
 * media:stream-download-tmp（cache）—— app.getPath('temp')/tabtin-stream/ 下
 * 的 HLS/DASH 分片中转目录。progress 运行时目录即扫即清是安全的——每次新下载
 * 走独立 downloadId 子目录，老 downloadId 的残留一定是崩溃遗留。
 */
function buildStreamDownloadTmpBucket(): StorageBucket {
  const MIN_AGE_MS = 6 * 60 * 60 * 1000 // 6h——留出长视频下载窗口
  const getRoot = () => join(app.getPath('temp'), 'tabtin-stream')
  return {
    id: 'media:stream-download-tmp',
    category: 'cache',
    group: 'cache',
    displayName: '流媒体下载临时分片',
    description:
      '下载 HLS / DASH 流媒体视频时的临时分片文件。进程异常退出时不会自动清理，长视频下载可累积 GB 级。',
    requiresConfirmation: 'none',
    sizeFn: async () => {
      const root = getRoot()
      if (!existsSync(root)) return { bytes: 0, itemCount: 0 }
      const entries = await listTmpByPrefix([''], {
        root,
        minAgeMs: MIN_AGE_MS,
      })
      return {
        bytes: entries.reduce((s, e) => s + e.bytes, 0),
        itemCount: entries.length,
      }
    },
    listFn: async () => {
      const root = getRoot()
      if (!existsSync(root)) return []
      const entries = await listTmpByPrefix([''], {
        root,
        minAgeMs: MIN_AGE_MS,
      })
      return entries.map((e) => ({
        id: e.name,
        label: e.name,
        bytes: e.bytes,
        metadata: { fullPath: e.fullPath, mtimeMs: e.mtimeMs },
      }))
    },
    clearFn: async (options) => {
      const root = getRoot()
      if (!existsSync(root)) return { clearedItemCount: 0, freedBytes: 0 }
      const entries = await listTmpByPrefix([''], {
        root,
        minAgeMs: MIN_AGE_MS,
      })
      const target =
        options?.itemIds && options.itemIds.length > 0
          ? entries.filter((e) => options.itemIds!.includes(e.name))
          : entries
      if (options?.dryRun) {
        return {
          clearedItemCount: target.length,
          freedBytes: target.reduce((s, e) => s + e.bytes, 0),
        }
      }
      const errors: string[] = []
      let cleared = 0
      let freed = 0
      for (const e of target) {
        const r = rmSafe(e.fullPath)
        if (r.removed) {
          cleared += 1
          freed += e.bytes
        } else if (r.error) {
          errors.push(`${e.name}: ${r.error}`)
        }
      }
      return {
        clearedItemCount: cleared,
        freedBytes: freed,
        ...(errors.length ? { errors } : {}),
      }
    },
  }
}

/**
 * 为一个"目录 + 文件名过滤"的 data 类桶做通用实现（recordings / screenshots / exports）。
 */
function buildDataDirBucket(params: {
  id: string
  group: 'media'
  displayName: string
  description: string
  warnings: string[]
  getDir: () => string
  /** 可选文件名过滤（如只看 .mp4） */
  filenameFilter?: (name: string) => boolean
}): StorageBucket {
  const { id, group, displayName, description, warnings, getDir, filenameFilter } = params

  async function listFiles(): Promise<
    Array<{ name: string; fullPath: string; bytes: number; mtimeMs: number }>
  > {
    const dir = getDir()
    if (!existsSync(dir)) return []
    let entries: Array<{ name: string; isFile: () => boolean; isDirectory: () => boolean }>
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const out: Array<{ name: string; fullPath: string; bytes: number; mtimeMs: number }> = []
    for (const ent of entries) {
      if (!ent.isFile()) continue
      if (filenameFilter && !filenameFilter(ent.name)) continue
      const full = join(dir, ent.name)
      try {
        const st = await stat(full)
        out.push({ name: ent.name, fullPath: full, bytes: st.size, mtimeMs: st.mtimeMs })
      } catch {
        /* ignore */
      }
    }
    return out
  }

  return {
    id,
    category: 'data',
    group,
    displayName,
    description,
    warnings,
    requiresConfirmation: 'soft',
    sizeFn: async (): Promise<BucketSize> => {
      const files = await listFiles()
      return {
        bytes: files.reduce((s, f) => s + f.bytes, 0),
        itemCount: files.length,
      }
    },
    listFn: async () => {
      const files = await listFiles()
      return files.map((f) => ({
        id: f.name,
        label: f.name,
        bytes: f.bytes,
        metadata: { fullPath: f.fullPath, mtimeMs: f.mtimeMs },
      }))
    },
    clearFn: async (options): Promise<ClearResult> => {
      const files = await listFiles()
      const target =
        options?.itemIds && options.itemIds.length > 0
          ? files.filter((f) => options.itemIds!.includes(f.name))
          : files
      if (options?.dryRun) {
        return {
          clearedItemCount: target.length,
          freedBytes: target.reduce((s, f) => s + f.bytes, 0),
        }
      }
      const errors: string[] = []
      let cleared = 0
      let freed = 0
      for (const f of target) {
        try {
          unlinkSync(f.fullPath)
          cleared += 1
          freed += f.bytes
        } catch (err) {
          errors.push(`${f.name}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      return {
        clearedItemCount: cleared,
        freedBytes: freed,
        ...(errors.length ? { errors } : {}),
      }
    },
  }
}

// ── download:user-downloads（特殊逻辑：只清 history） ──────

interface DownloadHistoryEntry {
  id: string
  name?: string
  savePath?: string
  status?: string
  startTime?: number
  size?: { received?: number; total?: number }
}

function readDownloadHistory(): Record<string, DownloadHistoryEntry> {
  try {
    const raw = configService.get('download.history')
    if (raw && typeof raw === 'object') {
      return raw as Record<string, DownloadHistoryEntry>
    }
  } catch {
    /* ignore */
  }
  return {}
}

/**
 * download:user-downloads（data，soft）——**不直接清用户文件**，只清
 * ConfigService 下的 download.history。
 *
 * sizeFn **只算 history 记录本身的字节数**（不累加磁盘文件），避免 UI 上
 * 显示"占用 5GB"但清理后 freedBytes=0 的误导。每个 history entry 约 0.5-1KB
 * JSON，全量 max 500 条约 500KB 级。
 *
 * listFn 仍然为每条返回 `metadata.actualFileBytes`（保留磁盘真实大小给 UI
 * 展示，但不算进容器容量），这样 UI 可以同时展示"此记录指向的文件占 X MB"
 * 和"历史记录本身占 Y KB"两个独立数字，不让用户产生"清掉这里就能回收 X MB
 * 磁盘"的误判。
 */
function buildUserDownloadsBucket(): StorageBucket {
  const HISTORY_ENTRY_AVG_BYTES = 600
  return {
    id: 'download:user-downloads',
    category: 'data',
    group: 'media',
    displayName: '下载列表（仅记录）',
    description:
      'TabTin 触发下载的历史记录（系统下载 + 流媒体下载聚合）。清理只删这份记录，磁盘上的下载文件不会被删。',
    warnings: [
      '清理后下载列表清空；~/Downloads 与 ~/Downloads/TabTin/ 里的文件**不会被删**，需要时请在系统文件管理器里手动删除',
      '清理不会停止正在进行的下载',
    ],
    requiresConfirmation: 'soft',
    sizeFn: async (): Promise<BucketSize> => {
      const history = readDownloadHistory()
      const items = Object.values(history)
      // 只算 history JSON 本身的字节数——清理真实回收量就是这个数字
      const bytes = items.length * HISTORY_ENTRY_AVG_BYTES
      return { bytes, itemCount: items.length }
    },
    listFn: async () => {
      const history = readDownloadHistory()
      const items = Object.values(history)
      const results = await Promise.all(
        items.map(async (it) => {
          const actualFileBytes = it?.savePath ? await fileSize(it.savePath) : 0
          const src = classifyDownloadSource(it?.savePath)
          return {
            id: it.id,
            label: it.name || it.savePath || it.id,
            // 条目自身容量（JSON 开销），与顶层 sizeFn 语义对齐
            bytes: HISTORY_ENTRY_AVG_BYTES,
            metadata: {
              savePath: it.savePath,
              source: src,
              status: it.status,
              startTime: it.startTime,
              // 磁盘文件实际大小给 UI 额外展示，**不**算进 bucket 容量
              actualFileBytes,
              fileExists: actualFileBytes > 0,
            },
          }
        }),
      )
      return results.sort((a, b) => {
        const ta = (a.metadata?.startTime as number | undefined) ?? 0
        const tb = (b.metadata?.startTime as number | undefined) ?? 0
        return tb - ta
      })
    },
    clearFn: async (options): Promise<ClearResult> => {
      const history = readDownloadHistory()
      const ids = Object.keys(history)
      const target =
        options?.itemIds && options.itemIds.length > 0
          ? ids.filter((id) => options.itemIds!.includes(id))
          : ids

      const freedBytes = target.length * HISTORY_ENTRY_AVG_BYTES

      if (options?.dryRun) {
        return { clearedItemCount: target.length, freedBytes }
      }

      if (target.length === 0) return { clearedItemCount: 0, freedBytes: 0 }

      // 全清：直接 clearByKey('download.history')
      if (target.length === ids.length) {
        try {
          configService.clearByKey('download.history')
          return { clearedItemCount: ids.length, freedBytes }
        } catch (err) {
          return {
            clearedItemCount: 0,
            freedBytes: 0,
            errors: [err instanceof Error ? err.message : String(err)],
          }
        }
      }

      // 部分清：重写 history
      const next: Record<string, DownloadHistoryEntry> = {}
      for (const id of ids) {
        if (!target.includes(id)) next[id] = history[id]
      }
      try {
        configService.set('download.history', next)
        return { clearedItemCount: target.length, freedBytes }
      } catch (err) {
        return {
          clearedItemCount: 0,
          freedBytes: 0,
          errors: [err instanceof Error ? err.message : String(err)],
        }
      }
    },
  }
}

function classifyDownloadSource(savePath?: string): 'system' | 'tabtin-sub' | 'unknown' {
  if (!savePath) return 'unknown'
  const downloads = safeAppPath('downloads')
  if (downloads) {
    const tabtinSub = join(downloads, 'TabTin')
    if (savePath.startsWith(tabtinSub)) return 'tabtin-sub'
    if (savePath.startsWith(downloads)) return 'system'
  }
  return 'unknown'
}

function safeAppPath(name: Parameters<typeof app.getPath>[0]): string | null {
  try {
    return app.getPath(name)
  } catch {
    return null
  }
}

/**
 * download:agent-sandbox-downloads（data，soft）—— 扫 Agent downloads：
 *  硬切，只扫新树 `{dataRoot}/users/{u}/organizations/{o}/workspaces/{w}/downloads/`，
 * 不再枚举 legacy `{platformDataRoot}/{org}/spaces/{sp}/downloads/` 残留。
 * 按 workspace/space 聚合。
 */
function buildAgentSandboxDownloadsBucket(): StorageBucket {
  async function listSpaceDownloads(): Promise<
    Array<{ organizationId: string; spaceId: string; bytes: number; itemCount: number; fullPath: string }>
  > {
    const out: Array<{ organizationId: string; spaceId: string; bytes: number; itemCount: number; fullPath: string }> = []
    const seen = new Set<string>()

    const pushEntry = async (
      organizationId: string,
      spaceId: string,
      dlDir: string,
    ): Promise<void> => {
      if (!existsSync(dlDir) || seen.has(dlDir)) return
      const { bytes, itemCount } = await dirSize(dlDir)
      if (itemCount === 0 && bytes === 0) return
      seen.add(dlDir)
      out.push({ organizationId, spaceId, bytes, itemCount, fullPath: dlDir })
    }

    // 新布局
    const dataRoot = resolveDataRoot()
    const usersRoot = join(dataRoot, 'users')
    if (existsSync(usersRoot)) {
      let userDirs: Array<{ name: string; isDirectory: () => boolean }>
      try {
        userDirs = await readdir(usersRoot, { withFileTypes: true })
      } catch {
        userDirs = []
      }
      for (const userEnt of userDirs) {
        if (!userEnt.isDirectory()) continue
        const orgsRoot = join(usersRoot, userEnt.name, 'organizations')
        let orgDirs: Array<{ name: string; isDirectory: () => boolean }>
        try {
          orgDirs = await readdir(orgsRoot, { withFileTypes: true })
        } catch {
          continue
        }
        for (const orgEnt of orgDirs) {
          if (!orgEnt.isDirectory()) continue
          const workspacesParent = join(orgsRoot, orgEnt.name, 'workspaces')
          let workspaceDirs: Array<{ name: string; isDirectory: () => boolean }>
          try {
            workspaceDirs = await readdir(workspacesParent, { withFileTypes: true })
          } catch {
            continue
          }
          for (const wsEnt of workspaceDirs) {
            if (!wsEnt.isDirectory()) continue
            const dlDir = resolveWorkspaceDownloadsDir(
              dataRoot,
              userEnt.name,
              orgEnt.name,
              wsEnt.name,
            )
            await pushEntry(orgEnt.name, wsEnt.name, dlDir)
          }
        }
      }
    }

    return out
  }

  return {
    id: 'download:agent-sandbox-downloads',
    category: 'data',
    group: 'media',
    displayName: 'Agent 沙箱下载',
    description:
      'Agent 工具（视频下载 / 资源抓取等）在各 Space 沙箱内保存的本地文件。按 Space 分组。',
    warnings: [
      '清理会永久删除选中 Space 下所有本地下载文件',
      'Agent 后续若引用已删文件会报错，需要时 Agent 会重新触发下载',
      '建议按 Space 选择性清理，保留活跃 Space 的工作产物',
    ],
    requiresConfirmation: 'soft',
    sizeFn: async () => {
      const entries = await listSpaceDownloads()
      return {
        bytes: entries.reduce((s, e) => s + e.bytes, 0),
        itemCount: entries.length,
      }
    },
    listFn: async () => {
      const entries = await listSpaceDownloads()
      return entries.map((e) => ({
        id: e.spaceId,
        label: `Space ${e.spaceId.slice(0, 8)}（${e.itemCount} 个文件）`,
        bytes: e.bytes,
        metadata: { spaceId: e.spaceId, fullPath: e.fullPath, itemCount: e.itemCount },
      }))
    },
    clearFn: async (options) => {
      const entries = await listSpaceDownloads()
      const target =
        options?.itemIds && options.itemIds.length > 0
          ? entries.filter((e) => options.itemIds!.includes(e.spaceId))
          : entries
      if (options?.dryRun) {
        return {
          clearedItemCount: target.length,
          freedBytes: target.reduce((s, e) => s + e.bytes, 0),
        }
      }
      const errors: string[] = []
      let cleared = 0
      let freed = 0
      for (const e of target) {
        // rm 目录内容但保留目录本身——避免下次 Agent 写入时找不到目录
        let innerEntries: Array<{ name: string; isFile: () => boolean; isDirectory: () => boolean }>
        try {
          innerEntries = await readdir(e.fullPath, { withFileTypes: true })
        } catch {
          errors.push(`${e.spaceId}: 无法读取目录`)
          continue
        }
        let spaceCleared = 0
        let spaceFreed = 0
        for (const inner of innerEntries) {
          const full = join(e.fullPath, inner.name)
          // 先 stat 拿到实际大小（含子目录递归），再 rm，保证 freedBytes 精确
          let itemBytes = 0
          try {
            if (inner.isDirectory()) {
              const sub = await dirSize(full)
              itemBytes = sub.bytes
            } else if (inner.isFile()) {
              const st = await stat(full)
              itemBytes = st.size
            }
          } catch {
            // 读不到 size 的条目，rm 成功时 freed 只记录 0
          }
          const r = rmSafe(full)
          if (r.removed) {
            spaceCleared += 1
            spaceFreed += itemBytes
          } else if (r.error) {
            errors.push(`${e.spaceId}/${inner.name}: ${r.error}`)
          }
        }
        if (spaceCleared > 0) {
          cleared += 1
          freed += spaceFreed
        }
      }
      return {
        clearedItemCount: cleared,
        freedBytes: freed,
        ...(errors.length ? { errors } : {}),
      }
    },
  }
}

// ── 注册入口 ───────────────────────────────────────────────

let _registered = false
const _offs: Array<() => void> = []

/**
 * 注册 7 个 media / download bucket（main-process 侧）。
 * `oss:pending-confirms` 在 renderer 端的 oss-direct-uploader 顶部自注册，
 * 本函数不处理。
 */
export function registerMediaStorageBuckets(): Array<() => void> {
  if (_registered) {
    logger.debug(TAG, 'media storage buckets 已注册，跳过')
    return _offs.slice()
  }

  const specs: StorageBucket[] = [
    buildTabVideoRenderTmpBucket(),
    buildStreamDownloadTmpBucket(),
    buildDataDirBucket({
      id: 'media:recordings',
      group: 'media',
      displayName: '浏览器录屏',
      description:
        '浏览器内嵌视图的录屏文件（MP4 / WebM）。永久保留，无自动清理。',
      warnings: [
        '清理会永久删除所有录屏文件',
        '录屏文件可能仍在 Agent 对话或视频剪辑项目中被引用',
      ],
      getDir: () => getUserDataPath('recordings'),
      filenameFilter: (n) => /\.(mp4|webm|mov)$/i.test(n),
    }),
    buildDataDirBucket({
      id: 'media:screenshots',
      group: 'media',
      displayName: '截图',
      description:
        '~/.tabtin/screenshots/ 下的截图文件（PNG / JPG），包含自动截图与用户主动截图。',
      warnings: [
        '清理会永久删除所有截图文件',
        '截图文件可能仍在 Agent 对话中被引用',
      ],
      getDir: () => getHomeTabtinPath('screenshots'),
      filenameFilter: (n) => /\.(png|jpe?g)$/i.test(n),
    }),
    buildDataDirBucket({
      id: 'media:exports-pdf',
      group: 'media',
      displayName: 'PDF 导出',
      description: '~/.tabtin/exports/ 下的 PDF 导出文件。',
      warnings: ['清理会永久删除所有 PDF 导出文件'],
      getDir: () => getHomeTabtinPath('exports'),
      filenameFilter: (n) => /\.pdf$/i.test(n),
    }),
    buildUserDownloadsBucket(),
    buildAgentSandboxDownloadsBucket(),
  ]

  for (const spec of specs) {
    try {
      _offs.push(registerStorageBucket(spec))
      logger.debug(TAG, `bucket registered: ${spec.id}`)
    } catch (err) {
      logger.warn(TAG, `bucket registration skipped (${spec.id}):`, err)
    }
  }

  _registered = true
  return _offs.slice()
}

/** 仅供测试 / HMR 使用的反注册。 */
export function unregisterMediaStorageBuckets(): void {
  while (_offs.length > 0) {
    const off = _offs.pop()
    try {
      off?.()
    } catch {
      /* swallow */
    }
  }
  _registered = false
}

// ── 仅供测试导出的 helper ────────────────────────────────────

/** @internal 只给单元测试用 */
export const __internals = {
  TABVIDEO_TMP_PREFIXES,
  listTmpByPrefix,
  dirSize,
  classifyDownloadSource,
  readDownloadHistory,
} as const
