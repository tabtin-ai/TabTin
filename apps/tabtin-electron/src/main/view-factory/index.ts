/**
 * ViewFactory - 导出模块
 */

export * from './types';
export * from './profiles';
export { ViewFactory, getViewFactory, setViewFactoryExternalHandlers } from './ViewFactory';
export { setupResourceInterception, type ResourceInterceptionContext } from './resource-interception';
export {
  cleanUserAgent,
  ensureSessionUARewrite,
  applyProxyFromAntiDetect,
  applyTraditionalConfig,
  setupUAOverrideInjection,
  tagProxy,
  tagUserAgent,
  type AntiDetectContext,
} from './anti-detect-config';
export {
  handleDisplay,
  hideToOffscreen,
  showInMainWindow,
  removeFromMainWindow,
  notifyRendererCreateTab,
  notifyRendererCloseTab,
  type DisplayContext,
} from './display-handler';
