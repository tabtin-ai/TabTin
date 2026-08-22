/**
 * OrganizationTabManager - 组织 Tab 与 View 的关系管理
 *
 * 核心职责：
 * 1. 维护 Tab → Views 的 1:N 映射关系
 * 2. 维护 View → Tab 的反向索引（用于链接拦截）
 * 3. 提供 View 元数据查询接口
 *
 * 设计原则：
 * - 轻量级：只存储映射关系，不管理 View 的生命周期
 * - 单例模式：全局唯一实例
 * - 类型安全：所有方法都有完整的类型定义
 */


import { createLogger } from '../logger'

const log = createLogger('OrganizationTabManager')

/**
 * View 元数据
 */
export interface ViewMetadata {
  title: string
  url: string
  favicon?: string
  runId?: string
  createdAt: number
}

/**
 * OrganizationTabManager 单例类
 */
export class OrganizationTabManager {
  private static instance: OrganizationTabManager | null = null

  /** Tab → Views 映射 */
  private tabToViews = new Map<string, Set<string>>()

  /** View → Tab 反向索引 */
  private viewToTab = new Map<string, string>()

  /** View 元数据 */
  private viewMetadata = new Map<string, ViewMetadata>()

  private constructor() {
    log.info('初始化完成')
  }

  /**
   * 获取单例实例
   */
  public static getInstance(): OrganizationTabManager {
    if (!OrganizationTabManager.instance) {
      OrganizationTabManager.instance = new OrganizationTabManager()
    }
    return OrganizationTabManager.instance
  }

  /**
   * 注册 View 到 Tab
   *
   * @param tabId Tab ID（组织 ID）
   * @param viewId View ID
   * @param metadata View 元数据
   */
  public registerView(tabId: string, viewId: string, metadata: ViewMetadata): boolean {
    const existingTabId = this.viewToTab.get(viewId)
    if (existingTabId && existingTabId !== tabId) {
      log.error('❌ View 已绑定其他 Tab，拒绝覆盖:', {
        viewId,
        tabId,
        existingTabId
      })
      return false
    }

    log.debug('📝 注册 View:', { tabId, viewId, title: metadata.title })

    // 初始化 Tab 的 View 集合
    if (!this.tabToViews.has(tabId)) {
      this.tabToViews.set(tabId, new Set())
    }

    // 添加到集合
    this.tabToViews.get(tabId)!.add(viewId)

    // 建立反向索引
    this.viewToTab.set(viewId, tabId)

    // 存储元数据
    this.viewMetadata.set(viewId, metadata)

    log.debug('✅ View 注册完成:', {
      tabId,
      viewId,
      totalViews: this.tabToViews.get(tabId)!.size
    })
    return true
  }

  /**
   * 注销 View
   *
   * @param viewId View ID
   */
  public unregisterView(viewId: string): void {
    const tabId = this.viewToTab.get(viewId)

    if (!tabId) {
      log.warn('⚠️  View 未注册，跳过注销:', viewId)
      return
    }

    log.debug('📝 注销 View:', { tabId, viewId })

    // 从 Tab 的 View 集合中移除
    this.tabToViews.get(tabId)?.delete(viewId)

    // 如果该 Tab 没有 View 了，清理映射
    if (this.tabToViews.get(tabId)?.size === 0) {
      this.tabToViews.delete(tabId)
      log.debug('🗑️  Tab 已无 View，清理映射:', tabId)
    }

    // 删除反向索引
    this.viewToTab.delete(viewId)

    // 删除元数据
    this.viewMetadata.delete(viewId)

    log.debug('✅ View 注销完成:', viewId)
  }

  /**
   * 查找 View 所属的 Tab
   *
   * @param viewId View ID
   * @returns Tab ID 或 null
   */
  public getTabByView(viewId: string): string | null {
    return this.viewToTab.get(viewId) || null
  }

  /**
   * 获取 Tab 的所有 View
   *
   * @param tabId Tab ID
   * @returns View ID 列表
   */
  public getViewsByTab(tabId: string): string[] {
    return Array.from(this.tabToViews.get(tabId) || [])
  }

  /**
   * 获取 View 的元数据
   *
   * @param viewId View ID
   * @returns View 元数据或 null
   */
  public getViewMetadata(viewId: string): ViewMetadata | null {
    return this.viewMetadata.get(viewId) || null
  }

  /**
   * 更新 View 元数据
   *
   * @param viewId View ID
   * @param updates 要更新的字段
   */
  public updateViewMetadata(viewId: string, updates: Partial<ViewMetadata>): void {
    const existing = this.viewMetadata.get(viewId)

    if (!existing) {
      log.warn('⚠️  View 元数据不存在，无法更新:', viewId)
      return
    }

    this.viewMetadata.set(viewId, { ...existing, ...updates })
    log.debug('✅ View 元数据已更新:', { viewId, updates })

  }

  /**
   * 检查 Tab 是否为组织标签
   *
   * @param tabId Tab ID
   * @returns 是否为组织标签
   */
  public isOrganizationTab(tabId: string): boolean {
    if (!tabId) {
      return false
    }
    if (tabId.startsWith('cs-')) {
      return true
    }
    return this.tabToViews.has(tabId)
  }

  /**
   * 检查 View 是否属于某个组织
   *
   * @param viewId View ID
   * @returns 是否属于组织
   */
  public isOrganizationView(viewId: string): boolean {
    const tabId = this.viewToTab.get(viewId)
    return tabId ? this.isOrganizationTab(tabId) : false
  }

  /**
   * 获取统计信息
   */
  public getStats(): {
    totalTabs: number
    totalViews: number
    tabStats: Array<{ tabId: string; viewCount: number }>
  } {
    const tabStats = Array.from(this.tabToViews.entries()).map(([tabId, views]) => ({
      tabId,
      viewCount: views.size
    }))

    return {
      totalTabs: this.tabToViews.size,
      totalViews: this.viewToTab.size,
      tabStats
    }
  }

  /**
   * 调试信息
   */
  public debug(): void {
    log.debug('===== 调试信息 =====')
    log.debug('统计:', this.getStats())
    log.debug('Tab → Views 映射:')
    for (const [tabId, views] of this.tabToViews.entries()) {
      log.debug(`  - ${tabId}: [${Array.from(views).join(', ')}]`)
    }
    log.debug('View → Tab 映射:')
    for (const [viewId, tabId] of this.viewToTab.entries()) {
      const metadata = this.viewMetadata.get(viewId)
      log.debug(`  - ${viewId} → ${tabId}`, metadata)
    }
  }

  /**
   * 批量清除 Tab 下所有 View 的映射和元数据
   *
   * 当 crawlspace 被强制关闭时，views 可能未逐一走 destroyView 流程，
   * 需要按 Tab 维度一次性清理，避免 isOrganizationTab 返回 true 的僵尸条目。
   *
   * @param tabId Tab ID（组织 ID）
   * @returns 被清除的 viewId 列表
   */
  public clearTab(tabId: string): string[] {
    const viewSet = this.tabToViews.get(tabId)
    if (!viewSet || viewSet.size === 0) {
      this.tabToViews.delete(tabId)
      return []
    }

    const removedViewIds = Array.from(viewSet)

    for (const viewId of removedViewIds) {
      this.viewToTab.delete(viewId)
      this.viewMetadata.delete(viewId)
    }

    this.tabToViews.delete(tabId)

    log.debug('🗑️  clearTab 批量清除:', {
      tabId,
      removedViews: removedViewIds.length
    })

    return removedViewIds
  }

  /**
   * 清理所有数据（测试用）
   */
  public clear(): void {
    this.tabToViews.clear()
    this.viewToTab.clear()
    this.viewMetadata.clear()
    log.debug('🗑️  所有数据已清理')
  }
}

/**
 * 获取 OrganizationTabManager 单例
 */
export function getOrganizationTabManager(): OrganizationTabManager {
  return OrganizationTabManager.getInstance()
}
