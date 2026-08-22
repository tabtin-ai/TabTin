/**
 * Bucket UI 文案与分组覆盖层
 *
 * 业务背景：
 *   bucket 在主进程多个 service 里以工程化的 displayName 注册（"对话历史 ·
 *   消息流"、"AI 外部工具连接（MCP）"、"工具调用结果归档"等）。这些名字
 *   是给开发者看的，对最终用户不友好。
 *
 *   同时，bucket 的工程分组（`group`）和"用户视角的分组"不完全重合：
 *     - conversation + checkpoint：用户看就是"对话和操作记录"，没必要分两块
 *     - business-app 里的 mcp / skills 等：用户看不到也管不着
 *
 *   本文件在 UI 层做覆盖映射，**不改注册端**——避免影响 export / 测试 /
 *   可能的 daemon 消费方。
 *
 * SSoT 切分（2026-05 重构）：
 *   - **i18n 文件**（`storage-manager.json` 的 `bucketDisplay.*`）= 文案最终 SSoT
 *   - **本文件** = 路由层：标记哪个 bucket 走 i18n、哪个隐藏、归到哪个用户分组
 *   两者解耦后翻译可以纯走 i18n 流程，不再需要改 .ts 代码。
 */

import type { TFunction } from 'i18next'
import type { BucketDescriptor, BucketGroup } from './components/types'

/**
 * 用户视角的 5 大分组——对应 i18n `userGroup.*`。
 *
 * 注意这与底层 `BucketGroup` 是**多对一**关系：例如底层 conversation +
 * checkpoint 都映射到用户视角的 'conversations'。
 */
export type UserFacingGroup =
  | 'conversations'
  | 'browser'
  | 'media'
  | 'apps'
  | 'voice'

/**
 * bucket id → UI 路由配置。
 *
 * 字段语义：
 *   - `userVisible`: 是否在 YourData section 露出（true / false / 不传 = 走兜底）
 *   - `userGroup`:   归到哪个用户分组（不传 = 按 USER_GROUP_FALLBACK 兜底）
 *   - `i18nKey`:     i18n 文件下 `bucketDisplay.<key>.title` / `.description` 的 key
 *                    （不传 = 直接用注册端的 displayName / description）
 *
 * 注意：`displayName` / `description` 的字面量在 i18n 文件，不在本表。
 */
interface BucketDisplayOverride {
  userGroup?: UserFacingGroup
  userVisible?: boolean
  /** 默认等于 bucket id（i18n 文件用 bucket id 作为子键） */
  i18nKey?: string
}

const BUCKET_OVERRIDES: Record<string, BucketDisplayOverride> = {
  // ── conversation 组：对用户而言全部是"对话和操作记录"，
  //    工程内部细分为 messages / snapshots / events / tool-logs / sync-* 等。
  //    单独露出会把"对话历史 · 消息流""对话历史 · LLM 调用快照""未上云的对话片段（待重试）"
  //    这种工程视角直接砸用户脸上。统一隐藏，仅在 SpaceAggregator 里用聚合视图展示。
  'agent:conversations:messages': { userVisible: false },
  'agent:conversations:snapshots': { userVisible: false },
  'agent:conversations:events': { userVisible: false },
  'agent:tool-logs': { userVisible: false },
  'agent:tool-results': { userVisible: false },
  'agent:sync-pending': { userVisible: false },
  'agent:sync-archive': { userVisible: false },
  'chat:input-drafts': { userVisible: false },
  'voice:offline-queue': { userVisible: false },
  // 注：注册端真实 id 是 `chat:message-cache`（W3.1 调研），保留旧的
  // `renderer:message-cache` 作为兜底——避免某些上游 bridge 用了旧 id。
  'chat:message-cache': { userVisible: false },
  'renderer:message-cache': { userVisible: false },

  // ── checkpoint：对用户而言这就是"项目操作快照"，归到 conversations。
  //    注册端真实 id 是 `checkpoint:shadow-git`（cwdHash 维度），同时保留
  //    旧 `agent:checkpoints` 作为兜底——i18n 文件里两个 key 都有相同文案。
  'checkpoint:shadow-git': { userGroup: 'conversations', userVisible: true },
  'agent:checkpoints': { userGroup: 'conversations', userVisible: true },

  // ── browser 组：partition 类的单 bucket 不直接渲染卡片，全部由
  //    buildTopItems 的 aggregateByEnv 按 env 聚合到「{环境名} 的登录态」TopItem。
  //    仍归入 'browser' 用户组以便 display-overrides 走 i18n 文案路径。
  'browser:env-partitions': { userGroup: 'browser', userVisible: true },
  'browser:task-partitions': { userGroup: 'browser', userVisible: true },
  'browser:upgrade-partitions': { userGroup: 'browser', userVisible: true },
  'browser:legacy-crawlspace-partitions': {
    userGroup: 'browser',
    userVisible: true,
  },
  'browser:http-cache-aggregate': { userGroup: 'browser', userVisible: true },
  'browser:bookmarks': { userGroup: 'browser', userVisible: true },
  'browser:browsing-history': { userGroup: 'browser', userVisible: true },

  // ── business-app 组：用户能感知的"已安装应用"子集
  'tin:sandboxes': { userGroup: 'apps', userVisible: true },
  'marketplace:apps': { userGroup: 'apps', userVisible: true },
  // skills:preinstalled 是 TabTin 自动注入到每个工作区的工具脚本，用户既不能管
  // 也不应该管 → 全程隐藏
  'skills:preinstalled': { userVisible: false },
  'mcp:local-connections': { userGroup: 'apps', userVisible: true },

  // ── media 组：保留单卡片
  'media:recordings': { userGroup: 'media', userVisible: true },
  'media:screenshots': { userGroup: 'media', userVisible: true },
  'media:exports-pdf': { userGroup: 'media', userVisible: true },
  'download:user-downloads': { userGroup: 'media', userVisible: true },
  'download:agent-sandbox-downloads': { userGroup: 'media', userVisible: true },
  // cache 类，归到 quick cleanup，不进 YourData
  'media:tabvideo-render-tmp': { userVisible: false },
  'media:stream-download-tmp': { userVisible: false },

  // ── system 组里用户能感知的：只有 voice 热词
  //
  // W2.2 因历史原因把 Voice 注册到 group=system + hideFromList=true，但语义上
  // 是用户长期沉淀的核心资产，必须在 YourData 露出。两个 id 都覆盖：
  //   - 'voice:hotwords-rules'（标准 id）
  //   - 'system:voice-settings'（W2.2 产线注册 id，与 useVoiceSettingsStore.ts 严格对齐）
  'voice:hotwords-rules': { userGroup: 'voice', userVisible: true },
  'system:voice-settings': { userGroup: 'voice', userVisible: true },
  // OSS 上传记录是系统内部，不露出
  'oss:pending-confirms': { userVisible: false },
}

/**
 * 给一个 bucket 在 UI 上展示用的标题。
 *
 * 优先级：
 *   1. i18n 文件 `bucketDisplay.<bucketId>.title`（最终 SSoT）
 *   2. 注册端的 displayName 兜底
 *
 * @param d 描述符
 * @param t i18next TFunction（必须是 'storage-manager' namespace 下的）
 */
export function resolveBucketDisplayName(
  d: BucketDescriptor,
  t: TFunction,
): string {
  const i18nKey = `bucketDisplay.${d.id}.title`
  const translated = t(i18nKey, { defaultValue: '' })
  if (translated && translated !== i18nKey) return translated
  return d.displayName
}

/**
 * 给一个 bucket 在 UI 上展示用的描述。
 *
 * 优先级：
 *   1. i18n 文件 `bucketDisplay.<bucketId>.description`（最终 SSoT）
 *   2. 注册端的 description 兜底（如有）
 */
export function resolveBucketDescription(
  d: BucketDescriptor,
  t: TFunction,
): string {
  const i18nKey = `bucketDisplay.${d.id}.description`
  const translated = t(i18nKey, { defaultValue: '' })
  if (translated && translated !== i18nKey) return translated
  return d.description ?? ''
}

/**
 * `cache` 组的兜底分组：归到"立即可清理"区，不进 YourData。
 *
 * conversation / checkpoint 默认归到 conversations 用户分组（不需要每个 bucket 再标）。
 */
const USER_GROUP_FALLBACK: Partial<Record<BucketGroup, UserFacingGroup>> = {
  conversation: 'conversations',
  checkpoint: 'conversations',
  browser: 'browser',
  media: 'media',
  'business-app': 'apps',
  // login / system / cache 不在 YourData 默认露出
}

/**
 * 这个 bucket 在「你的数据」区是否应该显示？
 *
 * - 强制露出白名单（如 Voice 热词被 W2.2 误隐藏）→ 永远显示
 * - 显式 userVisible=true → 永远显示
 * - 显式 userVisible=false → 永远隐藏（hideFromList 同义）
 * - 没标 → 按 hideFromList + 兜底用户分组判断
 */
export function isUserVisibleAsset(d: BucketDescriptor): boolean {
  if (isForceVisibleAsset(d)) return true
  const override = BUCKET_OVERRIDES[d.id]
  if (override && typeof override.userVisible === 'boolean') {
    return override.userVisible
  }
  if (d.hideFromList) return false
  if (d.category === 'cache') return false
  return USER_GROUP_FALLBACK[d.group] !== undefined
}

/**
 * 一个 bucket 该归到哪个用户分组。`null` = 不在 YourData section 显示。
 */
export function resolveUserGroup(
  d: BucketDescriptor,
): UserFacingGroup | null {
  if (!isUserVisibleAsset(d)) return null
  const override = BUCKET_OVERRIDES[d.id]
  if (override?.userGroup) return override.userGroup
  if (isForceVisibleAsset(d)) return 'voice'
  return USER_GROUP_FALLBACK[d.group] ?? null
}

export const USER_GROUP_ORDER: UserFacingGroup[] = [
  'conversations',
  'browser',
  'media',
  'apps',
  'voice',
]

/**
 * 强制露出资产白名单（即使 hideFromList=true 也要在 YourData 出现）。
 *
 * 仅 Voice 热词：W2.2 因历史原因把它注册到 system + hideFromList=true，
 * 但语义上是用户长期沉淀的核心资产，必须露出供导出和管理。
 */
export const FORCE_VISIBLE_BUCKET_IDS: ReadonlySet<string> = new Set([
  'system:voice-settings',
  'voice:hotwords-rules',
])

export function isForceVisibleAsset(d: BucketDescriptor): boolean {
  return FORCE_VISIBLE_BUCKET_IDS.has(d.id)
}
