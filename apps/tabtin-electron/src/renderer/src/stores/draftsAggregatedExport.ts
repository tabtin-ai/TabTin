/**
 * draftsAggregatedExport — D-5 §3 "未保存草稿"统一导出 bucket。
 *
 * ## 设计决策
 *
 * D-5 决策要求把多个来源的草稿聚合到一个 JSON 导出：
 *   1. ChatInput drafts（`chat:input-drafts`，localStorage）
 *   2. TabDoc 离线草稿（`tabdoc:offline-drafts`，IndexedDB）
 *   3. TabSlide 未同步编辑（`tabslide:offline-overflow`，localStorage）
 *
 * **为什么放 renderer 端而非 main 进程**：来源 listFn 全部跑在
 * renderer（依赖 localStorage / sessionStorage / IndexedDB）。
 * 若 main 进程注册聚合 bucket，需要一次 IPC 反向调到 renderer 各 bucket
 * 的 listFn——白白多一跳，错误处理面也更大。renderer 端注册可以直接
 * 调本进程 `localGetBucket` + `listBucketItems`，零 IPC。
 *
 * ## hideFromList 选择
 *
 * 来源 bucket 在「我的资产」面板里已经各自有卡片（W3.2 渲染），
 * 用户能看到每个来源的容量 + 单独清理。本 bucket 仅作为"统一导出"
 * 入口暴露给 UI（在草稿分组顶部加一个"一键导出所有未保存草稿"按钮），
 * **不在卡片列表里渲染**——因此 `hideFromList: true`。
 *
 * ## sizeFn 语义
 *
 * 累加各来源 bucket 的 sizeFn 返回值。来源未注册（如用户没启用
 * TabDoc）时跳过，不抛错。
 *
 * ## clearFn 不实现
 *
 * 聚合 bucket 不提供 clearFn——清理走各自来源 bucket 的 clearFn，
 * 避免"误以为清掉聚合就清掉一切"造成的不一致。UI 端"一键清所有
 * 未保存草稿"按钮（如未来上线）应分别 invoke 各来源 bucket 的 clearFn。
 *
 * ## 隐私守护（R2 review 修复）
 *
 * `tabdoc:offline-drafts` 的 listFn 在 `label` 字段里塞了草稿正文前 60 字
 * （[`packages/tabdoc-ui/src/utils/offlineCache.ts:245`]）。直接转发会让
 * 用户分享 drafts.json 时泄漏文档原文。本聚合在打包前**统一替换 label**
 * 为 `<displayName> <id-shortcut>` 形式（id 截前 12 位），保证导出文件
 * 不含任何来源 listFn 拍进 label 的内容片段。ChatInput 的 listFn 已经
 * 在 R2 加固时主动改用安全 label，本聚合的统一替换可视为"防御深度"——
 * 无论来源 listFn 未来是否再 regress，聚合层都不会泄漏。
 *
 * ## exportFn 输出
 *
 * ```json
 * {
 *   "schemaVersion": 1,
 *   "exportedAt": "2026-05-04T03:16:00.000Z",
 *   "source": "tabtin-electron",
 *   "bucketId": "drafts:all-unsaved",
 *   "totalDraftCount": 12,
 *   "totalBytes": 34567,
 *   "sources": [
 *     { "source": "chat", "bucketId": "chat:input-drafts",
 *       "available": true, "draftCount": 3, "bytes": 1234,
 *       "drafts": [{ id, label, bytes, metadata: { chars, lruRank, ... } }, ...] },
 *     { "source": "tabdoc", "bucketId": "tabdoc:offline-drafts",
 *       "available": true, "draftCount": 5, "bytes": 23000, "drafts": [...] },
 *     ...
 *   ]
 * }
 * ```
 *
 * 每条 draft 完整保留来源 bucket 的 metadata（如 TabDoc 的 savedAt /
 * baseVersion，ChatInput 的 chars / lruRank），UI 可以据此恢复。
 */

import {
  getBucket,
  listBucketItems,
  registerStorageBucket,
  type BucketItem,
} from '@tabtin/storage-manager'

const AGGREGATE_BUCKET_ID = 'drafts:all-unsaved'

interface DraftSource {
  /** 用户视角的来源标签（小写，便于程序处理） */
  source: 'chat' | 'tabdoc' | 'tabslide'
  /** 实际依赖的 storage-manager bucket id */
  bucketId: string
  /** 用户可读的中文展示名（用于 UI 提示 / 错误回执） */
  displayName: string
}

const DRAFT_SOURCES: readonly DraftSource[] = [
  { source: 'chat', bucketId: 'chat:input-drafts', displayName: '对话输入框草稿' },
  { source: 'tabdoc', bucketId: 'tabdoc:offline-drafts', displayName: 'TabDoc 离线草稿' },
  { source: 'tabslide', bucketId: 'tabslide:offline-overflow', displayName: 'TabSlide 未同步编辑' },
]

interface SourceProbe {
  available: boolean
  /** 来源 bucket 不存在 / listFn 抛错时的原因，方便用户排查 */
  reason?: 'not-registered' | 'no-list-fn' | 'list-failed'
  errorMessage?: string
  items: BucketItem[]
}

async function _probeSource(bucketId: string): Promise<SourceProbe> {
  const bucket = getBucket(bucketId)
  if (!bucket) {
    return { available: false, reason: 'not-registered', items: [] }
  }
  if (!bucket.listFn) {
    return { available: false, reason: 'no-list-fn', items: [] }
  }
  try {
    const items = await listBucketItems(bucketId)
    return { available: true, items }
  } catch (err) {
    return {
      available: false,
      reason: 'list-failed',
      errorMessage: err instanceof Error ? err.message : String(err),
      items: [],
    }
  }
}

export function registerDraftsAggregatedBucket(): void {
  if (typeof window === 'undefined') return
  if (getBucket(AGGREGATE_BUCKET_ID)) return

  registerStorageBucket({
    id: AGGREGATE_BUCKET_ID,
    category: 'data',
    group: 'conversation',
    displayName: '未保存草稿（聚合导出）',
    description:
      '把对话输入 / TabDoc / TabSlide / TabWhiteboard 的未保存草稿聚合导出到一个 JSON 文件。',
    warnings: [
      '本桶仅做导出聚合视图——清理请到各业务模块卡片单独操作',
      '导出仅打包元信息和必要的 metadata，不会包含已成功上传到云端的内容',
    ],
    requiresConfirmation: 'hard',
    hideFromList: true,
    sizeFn: async () => {
      let totalBytes = 0
      let totalCount = 0
      for (const src of DRAFT_SOURCES) {
        const bucket = getBucket(src.bucketId)
        if (!bucket) continue
        try {
          const size = await bucket.sizeFn()
          totalBytes += size.bytes
          if (size.itemCount !== undefined) totalCount += size.itemCount
        } catch {
          /* 单个来源 sizeFn 抛错不影响整体——保守归 0 即可 */
        }
      }
      return { bytes: totalBytes, itemCount: totalCount }
    },
    exportFn: async () => {
      const exportedAt = new Date().toISOString()

      const probes = await Promise.all(
        DRAFT_SOURCES.map((src) => _probeSource(src.bucketId)),
      )

      let totalBytes = 0
      let totalDraftCount = 0
      const sources = DRAFT_SOURCES.map((src, idx) => {
        const probe = probes[idx]!
        // 隐私守护：来源 listFn 的 label 可能含正文前缀（如 TabDoc 的
        // plaintext 前 60 字），导出文件必须用安全占位替代。
        const drafts = probe.items.map((it) => ({
          id: it.id,
          label: `${src.displayName} ${String(it.id).slice(0, 12)}`,
          bytes: it.bytes ?? 0,
          metadata: it.metadata ?? {},
        }))
        const bytes = drafts.reduce((sum, d) => sum + (d.bytes ?? 0), 0)
        totalBytes += bytes
        totalDraftCount += drafts.length
        return {
          source: src.source,
          bucketId: src.bucketId,
          displayName: src.displayName,
          available: probe.available,
          ...(probe.reason ? { unavailableReason: probe.reason } : {}),
          ...(probe.errorMessage ? { errorMessage: probe.errorMessage } : {}),
          draftCount: drafts.length,
          bytes,
          drafts,
        }
      })

      const payload = {
        schemaVersion: 1,
        exportedAt,
        source: 'tabtin-electron',
        bucketId: AGGREGATE_BUCKET_ID,
        totalDraftCount,
        totalBytes,
        sources,
      }

      const ts = exportedAt.replace(/[:.]/g, '-')
      return {
        filename: `tabtin-unsaved-drafts-${ts}.json`,
        data: JSON.stringify(payload, null, 2),
        mimeType: 'application/json',
      }
    },
  })
}

registerDraftsAggregatedBucket()
