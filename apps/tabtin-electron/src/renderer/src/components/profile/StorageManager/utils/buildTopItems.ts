/**
 * buildTopItems — 把所有 bucket 聚合成"用户能识别的数据类型" Top 列表（v3）。
 *
 * # 设计的演化
 *
 * v1（老 YourDataSection）：5 大用户分组横向并列，全部折叠，0 B 也显示 → 臃肿
 * v2（本文件第一版）：按 Workspace（工作区）/ env（环境）/ 项目 / 文件横向切，每一项独立成行 → 碎片化、暴露 UUID（通用唯一标识符）
 * v3（当前）：按"数据类型"纵向切，每行 1 类，点开行内展开看工作区 / 环境 / 文件细分
 *
 * # v3 设计原则（从 v2 翻车里学到的）
 *
 *   1. **顶层粒度 = 数据类型**，不是工作区。用户的心智模型是"我有多少对话"
 *      "我有多少录屏"，不是"我在某个工作区有多少东西"。工作区名称经常不直观
 *      （如 "19jcg30n" "midscene"），按工作区拆首屏会有 10+ 行。
 *
 *   2. **细分作为可选下钻**。每个数据类型 TopItem 携带 `drillItems` 字段，
 *      行可展开看该类型下按工作区 / 环境 / 文件的拆分。
 *
 *   3. **UUID 不进顶层**。spaceNameMap join 不到的项合并到 drillItems 里的
 *      「其他」一行，避免裸 UUID 暴露。
 *
 *   4. **0 B 自动隐藏**。bytes=0 且 itemCount=0 的不出现。
 *
 *   5. **媒体按文件夹分**（录屏 / 截图 / PDF 各一行），不合并——它们体量差异
 *      大、是用户独立感知的资产，合并反而模糊。
 *
 *   6. **临时缓存合并成 ONE 行**，一键清。
 *
 * # 与 i18n 的解耦
 *
 * label / subtitle 这里已经 t() 过的字面量，调用方传 t 进来。
 */

import type { TFunction } from 'i18next'
import type {
  BucketDescriptor,
  BucketItem,
  BucketSizeReport,
  ListItemsHandler,
} from '../components/types'
import { resolveAffordanceLevel, type AffordanceLevel } from '../components/types'
import {
  isUserVisibleAsset,
  resolveBucketDescription,
  resolveBucketDisplayName,
} from '../display-overrides'

/** 顶层数据类型 */
export type TopItemKind =
  | 'conversation-bundle' // 对话历史（仅 conversation 类，单位 = Workspace）
  | 'checkpoint-bundle' // 项目操作快照（仅 checkpoint 类，单位 = git 项目目录）
  | 'browser-env-bundle' // 浏览器登录环境（合 env-partitions 等）
  | 'media-folder' // 录屏 / 截图 / PDF / 下载（每个独立一行）
  | 'agent-download' // Agent 工具下载（合 sandbox-downloads）
  | 'app-bundle' // 已安装应用（合 marketplace + sandboxes + mcp）
  | 'app-project' // 业务 app 的用户项目（TabVideo 项目 / TabDoc 草稿）
  | 'browser-asset' // 书签 / 浏览历史 / 下载记录
  | 'voice-settings' // Voice 热词
  | 'cache-bundle' // 临时缓存合集

/** 下钻行——TopItem 展开后渲染 */
export interface StorageDrillItem {
  id: string
  /** 显示标签——优先用户能识别的名字（工作区名 / 环境名 / 文件名 / 项目名） */
  label: string
  /** 字节数 */
  bytes: number
  /** 条目数（如果有意义） */
  itemCount?: number
  /** 涉及 bucket id 集合——清理时按 bucket 分组依次 onClear */
  bucketIds: string[]
  /** 聚合的子项 ref 列表——清理时按 bucket 分组传 itemIds */
  itemRefs?: Array<{ bucketId: string; itemId: string }>
  /** 是否可清——某些下钻项可能只读 */
  canClear: boolean
  /** Affordance level */
  confirmationLevel: AffordanceLevel
}

/** Top 列表的一行 */
export interface StorageTopItem {
  id: string
  kind: TopItemKind
  /** 主标签——数据类型名，如 "对话与操作记录" / "浏览器登录环境" / "录屏" */
  label: string
  /** 副标——一句话解释，如 "{N} 个工作区 · 自 X 月起" */
  subtitle?: string
  bytes: number
  itemCount?: number
  bucketIds: string[]
  /** 是否可清（整行清——缓存组合 / 单存储桶行）；带下钻项的复合行通常不直接清，需展开按工作区单独清理 */
  canClear: boolean
  /** Affordance level */
  confirmationLevel: AffordanceLevel
  /**
   * 下钻细分——点开行后展示。
   * 用于 conversation-bundle / browser-env-bundle / app-bundle 等需要"按 Workspace/env/项目细分"的复合类。
   * 单 bucket 行（media-folder / voice-settings / browser-asset）通常没有下钻或下钻是文件列表。
   */
  drillItems?: StorageDrillItem[]
}

export interface BuildTopItemsResult {
  /** 按 bytes 倒序的 Top N */
  topItems: StorageTopItem[]
  /** 完整列表（用于"查看其余 N 项"折叠区） */
  allItems: StorageTopItem[]
}

export interface BuildTopItemsOptions {
  descriptors: BucketDescriptor[]
  sizeMap: Record<string, BucketSizeReport | undefined>
  onListItems: ListItemsHandler
  /** 历史 spaceId / 当前 workspaceId → 工作区名称的关联表（来自 useSpaceStore） */
  spaceNameMap: Map<string, string>
  /** organizationId → organizationName，用于区分不同组织下的同名项目。 */
  organizationNameMap?: ReadonlyMap<string, string>
  /** 'storage-manager' namespace 的 i18n t 函数 */
  t: TFunction
  /** Top N（默认 6） */
  topN?: number
  /** 下钻列表每类最多展示前 N 项明细（默认 8，其余合到「其他」一行） */
  drillTopN?: number
}

/**
 * 主入口——异步，因为需要调 listFn 拿 metadata 聚合。
 */
export async function buildStorageTopItems(
  opts: BuildTopItemsOptions,
): Promise<BuildTopItemsResult> {
  const {
    descriptors,
    sizeMap,
    onListItems,
    spaceNameMap,
    organizationNameMap = new Map<string, string>(),
    t,
    topN = 6,
    drillTopN = 8,
  } = opts
  const items: StorageTopItem[] = []

  // ── 1a. 对话历史（仅 conversation 类，按工作区聚合）──
  //    单位 = 工作区名称（"小豆子" / "默认工作区"）
  const conversationBuckets = descriptors.filter(
    (d) =>
      d.group === 'conversation' &&
      d.capabilities.canList &&
      isUserVisibleAsset(d),
  )
  const conversationItem = await buildConversationBundle(
    conversationBuckets,
    sizeMap,
    onListItems,
    spaceNameMap,
    t,
    drillTopN,
  )
  if (conversationItem) items.push(conversationItem)

  // ── 1b. 项目操作快照（仅 checkpoint 类，按 git 项目目录聚合）──
  //    单位 = 项目目录名（"midscene" / "TabTinAgent"）
  //    跟对话历史拆开是 v4 关键修复 —— v3 把两者合一导致单位混乱
  const checkpointBuckets = descriptors.filter(
    (d) => d.group === 'checkpoint' && d.capabilities.canList && isUserVisibleAsset(d),
  )
  const checkpointItem = await buildCheckpointBundle(
    checkpointBuckets,
    sizeMap,
    onListItems,
    organizationNameMap,
    t,
    drillTopN,
  )
  if (checkpointItem) items.push(checkpointItem)

  // ── 2. 浏览器登录环境（env-partitions 类全合，按 env 拆细）──
  const browserEnvBuckets = descriptors.filter(
    (d) =>
      d.group === 'browser' &&
      d.capabilities.canList &&
      (d.id.includes('partition') ||
        d.id.includes('env') ||
        d.id.includes('crawlspace') ||
        d.id.includes('http-cache')),
  )
  const envItem = await buildBrowserEnvBundle(
    browserEnvBuckets,
    sizeMap,
    onListItems,
    t,
    drillTopN,
  )
  if (envItem) items.push(envItem)

  // ── 3. 媒体文件——录屏 / 截图 / PDF 各自一行（体量差异大，独立感知）──
  const mediaBuckets = descriptors.filter(
    (d) => d.group === 'media' && d.category !== 'cache' && !d.hideFromList,
  )
  for (const d of mediaBuckets) {
    // download:agent-sandbox-downloads 走单独的 agent-download kind
    if (d.id === 'download:agent-sandbox-downloads') continue
    const top = buildSingleBucketTopItem(d, sizeMap[d.id], 'media-folder', t)
    items.push(top)
  }

  // ── 4. Agent 工具下载（如果有）——按 Space 拆细 ──
  const agentDownloadBucket = descriptors.find(
    (d) => d.id === 'download:agent-sandbox-downloads',
  )
  if (agentDownloadBucket) {
    const item = await buildAgentDownloadBundle(
      agentDownloadBucket,
      sizeMap,
      onListItems,
      spaceNameMap,
      t,
      drillTopN,
    )
    if (item) items.push(item)
  }

  // ── 5. 业务 app 用户项目（TabVideo / TabDoc 等）合并成 ONE「应用项目」？
  //    暂时保留分开——每类应用是独立感知的实体；TabVideo 项目有自己的生命周期
  const appProjectBuckets = descriptors.filter(
    (d) =>
      d.group === 'business-app' &&
      d.category !== 'cache' &&
      d.capabilities.canList &&
      (d.id === 'tabdoc:offline-drafts'),
  )
  for (const d of appProjectBuckets) {
    const item = await buildAppProjectBundle(d, sizeMap, onListItems, t, drillTopN)
    if (item) items.push(item)
  }

  // ── 6. 已安装应用（marketplace + sandboxes + mcp 合并）──
  const appBundleBuckets = descriptors.filter(
    (d) =>
      d.group === 'business-app' &&
      d.category !== 'cache' &&
      isUserVisibleAsset(d) &&
      !appProjectBuckets.includes(d),
  )
  const populatedAppBuckets = appBundleBuckets.filter((d) => {
    const size = sizeMap[d.id]
    return (size?.itemCount ?? 0) > 0 || (size?.itemCount === undefined && (size?.bytes ?? 0) > 0)
  })
  if (populatedAppBuckets.length > 0) {
    const totalBytes = populatedAppBuckets.reduce(
      (sum, d) => sum + (sizeMap[d.id]?.bytes ?? 0),
      0,
    )
    if (totalBytes > 0) {
      const drillItems: StorageDrillItem[] = populatedAppBuckets
        .map((d) => {
          const size = sizeMap[d.id]
          return {
            id: d.id,
            label: resolveBucketDisplayName(d, t),
            bytes: size?.bytes ?? 0,
            itemCount: size?.itemCount,
            bucketIds: [d.id],
            canClear: d.capabilities.canClear,
            confirmationLevel: resolveAffordanceLevel(d),
          }
        })
        .filter((it) => it.bytes > 0)
        .sort((a, b) => b.bytes - a.bytes)

      const strict = populatedAppBuckets.reduce(
        (max, d) => mostStrictAffordance(max, resolveAffordanceLevel(d)),
        'L1' as AffordanceLevel,
      )

      items.push({
        id: 'bundle::apps',
        kind: 'app-bundle',
        label: t('topItems.appBundle.label', { defaultValue: '已安装应用' }),
        subtitle: t('topItems.appBundle.subtitle', {
          count: populatedAppBuckets.length,
          defaultValue: '{{count}} 类应用本地数据',
        }),
        bytes: totalBytes,
        itemCount: populatedAppBuckets.length,
        bucketIds: populatedAppBuckets.map((d) => d.id),
        canClear: false, // 整体不清，得展开按类清
        confirmationLevel: strict,
        drillItems,
      })
    }
  }

  // ── 7. 浏览器资产（书签 / 浏览历史 / 下载记录）——通常 KB 级，单项展示 ──
  const browserAssetBuckets = descriptors.filter(
    (d) =>
      d.id === 'browser:bookmarks' ||
      d.id === 'browser:browsing-history',
  )
  for (const d of browserAssetBuckets) {
    const item = buildSingleBucketTopItem(d, sizeMap[d.id], 'browser-asset', t)
    items.push(item)
  }

  // ── 8. Voice 热词（D-5 核心资产，即使 hideFromList=true 也要露出）──
  const voiceBuckets = descriptors.filter(
    (d) =>
      d.id === 'voice:hotwords-rules' || d.id === 'system:voice-settings',
  )
  for (const d of voiceBuckets) {
    const item = buildSingleBucketTopItem(d, sizeMap[d.id], 'voice-settings', t)
    items.push(item)
  }

  // ── 9. 临时缓存（所有 cache 类合 ONE）──
  const cacheBuckets = descriptors.filter(
    (d) => d.category === 'cache' && d.capabilities.canClear,
  )
  if (cacheBuckets.length > 0) {
    const cacheBytes = cacheBuckets.reduce(
      (sum, d) => sum + (sizeMap[d.id]?.bytes ?? 0),
      0,
    )
    items.push({
      id: 'cache::bundle',
      kind: 'cache-bundle',
      label: t('topItems.cache.label', { defaultValue: '临时缓存' }),
      subtitle: t('topItems.cache.subtitle', {
        defaultValue: '下次需要时会自动重建',
      }),
      bytes: cacheBytes,
      itemCount: cacheBuckets.length,
      bucketIds: cacheBuckets.map((d) => d.id),
      canClear: true,
      confirmationLevel: 'L1',
    })
  }

  // 过滤掉空项，按 bytes 倒序
  const filtered = items.filter(
    (it) => it.bytes > 0 || (it.itemCount ?? 0) > 0,
  )
  const sorted = filtered.sort((a, b) => b.bytes - a.bytes)

  return {
    topItems: sorted.slice(0, topN),
    allItems: sorted,
  }
}

// ── Bundle 构造函数 ───────────────────────────────────────────────

/**
 * 对话历史——仅 conversation 类（不含 checkpoint），按 workspaceId 聚合到工作区名。
 *
 * 旧数据的 spaceId 仅作兼容回退。workspaceId 始终作为分组身份：名称映射
 * 不到时合到「其他工作区」，避免展示内部 ID；没有工作区 ID 的辅助数据
 * 单独合到「其他对话数据」。
 */
async function buildConversationBundle(
  buckets: BucketDescriptor[],
  sizeMap: Record<string, BucketSizeReport | undefined>,
  onListItems: ListItemsHandler,
  spaceNameMap: Map<string, string>,
  t: TFunction,
  drillTopN: number,
): Promise<StorageTopItem | null> {
  if (buckets.length === 0) return null

  const totalBytes = buckets.reduce(
    (sum, d) => sum + (sizeMap[d.id]?.bytes ?? 0),
    0,
  )
  if (totalBytes === 0) return null

  const listResults = await Promise.all(
    buckets.map(async (d) => {
      try {
        const report = await onListItems(d.id)
        return { descriptor: d, items: report.items }
      } catch (err) {
        console.warn('[buildTopItems] conversation listItems failed:', d.id, err)
        return { descriptor: d, items: [] as BucketItem[] }
      }
    }),
  )

  const otherLabel = t('topItems.conversation.otherLabel', {
    defaultValue: '其他工作区',
  })
  const unscopedLabel = t('topItems.conversation.unscopedLabel', {
    defaultValue: '其他对话数据',
  })
  const otherKey = '__other__'
  const unscopedKey = '__unscoped__'
  const map = new Map<string, DrillAgg>()
  const workspaceIds = new Set<string>()

  for (const { descriptor, items } of listResults) {
    const lvl = resolveAffordanceLevel(descriptor)
    for (const item of items) {
      const meta = item.metadata ?? {}
      const workspaceId = (
        meta.workspaceId
        ?? meta.workspace_id
        ?? meta.spaceId
        ?? meta.space_id
      ) as string | undefined

      let key: string
      let label: string
      let isOther = false

      if (workspaceId) {
        workspaceIds.add(workspaceId)
        const name = spaceNameMap.get(workspaceId)
        if (name && !looksLikeUuid(name)) {
          key = `workspace::${workspaceId}`
          label = name
        } else {
          key = otherKey
          label = otherLabel
          isOther = true
        }
      } else {
        // run-events / pending / archive 等没有 Workspace 维度，不计作工作区。
        key = unscopedKey
        label = unscopedLabel
        isOther = true
      }

      pushAgg(
        map,
        key,
        label,
        isOther,
        item,
        descriptor.id,
        lvl,
        workspaceId !== undefined,
      )
    }
  }

  return finalizeBundle({
    map,
    drillTopN,
    otherLabel,
    bundleId: 'bundle::conversation',
    kind: 'conversation-bundle',
    label: t('topItems.conversation.label', {
      defaultValue: '对话历史',
    }),
    subtitleI18nKey: 'topItems.conversation.subtitle',
    subtitleDefault: '来自 {{count}} 个工作区',
    subtitleCount: workspaceIds.size,
    totalBytes,
    bucketIds: buckets.map((d) => d.id),
    t,
  })
}

/**
 * 项目操作快照——仅 checkpoint 类（不含 conversation），按 cwdHash 聚合到 git 项目目录名。
 *
 * 单位统一 = 项目目录。任何没 projectName / 拿到的看着像 UUID 的，
 * 全部合到「其他项目」drill 行。
 */
async function buildCheckpointBundle(
  buckets: BucketDescriptor[],
  sizeMap: Record<string, BucketSizeReport | undefined>,
  onListItems: ListItemsHandler,
  organizationNameMap: ReadonlyMap<string, string>,
  t: TFunction,
  drillTopN: number,
): Promise<StorageTopItem | null> {
  if (buckets.length === 0) return null

  const totalBytes = buckets.reduce(
    (sum, d) => sum + (sizeMap[d.id]?.bytes ?? 0),
    0,
  )
  if (totalBytes === 0) return null

  const listResults = await Promise.all(
    buckets.map(async (d) => {
      try {
        const report = await onListItems(d.id)
        return { descriptor: d, items: report.items }
      } catch (err) {
        console.warn('[buildTopItems] checkpoint listItems failed:', d.id, err)
        return { descriptor: d, items: [] as BucketItem[] }
      }
    }),
  )

  const otherLabel = t('topItems.checkpoint.otherLabel', {
    defaultValue: '未归属撤销数据',
  })
  const otherKey = '__unassigned_checkpoint_data__'
  const map = new Map<string, DrillAgg>()

  for (const { descriptor, items } of listResults) {
    const lvl = resolveAffordanceLevel(descriptor)
    for (const item of items) {
      const meta = item.metadata ?? {}
      const cwdHash = meta.cwdHash as string | undefined
      const projectId = meta.projectId as string | undefined
      const organizationId = meta.organizationId as string | undefined
      const workspaceId = meta.workspaceId as string | undefined
      const projectName =
        (meta.projectName as string | undefined) ??
        inferProjectNameFromPath(
          (meta.projectPath as string | undefined) ??
          (meta.workspaceRoot as string | undefined),
        )
      const projectPath = (
        (meta.projectPath as string | undefined) ??
        (meta.workspaceRoot as string | undefined)
      )
      // shadow-git 旧数据只有工作目录，file-history 新数据同时有 workspaceId。
      // 用组织内的规范化单根路径作为两种撤销数据的桥接键，避免同一 Workspace 展示两行。
      const projectKey = organizationId && projectPath
        ? `${organizationId}:path:${normalizeProjectPathKey(projectPath)}`
        : organizationId && workspaceId
          ? `${organizationId}:workspace:${workspaceId}`
          : cwdHash ?? projectId ?? item.id

      let key: string
      let label: string
      let isOther = false

      // UUID 兜底：projectName 拿不到 OR 拿到的看着像 UUID → 合「其他」
      if (projectName && !looksLikeUuid(projectName)) {
        key = `project::${projectKey}`
        const organizationName = organizationId
          ? organizationNameMap.get(organizationId)
          : undefined
        label = organizationName
          ? `${projectName} · ${organizationName}`
          : projectName
      } else {
        key = otherKey
        label = otherLabel
        isOther = true
      }

      pushAgg(map, key, label, isOther, item, descriptor.id, lvl, !isOther)
    }
  }

  return finalizeBundle({
    map,
    drillTopN,
    otherLabel,
    bundleId: 'bundle::checkpoint',
    kind: 'checkpoint-bundle',
    label: t('topItems.checkpoint.label', {
      defaultValue: '项目操作快照',
    }),
    subtitleI18nKey: 'topItems.checkpoint.subtitle',
    subtitleDefault: '{{count}} 个项目 · Agent 操作的撤销快照',
    totalBytes,
    bucketIds: buckets.map((d) => d.id),
    countAggregatedItems: true,
    t,
  })
}

// ── conversation/checkpoint bundle 共用的聚合 helper ──────────────

interface DrillAgg {
  key: string
  label: string
  bytes: number
  itemCount: number
  bucketIds: Set<string>
  itemRefs: Array<{ bucketId: string; itemId: string }>
  confirmationLevel: AffordanceLevel
  isOther: boolean
  countsAsUnit: boolean
  unitCount: number
}

function pushAgg(
  map: Map<string, DrillAgg>,
  key: string,
  label: string,
  isOther: boolean,
  item: BucketItem,
  bucketId: string,
  lvl: AffordanceLevel,
  countsAsUnit = true,
): void {
  const agg = map.get(key) ?? {
    key,
    label,
    bytes: 0,
    itemCount: 0,
    bucketIds: new Set<string>(),
    itemRefs: [],
    confirmationLevel: 'L1' as AffordanceLevel,
    isOther,
    countsAsUnit,
    unitCount: countsAsUnit ? 1 : 0,
  }
  agg.bytes += item.bytes ?? 0
  agg.itemCount += 1
  agg.bucketIds.add(bucketId)
  agg.itemRefs.push({ bucketId, itemId: item.id })
  agg.confirmationLevel = mostStrictAffordance(agg.confirmationLevel, lvl)
  map.set(key, agg)
}

interface FinalizeBundleOpts {
  map: Map<string, DrillAgg>
  drillTopN: number
  otherLabel: string
  bundleId: string
  kind: TopItemKind
  label: string
  subtitleI18nKey: string
  subtitleDefault: string
  /** 副标题统计值；未传时使用可计数的普通分组数。 */
  subtitleCount?: number
  totalBytes: number
  bucketIds: string[]
  t: TFunction
  /** 分组行可能代表多个真实项目；副标题按真实项目数而不是分组行数展示。 */
  countAggregatedItems?: boolean
}

function finalizeBundle(opts: FinalizeBundleOpts): StorageTopItem {
  const {
    map,
    drillTopN,
    otherLabel,
    bundleId,
    kind,
    label,
    subtitleI18nKey,
    subtitleDefault,
    totalBytes,
    bucketIds,
    t,
  } = opts

  // 没有 Workspace / 项目维度的辅助数据单独展示，不进入单位数量。
  const supplementalAggs = Array.from(map.values()).filter(
    (agg) => !agg.countsAsUnit,
  )
  const unitAggs = Array.from(map.values()).filter((agg) => agg.countsAsUnit)

  // 排序：非「其他」按 bytes 倒序；「其他」永远排最后
  const sortedAggs = unitAggs.sort((a, b) => {
    if (a.isOther && !b.isOther) return 1
    if (!a.isOther && b.isOther) return -1
    return b.bytes - a.bytes
  })

  // 应用 drillTopN：前 N 个保留，其余合到「其他」
  const drillItems: StorageDrillItem[] = []
  let otherAggregate: DrillAgg | null = null
  let normalIndex = 0
  for (const agg of sortedAggs) {
    if (agg.isOther) {
      otherAggregate = mergeAggs(otherAggregate, agg)
      continue
    }
    if (normalIndex < drillTopN) {
      drillItems.push(aggToDrill(agg))
      normalIndex += 1
    } else {
      otherAggregate = mergeAggs(otherAggregate, agg)
    }
  }
  if (otherAggregate && otherAggregate.bytes > 0) {
    drillItems.push({
      ...aggToDrill(otherAggregate),
      label: otherLabel,
    })
  }
  for (const agg of supplementalAggs) {
    if (agg.bytes > 0 || agg.itemCount > 0) {
      drillItems.push(aggToDrill(agg))
    }
  }

  const totalItemCount = Array.from(map.values()).reduce(
    (sum, a) => sum + a.itemCount,
    0,
  )
  // 仅统计真实 Workspace / 项目分组；辅助数据在下钻中单列，但不伪装成单位。
  const visibleCount = opts.countAggregatedItems
    ? sortedAggs.reduce((sum, agg) => sum + agg.unitCount, 0)
    : sortedAggs.length
  const strict = drillItems.reduce(
    (max, d) => mostStrictAffordance(max, d.confirmationLevel),
    'L3-soft' as AffordanceLevel,
  )

  return {
    id: bundleId,
    kind,
    label,
    subtitle: t(subtitleI18nKey, {
      count: opts.subtitleCount ?? visibleCount,
      defaultValue: subtitleDefault,
    }),
    bytes: totalBytes,
    itemCount: totalItemCount,
    bucketIds,
    canClear: false,
    confirmationLevel: strict,
    drillItems,
  }
}

/**
 * UUID 兜底检测——任何看起来像 UUID v4 或 hash 的 label 都视为"未命名"，
 * 强制合到「其他」桶。
 *
 * 触发条件：
 *   - 标准 UUID v4 格式（8-4-4-4-12 hex）
 *   - 32 / 40 / 64 位纯 hex（MD5 / SHA1 / SHA256 hash）
 *   - 长度 > 20 且全是 hex / 短横线（保守兜底）
 */
function looksLikeUuid(label: string): boolean {
  if (!label) return true
  const trimmed = label.trim()
  // 标准 UUID
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return true
  }
  // 纯 hex hash（MD5 / SHA1 / SHA256）
  if (/^[0-9a-f]{32,64}$/i.test(trimmed)) {
    return true
  }
  // 兜底：长度 > 20 且只含 hex 或短横线
  if (trimmed.length > 20 && /^[0-9a-f-]+$/i.test(trimmed)) {
    return true
  }
  return false
}

function mergeAggs(
  a: DrillAgg | null,
  b: DrillAgg,
): DrillAgg {
  if (!a) return { ...b, isOther: true, key: '__other__' }
  return {
    key: '__other__',
    label: a.label,
    bytes: a.bytes + b.bytes,
    itemCount: a.itemCount + b.itemCount,
    unitCount: a.unitCount + b.unitCount,
    bucketIds: new Set([...a.bucketIds, ...b.bucketIds]),
    itemRefs: [...a.itemRefs, ...b.itemRefs],
    confirmationLevel: mostStrictAffordance(
      a.confirmationLevel,
      b.confirmationLevel,
    ),
    isOther: true,
    countsAsUnit: true,
  }
}

function aggToDrill(agg: {
  key: string
  label: string
  bytes: number
  itemCount: number
  bucketIds: Set<string>
  itemRefs: Array<{ bucketId: string; itemId: string }>
  confirmationLevel: AffordanceLevel
}): StorageDrillItem {
  return {
    id: agg.key,
    label: agg.label,
    bytes: agg.bytes,
    itemCount: agg.itemCount,
    bucketIds: Array.from(agg.bucketIds),
    itemRefs: agg.itemRefs,
    canClear: true,
    confirmationLevel: agg.confirmationLevel,
  }
}

/**
 * 浏览器登录环境——按 env 聚合，主进程注册端没填 envName 时 fallback 到 partition_key。
 */
async function buildBrowserEnvBundle(
  buckets: BucketDescriptor[],
  sizeMap: Record<string, BucketSizeReport | undefined>,
  onListItems: ListItemsHandler,
  t: TFunction,
  drillTopN: number,
): Promise<StorageTopItem | null> {
  if (buckets.length === 0) return null

  const totalBytes = buckets.reduce(
    (sum, d) => sum + (sizeMap[d.id]?.bytes ?? 0),
    0,
  )
  if (totalBytes === 0) return null

  const listResults = await Promise.all(
    buckets.map(async (d) => {
      try {
        const report = await onListItems(d.id)
        return { descriptor: d, items: report.items }
      } catch (err) {
        console.warn('[buildTopItems] env listItems failed:', d.id, err)
        return { descriptor: d, items: [] as BucketItem[] }
      }
    }),
  )

  const otherLabel = t('topItems.browserEnv.otherLabel', {
    defaultValue: '其他登录环境',
  })
  const map = new Map<string, DrillAgg>()

  for (const { descriptor, items } of listResults) {
    const lvl = resolveAffordanceLevel(descriptor)
    for (const item of items) {
      const meta = item.metadata ?? {}
      const envKey =
        (meta.env as string | undefined) ??
        (meta.envId as string | undefined) ??
        (meta.partitionEnv as string | undefined)
      const friendlyName =
        (meta.envName as string | undefined) ??
        (meta.envLabel as string | undefined)

      let key: string
      let label: string
      let isOther = false

      // UUID 兜底：没 envKey 或没 friendlyName 或 friendlyName 像 UUID → 合「其他」
      if (envKey && friendlyName && !looksLikeUuid(friendlyName)) {
        key = `env::${envKey}`
        label = friendlyName
      } else {
        key = '__other__'
        label = otherLabel
        isOther = true
      }

      pushAgg(map, key, label, isOther, item, descriptor.id, lvl)
    }
  }

  return finalizeBundle({
    map,
    drillTopN,
    otherLabel,
    bundleId: 'bundle::browser-env',
    kind: 'browser-env-bundle',
    label: t('topItems.browserEnv.label', {
      defaultValue: '浏览器登录环境',
    }),
    subtitleI18nKey: 'topItems.browserEnv.subtitle',
    subtitleDefault: '{{count}} 个环境 · 网站登录态与离线数据',
    totalBytes,
    bucketIds: buckets.map((d) => d.id),
    t,
  })
}

/**
 * Agent 工具下载——按 Space 拆 drill。
 */
async function buildAgentDownloadBundle(
  descriptor: BucketDescriptor,
  sizeMap: Record<string, BucketSizeReport | undefined>,
  onListItems: ListItemsHandler,
  spaceNameMap: Map<string, string>,
  t: TFunction,
  drillTopN: number,
): Promise<StorageTopItem | null> {
  const size = sizeMap[descriptor.id]
  const totalBytes = size?.bytes ?? 0
  if (totalBytes === 0) return null

  if (!descriptor.capabilities.canList) {
    return buildSingleBucketTopItem(descriptor, size, 'agent-download', t)
  }

  let items: BucketItem[]
  try {
    const report = await onListItems(descriptor.id)
    items = report.items
  } catch (err) {
    console.warn(
      '[buildTopItems] agent-download listItems failed:',
      descriptor.id,
      err,
    )
    return buildSingleBucketTopItem(descriptor, size, 'agent-download', t)
  }

  const lvl = resolveAffordanceLevel(descriptor)
  const otherLabel = t('topItems.agentDownload.otherLabel', {
    defaultValue: '其他工作区',
  })
  const map = new Map<string, DrillAgg>()

  for (const item of items) {
    const meta = item.metadata ?? {}
    const spaceId = (meta.spaceId ?? meta.space_id) as string | undefined

    let key: string
    let label: string
    let isOther = false

    if (spaceId) {
      const name = spaceNameMap.get(spaceId)
      if (name && !looksLikeUuid(name)) {
        key = `space::${spaceId}`
        label = name
      } else {
        key = '__other__'
        label = otherLabel
        isOther = true
      }
    } else {
      key = '__other__'
      label = otherLabel
      isOther = true
    }

    pushAgg(map, key, label, isOther, item, descriptor.id, lvl)
  }

  return finalizeBundle({
    map,
    drillTopN,
    otherLabel,
    bundleId: 'bundle::agent-download',
    kind: 'agent-download',
    label: t('topItems.agentDownload.label', {
      defaultValue: 'Agent 工具下载',
    }),
    subtitleI18nKey: 'topItems.agentDownload.subtitle',
    subtitleDefault: '{{count}} 个工作区 · Agent 抓取的文件',
    totalBytes,
    bucketIds: [descriptor.id],
    t,
  })
}

/**
 * 业务 app 项目级（TabVideo 项目 / TabDoc 草稿）——按项目 listFn 项目名直接 drill。
 */
async function buildAppProjectBundle(
  descriptor: BucketDescriptor,
  sizeMap: Record<string, BucketSizeReport | undefined>,
  onListItems: ListItemsHandler,
  t: TFunction,
  drillTopN: number,
): Promise<StorageTopItem | null> {
  const size = sizeMap[descriptor.id]
  if ((size?.bytes ?? 0) === 0) return null

  let items: BucketItem[]
  try {
    const report = await onListItems(descriptor.id)
    items = report.items
  } catch (err) {
    console.warn('[buildTopItems] appProject listItems failed:', descriptor.id, err)
    return buildSingleBucketTopItem(descriptor, size, 'app-project', t)
  }

  const lvl = resolveAffordanceLevel(descriptor)
  const projects = items
    .filter((it) => (it.bytes ?? 0) > 0)
    .map((it) => ({
      id: `${descriptor.id}::${it.id}`,
      label: it.label || `${descriptor.displayName} #${it.id.slice(0, 8)}`,
      bytes: it.bytes ?? 0,
      itemCount: 1,
      bucketIds: [descriptor.id],
      itemRefs: [{ bucketId: descriptor.id, itemId: it.id }],
      canClear: descriptor.capabilities.canClear,
      confirmationLevel: lvl,
    }))
    .sort((a, b) => b.bytes - a.bytes)

  // 应用 drillTopN
  const visible = projects.slice(0, drillTopN)
  const rest = projects.slice(drillTopN)
  if (rest.length > 0) {
    const restBytes = rest.reduce((s, p) => s + p.bytes, 0)
    if (restBytes > 0) {
      visible.push({
        id: `${descriptor.id}::__other__`,
        label: t('topItems.appProject.otherLabel', {
          count: rest.length,
          defaultValue: '其他 {{count}} 个',
        }),
        bytes: restBytes,
        itemCount: rest.length,
        bucketIds: [descriptor.id],
        itemRefs: rest.flatMap((p) => p.itemRefs),
        canClear: descriptor.capabilities.canClear,
        confirmationLevel: lvl,
      })
    }
  }

  const appNamespace = inferAppNamespace(descriptor.id)
  const label = resolveBucketDisplayName(descriptor, t)
  const subtitle = appNamespace
    ? t(`topItems.appProject.${appNamespace}.subtitle`, {
        count: projects.length,
        defaultValue: '{{count}} 个项目',
      })
    : descriptor.description

  return {
    id: `bundle::app-project::${descriptor.id}`,
    kind: 'app-project',
    label,
    subtitle,
    bytes: size?.bytes ?? 0,
    itemCount: projects.length,
    bucketIds: [descriptor.id],
    canClear: false,
    confirmationLevel: lvl,
    drillItems: visible,
  }
}

/**
 * 单 bucket 直接转 TopItem（无 drill）。
 */
function buildSingleBucketTopItem(
  descriptor: BucketDescriptor,
  size: BucketSizeReport | undefined,
  kind: TopItemKind,
  t: TFunction,
): StorageTopItem {
  return {
    id: descriptor.id,
    kind,
    label: resolveBucketDisplayName(descriptor, t),
    subtitle: resolveBucketDescription(descriptor, t),
    bytes: size?.bytes ?? 0,
    itemCount: size?.itemCount,
    bucketIds: [descriptor.id],
    canClear: descriptor.capabilities.canClear,
    confirmationLevel: resolveAffordanceLevel(descriptor),
  }
}

// ── 小工具 ────────────────────────────────────────────────────────

function inferProjectNameFromPath(path: string | undefined): string | null {
  if (!path) return null
  const parts = path.replace(/[\\/]$/, '').split(/[/\\]/)
  return parts[parts.length - 1] || null
}

function normalizeProjectPathKey(projectPath: string): string {
  return projectPath
    .trim()
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
    .toLocaleLowerCase()
}

function inferAppNamespace(bucketId: string): string | null {
  const idx = bucketId.indexOf(':')
  return idx > 0 ? bucketId.slice(0, idx) : null
}

const AFFORDANCE_ORDER: AffordanceLevel[] = [
  'L1',
  'L2',
  'L3-soft',
  'L3-hard',
  'L4',
]

function mostStrictAffordance(
  a: AffordanceLevel,
  b: AffordanceLevel,
): AffordanceLevel {
  return AFFORDANCE_ORDER.indexOf(a) >= AFFORDANCE_ORDER.indexOf(b) ? a : b
}
