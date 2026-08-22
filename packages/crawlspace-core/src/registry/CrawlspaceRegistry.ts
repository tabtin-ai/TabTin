/**
 * Crawlspace Plugin Registry
 *
 * 插件注册器，管理所有 Crawlspace 插件的注册、获取和生命周期
 */

import type { CrawlspacePlugin, ICrawlspaceRegistry } from '../types/plugin'
import { t } from '../i18n'

/**
 * Crawlspace 插件注册器实现
 */
export class CrawlspaceRegistry implements ICrawlspaceRegistry {
  private plugins = new Map<string, CrawlspacePlugin>()

  /**
   * 注册插件
   *
   * @param plugin - 插件实例
   * @throws 如果插件 ID 已存在
   *
   * @example
   * ```typescript
   * const myPlugin: CrawlspacePlugin = {
   *   config: { id: 'my-plugin', name: '我的插件', version: '1.0.0' },
   *   renderPanel: (context) => <MyPluginPanel context={context} />
   * }
   *
   * crawlspaceRegistry.register(myPlugin)
   * ```
   */
  register(plugin: CrawlspacePlugin): void {
    const { id, name, version } = plugin.config

    // 验证必填字段
    if (!id || !name || !version) {
      throw new Error(
        `[CrawlspaceRegistry] ${t('registry.pluginConfigMissing', { id, name, version })}`
      )
    }

    // 检查是否已注册
    if (this.plugins.has(id)) {
      console.warn(
        `[CrawlspaceRegistry] plugin already exists, overwriting: ${id}. ` +
        `old version: ${this.plugins.get(id)?.config.version}, new version: ${version}`
      )
    }

    // 注册插件
    this.plugins.set(id, plugin)
    console.log(`[CrawlspaceRegistry] plugin registered: ${id} (${name} v${version})`)
  }

  /**
   * 注销插件
   *
   * @param pluginId - 插件 ID
   * @returns 是否成功注销
   *
   * @example
   * ```typescript
   * crawlspaceRegistry.unregister('my-plugin')
   * ```
   */
  unregister(pluginId: string): boolean {
    const plugin = this.plugins.get(pluginId)

    if (!plugin) {
      console.warn(`[CrawlspaceRegistry] plugin not found, cannot unregister: ${pluginId}`)
      return false
    }

    this.plugins.delete(pluginId)
    console.log(`[CrawlspaceRegistry] plugin unregistered: ${pluginId}`)
    return true
  }

  /**
   * 获取插件
   *
   * @param pluginId - 插件 ID
   * @returns 插件实例，如果不存在返回 undefined
   *
   * @example
   * ```typescript
   * const plugin = crawlspaceRegistry.get('my-plugin')
   * if (plugin) {
   *   console.log(plugin.config.name)
   * }
   * ```
   */
  get(pluginId: string): CrawlspacePlugin | undefined {
    return this.plugins.get(pluginId)
  }

  /**
   * 获取所有插件
   *
   * @returns 插件列表
   *
   * @example
   * ```typescript
   * const allPlugins = crawlspaceRegistry.getAll()
   * console.log(`共有 ${allPlugins.length} 个插件`)
   * ```
   */
  getAll(): CrawlspacePlugin[] {
    return Array.from(this.plugins.values())
  }

  /**
   * 检查插件是否存在
   *
   * @param pluginId - 插件 ID
   * @returns 是否存在
   *
   * @example
   * ```typescript
   * if (crawlspaceRegistry.has('my-plugin')) {
   *   console.log('插件已安装')
   * }
   * ```
   */
  has(pluginId: string): boolean {
    return this.plugins.has(pluginId)
  }

  /**
   * 清空所有插件（谨慎使用）
   *
   * @internal
   */
  clear(): void {
    const count = this.plugins.size
    this.plugins.clear()
    console.log(`[CrawlspaceRegistry] all plugins cleared (${count})`)
  }

  /**
   * 获取插件数量
   *
   * @returns 插件数量
   */
  get size(): number {
    return this.plugins.size
  }
}

/**
 * 全局插件注册器实例
 *
 * @example
 * ```typescript
 * import { crawlspaceRegistry } from '@tabtin/crawlspace-core'
 *
 * crawlspaceRegistry.register(myPlugin)
 * ```
 */
export const crawlspaceRegistry = new CrawlspaceRegistry()
