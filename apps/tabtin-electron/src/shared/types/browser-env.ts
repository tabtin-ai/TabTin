/**
 * Browser Environment IPC 交互类型。
 *
 * 主进程 / preload / 渲染进程三处共享：
 *   - 主进程的 ``BrowserEnvironmentService`` 从这里 import 实体类型
 *   - preload 在 ``window.tabtin.browserEnv.xxx`` 的 IPC 封装里导入
 *   - 渲染进程消费时直接拿这里的类型，避免重复定义
 *
 * 本地化退役 Wave 1/2 之后：BrowserEnvironment 完全本地化（``BrowserEnvLocalStore``
 * 持久化到 ``app-config.json``），不再有云端 schema 对齐的需要。字段命名仍
 * 保留 snake_case 是为了与 ``shared/types`` 中的其他历史接口保持一致。
 */

/** 单个登录环境的元数据。 */
export interface BrowserEnvironment {
  id: string
  name: string
  /**
   * Electron session partition 标识，形如 ``tabtin:env:default`` 或
   * ``tabtin:env:{hex}``。注意：这里**不带** ``persist:`` 前缀——由 IPC 层
   * 或调用 ``session.fromPartition(...)`` 的地方按需附加（与现有
   * credential-vault 的 ``isAllowedPartition`` 约定一致）。
   */
  partition_key: string
  is_default: boolean
  /** 显式绑定到该环境的 Space 数（``BrowserEnvBinding`` 行数）。 */
  binding_count: number
  explicit_binding_count: number
  /**
   * 实际"正在使用"该环境的 Space 数。本地化后语义上等于 ``explicit_binding_count``
   * （本地无全量 Space 列表，无法精确统计默认 env 的隐式使用数）。
   */
  using_space_count: number
  created_at: string
  updated_at: string
}

/** Space ↔ environment 绑定的扁平条目。 */
export interface BrowserEnvBinding {
  space_id: string
  environment_id: string
  /** ``true`` = 用户显式调过 bindSpace；``false`` = fallback 到默认环境（本地化后只会出现 ``true``）。 */
  is_explicit: boolean
}

/** ``browser-env:list`` 的成功响应中的 environments + bindings 形状。 */
export interface BrowserEnvBootstrap {
  environments: BrowserEnvironment[]
  bindings: BrowserEnvBinding[]
}

// ==================== IPC 返回类型 ====================
//
// 业务错误 code 走纯字符串（如 `'ENV_NAME_REQUIRED'` / `'PERSIST_FAILED'`，
// 由 `BrowserEnvValidationError.code` 直接透传）。本地化退役后没有需要枚
// 举式约束的错误码集合，所以不再维护 `BROWSER_ENV_ERROR_CODES` 常量。

/** IPC 写操作的统一返回形状。 */
export interface BrowserEnvWriteResult<T = BrowserEnvironment> {
  success: boolean
  environment?: T
  error?: string
  code?: string
}

export interface BrowserEnvDeleteResult {
  success: boolean
  deleted_id?: string
  rebound_bindings?: number
  rebound_space_ids?: string[]
  error?: string
  code?: string
}

export interface BrowserEnvBindResult {
  success: boolean
  environment?: BrowserEnvironment
  error?: string
  code?: string
}

/** 同步查询（``get-partition`` / ``get-environment-for-space``）的返回。 */
export interface BrowserEnvGetPartitionResult {
  /** Partition 字符串，不带 ``persist:`` 前缀；未知 Space 时回落到默认环境 partition。 */
  partition: string
  environment: BrowserEnvironment | null
  /** 该 Space 是否有显式 binding；未启动服务时可能为 ``null``（降级态）。 */
  is_explicit: boolean | null
}

/** 事件通道名 —— 供 ``onChanged`` 订阅。 */
export const BROWSER_ENV_EVENTS = {
  CHANGED: 'browser-env:changed',
} as const

// ==================== Organization 级浏览器 partition（边界改造 Phase 3a） ====================
//
// 边界正典 `docs/prd/desktop-conversation-space-boundary.md` §1.4：
//   cookie / 登录态 = 基于 **Organization profile**，不基于 Space、也不基于对话。
//   同一 Organization 下，桌面 + 它下面所有 Space / 对话**共享同一份 cookie**。
//
// 因此普通浏览器（非隔离 named session、非显式 env 绑定）的 partition 不再是
// per-user 的 `tabtin:env:default`，而是 per-organization 的
// `tabtin:organization:{organizationId}:browser`：
//   - 同 organization 的所有 Space / 对话用**同一个 partition** → cookie 天然共享，
//     无需 CookieSyncService 跨罐同步（同罐即共享）。
//   - 切换 organization → 落到不同 partition → 登录态天然隔离。
//
// **承重墙**：隔离 named session 仍走 `tabtin:session:*` 独立 partition，
// 绝不并入本 organization 共享罐（见 `browserEnvSnapshot.SESSION_PARTITION_PREFIX`）。

/** Organization 级浏览器 partition 的前缀。 */
export const ORGANIZATION_BROWSER_PARTITION_PREFIX = 'tabtin:organization:'

/** Organization 级浏览器 partition 的后缀 —— 与未来可能的其它 organization 子罐区分。 */
export const ORGANIZATION_BROWSER_PARTITION_SUFFIX = ':browser'

/**
 * 把任意 organizationId 归一到 partition 名安全字符集。
 *
 * Chromium 的 `userData/Partitions/` 目录名直接来自 partition 字符串，
 * 非法字符会让目录创建失败 / 跨平台不一致。organizationId 一般是 UUID（本就
 * 安全），这里仍做防御性 sanitize，与 `main/organization-handler.ts::configPath`
 * 的口径一致（只留字母数字 / `-` / `_`）。
 */
function sanitizeOrganizationPartitionId(organizationId: string): string {
  return organizationId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128)
}

/**
 * 由 organizationId 构造普通浏览器的 Organization 级 partition。
 *
 * 形如 `tabtin:organization:{organizationId}:browser`（不带 `persist:` 前缀——由
 * `session.fromPartition(...)` 的调用方按需附加，与 env partition 约定一致）。
 *
 * 入参非法（空 / 全非法字符）时返回空串，调用方应据此回落到默认 partition；
 * 本函数不偷偷返回默认值，让"拿不到 organization"这件事在调用方显式可见。
 */
export function buildOrganizationBrowserPartition(organizationId: string | null | undefined): string {
  if (typeof organizationId !== 'string') return ''
  const safe = sanitizeOrganizationPartitionId(organizationId.trim())
  if (!safe) return ''
  return `${ORGANIZATION_BROWSER_PARTITION_PREFIX}${safe}${ORGANIZATION_BROWSER_PARTITION_SUFFIX}`
}

/** 判断一个 partition（可能带 `persist:`）是否是 Organization 级浏览器 partition。 */
export function isOrganizationBrowserPartition(partition: string | null | undefined): boolean {
  if (typeof partition !== 'string' || !partition) return false
  const stripped = partition.startsWith('persist:')
    ? partition.slice('persist:'.length)
    : partition
  return stripped.startsWith(ORGANIZATION_BROWSER_PARTITION_PREFIX)
}
