import type { ReactNode } from 'react'
import type { CanvasPaneContent, CanvasTabKey } from '@stores/useCanvasLayoutStore'
import type { CrawlspaceConfig, CrawlspaceViewInfo } from '@stores/useCrawlTabStore'
import type { Table } from '@tabtin/table-core'
import type { SpaceContextItem } from '@tabtin/app-shell'
import type { CreateResourceOptions } from '../hooks/createResourceTypes'

export type ContextItemType =
  | 'apphome'
  | 'tabdata'
  | 'tabdoc'
  | 'tabslide'
  | 'tabcode'
  | 'tabtracker'
  | 'tabweb'
  | 'login_relay'
  | 'tabfolder'
  | 'tabfiles'
  | 'terminal'
  | 'subagent_session'
  | (string & {})

/**
 * 上下文可见性钩子的解析上下文。
 *
 * 用于 `ContextTypeHandler.isVisibleInContext`：handler 据此决定一个 tab
 * 在当前 chat session 视角下是否应展示。典型场景：subagent_session tab
 * 只在父 session 是当前激活 session 时才可见——切走后隐藏（不删）。
 *
 * 字段语义：
 * - spaceId：当前 Space ID（决定 currentSessionIdBySpaceId 的查找口径）
 * - currentSessionId：当前 Space 激活的 chat session ID，`null` 表示首页 / 草稿态
 */
export interface TabKeyResolutionContext {
  spaceId: string
  currentSessionId: string | null
}

export type ContextTabKey = `${string}:${string}`

export type ContextItem = {
  type: ContextItemType
  id: string
  tabKey: ContextTabKey
  title?: string
  meta?: Record<string, unknown>
  /** replaceTabKey 保留的原始 tabKey，用于稳定 React key */
  originTabKey?: string
}

export type ContextDragPayload = {
  type: string
  id: string
  title?: string
  url?: string
  [key: string]: unknown
}

export type ContextCanvasBuildContext = {
  browserTabs: CrawlspaceViewInfo[]
}

export type ContextPaneRenderContext = {
  spaceId?: string | null
  tabScopeKey?: string | null
  crawlspaceId?: string | null
  crawlspaceConfig?: CrawlspaceConfig | null
  isGroupActive?: boolean
  isPaneActive?: boolean
  isVisible?: boolean
  viewInfo?: CrawlspaceViewInfo | null
  onPaneInteraction?: () => void
}

/** resolveTabItem 的上下文：Container 传入持久化数据和公共 ID */
export type ResolveTabContext = {
  spaceId: string
  tabKey: ContextTabKey
  persistedItem?: { title?: string; meta?: Record<string, unknown> } | null
  crawlspaceId?: string | null
}

// ---------------------------------------------------------------------------
// dispatchClose 契约守卫的快照与返回值
// ---------------------------------------------------------------------------

/**
 * `ContextRegistry.dispatchClose` 在 handler.onClose 调用前后采集的快照。
 * 用于守卫识别 handler 是否擅自修改 activeKey / tabOrder。
 */
export interface DispatchCloseSnapshot {
  activeKey: string | null
  tabOrder: readonly string[]
}

/**
 * 守卫快照采集器。
 * - 同步返回当前 space 的快照
 * - 返回 null 表示当前无可用快照（守卫此次降级为 no-op）
 */
export type DispatchCloseSnapshotProvider = (spaceId: string) => DispatchCloseSnapshot | null

/**
 * `dispatchClose` 的返回值（D4 升级：从 `boolean` 改为结构化结果）。
 *
 * - `hasHandler`: handler 是否声明并执行了 onClose
 *   - **仅诊断用，严禁作为是否兜底 closeTab 的决策依据**（请用 `needsClose`）
 *   - 用于日志、指标、`onClose` 的覆盖率统计
 *
 * - `needsClose`: 调用方是否仍需 `closeTab` 把 item.tabKey 从 tabOrder 移除
 *   - 默认 `true`（契约保证 handler 不动 tabOrder）
 *   - 仅当**未 throw 的违约降级路径**（prod warn）且 handler 已自行从 tabOrder 移除 item.tabKey 时为 `false`，避免 consumer 重复 `closeTab` 触发 store self-healing 噪声日志
 *   - **注意**：`needsClose=false` **仅**反映 tabOrder 状态，不代表 activeKey 已正确切换；
 *     consumer 仍需走"第二道防线"——`if (postActive !== plannedFallback) setActiveKey(...)`
 */
export interface DispatchCloseResult {
  hasHandler: boolean
  needsClose: boolean
}

/** Container 传给 handler lifecycle hooks 的上下文 */
export type ContainerContext = {
  spaceId: string
  /** 当前 UI 标签组 scope；资源/权限仍使用 spaceId。 */
  tabScopeKey?: string | null
  crawlspaceId?: string | null
  /**
   * 关闭浏览器视图。仅 browser handler 使用。
   *
   * 调用方实现策略：
   * - UI 侧（SpaceContextContainer）：乐观更新 → IPC 关闭 → 失败时回滚 + toast
   * - Tool 侧（ContextSpaceToolHandler）：直接 IPC 关闭（无乐观更新，由 ToolHandler 管理 nextActiveTabKey）
   */
  closeBrowserView: (
    crawlspaceId: string,
    viewId: string
  ) =>
    | Promise<{ ok: boolean; code?: string; message?: string }>
    | { ok: boolean; code?: string; message?: string }
    | void
}

// ---------------------------------------------------------------------------
// Home Section（App 驱动的资源面板）
// ---------------------------------------------------------------------------

/**
 * 每个 App 通过注册 HomeSectionHandler 声明自己在 ContextHome 资源面板中展示什么。
 * tabs = "最近" + 按 order 排序的已注册 App sections。
 */
export interface HomeSectionHandler {
  /** 对应的 App ID（与空间启用应用配置中的 id 对齐） */
  appId: string
  /** 分栏标签的 i18n key */
  labelKey: string
  /** 渲染分栏内容的 React 组件 */
  Component: React.FC<HomeSectionProps>
  /**
   * 独立 apphome 标签页渲染策略（仅影响 apphomeHandler.renderPane）。
   *
   * - `true`：包裹完整的 `<ContextHome forcedAssetTab={appId} />`，带工具栏 / 视图模式切换 /
   *   置顶面板等全功能容器。适合"以资源列表为核心"的 App（tabdoc / tabdata / tabslide /
   *   tabvideo / tabwhiteboard / tabsite / tabfolder 等），独立打开 App 标签页时
   *   用户期望看到完整的资源管理体验。
   * - `false`（默认）：直接渲染 Section 自身的 Component，提供轻量、紧凑的视图。
   *   适合 TabPhone 这类设备/工具型 App，资源列表只是次要信息。
   *
   * 历史背景：之前在 apphome.tsx 中维护了一份硬编码白名单 `RESOURCE_TYPE_APPS`，
   * 新增 App 的同事很容易漏掉，导致独立 apphome 视图行为不一致（DM-064 / 此前 TabPhone bug）。
   * 现改为由 Section 自身显式声明，避免遗漏。
   */
  renderInsideContextHome?: boolean
  /**
   * 独立 apphome 标签页的图标（仅影响 apphomeHandler.getTabIcon）。
   *
   * 未声明时按既有链路兜底：App handler 的 displayEmoji → Home 图标。
   * 像「云盘」这类没有对应 App handler（无 displayEmoji）的聚合首页，
   * 不声明就会落到 Home 兜底，与侧边栏入口的图标不一致——由 Section
   * 自身声明与侧边栏同款图标（声明式，避免在 apphome.tsx 里硬编码 appId）。
   */
  tabIcon?: React.ReactNode
}

/**
 * 所有 HomeSection 组件都会收到的基础 props。
 */
export interface HomeSectionBaseProps {
  spaceId: string
  /** 当前 UI 标签组 scope；打开 tab 时优先使用，资源/业务归属仍使用 spaceId。 */
  tabScopeKey?: string | null
  /** 独立 apphome 标签页的 key；供内嵌工作表面上报瞬时文件焦点。 */
  contextTabKey?: ContextTabKey | null
  /** 通用资源创建回调：传入 appId 即可触发对应 App 的新建流程 */
  onCreateResource: (appId: string, options?: CreateResourceOptions) => void
  /** 视图模式：列表 / 宫格（由 ContextHome 传入） */
  viewMode?: import('./homeSections/HomeGridCard').HomeViewMode
  /** 统一资源跳转，支持跨 Space 资源 */
  onSearchNavigate?: (item: SpaceContextItem) => void | Promise<void>
}

/** 表格相关 props — tabdata / orchestration 等需要表格列表的 Section 使用 */
export interface HomeSectionTableProps {
  tables: Table[]
  isLoading: boolean
  error: string | null
  onTableClick: (table: Table) => void
}

/**
 * 完整 props（向后兼容）。
 * ContextHome 统一构造此类型并传给各 Section，各 Section 只解构自己需要的字段。
 *
 * 历史：曾有 HomeSectionFolderProps（onOpenFolder / onOpenAgentFolder /
 * onFolderTabOpen / invalidFolderIds）专供 folder / tabcode HomeSection 用，
 * 单根契约下 TabCode / TabFolder 不再有独立 HomeSection（改为由 Orchestration
 * HomeSection 按 working_dir_type 内嵌渲染），整组 props 已移除。
 */
export type HomeSectionProps = HomeSectionBaseProps &
  Partial<HomeSectionTableProps>

// ---------------------------------------------------------------------------
// Context Type Handler（打开某个资源后怎么渲染 tab）
// ---------------------------------------------------------------------------

export interface ContextTypeHandler {
  type: ContextItemType
  appId?: string
  /** If true, tabs of this type have no live context source and are preserved
   *  purely from the persisted tabOrder. Without this flag, syncTabOrder will
   *  remove such tabs when switching away. */
  persistOnly?: boolean
  /**
   * 渲染模式（默认 'pane'）:
   * - 'persistent': 由独立的持久层渲染（PersistentTableTabs / CrawlspaceWorkspace 等），
   *   mainContent 返回 null。适用于需要跨标签切换保持进程/状态的 App（tabdata/tabweb/terminal）
   * - 'pane': 由 handler.renderPane 渲染到 mainContent 中（默认值，大多数 App 使用此模式）
   */
  renderMode?: 'persistent' | 'pane'
  /** 用于搜索结果、Recent 列表等场景的产品名称（如 'TabData'） */
  displayLabel?: string
  /** 用于搜索结果等场景的 emoji 图标（如 '📊'） */
  displayEmoji?: string
  /** 后端可能使用的 item_type 别名（如 ['table']），注册时自动写入 backendTypeMap */
  backendAliases?: string[]
  /** marketplace app 标记：为 true 时仅在 App 已安装时可见 */
  marketplaceApp?: boolean
  /**
   * 此 type 的 Tab 是否允许用户主动关闭（默认 true）。
   * 声明 false 时 NormalTab 不渲染 X 按钮、批量关闭也跳过。
   * 典型用例：虚拟 Tab（如 desktop_tab 桌面主页），始终存在于渲染层，
   * "关闭"语义由其它机制承载（切回普通 tab / 退出虚拟 surface 等）。
   *
   * **函数形态**：当 type 的子分类（如 apphome 的不同 appId）需要不同 closable
   * 策略时，可声明为 `(item) => boolean`。例如 apphome handler 让 Orchestration
   * 起始页不可关闭，其他 apphome（TabCode、TabFolder 主页等）允许关闭——避免
   * 把决策权下放到 caller 的 meta.sticky 自由键。
   */
  closable?: boolean | ((item: ContextItem) => boolean)
  /**
   * keepAlive=true 的 Tab 是否免疫驱逐（默认 false）。
   * paneOverlays 在 inactive keepAlive tab 数 ≥ MAX_KEEP_ALIVE_TABS 时会按
   * 最近活跃时间驱逐最旧的；声明 immune 后该 type 的 Tab 始终留在挂载列表。
   * 仅当 keepAlive=true 时该字段才有意义。
   */
  keepAliveEvictionImmune?: boolean
  /**
   * 标记此 type 的 tab 依赖「Space 内具名资源」存在性。
   *
   * 设为 true 后，restore 阶段会校验 `item.id` 是否仍存在于 Space 的
   * UnifiedResources（按 item_type 索引的 resource_id 集合）中：
   *   - 资源在 → tab 保留为 valid
   *   - 资源不在 + 资源列表已加载完成 → tab 标 stale（自动清理）
   *   - 资源列表还在加载 → 维持 unknown（保守策略，防止误删）
   *
   * 适用场景：tabdata / tabdoc / tabslide 等「打开后 tab id 即资源 id」的类型。
   * 不适用：tabweb（id 是 viewId 不是后端资源）、tabcode（id 是 path）、terminal（id 是 sessionId）。
   *
   * 默认 false（保守不校验）。
   */
  requireResourceMembership?: boolean
  /** 嵌入式 Web App 配置：声明后平台自动提供 crawlspace 打开/去重/同步能力 */
  embeddedWeb?: {
    baseUrl: string
    sessionMode?: string
  }
  /** 是否在全局搜索 (Cmd+K) 中显示为可筛选的类型 Tab */
  searchable?: boolean
  /** 全局搜索 Tab 的 i18n label key（如 'organization:search.tables'） */
  searchLabelKey?: string
  /** Quick Action 配置：声明后会出现在 ContextHome 的快速创建按钮区 */
  quickAction?: {
    icon: ReactNode
    /** 完整 label 的 i18n key（如 "新建表格" / "New Table"） */
    labelKey: string
    /** 短 label 的 i18n key（如 "表格" / "Table"），用于按钮区的紧凑展示 */
    shortLabelKey?: string
  }
  /**
   * @提及（Mention）配置：声明后会出现在 MentionPopover 的分类列表中。
   * - icon: 分类图标组件
   * - color: Tailwind 颜色类（如 'text-accent bg-accent/10'）
   * - mentionType: 映射到 MentionItem.type（如 'table', 'document'），
   *   用于 normalizeType 归一化
   */
  mention?: {
    icon: React.FC<{ className?: string }>
    color: string
    mentionType: string
  }
  /**
   * 「添加到对话」配置：声明后该 type 的 tab 可被用户通过右键菜单 / @ 选择
   * 添加为 Chat 的上下文引用。
   *
   * 设计原则（轻量）：
   * - 不预取内容，只输出资源 ID + 元数据，由 Agent 自主决定调工具读详情
   * - resourceId 必须是 Agent 工具能直接消费的稳定 ID（如 table_id / URL / device_id）
   *
   * 未声明则该 type 的 tab 在右键菜单里显示为禁用项。
   */
  attachToChat?: {
    /** 输出到 Chat 的引用类型（决定 ContextChip 的图标/颜色和后端 resolver 走哪条分支） */
    refType: import('@components/chat/types').ContextRefType
    /**
     * 从 ContextItem 构建一个 ContextRef 描述。
     * 返回 null 表示当前 item 状态下无法提取（如浏览器还在加载，没拿到 url）。
     */
    buildRef: (item: ContextItem) => {
      resourceId: string
      label: string
      meta?: Record<string, unknown>
    } | null
  }
  /**
   * Agent-facing 元信息 —— 跟 LLM 对话时的「权威 App 身份」。
   *
   * 不与 UI 层的 `displayLabel` / i18n `labelKey` 直接关联：UI 显示走 i18n，
   * Agent 看到的 prompt 内容由本字段 SSoT 化。如果产品决策上希望统一 UI
   * 显示名和 Agent 显示名，可以把 i18n label 跟本字段同源（推荐）。
   *
   * 缺省（未声明）的 handler 表示「这是一个内部 / 系统 tab，不暴露给 Agent」
   * —— Agent 看到这种 tab 时只显示 type + title，不会进入 <apps> 段。
   *
   * 设计原则：
   * - displayName：跟用户说话用的名字（中文优先），而不是内部类型名。
   *   Agent 把它当用户对话措辞的权威。
   * - capability：≤80 字一句话能力描述。Agent 在用户问「你能做什么」时
   *   按 <apps> 段直接读出来；要写**具体可操作的能力**，不要营销话术。
   * - aliases：用户口语中可能怎么称呼这个 App，喂给 Agent 帮它理解用户消息。
   */
  agent?: {
    /** Agent 跟用户对话时的权威显示名。优先于 displayLabel / type 内部 key。 */
    displayName: string
    /** 一句话能力描述（≤80 字），用于 system prompt 的 `<apps>` 段。 */
    capability: string
    /** 用户口语别名，可选。譬如 ['记事本', '便签', 'notes']。 */
    aliases?: readonly string[]
    /**
     * 真实顶层 CLI 命令名（`tabtin <cliKey> ...`），仅当它与 `backendAliases[0]`
     * 不一致时才需显式声明。
     *
     * 背景：`<apps>` 段的 cliKey 默认取 `backendAliases[0]`，但 backendAliases 同时
     * 承担「后端 item_type 别名」职责——对 tabdoc(`document`) / tabslide(`ppt`) /
     * tabfiles(`tabfiles`) 等 App，item_type 别名与真实 CLI 命令（`doc`/`slide`/`file`）
     * 不同（见 ）。声明本字段让 `toEnabledAppInfo` 优先用真实命令名，既让
     * `(CLI: x)` 提示正确，也让 host 能按它从 `tabtin commands` 分组出真实子命令。
     * 缺省时回落 `backendAliases[0]`（对 table/memo/video/browser/code 等一致的 App 无需声明）。
     */
    cliKey?: string
  }
  /**
   * AI Agent 上下文字段映射。ChatPanel 据此构建 activeAppMeta 注入 agent state。
   * - 标准模式：{ idField, titleField? } — 自动用 item.id 和 item.title 填充
   * - 自定义模式：提供 resolve 函数完全接管字段生成（如 tabweb 需从 crawl store 读取 url）
   *   当 resolve 存在时 idField/titleField 被忽略
   */
  appMeta?: {
    idField: string
    titleField?: string
    resolve?: (item: ContextItem) => Record<string, unknown> | null
    /**
     * 声明式响应依赖：宿主根据此规格在顶层订阅 store，
     * 当声明的 key 变化时自动重新计算 resolve。
     * 不是 hook，是纯数据声明。
     */
    metaDeps?: {
      /** tab meta 中哪些 key 变化时需要重算 resolve */
      tabMetaKeys?: string[]
      /** 是否需要订阅对应 crawl view 的 URL 变化 */
      useCrawlViewUrl?: boolean
      /** 是否需要订阅对应 crawl view 的标题变化 */
      useCrawlViewTitle?: boolean
      /**
       * 是否需要订阅 table-core ViewStore 的 currentViewId 变化（仅 tabdata 用）。
       * 声明 true 后，用户切换视图（点 ViewSwitcher）能立即触发 activeAppMeta 重算 + syncContext。
       */
      useViewStoreId?: boolean
    }
  }
  /**
   * 从 tabKey 解析出的 { type, id } 恢复完整 ContextItem（标题、meta 等）。
   * Container 在构建 contextItemByTabKey 时优先调用此方法，未声明时走通用 fallback。
   * handler 可通过 ctx.persistedItem 获取持久化数据，或通过自己已 import 的 store 读取实时数据。
   */
  resolveTabItem?: (id: string, ctx: ResolveTabContext) => ContextItem | null

  // ─── Lifecycle Hooks ──────────────────────────────────────────────
  // 由 ContainerContext 传递运行时上下文，handler 内部通过 getState() 访问所需 store

  /**
   * 关闭前拦截钩子（异步）。返回 true 允许关闭，返回 false 取消关闭。
   * 典型场景：TabPhone 关闭前检查模拟器状态并弹窗确认。
   * 未提供时默认允许关闭（等价于返回 true）。
   */
  beforeClose?: (item: ContextItem, ctx: ContainerContext) => Promise<boolean>

  /**
   * 用户选中此 tab 时的回调。
   * 提供时替代默认的 setActiveKey 行为，handler 需自行负责激活标签。
   * 未提供时 Container 默认调用 setActiveKey(spaceId, item.tabKey)。
   */
  onSelect?: (item: ContextItem, ctx: ContainerContext) => void
  /**
   * 用户关闭此 tab 时的回调。
   *
   * 🚨 契约：**只清理不影响 source items 的资源**（销毁 WebContentsView、kill PTY、
   * 推送 closedTabsStore、清理 split layout / pane status 等）。
   *
   * 严禁在此：
   *   1. 直接修改 activeKey / tabOrder（由 useCloseHandlers 统一计算 fallback）
   *   2. 删除 source store 里对应的资源条目（如 sessionsBySpace / viewList），
   *      这会让 useTabSync 同步反推 tabOrder，间接违约。**清这种条目用 `onAfterClose`**。
   *
   * 未提供时 Container 默认从 tabOrder 中移除 item.tabKey。
   *
   * 返回值 void | Promise<unknown>：
   * - UI 侧（useCloseHandlers）会 `await` 返回的 Promise，待资源销毁再做 fallback 纠正
   * - Tool 侧（ContextSpaceToolHandler）同样 `await`，用于编排后续动作
   */
  onClose?: (item: ContextItem, ctx: ContainerContext) => void | Promise<unknown>
  /**
   * `closeTab` 完成（tabOrder 已删除 self.tabKey）之后的最终清理钩子。
   *
   * 设计目的：handler 有时需要从「会驱动 useTabSync.syncTabOrder 的 source store」
   * 中删除资源（典型：terminal 的 sessionsBySpace、browser 的 view list 缓存），
   * 这种删除会通过 source items → currentTabKeys → syncTabOrder 间接动 tabOrder。
   *
   * 如果在 onClose 里做 → 守卫快照看到 tabOrder 减少 self.tabKey → 误报违约。
   * 放到 onAfterClose 里做 → 此时 closeTab 已显式删过，syncTabOrder 看 tabOrder 与
   * currentTabKeys 一致，不会再动 tabOrder，也不会被守卫拦下。
   *
   * 时机：useCloseHandlers / batch close 在 `closeTab` / `batchCloseTab` 调用完成后
   * 同步触发，处于同一个 sync render 闭环内——UI 不会出现"删了又被加回"的中间帧。
   *
   * 与 `onClose` 的分工：
   *   - onClose：销毁不会触发 source 同步的资源（kill PTY、push closedTabs、清 split layout 等）
   *   - onAfterClose：清 source store 条目（让 portal layer 走 dispose 路径等）
   */
  onAfterClose?: (item: ContextItem, ctx: ContainerContext) => void
  /**
   * 用户刷新此 tab 时的回调。
   * 未提供时该 tab 的刷新操作为 no-op。
   */
  onRefresh?: (item: ContextItem, ctx: ContainerContext) => void

  /**
   * 提供非 tabOrder 来源的额外 items（如 browser 的 crawlspace viewList）。
   * ToolHandler 在 tabOrder 解析后遍历所有 handler 收集补充 items。
   */
  getSourceItems?: (ctx: { crawlspaceId?: string | null }, existingKeys: Set<string>) => ContextItem[]

  /** 是否支持浏览器专属操作（后退/前进/查找/缩放）。仅 browser handler 声明为 true。 */
  hasBrowserActions?: boolean
  /**
   * pane 预挂载策略（仅对 renderMode === 'pane' 的 handler 有效）。
   * - true: 即使非活动也保持挂载（block/hidden），适用于有内部状态的面板（如 folder 文件树）
   * - false/默认: 仅在活动时渲染
   * - 函数: 按 item 的子类型决定，例如 apphome 只保活工作空间目录起始页
   */
  keepAlive?: boolean | ((item: ContextItem) => boolean)
  /**
   * keepAlive inactive 时的挂起策略：
   * - `activity`（默认）：`<Activity mode="hidden">`，effect cleanup（含 Collab disconnect）
   * - `visibility`：仅 CSS/`aria-hidden`/inert 隐藏，不 cleanup effects，保留 Y.Doc
   *
   * LRU 驱逐与真实关 tab 仍会 unmount。仅 TabDoc 等强依赖长连接的类型声明 visibility。
   */
  keepAliveSuspendMode?: 'activity' | 'visibility'

  /**
   * 上下文可见性钩子（subagent_session 这类「按当前 chat session 过滤」的 tab 用）。
   *
   * 三集合分离（PRD §4.3）：
   * - `tabOrder` / `currentTabKeys`：全量持久化，跨 session 仍保留——`syncTabOrder` 用这一份
   * - `visibleTabKeys`：UI 用，过滤后——`paneItems` / `ContextTabs` / `pickFallbackTabKey` /
   *   `useChatPanelContext.openTabs` 等消费它
   *
   * 此钩子作用在 `currentTabKeys → visibleTabKeys` 的过滤层：返回 false 的 tab 被隐藏
   * 但仍保留在 tabOrder 与 itemsBySpace 中。
   *
   * 缺省（未声明）→ tab 始终可见，等价于固定返回 true。
   */
  isVisibleInContext?: (item: ContextItem, ctx: TabKeyResolutionContext) => boolean

  /**
   * 从「全部资源」列表点击跳转后的后置回调。
   * 用于单面板类型（tins/tabphone 等）在 openResource 打开面板后，
   * 根据 metadata 中携带的具体 ID 选中对应条目。
   * 未提供时无后置动作。
   */
  onNavigateFromList?: (metadata: Record<string, unknown>) => void

  /**
   * 「应用」Tab 中的入口模式：
   * - 'panel': 点击直接打开该 App 的面板（单例 App，如 tabphone/tabtracker/tabmail）
   * - 'resources': 点击展示该 App 的资源列表（如 tabdata/tabdoc/tabslide）
   * - 'create': 点击直接创建新实例（如 tabweb/terminal）
   * 未声明时不出现在「应用」列表中。
   */
  appEntryMode?: 'panel' | 'resources' | 'create'

  /**
   * 聚合入口 ID。声明后，该 App 的打开标签会同时归入指定的聚合入口下展示。
   * 例如 tabdata/tabdoc/tabslide/tabvideo 声明 `aggregateAppId: 'cloud-resources'`，
   * 侧边栏会在 content 组之前渲染一个「云资源」聚合行，展开时显示所有这些类型的打开标签。
   */
  aggregateAppId?: string

  /**
   * panel 类 App 在桌面 Tab drill-down 时渲染的侧栏组件。
   * 声明后 DesktopPanel 会自动发现并渲染，无需硬编码映射。
   */
  sidebarPanel?: React.LazyExoticComponent<React.FC<{
    spaceId: string
    tabScopeKey?: string
    /** Skill 市场「去管理」等入口：打开面板后锚定到该 skill */
    focusSkillKey?: string
    focusAt?: number
  }>>

  getTabLabel?: (item: ContextItem) => string
  getTabIcon?: (item: ContextItem) => ReactNode
  getDragPayload?: (item: ContextItem) => ContextDragPayload | null
  buildCanvasContent?: (item: ContextItem, ctx: ContextCanvasBuildContext) => CanvasPaneContent | null
  buildCanvasContentFromDrag?: (
    tabKey: CanvasTabKey,
    payload: ContextDragPayload,
    ctx: ContextCanvasBuildContext
  ) => CanvasPaneContent | null
  renderPane?: (item: ContextItem, ctx: ContextPaneRenderContext) => ReactNode
  getCanvasColor?: (item: ContextItem, isDark: boolean) => string | null
  /**
   * 预热此 type 的 renderPane lazy chunk（与 renderPane 内 React.lazy 共用同一个
   * `import()`）。声明后，启动恢复会话时 prefetchPersistedTabPanes 会在首帧之后的
   * idle 窗口提前触发对应 chunk 下载/编译，让被恢复的活动 Tab 挂载时不再闪
   * Suspense fallback（"跳 loading"）。
   *
   * 仅对有重量级 lazy renderPane 的 handler 声明；轻量 pane 不声明即可（驱动会跳过）。
   * 实现约束：必须复用 renderPane 中 React.lazy 的同一个 loader 函数引用，避免出现
   * 第二份 import 路径导致漂移。
   */
  prefetch?: () => Promise<unknown>
}
