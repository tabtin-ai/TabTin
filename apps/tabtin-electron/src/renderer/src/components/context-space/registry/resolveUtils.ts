import { contextRegistry, homeSectionRegistry } from './instance'
import type { ContextItem, ContextTabKey, ContextTypeHandler, HomeSectionHandler, ResolveTabContext } from './types'
import i18n from '@/i18n'

/**
 * 统一的 tabKey → ContextItem 解析核心逻辑。
 *
 * 优先使用 handler.resolveTabItem（从 store 读取实时数据），
 * 返回 null 时由调用方提供 fallback（如 persisted 数据或默认标题）。
 *
 * 目前主要被 ContextSpaceToolHandler 消费，Container 可按需复用。
 */
export function resolveTabItemCore(
  type: string,
  id: string,
  ctx: ResolveTabContext,
): ContextItem | null {
  const handler = contextRegistry.getHandler(type)
  if (handler?.resolveTabItem) {
    return handler.resolveTabItem(id, ctx) ?? null
  }
  return null
}

/**
 * 从 tabKey 解析出 type/id 并构建 ResolveTabContext。
 * 返回 null 表示 tabKey 无效。
 */
export function parseAndResolve(
  tabKey: string,
  spaceId: string,
  opts: {
    persistedItem?: ResolveTabContext['persistedItem']
    crawlspaceId?: string | null
  } = {},
): ContextItem | null {
  const parsed = contextRegistry.parseTabKey(tabKey)
  if (!parsed) return null
  return resolveTabItemCore(parsed.type, parsed.id, {
    spaceId,
    tabKey: tabKey as ContextTabKey,
    persistedItem: opts.persistedItem ?? null,
    crawlspaceId: opts.crawlspaceId,
  })
}

// ---------------------------------------------------------------------------
// App Home Tab Model — single source of truth
// ---------------------------------------------------------------------------

export interface AppHomeTabModel {
  appId: string
  /** 当前语言环境下的显示标题（始终实时翻译） */
  title: string
  /** i18n key（有 HomeSectionHandler 时非 null），用于持久化 */
  labelKey: string | null
  /** handler 上的语言无关产品名（如 'TabDoc'），无 handler 时退化为 appId */
  displayLabel: string
  displayEmoji: string | null
  section: HomeSectionHandler | null
  sidebarPanel: ContextTypeHandler['sidebarPanel'] | null
}

/**
 * 给定 appId，返回 apphome 标签的完整展示模型。
 *
 * 持久化策略：写入方把 labelKey 存入 meta，读取方始终用 labelKey
 * 实时翻译 title，语言切换后自动跟随。
 */
export function resolveAppHomeTabModel(
  appId: string,
  persisted?: { title?: string; meta?: Record<string, unknown> } | null,
): AppHomeTabModel {
  const section = homeSectionRegistry.get(appId) ?? null
  const appHandler = contextRegistry.getHandlerByAppId(appId) ?? null

  const labelKey = section?.labelKey ?? null
  const displayLabel = appHandler?.displayLabel ?? appId
  const displayEmoji = appHandler?.displayEmoji
    ?? (typeof persisted?.meta?.displayEmoji === 'string' ? persisted.meta.displayEmoji : null)

  // 无 section.labelKey 时优先走 appName.*（实时语言），避免把模块加载时写死的
  // 英文 displayLabel / 已持久化的 "Directories" 粘在标签上（tabfolder 本地目录）。
  const localizedAppName = i18n.t(`appName.${appId}`, {
    ns: 'context',
    defaultValue: '',
  })
  const title = labelKey
    ? i18n.t(labelKey, { ns: 'context' })
    : (localizedAppName || persisted?.title || displayLabel)

  return {
    appId,
    title,
    labelKey,
    displayLabel: localizedAppName || displayLabel,
    displayEmoji,
    section,
    sidebarPanel: appHandler?.sidebarPanel ?? null,
  }
}
