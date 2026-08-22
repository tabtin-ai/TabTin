/**
 * Tins 模块入口
 *
 * 导出所有 Tin 相关的主进程功能。
 */

export { TinManager, getTinManager, initTinManager, disposeTinManagerSingleton } from './tin-manager'
export { initTinBridge, disposeTinBridge, generateTinPreloadScript } from './tin-bridge'
export { prepareSandbox, cleanupSandbox } from './tin-sandbox'
export { matchActivationRules } from './activation-matcher'
export {
  initCrawlViewIntegration,
  connectCrawlViewEvents,
  disposeCrawlViewIntegration,
  setActiveWebContents,
  getPageContent,
  getPageSelection,
} from './crawlview-integration'
export type {
  TinDefinition,
  TinInstance,
  TinActivationState,
  TinManifest,
  ActivationRule,
  VariableSchema,
  TinBridgeMessage,
} from './types'
