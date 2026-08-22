/**
 * BrowserStorageBucketRegistration — 把浏览器内嵌相关的本地存储登记到 storage-manager。
 *
 * 背景（W2.2 G3，browser / cache 分组）：
 *   Electron 为每个内嵌 BrowserView 创建 `userData/Partitions/<safe-name>/` 目录，
 *   承载 cookies / localStorage / IndexedDB / ServiceWorker / HTTP+GPU+Code Cache。
 *   当前有 5 类命名：
 *     - `persist:tabtin:env:{default|hex32}`  —— 业务身份隔离 env（data）
 *     - `persist:task-{taskId}`                —— `forCrawl(_, isolated)` 产物（data）
 *     - `persist:tabtin:upgrade:transient` / 老的 `tabtin:upgrade:{ts}`
 *                                              —— access-strategy-upgrade 临时环境（cache）
 *     - `persist:tabtin:crawlspace:{id}`       —— 2026-05 退役，老用户磁盘残留（semi-cache）
 *     - 各 partition 内的 HTTP/GPU/Code Cache  —— 聚合展示（cache）
 *
 * 本模块把上述五类 + renderer 两个 localStorage bucket（bookmarks / browsing-history）
 * 统一登记到 `@tabtin/storage-manager`，让「存储管理」UI 能按 partition 家族
 * 分组展示。
 *
 * ## 设计约束
 *
 * 1. **只改 main 进程视角**：
 *    - browser:env-partitions / browser:task-partitions / browser:upgrade-partitions /
 *      browser:legacy-crawlspace-partitions / browser:http-cache-aggregate
 *      都扫 `userData/Partitions/` 下的子目录，**不拿登录用户名或路径 SSoT
 *      之外的决议**。
 *    - bookmarks / browsing-history 的 bucket 注册在 renderer 端 store
 *      模块顶部（见 `useBookmarkStore.ts` / `useBrowsingHistoryStore.ts`），
 *      本模块不处理。
 *
 * 2. **partition safe-name 规则**：
 *    Electron / Chromium 把 partition 名里的非字母数字字符替换为 `_XX`
 *    （XX 是两位 hex）。`:` → `_3a`。这是 `TemplateURLPrepopulatedDataUtilBase`
 *    的 `GenerateFileName` 规则。我们反向扫目录名时只要识别前缀即可。
 *
 * 3. **清理语义**：
 *    - **env**（data）：clearFn 调 `session.fromPartition(name).clearStorageData()`
 *      清 cookies/localStorage/IndexedDB/ServiceWorker，**不 rm 整个目录**
 *      —— env 还要被继续使用，目录删了 Chromium 下次再写时会重建但有时会
 *      导致 page 挂载异常。另外 env 背后的 cookies 是业务身份，**误清会让
 *      用户所有嵌入站点重新登录**，warnings 里明说。
 *    - **task / upgrade / legacy-crawlspace**（可清类）：
 *      clearFn 先调 `session.fromPartition(name).clearStorageData()`，
 *      再 rm 整个 Partitions/<safe-name>/ 子目录（对应 partition 不会再被业
 *      务创建，直接删目录更彻底）。
 *    - **http-cache-aggregate**（cache，最弱）：聚合所有 partition 的
 *      `Cache/` `GPUCache/` `Code Cache/` `Service Worker/CacheStorage` 容量，
 *      clearFn 对每个 partition 调 `session.clearCache()`。
 *
 * 4. **路径决议**：
 *    所有 userData 路径通过 `@tabtin/shared/storage-paths` 的 `getUserDataPath`
 *    决议（W1.2 SSoT）。startup-services 在 app.whenReady() 后会调用
 *    `setUserDataOverride(app.getPath('userData'))`，确保所有模块共享同一根。
 *
 * 5. **幂等**：本模块暴露 `registerBrowserStorageBuckets` / `unregisterBrowserStorageBuckets`，
 *    startup-services 启动期调一次；HMR / 单测通过 `__resetForTesting`
 *    先清 registry 再调。
 */

import { session } from 'electron'
import { existsSync, rmSync } from 'node:fs'
import { stat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  registerStorageBucket,
  type BucketSize,
  type ClearOptions,
  type ClearResult,
  type StorageBucket,
} from '@tabtin/storage-manager'
import { getUserDataPath } from '@tabtin/shared/storage-paths'

import { logger } from '../utils/logger'

const TAG = 'BrowserStorageBucketRegistration'

// ── partition safe-name helper ───────────────────────────────

/**
 * Partition safe-name 前缀匹配表。
 * 对应调研报告 A2 §2.2 的 7 类命名。
 *
 *   key          — bucket id 语义
 *   safePrefix   — userData/Partitions/ 下目录名实际前缀（含 `_3a` 等编码）
 *   partitionFn  — 给定目录名反向算出原始 partition 名（传给 session.fromPartition）
 */
interface PartitionFamily {
  readonly key: 'env' | 'task' | 'upgrade' | 'legacy-crawlspace' | 'persist-tin'
  readonly safePrefixes: readonly string[]
  readonly partitionFor: (safeName: string) => string
}

function safeToPartition(safeName: string): string {
  // `_XX` hex → 原字符；`_3a` → `:`；其他常见 ESCAPE 已经足够覆盖 partition 字符。
  return safeName.replace(/_([0-9a-fA-F]{2})/g, (_m, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  )
}

const PARTITION_FAMILIES: readonly PartitionFamily[] = [
  // tabtin:env:default / tabtin:env:{hex32}
  // 目录名：persist_3atabtin_3aenv_3a{...}（默认 env 带 persist 前缀）
  {
    key: 'env',
    safePrefixes: ['persist_3atabtin_3aenv_3a'],
    partitionFor: (safe) => safeToPartition(safe),
  },
  // task-{taskId}：持久 partition（forCrawl isolated=true）
  {
    key: 'task',
    safePrefixes: ['persist_3atask-', 'task-'],
    partitionFor: (safe) => safeToPartition(safe),
  },
  // tabtin:upgrade:* —— W1.3 修后复用 persist:tabtin:upgrade:transient，
  // 老用户磁盘可能仍有 tabtin_3aupgrade_3a{ts} 或 persist_3atabtin_3aupgrade_3a*
  {
    key: 'upgrade',
    safePrefixes: ['persist_3atabtin_3aupgrade_3a', 'tabtin_3aupgrade_3a'],
    partitionFor: (safe) => safeToPartition(safe),
  },
  // 2026-05 退役：老用户磁盘上的 tabtin:crawlspace:{id} 孤儿
  {
    key: 'legacy-crawlspace',
    safePrefixes: ['tabtin_3acrawlspace_3a', 'persist_3atabtin_3acrawlspace_3a'],
    partitionFor: (safe) => safeToPartition(safe),
  },
  // Tin sandbox persist:tin-{instanceId} —— 只用于 HTTP cache 聚合，不单独成 bucket
  {
    key: 'persist-tin',
    safePrefixes: ['persist_3atin-'],
    partitionFor: (safe) => safeToPartition(safe),
  },
] as const

/**
 * 返回 `userData/Partitions/` 绝对路径。
 * 通过 W1.2 storage-paths SSoT 决议——`setUserDataOverride` 必须在启动期
 * 已被调用（`startup-services.initializeStartupServices` 顶部完成）。
 */
function getPartitionsRoot(): string {
  return getUserDataPath('Partitions')
}

/**
 * 列出 userData/Partitions/ 下符合某家族前缀的子目录。
 * 返回 [{ safeName, partition, fullPath }, ...]，按目录 mtime 最新优先。
 */
async function listFamilyPartitions(
  family: PartitionFamily,
): Promise<Array<{ safeName: string; partition: string; fullPath: string }>> {
  const root = getPartitionsRoot()
  if (!existsSync(root)) return []

  let entries: Array<{ name: string; isDirectory: () => boolean }>
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }

  const hits: Array<{ safeName: string; partition: string; fullPath: string }> = []
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const name = ent.name
    if (!family.safePrefixes.some((p) => name.startsWith(p))) continue
    hits.push({
      safeName: name,
      partition: family.partitionFor(name),
      fullPath: join(root, name),
    })
  }
  return hits
}

/**
 * 列出 userData/Partitions/ 下所有 persist:* / task-* / tabtin:* 的目录，
 * http-cache 聚合用（不限家族）。
 */
async function listAllKnownPartitions(): Promise<
  Array<{ safeName: string; partition: string; fullPath: string }>
> {
  const out: Array<{ safeName: string; partition: string; fullPath: string }> = []
  for (const family of PARTITION_FAMILIES) {
    out.push(...(await listFamilyPartitions(family)))
  }
  return out
}

/**
 * Chromium 在每个 partition 下创建的 **cache 子目录名**。
 * 聚合 http-cache bucket 会单独统计这些，所以 env / task / upgrade / legacy
 * 等 family 的"整 partition du"必须排除这些子目录，避免 UI 容量加总双计。
 */
const CACHE_SUBDIR_NAMES: ReadonlySet<string> = new Set([
  'Cache',
  'GPUCache',
  'Code Cache',
  // Service Worker 下含 CacheStorage + ScriptCache + Database，统一按目录维度排除
  'Service Worker',
])

/**
 * 递归统计目录大小 + 文件数（跳不读的子项）。
 * 不跟随 symlink。
 *
 * @param opts.excludeNames 顶层跳过的目录/文件名（不递归进入）——"顶层"指
 *   最初传入 `dir` 下直接的一层子项；递归进入子目录后不再过滤（避免把深
 *   层一个恰好叫 `Cache` 的用户文件误漏）。
 */
async function dirSize(
  dir: string,
  opts?: { excludeNames?: ReadonlySet<string> },
): Promise<{ bytes: number; itemCount: number }> {
  return _dirSizeImpl(dir, opts?.excludeNames, true)
}

async function _dirSizeImpl(
  dir: string,
  excludeNames: ReadonlySet<string> | undefined,
  isTopLevel: boolean,
): Promise<{ bytes: number; itemCount: number }> {
  let bytes = 0
  let itemCount = 0
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return { bytes: 0, itemCount: 0 }
  }
  for (const ent of entries) {
    if (isTopLevel && excludeNames && excludeNames.has(ent.name)) continue
    const full = join(dir, ent.name)
    try {
      if (ent.isDirectory()) {
        const sub = await _dirSizeImpl(full, excludeNames, false)
        bytes += sub.bytes
        itemCount += sub.itemCount
      } else if (ent.isFile()) {
        const st = await stat(full)
        bytes += st.size
        itemCount += 1
      }
    } catch {
      // best-effort
    }
  }
  return { bytes, itemCount }
}

/**
 * 聚合给定家族下所有 partition 的容量 + 数量。
 *
 * **双计避免策略**（与 `browser:http-cache-aggregate` 配合）：
 *   - `env` family（clearFn 只清 data 不 rm 目录）→ du 排除 cache 子目录，
 *     cache 部分归 `browser:http-cache-aggregate` 统计。
 *   - `task` / `upgrade` / `legacy-crawlspace` family（clearFn rm 整目录）
 *     → du **包含** cache 子目录，因为清理释放的确实是整目录大小；
 *     `browser:http-cache-aggregate` 则反过来**排除**这些 family，
 *     避免双计。
 */
async function aggregateFamilySize(
  family: PartitionFamily,
): Promise<{
  bytes: number
  itemCount: number
  partitions: Array<{ safeName: string; partition: string; bytes: number; fullPath: string }>
}> {
  // env 的 clearFn 不 rm 目录，cache 不算进 env 的 sizeFn
  // task / upgrade / legacy-crawlspace 的 clearFn 整目录 rm，cache 算进 sizeFn
  const excludeNames = family.key === 'env' ? CACHE_SUBDIR_NAMES : undefined

  const hits = await listFamilyPartitions(family)
  const partitions: Array<{
    safeName: string
    partition: string
    bytes: number
    fullPath: string
  }> = []
  let totalBytes = 0
  for (const hit of hits) {
    const { bytes } = await dirSize(hit.fullPath, excludeNames ? { excludeNames } : undefined)
    partitions.push({ ...hit, bytes })
    totalBytes += bytes
  }
  return { bytes: totalBytes, itemCount: hits.length, partitions }
}

/**
 * 给 partition 清空 cookies/localStorage/IndexedDB/ServiceWorker 等 data 类存储。
 * 不包含 HTTP cache（那个由 http-cache-aggregate bucket 负责）。
 */
async function clearPartitionStorageData(partition: string): Promise<void> {
  try {
    const ses = session.fromPartition(partition)
    await ses.clearStorageData({
      storages: [
        'cookies',
        'localstorage',
        'indexdb',
        'serviceworkers',
        'cachestorage',
        'websql',
      ],
    })
  } catch (err) {
    logger.warn(TAG, `clearStorageData("${partition}") 失败:`, err)
    throw err
  }
}

/**
 * 给 partition 只清 HTTP cache。
 */
async function clearPartitionHttpCache(partition: string): Promise<void> {
  try {
    const ses = session.fromPartition(partition)
    await ses.clearCache()
  } catch (err) {
    logger.warn(TAG, `clearCache("${partition}") 失败:`, err)
    throw err
  }
}

/**
 * rm -rf 整个 partition 目录。只用于 task/upgrade/legacy-crawlspace
 * ——env / persist-tin 不走此路径。
 */
function rmPartitionDir(fullPath: string): { removed: boolean; error?: string } {
  try {
    rmSync(fullPath, { recursive: true, force: true })
    return { removed: true }
  } catch (err) {
    return { removed: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ── bucket 构造器 ────────────────────────────────────────────

/**
 * 构造 env partitions bucket（data 类）。
 */
function buildEnvPartitionsBucket(): StorageBucket {
  const family = PARTITION_FAMILIES.find((f) => f.key === 'env')!
  return {
    id: 'browser:env-partitions',
    category: 'data',
    group: 'browser',
    displayName: '浏览器环境数据',
    description:
      '每个业务环境（默认与用户新建）独立保存飞书 / Notion / ChatGPT 等嵌入站点的登录态和本地数据。',
    warnings: [
      '清理后嵌入站点（飞书 / Notion / ChatGPT 等）都需要重新输入密码 / 扫码登录',
      '书签与浏览历史不在此范围（有各自独立的清理入口）',
      '可在子项里按单个环境选择性清理，避免一次性清掉所有账号',
    ],
    requiresConfirmation: 'hard',
    sizeFn: async () => {
      const { bytes, itemCount } = await aggregateFamilySize(family)
      return { bytes, itemCount }
    },
    listFn: async () => {
      const { partitions } = await aggregateFamilySize(family)
      return partitions.map((p) => ({
        id: p.safeName,
        label: p.partition,
        bytes: p.bytes,
        metadata: { partition: p.partition, safeName: p.safeName },
      }))
    },
    clearFn: async (options) => {
      const { bytes, itemCount, partitions } = await aggregateFamilySize(family)
      if (options?.dryRun) {
        if (options.itemIds?.length) {
          const idSet = new Set(options.itemIds)
          const picked = partitions.filter((p) => idSet.has(p.safeName))
          return {
            clearedItemCount: picked.length,
            freedBytes: picked.reduce((s, p) => s + p.bytes, 0),
          }
        }
        return { clearedItemCount: itemCount, freedBytes: bytes }
      }
      const target =
        options?.itemIds && options.itemIds.length > 0
          ? partitions.filter((p) => options.itemIds!.includes(p.safeName))
          : partitions
      const errors: string[] = []
      let cleared = 0
      let freed = 0
      for (const p of target) {
        try {
          await clearPartitionStorageData(p.partition)
          cleared += 1
          freed += p.bytes
        } catch (err) {
          errors.push(`${p.partition}: ${err instanceof Error ? err.message : String(err)}`)
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
 * 构造 task / upgrade / legacy-crawlspace 共用的清理型 bucket。
 * 共同特征：partition 本身将来不再被业务使用，可以整目录 rm。
 */
function buildDiscardablePartitionBucket(params: {
  id: string
  family: PartitionFamily
  displayName: string
  description: string
  category: 'data' | 'semi-cache' | 'cache'
  warnings: string[]
}): StorageBucket {
  const { id, family, displayName, description, category, warnings } = params
  return {
    id,
    category,
    group: 'browser',
    displayName,
    description,
    warnings: warnings.length > 0 ? warnings : undefined,
    requiresConfirmation:
      category === 'data' ? 'hard' : category === 'semi-cache' ? 'soft' : 'none',
    sizeFn: async () => {
      const { bytes, itemCount } = await aggregateFamilySize(family)
      return { bytes, itemCount }
    },
    listFn: async () => {
      const { partitions } = await aggregateFamilySize(family)
      return partitions.map((p) => ({
        id: p.safeName,
        label: p.partition,
        bytes: p.bytes,
        metadata: { partition: p.partition, safeName: p.safeName, fullPath: p.fullPath },
      }))
    },
    clearFn: async (options) => {
      const { bytes, itemCount, partitions } = await aggregateFamilySize(family)
      if (options?.dryRun) {
        if (options.itemIds?.length) {
          const idSet = new Set(options.itemIds)
          const picked = partitions.filter((p) => idSet.has(p.safeName))
          return {
            clearedItemCount: picked.length,
            freedBytes: picked.reduce((s, p) => s + p.bytes, 0),
          }
        }
        return { clearedItemCount: itemCount, freedBytes: bytes }
      }
      const target =
        options?.itemIds && options.itemIds.length > 0
          ? partitions.filter((p) => options.itemIds!.includes(p.safeName))
          : partitions
      const errors: string[] = []
      let cleared = 0
      let freed = 0
      for (const p of target) {
        // 先清 session storage（释放 Chromium 内部句柄），再 rm 目录
        try {
          await clearPartitionStorageData(p.partition)
        } catch {
          // clearStorageData 失败不阻断 rm —— 目录删掉 Chromium 下次再
          // 访问该 partition 会重建空目录，不影响正确性。
        }
        const r = rmPartitionDir(p.fullPath)
        if (r.removed) {
          cleared += 1
          freed += p.bytes
        } else if (r.error) {
          errors.push(`${p.partition}: ${r.error}`)
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
 * 构造 http-cache-aggregate bucket（cache 类）。
 *
 * **聚合范围**（避免与 env / task / upgrade / legacy / 主窗口 bucket 双计）：
 *   - env family：每个 env partition 的 Cache/GPUCache/Code Cache/Service Worker
 *     子目录 —— 因为 env family 的 sizeFn 在 du 时排除了这些子目录
 *   - persist-tin family 的同类 cache 子目录 —— tin-sandbox 卸载时会级联清，
 *     这里只做"展示 cache 占用"
 *   - 注意：**不包含**主进程默认 session（主窗口 / chat-window 自己的 cache）
 *     —— 那是 App 自身的 UI 资源缓存，清掉会让首屏慢几秒。不主动清它。
 *   - 注意：**不包含** task / upgrade / legacy-crawlspace 的 cache，
 *     因为它们归各自 family bucket（整目录 rm），避免双计
 */
function buildHttpCacheAggregateBucket(): StorageBucket {
  const CACHE_SUBDIRS = [
    'Cache',
    'GPUCache',
    'Code Cache',
    'Service Worker/CacheStorage',
    'Service Worker/ScriptCache',
  ] as const

  const AGGREGATED_FAMILY_KEYS: readonly PartitionFamily['key'][] = [
    'env',
    'persist-tin',
  ]

  async function aggregateCacheSize(): Promise<{
    bytes: number
    partitions: Array<{ safeName: string; partition: string; bytes: number }>
  }> {
    let totalBytes = 0
    const partitions: Array<{ safeName: string; partition: string; bytes: number }> = []

    for (const familyKey of AGGREGATED_FAMILY_KEYS) {
      const family = PARTITION_FAMILIES.find((f) => f.key === familyKey)
      if (!family) continue
      const hits = await listFamilyPartitions(family)
      for (const p of hits) {
        let subBytes = 0
        for (const sub of CACHE_SUBDIRS) {
          const full = join(p.fullPath, sub)
          if (existsSync(full)) {
            const { bytes } = await dirSize(full)
            subBytes += bytes
          }
        }
        if (subBytes > 0) {
          partitions.push({ safeName: p.safeName, partition: p.partition, bytes: subBytes })
          totalBytes += subBytes
        }
      }
    }
    return { bytes: totalBytes, partitions }
  }

  return {
    id: 'browser:http-cache-aggregate',
    category: 'cache',
    group: 'cache',
    displayName: '浏览器嵌入站点缓存',
    description:
      '飞书 / Notion / ChatGPT 等嵌入站点的图片 / 脚本 / 字体缓存。清掉这些站点下次首屏会慢几秒，几秒后自动重建。不影响 TabTin 主窗口。',
    requiresConfirmation: 'none',
    sizeFn: async (): Promise<BucketSize> => {
      const { bytes, partitions } = await aggregateCacheSize()
      return { bytes, itemCount: partitions.length }
    },
    listFn: async () => {
      const { partitions } = await aggregateCacheSize()
      return partitions.map((p) => ({
        id: p.safeName,
        label: p.partition,
        bytes: p.bytes,
        metadata: { partition: p.partition, safeName: p.safeName },
      }))
    },
    clearFn: async (options: ClearOptions | undefined): Promise<ClearResult> => {
      const { bytes, partitions } = await aggregateCacheSize()
      if (options?.dryRun) {
        return { clearedItemCount: partitions.length, freedBytes: bytes }
      }
      const errors: string[] = []
      let cleared = 0
      let freed = 0
      for (const p of partitions) {
        try {
          await clearPartitionHttpCache(p.partition)
          cleared += 1
          freed += p.bytes
        } catch (err) {
          errors.push(`${p.partition}: ${err instanceof Error ? err.message : String(err)}`)
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
 * 注册浏览器相关的 5 个 bucket（browser / cache 分组的 main-process 侧）。
 * renderer 的 2 个 bucket（bookmarks / browsing-history）在各自 store
 * 模块顶部自注册，本函数不处理。
 *
 * @returns unregister 函数数组
 */
export function registerBrowserStorageBuckets(): Array<() => void> {
  if (_registered) {
    logger.debug(TAG, 'browser storage buckets 已注册，跳过')
    return _offs.slice()
  }

  const specs: StorageBucket[] = [
    buildEnvPartitionsBucket(),
    buildDiscardablePartitionBucket({
      id: 'browser:task-partitions',
      family: PARTITION_FAMILIES.find((f) => f.key === 'task')!,
      displayName: '爬取任务数据',
      description:
        '独立爬取任务各自使用的本地数据与缓存目录。任务完成后不会自动清理。',
      category: 'data',
      warnings: [
        '清理会丢失该任务执行期间累积的登录态与本地数据',
        '如任务仍在运行，清理可能导致该任务流程异常',
      ],
    }),
    buildDiscardablePartitionBucket({
      id: 'browser:upgrade-partitions',
      family: PARTITION_FAMILIES.find((f) => f.key === 'upgrade')!,
      displayName: '访问受限升级残留',
      description:
        '旧版"访问受限站点升级"流程在磁盘上留下的一次性目录，不影响功能。建议清理。',
      category: 'cache',
      warnings: [],
    }),
    buildDiscardablePartitionBucket({
      id: 'browser:legacy-crawlspace-partitions',
      family: PARTITION_FAMILIES.find((f) => f.key === 'legacy-crawlspace')!,
      displayName: '历史浏览环境残留',
      description:
        '2026-05 之前版本的浏览器环境数据目录，当前版本已不再使用。清掉不影响现有功能。',
      category: 'semi-cache',
      warnings: ['这些是历史版本的浏览器环境残留，清掉不影响当前功能'],
    }),
    buildHttpCacheAggregateBucket(),
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

/**
 * 仅供测试 / HMR 使用的反注册。
 */
export function unregisterBrowserStorageBuckets(): void {
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
  safeToPartition,
  PARTITION_FAMILIES,
  listFamilyPartitions,
  dirSize,
} as const
