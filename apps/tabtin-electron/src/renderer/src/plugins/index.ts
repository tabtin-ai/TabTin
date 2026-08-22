/**
 * Plugin Registry
 *
 * 注册所有 Crawlspace 插件
 */

import { crawlspaceRegistry } from '@tabtin/crawlspace-core'
import { createLogger } from '@/utils/logger'

const log = createLogger('PluginRegistry')

export { crawlspaceRegistry }

/**
 * 注册所有插件
 *
 * @returns 清理函数
 */
export function registerAllPlugins(): () => void {
  const registered = crawlspaceRegistry.getAll().map(p => p.config.id)
  if (registered.length > 0) {
    log.info('已注册插件:', registered)
  } else {
    log.debug('Agent 驱动模式，无遗留插件')
  }

  // 当前 Agent 驱动模式无遗留插件；若未来恢复插件注册，需在此实现 crawlspaceRegistry.unregister 清理
  return () => {}
}
