/**
 * @tabtin/resource-router · 公共类型契约
 *
 * 这是「Agent 产物在 Space 内的打开」专题 W2 协议骨架的 SSOT 之一。
 * 双端字符级对齐：Python 镜像见
 * `apps/tabtin_django/apps/services/common/resource_pointer.py`。
 *
 * 设计取向（来自 RFC v1.0 §1）：
 *  - 不引入第 4 套指针元模型——`ResourcePointerType` 直接复用现有
 *    `ContextRefType` 字符串，不另立枚举
 *  - 三种 Agent 输出形式（增强 markdown / `open_in_space` 工具 / 富 ResourceCard）
 *    必须共享同一种 `ResourcePointer` 结构（D3 红线）
 *  - 自有格式（`tabtin://resource/<type>/<id>?hint=…`）+ 行业格式（http /
 *    https / file / mailto / tel / 其他 scheme）双轨并存（D5 红线）
 */

// ─── Pointer ─────────────────────────────────────────────────────

/**
 * 来源 scheme：'tabtin' = 自有格式；其余 = 行业格式。
 *
 * 字面量 union 中只列 RFC v1.0 §1.3 显式枚举的 5 种行业 scheme + 'tabtin'
 * 自有格式；其他如 `tabtin-file:` / `weixin:` / `ssh:` 等都走 `(string & {})`
 * 兜底——避免在协议层预埋"未来要支持"的字面量过度设计。
 */
export type ResourcePointerScheme =
  | 'tabtin'
  | 'http'
  | 'https'
  | 'file'
  | 'mailto'
  | 'tel'
  | (string & {})

export type TabTinResourceScheme = 'tabtin' | 'tabtin-preprod' | 'tabtin-dev'

/**
 * 自有格式 type 轴。
 *
 * 取值与 `apps/tabtin-electron/src/renderer/src/components/chat/types.ts`
 * 中 `ContextRefType` 字符串完全一致（小写 snake，约 22 种）。
 *
 * 故意保持 `string` 而非闭合 union——`@tabtin/resource-router` 是协议层包，
 * 不应依赖 renderer 层的具体枚举；ContextRefType 增减由 Renderer 那边的
 * SSOT 与 manifest 校验脚本兜底（`scripts/validate-manifest-schema.py` cross-ref）。
 */
export type ResourcePointerType = string

/**
 * 「Agent 产物指针」。
 *
 * 三种来源：
 *   1. 自有格式 `tabtin://resource/<type>/<id>?hint=<carrierAppId>&...meta`
 *   2. 行业格式 `http(s)://...` / `file://...` / `mailto:...` / `tel:...` / 其他
 *   3. 裸路径（本期 Electron 由 W3 `remarkAutolinkResource` 升级到
 *      `tabtin://resource/file/<encoded>` 形态后再进 parser；本包 parser
 *      不直接处理裸路径——baseDir 解析依赖渲染层上下文）
 */
export interface ResourcePointer {
  /** 'tabtin' = 自有格式，其他都是行业格式（含未知 scheme） */
  scheme: ResourcePointerScheme

  /** 自有格式：ContextRefType 字符串；行业格式：null */
  type: ResourcePointerType | null

  /**
   * 自有格式：`tabtin://resource/<type>/<id>` 中的 `<id>`，已 urldecode；
   * 行业格式：原始 URI（不 decode 重写，调 `shell.openExternal` 时直接用）。
   */
  id: string

  /** 原始 URI 文本（可逆原文）。永远是字符串，便于持久化 / debug。 */
  raw: string

  /**
   * D5 hint：自有格式 `?hint=<carrierAppId>` 的 `<carrierAppId>`；
   * 行业格式恒为 null。
   */
  hint: string | null

  /**
   * Agent 携带的可选元信息。
   * 常用：title / preview / page_title / url / file_path / spaceId override 等。
   * 自有格式中除 `hint` 外的所有 query 字段都进这里（扁平 string→string 提取）。
   */
  meta?: Record<string, unknown>

  /**
   * chat 上下文 baseDir（仅用于 file:// 相对路径解析；由调用点注入）。
   * 不放在 RouterCore 内推导：baseDir 来源于 chat session，不在 Router 知识范围。
   * 本期未启用相对路径解析（W3 由 remark plugin 处理），保留字段为 mobile / daemon
   * 单独专题预留输入位。
   */
  baseDir?: string
}

// ─── Manifest opens 字段 ────────────────────────────────────────────

/**
 * manifest `opens.types[]` 单项。
 *
 * `priority` 是 D2 优先级表第 4 层「产品默认推荐」内的相对排序；数字大优先。
 * `matcher` 是 schema slot，本期保留但不实现（参见 RFC §5.1 / L12 / R16）。
 */
export interface ManifestOpensTypeEntry {
  type: ResourcePointerType
  priority: number
  matcher?: {
    metaKey?: string
    regex?: string
    [k: string]: unknown
  }
}

/**
 * manifest `opens.schemes[]` 单项。
 *
 * `scheme` 必须以冒号结尾（与 `URL.protocol` 保持一致），如 `https:` / `mailto:`。
 * `matcher` 是 schema slot，本期保留但不实现。
 */
export interface ManifestOpensSchemeEntry {
  scheme: string
  priority: number
  matcher?: {
    hostRegex?: string
    pathRegex?: string
    mimeType?: string
    [k: string]: unknown
  }
}

/**
 * manifest 顶层 `opens` 字段（与 `agentIntegration` 平级）。
 *
 * 任何字段都可选——没声明等价于「不能打开任何东西」（兜底交系统应用）。
 */
export interface ManifestOpens {
  types?: ManifestOpensTypeEntry[]
  schemes?: ManifestOpensSchemeEntry[]
}

// ─── Resolve / Open 结果 ────────────────────────────────────────────

/**
 * D2 优先级表对应的「来源标签」。
 * 系统应用兜底（`__system__` carrier）专门用 `system_fallback`。
 * `modifier_key` 是 ⌘ 修饰键短路独立 tag（不参与 1-4 排序）。
 */
export type ResolveSource =
  | 'user_pref'
  | 'session_override'
  | 'agent_hint'
  | 'manifest_default'
  | 'system_fallback'
  | 'modifier_key'

/**
 * 「我建议你用这个 App 打开」的单条候选。
 * `appId === SYSTEM_CARRIER_APP_ID` 表示「系统应用兜底」。
 */
export interface ResolveCandidate {
  appId: string
  priority: number
  source: ResolveSource
}

export interface ResolveResult {
  pointer: ResourcePointer
  /** 候选载体按 D2 优先级降序排列；最少 1 个（系统应用兜底永远存在） */
  candidates: ResolveCandidate[]
  /** = candidates[0]，方便调用方 */
  chosen: ResolveCandidate
}

export type OpenOutcomeKind =
  | 'in_space_opened'
  | 'system_app_opened'
  | 'denied_known_bad'
  | 'error'

export interface OpenOutcome {
  outcome: OpenOutcomeKind
  /** outcome=system_app_opened / denied_known_bad / error 时为 null */
  carrierAppId: string | null
  /** outcome=denied_known_bad / error 时填具体原因 */
  errorMessage?: string
  /** D2 优先级表第几层裁决出来的，便于埋点对账 */
  resolveSource: ResolveSource
  /** 总耗时（ms），便于性能预算审计；默认 0（由调用方按需填） */
  durationMs?: number
}

// ─── Adapter 接口（Router 依赖注入点）────────────────────────────────

/**
 * 「系统应用兜底」专用 carrier id。
 *
 * 永远不会有任何 builtin / marketplace App 用这个 id（验证脚本在
 * `scripts/validate-manifest-schema.py` 校验）。Router 内部把它转译为
 * `shellOpenExternal(pointer.raw)` 调用。
 */
export const SYSTEM_CARRIER_APP_ID = '__system__' as const

/**
 * Renderer 端 ContextRegistry 的最小读接口（Router 依赖注入点）。
 *
 * 只需要 lookup 能力——Router 不持有 handler 注册职责，纯读 registry
 * 来确认「这个 appId 真的存在」。
 *
 * 实际实现见
 * `apps/tabtin-electron/src/renderer/src/components/context-space/registry/ContextRegistry.ts`，
 * 但本包不直接 import 它——避免 protocol 层耦合 renderer 层。
 */
export interface ContextRegistryAdapter {
  /** 该 appId 是否有注册的 ContextTypeHandler */
  hasHandlerByAppId(appId: string): boolean
  /** 给定 ContextRefType 字符串，返回所有已注册 handler 的 appId 列表 */
  getAppIdsForType(type: ResourcePointerType): readonly string[]
}

/**
 * 用户偏好 store 的最小接口。实际实现是 zustand store（W4 落地）。
 *
 * 接口分两半（与 D2 优先级表一一对应）：
 *   - `get / set / unset` —— 第 1 层 user_pref（持久化到 localStorage）
 *   - `getSessionOverride` —— 第 2 层 session_override（仅本会话内存，不 persist）
 *
 * `getSessionOverride` 故意为 optional，向后兼容 W2 测试 fixture（FakePreferenceStore
 * 不需要改）。router.open 内部按"options.forceCarrierAppId 显式传入 > store
 * sessionOverride > 不注入"次序处理；resolve() 内对 user_pref 的胜过 session
 * 排序保持不变。
 *
 * 由 W4 `useResourceOpenPreferences` 实现。
 */
export interface ResourceOpenPreferenceStore {
  get(key: string): string | undefined
  set(key: string, carrierAppId: string): void
  unset(key: string): void
  /** D2 第 2 层 session_override 数据源；undefined 等价于"本会话未临时切换" */
  getSessionOverride?(key: string): string | undefined
}

/** 在 Space 内开 tab 的回调接口。实际实现是 useSpaceContextTabsStore.openResourceTab。 */
export interface OpenResourceTabParams {
  type: ResourcePointerType
  id: string
  title?: string
  meta?: Record<string, unknown>
  /**
   * Optional UI tab bucket override. Resource/runtime ownership still uses
   * spaceId; Electron uses this to open resources inside a desktop/conversation
   * tab scope instead of the legacy per-Space tab bucket.
   */
  tabScopeKey?: string | null
  /**
   * Runtime tab stores may support a silent upsert mode. ResourceRouter keeps
   * this as a transport hint only; individual clients decide whether to honor it.
   */
  silent?: boolean
}

export interface OpenResourceTabFn {
  (spaceId: string, params: OpenResourceTabParams): void | Promise<void>
}

/**
 * Electron / daemon runtime injects this to resolve local file artifact pointers.
 *
 * The protocol package intentionally does not know how to read the current
 * Space-bound Agent working_dir or filesystem state. Returning null means
 * "not a local file artifact; continue with normal ResourceRouter params".
 * Throwing turns into outcome='error' so callers can show a small unavailable
 * message instead of falling back to temp or system paths.
 */
export interface LocalFileResourceResolver {
  (ctx: {
    spaceId: string
    pointer: ResourcePointer
  }): OpenResourceTabParams | null | undefined | Promise<OpenResourceTabParams | null | undefined>
}

// ─── 埋点事件契约 ────────────────────────────────────────────────────

/**
 * 当前 router 实际 emit 两种事件名：
 *   - `resource_open.resolved` —— 派发成功（in_space_opened / system_app_opened）
 *   - `resource_open.failed`   —— 派发失败（denied_known_bad / error）
 *
 * 故意未保留"triggered"事件名（W2 已删除）——避免"为将来留扩展点但当前
 * 没人 emit"的过度设计；如未来需要"用户点了但还没决定 carrier 那一刻"
 * 的事件，应当显式扩展枚举 + 同步加 emit 调用，不预埋死枝。
 */
export type ResourceOpenEventName =
  | 'resource_open.resolved'
  | 'resource_open.failed'

export type ResourceOpenTriggerSource =
  | 'chat_markdown'
  | 'open_in_space_tool'
  | 'rich_resource_card'
  | 'user_paste'
  | 'window_open_fallback'

/**
 * 客户端埋点事件单条 payload（与后端
 * `apps/tabtin_django/apps/services/agent_engine/models.py:ResourceOpenEvent`
 * 字段对齐，序列化后 HTTP POST 上报）。
 *
 * 注意：`pointer_id_hash` 不是原始 id——出于隐私考虑用 16 hex 字符的
 * 不可逆同步 hash（djb2 + FNV-1a 双轨拼接，**非 SHA256**——SubtleCrypto
 * async 与 router emit 同步语义不兼容；详见 router.ts:hashPointerId 注释）。
 * 隐私目标是"不让明文 url / 业务 ID 入库"，不要求密码学安全。查询时通过
 * `pointer_scheme + pointer_type` 维度聚合即可，不需要原文。
 *
 * 详见 RFC §8.1 拒绝清单「写死 pointer_id 不 hash」+ harness 总控 §6.2
 * 登记的"RFC §8.1 SHA256 契约修订"项。
 */
export interface ResourceOpenEvent {
  event_name: ResourceOpenEventName
  trigger_source: ResourceOpenTriggerSource

  /** Pointer 维度 */
  pointer_scheme: string
  pointer_type: string | null
  pointer_id_hash: string

  /** D2 优先级 5 层各打 tag */
  hint_app_id: string | null
  resolved_carrier_app_id: string | null
  resolve_source: ResolveSource

  /** Outcome（PRD §6 标准 2 五分支 + 异常 deny） */
  outcome: OpenOutcomeKind

  /** 上下文 */
  space_id: string
  user_id: string
  organization_id: string
  agent_run_id: string | null
  message_id: string | null
  tool_call_id: string | null

  /** 性能 */
  duration_ms: number

  /** 时间戳（ms epoch） */
  ts: number

  /** 错误信息（outcome ∈ {denied_known_bad, error}） */
  error_message?: string

  /** 客户端标识 */
  client: 'electron' | 'daemon' | 'ios' | 'android' | (string & {})
  client_version: string
}
