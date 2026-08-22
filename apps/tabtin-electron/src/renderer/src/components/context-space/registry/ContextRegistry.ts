import type { ReactNode } from 'react'
import type {
  ContainerContext,
  ContextCanvasBuildContext,
  ContextDragPayload,
  ContextItem,
  ContextItemType,
  ContextTabKey,
  ContextTypeHandler,
  DispatchCloseResult,
  DispatchCloseSnapshot,
  DispatchCloseSnapshotProvider,
} from './types'
import type { CanvasPaneContent, CanvasTabKey } from '@stores/useCanvasLayoutStore'
import i18n from '@/i18n'

type AgentExposedHandler = ContextTypeHandler & {
  agent: NonNullable<ContextTypeHandler['agent']>
}

// ：统一 Resolver 上线前的发布线止血名单。这里只控制 Electron 本地 `<apps>`
// 提示词；不会拦截 Agent 主动手写 CLI 命令，执行门控仍留给后续统一 Resolver。
const TEMPORARILY_HIDDEN_AGENT_APP_IDS = new Set([
  'tabsite',
  // UI 仍可能存在，但当前不向 Agent 主动推荐。
  // #8695：tabslide 已恢复进 `<apps>`（CLI `slide` 与 App 选型对齐）；UI 入口仍由
  // #3417 / TABSLIDE_UI_ENABLED 控制。
])

export class ContextRegistry {
  private handlers = new Map<ContextItemType, ContextTypeHandler>()
  /** appId → handler 索引，register() 自动维护 */
  private appIdIndex = new Map<string, ContextTypeHandler>()
  /** 后端 item_type → 前端 ContextItemType 映射，由 register() 自动维护 */
  private backendTypeMap: Record<string, string> = {}
  /** marketplace app 安装状态检查器（由外部注入） */
  private marketplaceInstallChecker: ((appId: string) => boolean) | null = null
  /**
   * `dispatchClose` 契约守卫的状态采集器（由外部注入）。
   * 未注入时守卫退化为 no-op（保持向后兼容；测试可显式注入 mock provider）。
   * 生产入口在 `registry/index.ts` 注入真实 zustand store 快照。
   */
  private closeGuardSnapshotProvider: DispatchCloseSnapshotProvider | null = null

  private isAgentExposedHandler(
    handler: ContextTypeHandler | undefined,
    fallbackType: string,
  ): handler is AgentExposedHandler {
    return !!handler?.agent
      && !TEMPORARILY_HIDDEN_AGENT_APP_IDS.has(handler.appId ?? fallbackType)
  }
  /**
   * 守卫违约的处理模式覆盖（仅供测试）。
   * - `null`（默认）: 走 `import.meta.env` 静态判定（Vite transform 期已固化）
   * - `'throw'`: 强制 throw（模拟 dev/test 环境）
   * - `'warn'`: 强制只 warn（模拟 production 环境）
   *
   * Vite 把 `import.meta.env.DEV` 编译时静态替换，运行时 `vi.stubEnv` 无效，
   * 所以需要这个 instance-level override 让测试覆盖两条分支。
   */
  private closeGuardEnvOverride: 'throw' | 'warn' | null = null

  register(handler: ContextTypeHandler): void {
    this.handlers.set(handler.type, handler)
    const appId = handler.appId || (handler.type as string)
    this.appIdIndex.set(appId, handler)
    const frontendType = handler.type as string
    this.backendTypeMap[frontendType] = frontendType
    for (const alias of handler.backendAliases ?? []) {
      this.backendTypeMap[alias] = frontendType
    }
  }

  /** 注入 marketplace app 安装状态检查器 */
  setMarketplaceInstallChecker(checker: (appId: string) => boolean): void {
    this.marketplaceInstallChecker = checker
  }

  /**
   * 注入 `dispatchClose` 契约守卫的状态采集器。
   *
   * provider 应同步返回当前 space 的 activeKey + tabOrder 快照，用于
   * 在 handler.onClose 调用前后做差异比对，识别违约（擅自改 activeKey / tabOrder）。
   *
   * - 未注入时守卫降级为 no-op（向后兼容，便于纯单元测试免 mock）
   * - 注入后契约违约在 dev/test 环境 throw、生产环境 console.warn
   */
  setCloseGuardSnapshotProvider(provider: DispatchCloseSnapshotProvider | null): void {
    this.closeGuardSnapshotProvider = provider
  }

  /**
   * @internal 仅供测试覆盖 dev/prod 分支。生产/开发代码勿调用。
   */
  __setCloseGuardEnvOverrideForTest(mode: 'throw' | 'warn' | null): void {
    this.closeGuardEnvOverride = mode
  }

  /** 检查 handler 是否对当前用户可见（marketplace app 需要已安装） */
  private isHandlerVisible(handler: ContextTypeHandler): boolean {
    if (!handler.marketplaceApp) return true
    if (!this.marketplaceInstallChecker) return false
    return this.marketplaceInstallChecker(handler.appId || (handler.type as string))
  }

  /** 获取所有已注册且可见的 handler */
  getAllHandlers(): ContextTypeHandler[] {
    return Array.from(this.handlers.values()).filter(h => this.isHandlerVisible(h))
  }

  /** 获取所有已注册的 handler（含不可见的，内部使用） */
  getAllHandlersRaw(): ContextTypeHandler[] {
    return Array.from(this.handlers.values())
  }

  getHandler(type: ContextItemType): ContextTypeHandler | undefined {
    const resolved = (this.backendTypeMap[type] || type) as ContextItemType
    return this.handlers.get(resolved)
  }

  getAppId(type: ContextItemType): string | undefined {
    return this.handlers.get(type)?.appId
  }

  /** 按 appId 查找 handler（O(1)），找不到时返回 undefined */
  getHandlerByAppId(appId: string): ContextTypeHandler | undefined {
    return this.appIdIndex.get(appId)
  }

  buildTabKey(type: ContextItemType, id: string): ContextTabKey {
    return `${type}:${id}` as ContextTabKey
  }

  parseTabKey(tabKey: string): { type: string; id: string } | null {
    const delimiterIndex = tabKey.indexOf(':')
    if (delimiterIndex <= 0) return null
    const type = tabKey.slice(0, delimiterIndex)
    const id = tabKey.slice(delimiterIndex + 1)
    if (!type || !id) return null
    return { type, id }
  }

  getTabLabel(item: ContextItem): string {
    const handler = this.handlers.get(item.type)
    if (handler?.getTabLabel) {
      return handler.getTabLabel(item)
    }
    return item.title || i18n.t('label.untitledTab', { ns: 'context' })
  }

  getTabIcon(item: ContextItem): ReactNode {
    const handler = this.handlers.get(item.type)
    return handler?.getTabIcon ? handler.getTabIcon(item) : null
  }

  getDragPayload(item: ContextItem): ContextDragPayload | null {
    const handler = this.handlers.get(item.type)
    if (handler?.getDragPayload) {
      return handler.getDragPayload(item)
    }
    return { type: item.type as string, id: item.id, title: item.title }
  }

  buildCanvasContent(item: ContextItem, ctx: ContextCanvasBuildContext): CanvasPaneContent | null {
    const handler = this.handlers.get(item.type)
    if (handler?.buildCanvasContent) {
      return handler.buildCanvasContent(item, ctx)
    }
    return { tabKey: item.tabKey }
  }

  getCanvasColor(item: ContextItem, isDark: boolean): string | null {
    const handler = this.handlers.get(item.type)
    return handler?.getCanvasColor ? handler.getCanvasColor(item, isDark) : null
  }

  /**
   * 此 item 是否允许用户主动关闭。
   * handler 未声明 closable 时默认 true（兼容历史行为）。
   *
   * `closable` 优先走 handler（决策权在 handler，不依赖 caller 传 meta）：
   *   - 函数形态：调函数根据 item 算（用于 apphome 区分 orchestration vs 其他 appId）
   *   - boolean：直接返回
   * 兜底兼容：item.meta?.sticky === true 也算不可关闭——历史持久化数据兼容路径。
   */
  isClosable(item: ContextItem): boolean {
    const handler = this.handlers.get(item.type)
    if (handler?.closable !== undefined) {
      const resolved =
        typeof handler.closable === 'function'
          ? handler.closable(item)
          : handler.closable
      if (resolved === false) return false
    }
    if (item.meta?.sticky === true) return false
    return true
  }

  /** 此 item 是否免疫 keepAlive 驱逐。仅在 item 实际启用 keepAlive 时有意义。 */
  isKeepAliveEvictionImmune(item: ContextItem): boolean {
    const handler = this.handlers.get(item.type)
    return Boolean(handler?.keepAliveEvictionImmune)
  }

  /** 此 item 是否应在切换 Tab 后保留 pane 实例。 */
  isKeepAlive(item: ContextItem): boolean {
    const keepAlive = this.handlers.get(item.type)?.keepAlive
    return typeof keepAlive === 'function' ? keepAlive(item) : Boolean(keepAlive)
  }

  getPersistedOnlyPrefixes(): string[] {
    const prefixes: string[] = []
    this.handlers.forEach((handler) => {
      if (handler.persistOnly) {
        prefixes.push(`${handler.type}:`)
      }
    })
    return prefixes
  }

  buildCanvasContentFromDrag(
    tabKey: CanvasTabKey,
    payload: ContextDragPayload,
    ctx: ContextCanvasBuildContext
  ): CanvasPaneContent | null {
    const handler = this.handlers.get(payload.type as ContextItemType)
    if (!handler) return null
    if (handler.buildCanvasContentFromDrag) {
      return handler.buildCanvasContentFromDrag(tabKey, payload, ctx)
    }
    return { tabKey }
  }

  /** 后端 item_type 归一化为前端 ContextItemType */
  normalizeBackendType(backendType: string): string {
    return this.backendTypeMap[backendType] || backendType
  }

  /** 获取类型的产品显示名称（如 'TabData'），未注册时返回 type 本身 */
  getDisplayLabel(type: string): string {
    const resolved = this.backendTypeMap[type] || type
    return this.handlers.get(resolved as ContextItemType)?.displayLabel || resolved
  }

  /** 获取类型的 i18n label key（如 'organization:search.tables'），未注册或无 key 时返回 undefined */
  getDisplayLabelKey(type: string): string | undefined {
    const resolved = this.backendTypeMap[type] || type
    return this.handlers.get(resolved as ContextItemType)?.searchLabelKey
  }

  /** 获取类型的 emoji 图标（如 '📊'），未注册时返回 undefined */
  getDisplayEmoji(type: string): string | undefined {
    const resolved = this.backendTypeMap[type] || type
    return this.handlers.get(resolved as ContextItemType)?.displayEmoji
  }

  /**
   * 获取类型的 Agent-facing 显示名（譬如 "多维表"）—— Agent 跟用户对话时该用的权威名字。
   *
   * 查找优先级：
   *   1. handler.agent.displayName（中文优先，跟用户说话的名字）
   *   2. handler.displayLabel（英文 fallback，譬如 "Tables"）
   *   3. type 内部 key（最后兜底，譬如 "tabdata"——不应该让用户看到，但 Agent 至少能引用）
   *
   * 注意：未声明 `agent` 字段的 handler（系统 tab：tabsettings、bookmarks 等）走 2/3 fallback，
   * 调用方应配合 `getAgentExposedHandlers()` 判断是否要把它纳入 `<apps>` 段。
   */
  getAgentDisplayName(type: string): string {
    const resolved = this.backendTypeMap[type] || type
    const handler = this.handlers.get(resolved as ContextItemType)
    return handler?.agent?.displayName ?? handler?.displayLabel ?? resolved
  }

  /**
   * 获取类型的 Agent-facing 能力描述（≤80 字一句话），用于 `<apps>` 段。
   *
   * 未声明 `agent` 字段的 handler 返回 undefined —— 表示「这是系统 tab，Agent 不需要把它当作
   * 可推荐的 App」。调用方 (`buildAppsSection`) 应跳过此类 handler。
   */
  getAgentCapability(type: string): string | undefined {
    const resolved = this.backendTypeMap[type] || type
    return this.handlers.get(resolved as ContextItemType)?.agent?.capability
  }

  /** 获取可进入 system prompt `<apps>` 清单的 handler。 */
  getAgentExposedHandler(type: string): AgentExposedHandler | undefined {
    const handler = this.getHandler(type)
    return this.isAgentExposedHandler(handler, type) ? handler : undefined
  }

  /**
   * 列出所有「暴露给 Agent」的 handler（声明了 `agent` 且未临时隐藏）—— 用于装配
   * `<apps>` 段。系统 tab（tabsettings / bookmarks / downloads / history）/ 抽象 type（apphome）
   * 不在此列。
   */
  getAgentExposedHandlers(): AgentExposedHandler[] {
    return Array.from(this.handlers.values()).filter(
      (handler): handler is AgentExposedHandler => this.isAgentExposedHandler(handler, handler.type),
    )
  }

  /** 检查类型是否已在 registry 中注册 */
  isKnownType(type: string): boolean {
    const resolved = this.backendTypeMap[type] || type
    return this.handlers.has(resolved as ContextItemType)
  }

  /** 从已注册的 searchable handler 动态生成全局搜索 TYPE_TABS */
  getSearchTypeTabs(): Array<{ key: string; label: string }> {
    const tabs: Array<{ key: string; label: string }> = [
      { key: '', label: 'organization:search.all' },
    ]
    this.handlers.forEach((handler) => {
      if (handler.searchable && handler.searchLabelKey) {
        tabs.push({ key: handler.type as string, label: handler.searchLabelKey })
      }
    })
    return tabs
  }

  /** 从 backendTypeMap 反转生成 前端类型→后端 item_type 列表 映射 */
  getFrontendToBackendTypes(): Record<string, string[]> {
    const result: Record<string, string[]> = {}
    for (const [backend, frontend] of Object.entries(this.backendTypeMap)) {
      if (!result[frontend]) result[frontend] = []
      if (!result[frontend].includes(backend)) {
        result[frontend].push(backend)
      }
    }
    return result
  }

  /** 获取所有声明了 quickAction 的 handler，按注册顺序返回 */
  getQuickActions(): Array<ContextTypeHandler & { quickAction: NonNullable<ContextTypeHandler['quickAction']> }> {
    const actions: Array<ContextTypeHandler & { quickAction: NonNullable<ContextTypeHandler['quickAction']> }> = []
    this.handlers.forEach((handler) => {
      if (handler.quickAction) {
        actions.push(handler as typeof actions[number])
      }
    })
    return actions
  }

  /** 获取所有声明了 appEntryMode 的 handler，按注册顺序返回 */
  getAppEntries(): Array<ContextTypeHandler & { appEntryMode: NonNullable<ContextTypeHandler['appEntryMode']> }> {
    const entries: Array<ContextTypeHandler & { appEntryMode: NonNullable<ContextTypeHandler['appEntryMode']> }> = []
    this.handlers.forEach((handler) => {
      if (handler.appEntryMode) {
        entries.push(handler as typeof entries[number])
      }
    })
    return entries
  }

  /** 获取指定类型的 appMeta 配置（AI Agent 上下文字段映射） */
  getAppMeta(type: ContextItemType): ContextTypeHandler['appMeta'] | undefined {
    return this.handlers.get(type)?.appMeta
  }

  /** 获取所有声明了 aggregateAppId 的 handler 按聚合 ID 分组 */
  getAggregateGroups(): Map<string, string[]> {
    const groups = new Map<string, string[]>()
    this.handlers.forEach((handler) => {
      if (!handler.aggregateAppId) return
      const appId = handler.appId ?? (handler.type as string)
      if (!groups.has(handler.aggregateAppId)) groups.set(handler.aggregateAppId, [])
      groups.get(handler.aggregateAppId)!.push(appId)
    })
    return groups
  }

  // ─── Mention ────────────────────────────────────────────────────

  /** 获取所有声明了 mention 配置的分类，按注册顺序返回 */
  getMentionCategories(): Array<{
    key: string
    label: string
    icon: React.FC<{ className?: string }>
    type: string
    color: string
  }> {
    const cats: Array<{
      key: string; label: string; icon: React.FC<{ className?: string }>; type: string; color: string
    }> = []
    this.handlers.forEach((handler) => {
      if (handler.mention) {
        cats.push({
          key: handler.type as string,
          label: handler.displayLabel || (handler.type as string),
          icon: handler.mention.icon,
          type: handler.type as string,
          color: handler.mention.color,
        })
      }
    })
    return cats
  }

  /** 将后端 item_type 归一化为 MentionItem.type（如 'table', 'document'） */
  normalizeMentionType(backendType: string): string {
    const frontendType = this.normalizeBackendType(backendType)
    const handler = this.handlers.get(frontendType as ContextItemType)
    return handler?.mention?.mentionType || 'document'
  }

  // ─── Attach-to-chat ─────────────────────────────────────────────

  /** 该 type 的 tab 是否声明了「添加到对话」能力 */
  canAttachToChat(type: ContextItemType): boolean {
    return Boolean(this.handlers.get(type)?.attachToChat)
  }

  /**
   * 从 ContextItem 构建可发送到 Chat 的引用描述。
   * 返回 null 表示当前状态无法提取或 handler 未声明 attachToChat。
   */
  buildContextAttachment(item: ContextItem): {
    refType: import('@components/chat/types').ContextRefType
    resourceId: string
    label: string
    meta?: Record<string, unknown>
  } | null {
    const handler = this.handlers.get(item.type)
    if (!handler?.attachToChat) return null
    const built = handler.attachToChat.buildRef(item)
    if (!built) return null
    if (!built.resourceId) return null
    return {
      refType: handler.attachToChat.refType,
      resourceId: built.resourceId,
      label: built.label || item.title || '',
      meta: built.meta,
    }
  }

  // ─── Lifecycle Dispatch ──────────────────────────────────────────

  /** handler 是否声明了 onSelect hook */
  hasOnSelect(type: ContextItemType): boolean {
    return Boolean(this.handlers.get(type)?.onSelect)
  }

  /** 调用 handler 的 onSelect hook（如存在） */
  dispatchSelect(item: ContextItem, ctx: ContainerContext): boolean {
    const handler = this.handlers.get(item.type)
    if (handler?.onSelect) { handler.onSelect(item, ctx); return true }
    return false
  }

  /**
   * 调用 handler 的 beforeClose hook（如存在）。
   * 返回 true 表示允许关闭，返回 false 表示取消关闭。
   * 未声明 beforeClose 的 handler 默认允许关闭。
   */
  async dispatchBeforeClose(item: ContextItem, ctx: ContainerContext): Promise<boolean> {
    const handler = this.handlers.get(item.type)
    if (handler?.beforeClose) {
      return handler.beforeClose(item, ctx)
    }
    return true
  }

  /**
   * 调用 handler 的 onClose hook（如存在），并对契约违约做前置守卫。
   *
   * 契约（详见 `ContextTypeHandler.onClose` 文档）：
   *   handler.onClose 只负责清理自己的资源，**严禁**修改 activeKey / tabOrder。
   *   activeKey 由 useCloseHandlers / ContextSpaceToolHandler 统一计算 fallback，
   *   tabOrder 由调用方显式 closeTab 移除。
   *
   * 守卫策略（D5 仅作用于 onClose，不扩散到其他 lifecycle hook）：
   *   - 调用前后通过 `closeGuardSnapshotProvider` 采集 activeKey + tabOrder
   *   - **真违约**（dev/test throw、prod warn）：
   *       a) 关闭**非 active** tab 却改了 activeKey（handler 抢焦点）
   *       b) tabOrder 出现"非 self.tabKey 的成员/顺序变化"（动了别人的 tab）
   *   - **合法的 source-driven sync**（不报警，但可能 needsClose=false）：
   *       a) 仅 self.tabKey 从 tabOrder 中被移除（无论 handler 直接调 closeTab，
   *          还是通过 source store 删除间接触发 syncTabOrder）。
   *       b) 关闭的就是当前 active tab 时，activeKey 从被销毁的 tab 移走
   *          （BR-28：见下文第 4 点）。
   *
   *       为什么这些情况合法：
   *       1. 结果跟用户预期一致（关掉自身），不影响其他 tab
   *       2. 对调用方语义透明：通过 needsClose=false 让调用方跳过冗余 closeTab
   *       3. 像 browser onClose 这种"必须 await IPC 才能确认 close 成功"+ IPC
   *          内部同步设 _recentlyClosedViewIds 让 useTabSync 立即排除 view 的场景，
   *          await 期间 syncTabOrder 不可避免地会让 tabOrder 在 capture(after)
   *          之前就删了 self.tabKey；这是结构性的，不是 handler 误用
   *       4. **BR-28**：当关闭的恰是 active tab 时，active 必然要从被销毁的 tab
   *          移走——这一步同样由 reactive 同步层（useTabSync 的 stale-active 守卫 /
   *          useActiveKeyGuard）在 onClose 的 await 期间完成，和第 3 点的 removed-self
   *          同源、同样是结构性的，不是 handler 误用。从 before/after 快照无法把它
   *          归因到 handler；且 active 的最终落点由调用方 plannedFallback（第二道防线）
   *          统一裁决，所以这里不把它当违约。**反之**，关闭一个非 active tab 却改了
   *          active = handler 抢焦点，仍属真违约（仍会被抓）。
   *       5. 真违约的二道防线（useCloseHandlers / ContextSpaceToolHandler 在
   *          dispatchClose 后把 active 纠正到 plannedFallback）已经覆盖兜底
   *
   * 返回值（D4）：
   *   - hasHandler: handler 是否声明并执行了 onClose（仅诊断，不应作为决策依据）
   *   - needsClose: 调用方是否仍需 closeTab 兜底
   *     - 默认 true（handler 没动 tabOrder）
   *     - false：handler 已让 self.tabKey 从 tabOrder 移除（source-driven sync 或 prod 降级违约）
   */
  async dispatchClose(item: ContextItem, ctx: ContainerContext): Promise<DispatchCloseResult> {
    const handler = this.handlers.get(item.type)
    if (!handler?.onClose) {
      return { hasHandler: false, needsClose: true }
    }

    const snapshotKey = ctx.tabScopeKey ?? ctx.spaceId
    const before = this.captureCloseGuardSnapshot(snapshotKey)
    await handler.onClose(item, ctx)
    const after = this.captureCloseGuardSnapshot(snapshotKey)

    const guardResult = this.detectCloseGuardViolation(item, before, after)
    if (guardResult?.severity === 'violation') {
      this.reportCloseGuardViolation(item, guardResult)
    }

    return {
      hasHandler: true,
      needsClose: !guardResult?.handlerRemovedFromTabOrder,
    }
  }

  /** 采集 activeKey + tabOrder 快照（未注入 provider 时返回 null，守卫降级为 no-op） */
  private captureCloseGuardSnapshot(spaceId: string): DispatchCloseSnapshot | null {
    const provider = this.closeGuardSnapshotProvider
    if (!provider) return null
    try {
      return provider(spaceId)
    } catch (error) {
      console.warn('[ContextRegistry] closeGuardSnapshotProvider 抛错，本次跳过守卫', { spaceId, error })
      return null
    }
  }

  /**
   * 比对前后两份快照，分类 close-guard 结果。
   *
   * 三类结果：
   *   - null：完全无变化（or provider 未注入）
   *   - severity='sourceSync'：合法的 source-driven sync，不报警。两种形态：
   *     a) 仅 self.tabKey 从 tabOrder 移除（handlerRemovedFromTabOrder=true，
   *        让调用方跳过冗余 closeTab）
   *     b) 关闭的就是 active tab，activeKey 随之从被销毁的 tab 移走（BR-28）
   *   - severity='violation'：真违约 → reportCloseGuardViolation（dev/test throw、prod warn）
   *     a) 关闭**非 active** tab 却改了 activeKey（handler 抢焦点）
   *     b) tabOrder 出现 removed-self 以外的变化（动了别人的 tab）
   *
   * 任一快照为 null（未注入 provider）→ 跳过守卫
   */
  private detectCloseGuardViolation(
    item: ContextItem,
    before: DispatchCloseSnapshot | null,
    after: DispatchCloseSnapshot | null,
  ): {
    severity: 'sourceSync' | 'violation'
    reason: string
    details: Record<string, unknown>
    handlerRemovedFromTabOrder: boolean
  } | null {
    if (!before || !after) return null

    const activeChanged = before.activeKey !== after.activeKey
    const tabOrderDiff = diffTabOrderForCloseGuard(before.tabOrder, after.tabOrder, item.tabKey)

    if (!activeChanged && !tabOrderDiff) return null

    const handlerRemovedFromTabOrder = tabOrderDiff?.kind === 'removed-self'

    // BR-28：关闭的恰是 active tab 时，active 必然要从被销毁的 tab 移走——这一步由
    // reactive 同步层（useTabSync stale-active 守卫 / useActiveKeyGuard）在 onClose 的
    // await 期间完成，和 tabOrder removed-self 同源、同样是结构性的，无法从快照归因到
    // handler，且最终落点由调用方 plannedFallback 统一裁决。因此只有「关闭非 active tab
    // 却改了 active」才算 handler 抢焦点的真违约。
    const closingWasActive = before.activeKey === item.tabKey
    const activeChangedIllegally = activeChanged && !closingWasActive
    const tabOrderMutated = tabOrderDiff?.kind === 'mutated'

    const details: Record<string, unknown> = {
      type: item.type,
      tabKey: item.tabKey,
      activeKeyBefore: before.activeKey,
      activeKeyAfter: after.activeKey,
      tabOrderBefore: before.tabOrder,
      tabOrderAfter: after.tabOrder,
    }

    // 合法的 source-driven sync：removed-self / 关闭 active tab 引发的 active 迁移。
    // （前面 early-return 已排除"完全无变化"，所以这里至少有一项结构性变化。）
    if (!activeChangedIllegally && !tabOrderMutated) {
      return {
        severity: 'sourceSync',
        reason: handlerRemovedFromTabOrder ? 'tabOrder(去除自身)' : 'activeKey(关闭 active tab)',
        details,
        handlerRemovedFromTabOrder,
      }
    }

    // 真违约
    const reasons: string[] = []
    if (activeChangedIllegally) reasons.push('activeKey')
    if (tabOrderDiff) reasons.push(tabOrderDiff.kind === 'removed-self' ? 'tabOrder(去除自身)' : 'tabOrder')

    return {
      severity: 'violation',
      reason: reasons.join(' + '),
      details,
      handlerRemovedFromTabOrder,
    }
  }

  /** dev / test 环境 throw，prod 环境 console.warn */
  private reportCloseGuardViolation(
    item: ContextItem,
    violation: { reason: string; details: Record<string, unknown> },
  ): void {
    const message =
      `[ContextRegistry] handler.onClose 违反契约（修改了 ${violation.reason}）` +
      `: type=${item.type} tabKey=${item.tabKey}` +
      `\nonClose 只能清理自己的资源，不得修改 activeKey / tabOrder（详见 ContextTypeHandler.onClose 文档）`

    const shouldThrow = this.closeGuardEnvOverride
      ? this.closeGuardEnvOverride === 'throw'
      : isContextRegistryDevOrTestEnv()

    if (shouldThrow) {
      const error = new Error(message)
      ;(error as Error & { details?: Record<string, unknown> }).details = violation.details
      throw error
    }
    console.warn(message, violation.details)
  }

  /** 调用 handler 的 onRefresh hook（如存在） */
  dispatchRefresh(item: ContextItem, ctx: ContainerContext): boolean {
    const handler = this.handlers.get(item.type)
    if (handler?.onRefresh) { handler.onRefresh(item, ctx); return true }
    return false
  }

  /**
   * 调用 handler 的 onAfterClose hook（如存在）。
   *
   * 时机：调用方在 `closeTab` / `batchCloseTab` 完成（tabOrder 已删除 self.tabKey）
   * **之后**同步调用，用于清理「会驱动 useTabSync.syncTabOrder 的 source store
   * 条目」（terminal session、browser view 缓存等）。详见 ContextTypeHandler.onAfterClose
   * 文档。
   *
   * 不做契约守卫——因为此时 tabOrder 已是关闭后的状态，handler 通过 source 驱动
   * 的 syncTabOrder 不会再让 tabOrder 偏离。守卫无意义，反而引入噪声。
   *
   * 异常按 try/catch 捕获并 console.warn 转录，避免一个 handler 失败影响其他清理。
   */
  dispatchAfterClose(item: ContextItem, ctx: ContainerContext): void {
    const handler = this.handlers.get(item.type)
    if (!handler?.onAfterClose) return
    try {
      handler.onAfterClose(item, ctx)
    } catch (error) {
      console.warn('[ContextRegistry] handler.onAfterClose 抛错', {
        type: item.type,
        tabKey: item.tabKey,
        error,
      })
    }
  }
}

// ─── Close-guard helpers (module-private) ─────────────────────────────

/**
 * 比对 tabOrder 前后差异。
 *
 * - null: 完全一致（含 undefined === undefined / 引用同址）
 * - { kind: 'removed-self' }: 仅去除了 closingTabKey 自身，其他元素顺序不变
 * - { kind: 'mutated' }: 任何其他变化（增删、重排、修改）
 *
 * 区分"removed-self"是为了让调用方在 prod 降级场景里避免重复 closeTab。
 */
function diffTabOrderForCloseGuard(
  before: readonly string[] | null | undefined,
  after: readonly string[] | null | undefined,
  closingTabKey: string,
): { kind: 'removed-self' | 'mutated' } | null {
  if (before === after) return null
  const beforeArr = before ?? []
  const afterArr = after ?? []
  if (sequenceEqual(beforeArr, afterArr)) return null
  const beforeWithoutSelf = beforeArr.filter(key => key !== closingTabKey)
  if (sequenceEqual(beforeWithoutSelf, afterArr)) return { kind: 'removed-self' }
  return { kind: 'mutated' }
}

function sequenceEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * 判定守卫违约是否应 throw。dev 与 test（vitest）都视为开发期，需要 throw 让 CI 挂掉。
 * 生产构建（`import.meta.env.PROD === true` && `MODE === 'production'`）只 warn。
 */
function isContextRegistryDevOrTestEnv(): boolean {
  const env = (import.meta as { env?: { DEV?: boolean; PROD?: boolean; MODE?: string } }).env
  if (!env) return false
  if (env.DEV === true) return true
  if (env.MODE === 'test' || env.MODE === 'development') return true
  return false
}
